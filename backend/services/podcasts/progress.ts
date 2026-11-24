import { db } from "../../config/db-sqlite.ts";
import type { PodcastProgressRow } from "../../db/rows.ts";
import { followSettings, getFollow, reconcileFollow } from "./follows.ts";
import { queueDownloads } from "./downloads.ts";

const COMPLETE_WITHIN_SECONDS = 30;
const SESSION_GAP_MS = 30 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_SECONDS_PER_UPDATE = 120;

export interface ProgressUpdate {
  positionSeconds: number;
  durationSeconds?: number | null;
  clientTime: number;
  deviceId?: string | null;
  ended?: boolean;
}

const statements = {
  get: db.prepare<[number, number], PodcastProgressRow>(
    "SELECT * FROM podcast_progress WHERE user_id = ? AND episode_id = ?",
  ),
  episode: db.prepare<[number], { podcast_id: number; duration_seconds: number | null }>(
    "SELECT podcast_id, duration_seconds FROM podcast_episodes WHERE id = ?",
  ),
  upsert: db.prepare<{
    user_id: number;
    episode_id: number;
    position: number;
    duration: number | null;
    played: number;
    completed_at: number | null;
    listened_at: number;
    updated_at: number;
    device_id: string | null;
  }>(
    `INSERT INTO podcast_progress
       (user_id, episode_id, position_seconds, duration_seconds, played, completed_at,
        last_listened_at, updated_at, device_id)
     VALUES (@user_id, @episode_id, @position, @duration, @played, @completed_at,
        @listened_at, @updated_at, @device_id)
     ON CONFLICT (user_id, episode_id) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       duration_seconds = excluded.duration_seconds,
       played = excluded.played,
       completed_at = excluded.completed_at,
       last_listened_at = excluded.last_listened_at,
       updated_at = excluded.updated_at,
       device_id = excluded.device_id`,
  ),
  recentSession: db.prepare<[number, number, number], { id: number }>(
    `SELECT id FROM podcast_history WHERE user_id = ? AND episode_id = ? AND listened_at > ?
     ORDER BY listened_at DESC LIMIT 1`,
  ),
  addSession: db.prepare<[number, number, number, number]>(
    "INSERT INTO podcast_history (user_id, episode_id, listened_at, seconds) VALUES (?, ?, ?, ?)",
  ),
  extendSession: db.prepare<[number, number, number]>(
    "UPDATE podcast_history SET seconds = seconds + ?, listened_at = ? WHERE id = ?",
  ),
  clearPlayed: db.prepare<[number, number, number]>(
    `UPDATE podcast_progress SET played = 0, completed_at = NULL, position_seconds = 0,
       updated_at = ? WHERE user_id = ? AND episode_id = ?`,
  ),
  clearHistory: db.prepare<[number, number]>(
    "DELETE FROM podcast_history WHERE user_id = ? AND episode_id = ?",
  ),
};

export const getProgress = (userId: number, episodeId: number) =>
  statements.get.get(userId, episodeId);

const finite = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function followUp(userId: number, episodeId: number) {
  const podcastId = statements.episode.get(episodeId)?.podcast_id;
  const follow = podcastId === undefined ? undefined : getFollow(userId, podcastId);
  if (podcastId !== undefined && follow && followSettings(follow).removePlayed) {
    queueDownloads(reconcileFollow(userId, podcastId).toDownload);
  }
}

export const saveProgress = db.transaction(
  (userId: number, episodeId: number, update: ProgressUpdate, now: number = Date.now()) => {
    const episode = statements.episode.get(episodeId);
    if (!episode) return null;
    const stored = statements.get.get(userId, episodeId);
    const clientTime = Math.min(finite(update.clientTime, now), now + MAX_CLOCK_SKEW_MS);
    if (stored && clientTime < stored.updated_at) return { row: stored, applied: false };

    const duration = update.durationSeconds ?? stored?.duration_seconds ?? episode.duration_seconds;
    const position = Math.max(0, finite(update.positionSeconds));
    const reached =
      duration != null && duration > 0 && position >= duration - COMPLETE_WITHIN_SECONDS;
    const completed = update.ended === true || reached;
    const wasPlayed = stored?.played === 1;
    const played = completed || wasPlayed;

    const row = {
      user_id: userId,
      episode_id: episodeId,
      position: update.ended ? (duration ?? position) : position,
      duration: duration ?? null,
      played: played ? 1 : 0,
      completed_at: completed ? (stored?.completed_at ?? now) : (stored?.completed_at ?? null),
      listened_at: now,
      updated_at: Math.max(clientTime, stored?.updated_at ?? 0),
      device_id: update.deviceId ?? null,
    };
    statements.upsert.run(row);

    const advanced = stored ? position - stored.position_seconds : 0;
    const seconds = Math.min(MAX_SECONDS_PER_UPDATE, Math.max(0, Math.round(advanced)));
    const session = statements.recentSession.get(userId, episodeId, now - SESSION_GAP_MS);
    if (session) statements.extendSession.run(seconds, now, session.id);
    else statements.addSession.run(userId, episodeId, now, seconds);

    if (completed && !wasPlayed) followUp(userId, episodeId);
    return { row: statements.get.get(userId, episodeId)!, applied: true };
  },
);

export const markPlayed = db.transaction(
  (userId: number, episodeId: number, now: number = Date.now()) => {
    const episode = statements.episode.get(episodeId);
    if (!episode) return null;
    const stored = statements.get.get(userId, episodeId);
    const duration = stored?.duration_seconds ?? episode.duration_seconds;
    statements.upsert.run({
      user_id: userId,
      episode_id: episodeId,
      position: stored?.position_seconds ?? 0,
      duration: duration ?? null,
      played: 1,
      completed_at: stored?.completed_at ?? now,
      listened_at: stored?.last_listened_at ?? now,
      updated_at: now,
      device_id: null,
    });
    followUp(userId, episodeId);
    return statements.get.get(userId, episodeId)!;
  },
);

export const markUnplayed = db.transaction(
  (userId: number, episodeId: number, now: number = Date.now()) => {
    if (!statements.get.get(userId, episodeId)) return null;
    statements.clearPlayed.run(now, userId, episodeId);
    return statements.get.get(userId, episodeId)!;
  },
);

export const resetProgress = markUnplayed;

export const removeEpisodeHistory = (userId: number, episodeId: number) =>
  db.transaction(() => {
    statements.clearHistory.run(userId, episodeId);
    return db
      .prepare<[number, number]>(
        "DELETE FROM podcast_progress WHERE user_id = ? AND episode_id = ?",
      )
      .run(userId, episodeId).changes;
  })();
