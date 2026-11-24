import { XMLParser } from "fast-xml-parser";
import * as v from "valibot";
import { db } from "../../config/db-sqlite.ts";
import { podcastImportQueue } from "../jobs/queues.ts";
import { queueDownloads } from "./downloads.ts";
import { followPodcast, getFollow } from "./follows.ts";
import { findPodcastId, importPodcastFeed, normalizeFeedUrl } from "./store.ts";

export const MAX_OPML_FEEDS = 300;
export const podcastImportSchema = v.object({ userId: v.number(), feedUrl: v.string() });

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function exportOpml(userId: number) {
  const rows = db
    .prepare<[number], { title: string; feed_url: string; website_url: string | null }>(
      `SELECT p.title, s.feed_url, p.website_url FROM podcast_follows f
       JOIN podcasts p ON p.id = f.podcast_id JOIN podcast_sources s ON s.podcast_id = p.id
       WHERE f.user_id = ? ORDER BY p.title COLLATE NOCASE`,
    )
    .all(userId);
  const outlines = rows.map(
    (row) =>
      `    <outline type="rss" text="${escapeXml(row.title)}" title="${escapeXml(row.title)}" xmlUrl="${escapeXml(row.feed_url)}"${
        row.website_url ? ` htmlUrl="${escapeXml(row.website_url)}"` : ""
      }/>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Aurral podcasts</title></head>
  <body>
${outlines.join("\n")}
  </body>
</opml>
`;
}

type Outline = Record<string, unknown>;

const asOutlines = (value: unknown): Outline[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is Outline => typeof entry === "object" && entry !== null,
  );

export function parseOpml(xml: string) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => name === "outline",
  });
  const parsed: unknown = parser.parse(xml);
  const [root] = asOutlines(parsed);
  const [opml] = asOutlines(root?.opml);
  if (!opml || opml.body === undefined) return null;
  const [body] = asOutlines(opml.body);

  const feeds = new Map<string, string | null>();
  const walk = (outlines: Outline[]) => {
    for (const outline of outlines) {
      const raw = outline["@_xmlUrl"] ?? outline["@_xmlurl"];
      if (typeof raw === "string") {
        try {
          const url = normalizeFeedUrl(raw);
          const title = outline["@_title"] ?? outline["@_text"];
          if (!feeds.has(url))
            feeds.set(url, typeof title === "string" ? title.slice(0, 200) : null);
        } catch {}
      }
      if (outline.outline) walk(asOutlines(outline.outline));
    }
  };
  walk(asOutlines(body?.outline));
  return [...feeds.entries()].map(([feedUrl, title]) => ({ feedUrl, title }));
}

const statements = {
  put: db.prepare<[number, string, string | null, number]>(
    `INSERT INTO podcast_imports (user_id, feed_url, title, status, error, podcast_id, created_at)
     VALUES (?, ?, ?, 'pending', NULL, NULL, ?)
     ON CONFLICT (user_id, feed_url) DO UPDATE SET status = 'pending', error = NULL,
       podcast_id = NULL, title = excluded.title, created_at = excluded.created_at`,
  ),
  done: db.prepare<[number, number, string]>(
    "UPDATE podcast_imports SET status = 'done', podcast_id = ?, error = NULL WHERE user_id = ? AND feed_url = ?",
  ),
  failed: db.prepare<[string, number, string]>(
    "UPDATE podcast_imports SET status = 'failed', error = ? WHERE user_id = ? AND feed_url = ?",
  ),
  clear: db.prepare<[number]>(
    "DELETE FROM podcast_imports WHERE user_id = ? AND status != 'pending'",
  ),
  counts: db.prepare<[number], { status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM podcast_imports WHERE user_id = ? GROUP BY status",
  ),
  failures: db.prepare<[number], { feed_url: string; title: string | null; error: string | null }>(
    "SELECT feed_url, title, error FROM podcast_imports WHERE user_id = ? AND status = 'failed' ORDER BY created_at LIMIT 100",
  ),
};

export function queueOpmlImport(userId: number, xml: string) {
  const feeds = parseOpml(xml);
  if (!feeds) return { error: "This doesn't look like an OPML file" as const };
  if (!feeds.length) return { error: "The file has no podcast feeds in it" as const };
  const now = Date.now();
  let queued = 0;
  let alreadyFollowing = 0;
  for (const { feedUrl, title } of feeds.slice(0, MAX_OPML_FEEDS)) {
    const known = findPodcastId(feedUrl);
    if (known !== undefined && getFollow(userId, known)) {
      alreadyFollowing += 1;
      continue;
    }
    statements.put.run(userId, feedUrl, title, now);
    podcastImportQueue.enqueue({ userId, feedUrl }, { dedupeKey: `import:${userId}:${feedUrl}` });
    queued += 1;
  }
  return { queued, alreadyFollowing, skipped: Math.max(0, feeds.length - MAX_OPML_FEEDS) };
}

export async function runPodcastImport(userId: number, feedUrl: string) {
  try {
    const { podcastId } = await importPodcastFeed(feedUrl);
    queueDownloads(followPodcast(userId, podcastId).toDownload);
    statements.done.run(podcastId, userId, feedUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statements.failed.run(message.slice(0, 300), userId, feedUrl);
  }
}

export function importStatus(userId: number) {
  const counts = Object.fromEntries(
    statements.counts.all(userId).map((row) => [row.status, row.n]),
  );
  const pending = counts.pending ?? 0;
  const done = counts.done ?? 0;
  const failed = counts.failed ?? 0;
  return {
    total: pending + done + failed,
    pending,
    done,
    failed,
    failures: statements.failures.all(userId).map((row) => ({
      feedUrl: row.feed_url,
      title: row.title,
      error: row.error,
    })),
  };
}

export const clearFinishedImports = (userId: number) => statements.clear.run(userId).changes;
