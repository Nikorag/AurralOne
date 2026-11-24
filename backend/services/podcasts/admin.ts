import { db } from "../../config/db-sqlite.ts";
import { availableDirectories, directories } from "./directories/index.ts";
import { queueWaitingDownloads } from "./downloads.ts";
import { queueDueRefreshes } from "./refresh.ts";
import { getPodcastSettings } from "./settings.ts";
import { availableBytes, usedBytes } from "./storage.ts";

const one = <T>(sql: string) => db.prepare<[], T>(sql).get();

export function podcastStatus() {
  const settings = getPodcastSettings();
  const counts = Object.fromEntries(
    db
      .prepare<[], { status: string; n: number; bytes: number }>(
        "SELECT status, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM podcast_media GROUP BY status",
      )
      .all()
      .map((row) => [row.status, row]),
  );
  const cleanup = one<{ n: number; bytes: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM podcast_media m
     WHERE status = 'downloaded'
       AND NOT EXISTS (SELECT 1 FROM podcast_entitlements n WHERE n.episode_id = m.episode_id)`,
  );
  const biggest = db
    .prepare<[], { id: number; title: string; bytes: number; episodes: number }>(
      `SELECT p.id, p.title, SUM(m.bytes) AS bytes, COUNT(*) AS episodes
       FROM podcast_media m JOIN podcast_episodes e ON e.id = m.episode_id
       JOIN podcasts p ON p.id = e.podcast_id
       WHERE m.status = 'downloaded' GROUP BY p.id ORDER BY bytes DESC LIMIT 8`,
    )
    .all();
  const failed = db
    .prepare<
      [],
      { episode_id: number; title: string; podcast: string; error: string | null; attempts: number }
    >(
      `SELECT m.episode_id, e.title, p.title AS podcast, m.error, m.attempts
       FROM podcast_media m JOIN podcast_episodes e ON e.id = m.episode_id
       JOIN podcasts p ON p.id = e.podcast_id
       WHERE m.status = 'failed' ORDER BY m.updated_at DESC LIMIT 50`,
    )
    .all();
  const available = availableBytes();
  const feedErrors = db
    .prepare<[], { podcast_id: number; title: string; last_error: string }>(
      `SELECT s.podcast_id, p.title, s.last_error FROM podcast_sources s
       JOIN podcasts p ON p.id = s.podcast_id
       WHERE s.last_error IS NOT NULL AND EXISTS (
         SELECT 1 FROM podcast_follows f WHERE f.podcast_id = s.podcast_id) LIMIT 50`,
    )
    .all();
  return {
    settings: {
      storageLimitBytes: settings.storageLimitBytes,
      refreshIntervalMinutes: settings.refreshIntervalMinutes,
      podcastIndexKey: settings.podcastIndexKey,
      hasPodcastIndexSecret: settings.podcastIndexSecret !== "",
    },
    storage: {
      usedBytes: usedBytes(),
      limitBytes: settings.storageLimitBytes,
      availableBytes: Number.isFinite(available) ? available : null,
      pressure: settings.storageLimitBytes > 0 && (counts.awaiting_storage?.n ?? 0) > 0,
    },
    totals: {
      podcasts: one<{ n: number }>("SELECT COUNT(*) AS n FROM podcasts")?.n ?? 0,
      followedPodcasts:
        one<{ n: number }>("SELECT COUNT(DISTINCT podcast_id) AS n FROM podcast_follows")?.n ?? 0,
      episodes: one<{ n: number }>("SELECT COUNT(*) AS n FROM podcast_episodes")?.n ?? 0,
      downloadedEpisodes: counts.downloaded?.n ?? 0,
    },
    queue: {
      pending: (counts.pending?.n ?? 0) + (counts.queued?.n ?? 0),
      downloading: counts.downloading?.n ?? 0,
      awaitingStorage: counts.awaiting_storage?.n ?? 0,
      failed: counts.failed?.n ?? 0,
    },
    cleanup: { episodes: cleanup?.n ?? 0, bytes: cleanup?.bytes ?? 0 },
    biggest,
    failed,
    feedErrors,
    providers: directories.map(({ id, label }) => ({
      id,
      label,
      available: availableDirectories().some((directory) => directory.id === id),
    })),
  };
}

export function retryFailedDownloads() {
  const reset = db
    .prepare("UPDATE podcast_media SET status = 'pending', attempts = 0 WHERE status = 'failed'")
    .run().changes;
  queueWaitingDownloads();
  return reset;
}

export function refreshAllNow() {
  db.prepare(
    `UPDATE podcast_sources SET next_check_at = 0
     WHERE podcast_id IN (SELECT podcast_id FROM podcast_follows)`,
  ).run();
  return queueDueRefreshes();
}
