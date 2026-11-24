import { db } from "../../config/db-sqlite.ts";
import type { PodcastFollowsRow } from "../../db/rows.ts";

export interface FollowSettings {
  keepLatest: number;
  autoDownload: boolean;
  removePlayed: boolean;
}

export const MAX_KEEP_LATEST = 200;

const statements = {
  follow: db.prepare<[number, number, number]>(
    "INSERT INTO podcast_follows (user_id, podcast_id, followed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  ),
  get: db.prepare<[number, number], PodcastFollowsRow>(
    "SELECT * FROM podcast_follows WHERE user_id = ? AND podcast_id = ?",
  ),
  followers: db.prepare<[number], { user_id: number }>(
    "SELECT user_id FROM podcast_follows WHERE podcast_id = ?",
  ),
  update: db.prepare<[number, number, number, number, number]>(
    `UPDATE podcast_follows SET keep_latest = ?, auto_download = ?, remove_played = ?
     WHERE user_id = ? AND podcast_id = ?`,
  ),
  unfollow: db.prepare<[number, number]>(
    "DELETE FROM podcast_follows WHERE user_id = ? AND podcast_id = ?",
  ),
  dropEntitlements: db.prepare<[number, number]>(
    `DELETE FROM podcast_entitlements WHERE user_id = ? AND episode_id IN
       (SELECT id FROM podcast_episodes WHERE podcast_id = ?)`,
  ),
  dropProgress: db.prepare<[number, number]>(
    `DELETE FROM podcast_progress WHERE user_id = ? AND episode_id IN
       (SELECT id FROM podcast_episodes WHERE podcast_id = ?)`,
  ),
  dropHistory: db.prepare<[number, number]>(
    `DELETE FROM podcast_history WHERE user_id = ? AND episode_id IN
       (SELECT id FROM podcast_episodes WHERE podcast_id = ?)`,
  ),
  wanted: db.prepare<[number, number], { id: number; played: number | null }>(
    `SELECT e.id, p.played FROM podcast_episodes e
     LEFT JOIN podcast_progress p ON p.episode_id = e.id AND p.user_id = ?
     WHERE e.podcast_id = ?
     ORDER BY e.published_at DESC, e.id DESC`,
  ),
  entitled: db.prepare<[number, number], { episode_id: number; reason: string }>(
    `SELECT n.episode_id, n.reason FROM podcast_entitlements n
     JOIN podcast_episodes e ON e.id = n.episode_id
     WHERE n.user_id = ? AND e.podcast_id = ?`,
  ),
  entitle: db.prepare<[number, number, number]>(
    `INSERT INTO podcast_entitlements (user_id, episode_id, reason, created_at)
     VALUES (?, ?, 'retention', ?) ON CONFLICT DO NOTHING`,
  ),
  release: db.prepare<[number, number]>(
    "DELETE FROM podcast_entitlements WHERE user_id = ? AND episode_id = ?",
  ),
  needMedia: db.prepare<[number, number]>(
    `INSERT INTO podcast_media (episode_id, status, updated_at) VALUES (?, 'pending', ?)
     ON CONFLICT DO NOTHING`,
  ),
  mediaStatus: db.prepare<[number], { status: string }>(
    "SELECT status FROM podcast_media WHERE episode_id = ?",
  ),
};

export const getFollow = (userId: number, podcastId: number) =>
  statements.get.get(userId, podcastId);

export const followerIds = (podcastId: number) =>
  statements.followers.all(podcastId).map((row) => row.user_id);

export const followSettings = (row: PodcastFollowsRow): FollowSettings => ({
  keepLatest: row.keep_latest,
  autoDownload: row.auto_download === 1,
  removePlayed: row.remove_played === 1,
});

export const reconcileFollow = db.transaction(
  (userId: number, podcastId: number, now: number = Date.now()) => {
    const follow = statements.get.get(userId, podcastId);
    const toDownload: number[] = [];
    if (!follow) return { toDownload };
    const settings = followSettings(follow);
    const episodes = statements.wanted.all(userId, podcastId);
    const played = new Set(episodes.filter((episode) => episode.played === 1).map((e) => e.id));

    const keep = new Set<number>();
    if (settings.autoDownload) {
      for (const episode of episodes.slice(0, settings.keepLatest)) {
        if (!(settings.removePlayed && played.has(episode.id))) keep.add(episode.id);
      }
    }

    const current = new Map<number, string>();
    for (const row of statements.entitled.all(userId, podcastId)) {
      current.set(row.episode_id, row.reason);
    }
    const entitled = new Set(keep);
    for (const [episodeId, reason] of current) {
      const manualStays = reason === "manual" && !(settings.removePlayed && played.has(episodeId));
      if (keep.has(episodeId) || manualStays) entitled.add(episodeId);
      else statements.release.run(userId, episodeId);
    }
    for (const episodeId of keep) {
      if (!current.has(episodeId)) statements.entitle.run(userId, episodeId, now);
    }

    for (const episodeId of entitled) {
      statements.needMedia.run(episodeId, now);
      if (statements.mediaStatus.get(episodeId)?.status === "pending") toDownload.push(episodeId);
    }
    return { toDownload };
  },
);

export const reconcilePodcast = (podcastId: number) => {
  const toDownload = new Set<number>();
  for (const userId of followerIds(podcastId)) {
    for (const id of reconcileFollow(userId, podcastId).toDownload) toDownload.add(id);
  }
  return [...toDownload];
};

export const followPodcast = db.transaction((userId: number, podcastId: number) => {
  statements.follow.run(userId, podcastId, Date.now());
  return reconcileFollow(userId, podcastId);
});

export const updateFollowSettings = db.transaction(
  (userId: number, podcastId: number, patch: Partial<FollowSettings>) => {
    const row = statements.get.get(userId, podcastId);
    if (!row) return null;
    const next = { ...followSettings(row), ...patch };
    const keepLatest = Math.min(MAX_KEEP_LATEST, Math.max(1, Math.round(next.keepLatest)));
    statements.update.run(
      keepLatest,
      next.autoDownload ? 1 : 0,
      next.removePlayed ? 1 : 0,
      userId,
      podcastId,
    );
    return reconcileFollow(userId, podcastId);
  },
);

export const unfollowPodcast = db.transaction(
  (userId: number, podcastId: number, { removeHistory = false } = {}) => {
    statements.unfollow.run(userId, podcastId);
    statements.dropEntitlements.run(userId, podcastId);
    if (removeHistory) {
      statements.dropProgress.run(userId, podcastId);
      statements.dropHistory.run(userId, podcastId);
    }
  },
);

export const requestEpisodeDownload = db.transaction((userId: number, episodeId: number) => {
  const now = Date.now();
  db.prepare<[number, number, number]>(
    `INSERT INTO podcast_entitlements (user_id, episode_id, reason, created_at)
     VALUES (?, ?, 'manual', ?) ON CONFLICT (user_id, episode_id) DO UPDATE SET reason = 'manual'`,
  ).run(userId, episodeId, now);
  statements.needMedia.run(episodeId, now);
  const status = statements.mediaStatus.get(episodeId)?.status;
  return status === "pending" || status === "failed" || status === "awaiting_storage";
});

export const releaseEpisodeDownload = (userId: number, episodeId: number) =>
  db
    .prepare<[number, number]>(
      "DELETE FROM podcast_entitlements WHERE user_id = ? AND episode_id = ? AND reason = 'manual'",
    )
    .run(userId, episodeId).changes > 0;
