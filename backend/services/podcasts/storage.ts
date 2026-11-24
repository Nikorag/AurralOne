import { db } from "../../config/db-sqlite.ts";
import { mediaStore } from "./mediaStore.ts";
import { getPodcastSettings } from "./settings.ts";

const HOUR = 60 * 60_000;
const PLAYING_GRACE_MS = 6 * HOUR;
const PART_MAX_AGE_MS = 24 * HOUR;
const ORPHAN_GRACE_MS = HOUR;

const statements = {
  used: db.prepare<[], { n: number }>(
    "SELECT COALESCE(SUM(bytes), 0) AS n FROM podcast_media WHERE status = 'downloaded'",
  ),
  inflight: db.prepare<[], { n: number }>(
    `SELECT COALESCE(SUM(COALESCE(e.enclosure_bytes, 0)), 0) AS n
     FROM podcast_media m JOIN podcast_episodes e ON e.id = m.episode_id
     WHERE m.status = 'downloading'`,
  ),
  unreferenced: db.prepare<
    [number, number],
    { episode_id: number; path: string | null; bytes: number | null }
  >(
    `SELECT m.episode_id, m.path, m.bytes FROM podcast_media m
     WHERE m.status = 'downloaded'
       AND NOT EXISTS (SELECT 1 FROM podcast_entitlements n WHERE n.episode_id = m.episode_id)
       AND m.updated_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM podcast_progress p WHERE p.episode_id = m.episode_id AND p.updated_at > ?)
     ORDER BY m.downloaded_at`,
  ),
  dropMedia: db.prepare<[number, number]>(
    `DELETE FROM podcast_media WHERE episode_id = ?
       AND NOT EXISTS (SELECT 1 FROM podcast_entitlements WHERE episode_id = ?)`,
  ),
  downloaded: db.prepare<[], { episode_id: number; path: string | null; bytes: number | null }>(
    "SELECT episode_id, path, bytes FROM podcast_media WHERE status = 'downloaded'",
  ),
  reset: db.prepare<[number, number]>(
    `UPDATE podcast_media SET status = 'pending', path = NULL, bytes = NULL, sha256 = NULL,
       downloaded_at = NULL, updated_at = ? WHERE episode_id = ?`,
  ),
  stuck: db.prepare<[number]>(
    "UPDATE podcast_media SET status = 'pending', updated_at = ? WHERE status IN ('downloading', 'queued')",
  ),
};

export const usedBytes = () => statements.used.get()?.n ?? 0;

export function availableBytes() {
  const { storageLimitBytes } = getPodcastSettings();
  if (storageLimitBytes === 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, storageLimitBytes - usedBytes() - (statements.inflight.get()?.n ?? 0));
}

export async function removeUnreferencedMedia(now = Date.now()) {
  let freed = 0;
  const rows = statements.unreferenced.all(now - HOUR, now - PLAYING_GRACE_MS);
  for (const row of rows) {
    if (statements.dropMedia.run(row.episode_id, row.episode_id).changes === 0) continue;
    if (row.path) await mediaStore.remove(row.path);
    freed += row.bytes ?? 0;
  }
  return { removed: rows.length, freed };
}

export async function reconcileStorage(now = Date.now()) {
  const files = await mediaStore.list();
  const known = new Set<string>();
  let missing = 0;
  for (const row of statements.downloaded.all()) {
    const size = row.path ? await mediaStore.size(row.path) : null;
    if (size === null) {
      statements.reset.run(now, row.episode_id);
      missing += 1;
    } else {
      if (row.path) known.add(row.path);
      if (size !== row.bytes) {
        db.prepare<[number, number]>("UPDATE podcast_media SET bytes = ? WHERE episode_id = ?").run(
          size,
          row.episode_id,
        );
      }
    }
  }
  let orphans = 0;
  for (const file of files) {
    const stale =
      now - file.mtimeMs > (file.name.endsWith(".part") ? PART_MAX_AGE_MS : ORPHAN_GRACE_MS);
    if (known.has(file.name) || !stale) continue;
    await mediaStore.remove(file.name);
    orphans += 1;
  }
  const cleaned = await removeUnreferencedMedia(now);
  return { missing, orphans, removed: cleaned.removed, freed: cleaned.freed };
}

export const resetInterruptedDownloads = (now = Date.now()) => statements.stuck.run(now).changes;
