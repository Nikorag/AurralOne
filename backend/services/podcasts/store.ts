import { db } from "../../config/db-sqlite.ts";
import type { PodcastEpisodesRow, PodcastsRow } from "../../db/rows.ts";
import { fetchPodcastFeed, type ParsedPodcast } from "./feed.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const REFRESH_INTERVAL_MS = 2 * HOUR;
const MAX_BACKOFF_MS = 24 * HOUR;

export const normalizeFeedUrl = (value: string) => {
  const url = new URL(value.trim().replace(/^feed:\/\//i, "https://"));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS feeds are supported");
  }
  url.hash = "";
  return url.href;
};

const otherScheme = (url: string) =>
  url.startsWith("https://") ? `http://${url.slice(8)}` : `https://${url.slice(7)}`;

const statements = {
  byProvider: db.prepare<[string, string], { podcast_id: number }>(
    "SELECT podcast_id FROM podcast_provider_ids WHERE provider = ? AND external_id = ?",
  ),
  byFeed: db.prepare<[string, string], { podcast_id: number }>(
    "SELECT podcast_id FROM podcast_sources WHERE feed_url IN (?, ?) LIMIT 1",
  ),
  insertPodcast: db.prepare<
    [string, string | null, string, string | null, string | null, string, string | null, number]
  >(
    `INSERT INTO podcasts
       (title, publisher, description, image_url, language, categories, website_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  updatePodcast: db.prepare<
    [string, string | null, string, string | null, string | null, string, string | null, number]
  >(
    `UPDATE podcasts SET title = ?, publisher = ?, description = ?, image_url = ?, language = ?,
       categories = ?, website_url = ? WHERE id = ?`,
  ),
  insertSource: db.prepare<[number, string, number]>(
    "INSERT INTO podcast_sources (podcast_id, feed_url, next_check_at) VALUES (?, ?, ?)",
  ),
  linkProvider: db.prepare<[string, string, number]>(
    `INSERT INTO podcast_provider_ids (provider, external_id, podcast_id) VALUES (?, ?, ?)
     ON CONFLICT (provider, external_id) DO NOTHING`,
  ),
  episodeByGuid: db.prepare<[number, string], Pick<PodcastEpisodesRow, "id">>(
    "SELECT id FROM podcast_episodes WHERE podcast_id = ? AND guid = ?",
  ),
  episodeByEnclosure: db.prepare<[number, string], Pick<PodcastEpisodesRow, "id">>(
    "SELECT id FROM podcast_episodes WHERE podcast_id = ? AND enclosure_url = ? LIMIT 1",
  ),
  insertEpisode: db.prepare<
    [
      number,
      string,
      string,
      string,
      number | null,
      number | null,
      string | null,
      string,
      string | null,
      number | null,
      number | null,
      number | null,
      number,
    ]
  >(
    `INSERT INTO podcast_episodes
       (podcast_id, guid, title, description, published_at, duration_seconds, image_url,
        enclosure_url, enclosure_type, enclosure_bytes, season, episode_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  updateEpisode: db.prepare<
    [
      string,
      string,
      number | null,
      number | null,
      string | null,
      string,
      string | null,
      number | null,
      number | null,
      number | null,
      number,
    ]
  >(
    `UPDATE podcast_episodes SET title = ?, description = ?, published_at = ?,
       duration_seconds = ?, image_url = ?, enclosure_url = ?, enclosure_type = ?,
       enclosure_bytes = ?, season = ?, episode_number = ? WHERE id = ?`,
  ),
  checked: db.prepare<[number, number, string | null, string | null, number, number]>(
    `UPDATE podcast_sources SET last_checked_at = ?, last_success_at = ?, etag = ?,
       last_modified = ?, last_error = NULL, failure_count = 0, next_check_at = ?
     WHERE podcast_id = ?`,
  ),
  failed: db.prepare<[number, string, number, number]>(
    `UPDATE podcast_sources SET last_checked_at = ?, last_error = ?,
       failure_count = failure_count + 1, next_check_at = ? WHERE podcast_id = ?`,
  ),
  source: db.prepare<
    [number],
    { etag: string | null; last_modified: string | null; feed_url: string; failure_count: number }
  >(
    "SELECT etag, last_modified, feed_url, failure_count FROM podcast_sources WHERE podcast_id = ?",
  ),
  podcast: db.prepare<[number], PodcastsRow>("SELECT * FROM podcasts WHERE id = ?"),
};

export const getPodcast = (id: number) => statements.podcast.get(id);

export function findPodcastId(feedUrl: string, provider?: { name: string; id: string }) {
  const known = provider && statements.byProvider.get(provider.name, provider.id);
  return known?.podcast_id ?? statements.byFeed.get(feedUrl, otherScheme(feedUrl))?.podcast_id;
}

const storeFeed = db.transaction(
  (
    feedUrl: string,
    parsed: ParsedPodcast,
    provider: { name: string; id: string } | undefined,
    now: number,
  ) => {
    let podcastId = findPodcastId(feedUrl, provider);
    const fields = [
      parsed.title,
      parsed.publisher,
      parsed.description,
      parsed.imageUrl,
      parsed.language,
      JSON.stringify(parsed.categories),
      parsed.websiteUrl,
    ] as const;
    if (podcastId === undefined) {
      podcastId = Number(statements.insertPodcast.run(...fields, now).lastInsertRowid);
      statements.insertSource.run(podcastId, feedUrl, now);
    } else {
      statements.updatePodcast.run(...fields, podcastId);
    }
    if (provider) statements.linkProvider.run(provider.name, provider.id, podcastId);

    const added: number[] = [];
    for (const episode of parsed.episodes) {
      const existing =
        statements.episodeByGuid.get(podcastId, episode.guid) ??
        statements.episodeByEnclosure.get(podcastId, episode.enclosureUrl);
      const values = [
        episode.title,
        episode.description,
        episode.publishedAt,
        episode.durationSeconds,
        episode.imageUrl,
        episode.enclosureUrl,
        episode.enclosureType,
        episode.enclosureBytes,
        episode.season,
        episode.episodeNumber,
      ] as const;
      if (existing) {
        statements.updateEpisode.run(...values, existing.id);
      } else {
        const result = statements.insertEpisode.run(
          podcastId,
          episode.guid,
          episode.title,
          episode.description,
          episode.publishedAt,
          episode.durationSeconds,
          episode.imageUrl,
          episode.enclosureUrl,
          episode.enclosureType,
          episode.enclosureBytes,
          episode.season,
          episode.episodeNumber,
          now,
        );
        added.push(Number(result.lastInsertRowid));
      }
    }
    return { podcastId, newEpisodeIds: added };
  },
);

const retryDelay = (failures: number) =>
  Math.min(MAX_BACKOFF_MS, REFRESH_INTERVAL_MS * 2 ** Math.min(failures, 6));

export async function importPodcastFeed(rawUrl: string, provider?: { name: string; id: string }) {
  const feedUrl = normalizeFeedUrl(rawUrl);
  const result = await fetchPodcastFeed(feedUrl);
  if (result.notModified) throw new Error("The feed returned no content");
  const now = Date.now();
  const stored = storeFeed(feedUrl, result.podcast, provider, now);
  statements.checked.run(
    now,
    now,
    result.etag,
    result.lastModified,
    now + REFRESH_INTERVAL_MS,
    stored.podcastId,
  );
  return stored;
}

export async function refreshPodcast(podcastId: number) {
  const source = statements.source.get(podcastId);
  if (!source) return { newEpisodeIds: [] as number[] };
  const now = Date.now();
  try {
    const result = await fetchPodcastFeed(source.feed_url, {
      etag: source.etag,
      lastModified: source.last_modified,
    });
    if (result.notModified) {
      statements.checked.run(
        now,
        now,
        source.etag,
        source.last_modified,
        now + REFRESH_INTERVAL_MS,
        podcastId,
      );
      return { newEpisodeIds: [] as number[] };
    }
    const stored = storeFeed(source.feed_url, result.podcast, undefined, now);
    statements.checked.run(
      now,
      now,
      result.etag,
      result.lastModified,
      now + REFRESH_INTERVAL_MS,
      podcastId,
    );
    return { newEpisodeIds: stored.newEpisodeIds };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statements.failed.run(
      now,
      message.slice(0, 300),
      now + retryDelay(source.failure_count + 1),
      podcastId,
    );
    throw error;
  }
}

export const dueSourceIds = (now = Date.now()) =>
  db
    .prepare<[number], { podcast_id: number }>(
      `SELECT s.podcast_id FROM podcast_sources s
       WHERE s.next_check_at <= ? AND EXISTS (SELECT 1 FROM podcast_follows f WHERE f.podcast_id = s.podcast_id)
       ORDER BY s.next_check_at LIMIT 100`,
    )
    .all(now)
    .map((row) => row.podcast_id);
