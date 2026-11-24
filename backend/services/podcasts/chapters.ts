import * as v from "valibot";
import { http } from "../../../lib/http.ts";
import { db } from "../../config/db-sqlite.ts";

const MAX_BYTES = 1024 ** 2;
const MAX_CHAPTERS = 500;
const RETRY_AFTER_MS = 60 * 60_000;

export interface Chapter {
  startSeconds: number;
  title: string;
  imageUrl: string | null;
  url: string | null;
}

const chaptersFile = v.object({
  chapters: v.array(
    v.looseObject({
      startTime: v.number(),
      title: v.optional(v.string()),
      img: v.optional(v.string()),
      url: v.optional(v.string()),
      toc: v.optional(v.boolean()),
    }),
  ),
});

const httpUrl = (value: string | undefined) => {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

export function parseChapters(data: unknown): Chapter[] {
  const parsed = v.safeParse(chaptersFile, data);
  if (!parsed.success) return [];
  const seen = new Set<number>();
  return parsed.output.chapters
    .filter((chapter) => chapter.toc !== false && chapter.startTime >= 0)
    .sort((a, b) => a.startTime - b.startTime)
    .flatMap((chapter, index): Chapter[] => {
      const startSeconds = Math.floor(chapter.startTime);
      if (seen.has(startSeconds)) return [];
      seen.add(startSeconds);
      const title = (chapter.title ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      return [
        {
          startSeconds,
          title: title || `Chapter ${index + 1}`,
          imageUrl: httpUrl(chapter.img),
          url: httpUrl(chapter.url),
        },
      ];
    })
    .slice(0, MAX_CHAPTERS);
}

const statements = {
  get: db.prepare<
    [number],
    {
      chapters_url: string | null;
      chapters_json: string | null;
      chapters_checked_at: number | null;
    }
  >("SELECT chapters_url, chapters_json, chapters_checked_at FROM podcast_episodes WHERE id = ?"),
  save: db.prepare<[string | null, number, number]>(
    "UPDATE podcast_episodes SET chapters_json = ?, chapters_checked_at = ? WHERE id = ?",
  ),
};

const readStored = (value: string): Chapter[] => {
  try {
    const stored: unknown = JSON.parse(value);
    return Array.isArray(stored) ? (stored as Chapter[]) : [];
  } catch {
    return [];
  }
};

export async function getChapters(episodeId: number, now = Date.now()) {
  const row = statements.get.get(episodeId);
  if (!row?.chapters_url) return [];
  if (row.chapters_json !== null) return readStored(row.chapters_json);
  if (row.chapters_checked_at !== null && now - row.chapters_checked_at < RETRY_AFTER_MS) return [];
  try {
    const { data } = await http.get(row.chapters_url, {
      publicOnly: true,
      responseType: "buffer",
      maxBytes: MAX_BYTES,
      timeoutMs: 10_000,
      headers: { Accept: "application/json+chapters, application/json;q=0.9, */*;q=0.5" },
    });
    const chapters = parseChapters(
      JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : "null"),
    );
    statements.save.run(JSON.stringify(chapters), now, episodeId);
    return chapters;
  } catch {
    statements.save.run(null, now, episodeId);
    return [];
  }
}
