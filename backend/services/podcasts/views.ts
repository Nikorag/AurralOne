import { db } from "../../config/db-sqlite.ts";

export type EpisodeFilter = "all" | "unplayed" | "played" | "in_progress" | "downloaded";
export type EpisodeSort = "newest" | "oldest";

export const EPISODE_FILTERS: readonly EpisodeFilter[] = [
  "all",
  "unplayed",
  "played",
  "in_progress",
  "downloaded",
];

interface EpisodeRow {
  id: number;
  podcast_id: number;
  podcast_title: string;
  podcast_image_url: string | null;
  title: string;
  description: string | null;
  published_at: number | null;
  duration_seconds: number | null;
  image_url: string | null;
  enclosure_url: string;
  season: number | null;
  episode_number: number | null;
  position_seconds: number | null;
  progress_duration: number | null;
  played: number | null;
  progress_updated_at: number | null;
  last_listened_at: number | null;
  media_status: string | null;
  media_bytes: number | null;
  entitlement: string | null;
}

export type DownloadState =
  | "feed"
  | "pending"
  | "queued"
  | "downloading"
  | "downloaded"
  | "failed"
  | "awaiting_storage";

const SELECT = `
  SELECT e.id, e.podcast_id, p.title AS podcast_title, p.image_url AS podcast_image_url,
    e.title, e.description, e.published_at, e.duration_seconds, e.image_url, e.enclosure_url,
    e.season, e.episode_number,
    g.position_seconds, g.duration_seconds AS progress_duration, g.played,
    g.updated_at AS progress_updated_at, g.last_listened_at,
    m.status AS media_status, m.bytes AS media_bytes, n.reason AS entitlement
  FROM podcast_episodes e
  JOIN podcasts p ON p.id = e.podcast_id
  LEFT JOIN podcast_progress g ON g.episode_id = e.id AND g.user_id = @user
  LEFT JOIN podcast_media m ON m.episode_id = e.id
  LEFT JOIN podcast_entitlements n ON n.episode_id = e.id AND n.user_id = @user`;

const FILTER_SQL: Record<EpisodeFilter, string> = {
  all: "1",
  unplayed: "COALESCE(g.played, 0) = 0",
  played: "g.played = 1",
  in_progress: "COALESCE(g.played, 0) = 0 AND COALESCE(g.position_seconds, 0) > 0",
  downloaded: "n.episode_id IS NOT NULL AND m.status = 'downloaded'",
};

const downloadState = (row: EpisodeRow): DownloadState => {
  if (!row.entitlement || !row.media_status) return "feed";
  return row.media_status as DownloadState;
};

export const toEpisode = (row: EpisodeRow) => {
  const state = downloadState(row);
  return {
    id: row.id,
    podcastId: row.podcast_id,
    podcastTitle: row.podcast_title,
    title: row.title,
    description: row.description ?? "",
    publishedAt: row.published_at,
    durationSeconds: row.progress_duration ?? row.duration_seconds,
    imageUrl: row.image_url ?? row.podcast_image_url,
    season: row.season,
    episodeNumber: row.episode_number,
    audioUrl:
      state === "downloaded"
        ? `/api/podcasts/episodes/${row.id}/audio`
        : row.enclosure_url.replace(/^http:\/\//i, "https://"),
    download: { state, bytes: state === "downloaded" ? row.media_bytes : null },
    progress: {
      positionSeconds: row.position_seconds ?? 0,
      played: row.played === 1,
      updatedAt: row.progress_updated_at ?? 0,
      lastListenedAt: row.last_listened_at,
    },
  };
};

export type EpisodeView = ReturnType<typeof toEpisode>;

export function listEpisodes(
  userId: number,
  podcastId: number,
  {
    filter = "all",
    sort = "newest",
    limit = 30,
    offset = 0,
  }: { filter?: EpisodeFilter; sort?: EpisodeSort; limit?: number; offset?: number } = {},
) {
  const order = sort === "oldest" ? "ASC" : "DESC";
  const rows = db
    .prepare<{ user: number; podcast: number; limit: number; offset: number }, EpisodeRow>(
      `${SELECT} WHERE e.podcast_id = @podcast AND ${FILTER_SQL[filter]}
       ORDER BY e.published_at ${order}, e.id ${order} LIMIT @limit OFFSET @offset`,
    )
    .all({ user: userId, podcast: podcastId, limit: limit + 1, offset });
  return { episodes: rows.slice(0, limit).map(toEpisode), hasMore: rows.length > limit };
}

export function getEpisode(userId: number, episodeId: number) {
  const row = db
    .prepare<{ user: number; id: number }, EpisodeRow>(`${SELECT} WHERE e.id = @id`)
    .get({ user: userId, id: episodeId });
  return row ? toEpisode(row) : null;
}

export const getEpisodes = (userId: number, episodeIds: number[]) =>
  episodeIds.flatMap((id) => getEpisode(userId, id) ?? []);

export function continueListening(userId: number, limit = 10) {
  return db
    .prepare<{ user: number; limit: number }, EpisodeRow>(
      `${SELECT} WHERE g.user_id = @user AND g.played = 0 AND g.position_seconds > 5
       ORDER BY g.last_listened_at DESC LIMIT @limit`,
    )
    .all({ user: userId, limit })
    .map(toEpisode);
}

export function newEpisodes(userId: number, { days = 30, limit = 20 } = {}) {
  return db
    .prepare<{ user: number; since: number; limit: number }, EpisodeRow>(
      `${SELECT}
       WHERE e.podcast_id IN (SELECT podcast_id FROM podcast_follows WHERE user_id = @user)
         AND COALESCE(g.played, 0) = 0 AND e.published_at >= @since
       ORDER BY e.published_at DESC LIMIT @limit`,
    )
    .all({ user: userId, since: Date.now() - days * 86_400_000, limit })
    .map(toEpisode);
}

export function listeningHistory(userId: number, { limit = 30, offset = 0 } = {}) {
  const rows = db
    .prepare<{ user: number; limit: number; offset: number }, EpisodeRow>(
      `${SELECT} WHERE g.user_id = @user AND g.last_listened_at IS NOT NULL
       ORDER BY g.last_listened_at DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ user: userId, limit: limit + 1, offset });
  return { episodes: rows.slice(0, limit).map(toEpisode), hasMore: rows.length > limit };
}

interface PodcastRow {
  id: number;
  title: string;
  publisher: string | null;
  description: string | null;
  image_url: string | null;
  categories: string | null;
  website_url: string | null;
  followed_at: number | null;
  keep_latest: number | null;
  auto_download: number | null;
  remove_played: number | null;
  feed_url: string | null;
  last_success_at: number | null;
  last_error: string | null;
  episode_count: number;
  unplayed: number;
}

const PODCAST_SELECT = `
  SELECT p.id, p.title, p.publisher, p.description, p.image_url, p.categories, p.website_url,
    f.followed_at, f.keep_latest, f.auto_download, f.remove_played,
    s.feed_url, s.last_success_at, s.last_error,
    (SELECT COUNT(*) FROM podcast_episodes WHERE podcast_id = p.id) AS episode_count,
    (SELECT COUNT(*) FROM (
       SELECT e.id FROM podcast_episodes e
       LEFT JOIN podcast_progress g ON g.episode_id = e.id AND g.user_id = @user
       WHERE e.podcast_id = p.id AND COALESCE(g.played, 0) = 0
       ORDER BY e.published_at DESC LIMIT 10)) AS unplayed
  FROM podcasts p
  LEFT JOIN podcast_follows f ON f.podcast_id = p.id AND f.user_id = @user
  LEFT JOIN podcast_sources s ON s.podcast_id = p.id`;

const parseCategories = (value: string | null): string[] => {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const toPodcast = (row: PodcastRow) => ({
  id: row.id,
  title: row.title,
  publisher: row.publisher,
  description: row.description ?? "",
  imageUrl: row.image_url,
  categories: parseCategories(row.categories),
  websiteUrl: row.website_url,
  episodeCount: row.episode_count,
  unplayed: row.unplayed,
  feed: { url: row.feed_url, lastSuccessAt: row.last_success_at, error: row.last_error },
  follow:
    row.followed_at === null
      ? null
      : {
          followedAt: row.followed_at,
          keepLatest: row.keep_latest ?? 5,
          autoDownload: row.auto_download === 1,
          removePlayed: row.remove_played === 1,
        },
});

export type PodcastView = ReturnType<typeof toPodcast>;

export function getPodcastView(userId: number, podcastId: number) {
  const row = db
    .prepare<{ user: number; id: number }, PodcastRow>(`${PODCAST_SELECT} WHERE p.id = @id`)
    .get({ user: userId, id: podcastId });
  return row ? toPodcast(row) : null;
}

export const followedPodcasts = (userId: number) =>
  db
    .prepare<{ user: number }, PodcastRow>(
      `${PODCAST_SELECT} WHERE f.user_id = @user ORDER BY
         (SELECT MAX(published_at) FROM podcast_episodes WHERE podcast_id = p.id) DESC`,
    )
    .all({ user: userId })
    .map(toPodcast);

export const recentlyPlayedPodcasts = (userId: number, limit = 10) =>
  db
    .prepare<{ user: number; limit: number }, PodcastRow>(
      `${PODCAST_SELECT}
       WHERE p.id IN (SELECT e.podcast_id FROM podcast_progress g
         JOIN podcast_episodes e ON e.id = g.episode_id WHERE g.user_id = @user)
       ORDER BY (SELECT MAX(g.last_listened_at) FROM podcast_progress g
         JOIN podcast_episodes e ON e.id = g.episode_id
         WHERE g.user_id = @user AND e.podcast_id = p.id) DESC LIMIT @limit`,
    )
    .all({ user: userId, limit })
    .map(toPodcast);

export function interestCategories(userId: number, limit = 3) {
  const weights = new Map<string, number>();
  const add = (categories: string | null, weight: number) => {
    for (const category of parseCategories(categories)) {
      weights.set(category, (weights.get(category) ?? 0) + weight);
    }
  };
  for (const row of db
    .prepare<[number], { categories: string | null }>(
      `SELECT p.categories FROM podcast_follows f JOIN podcasts p ON p.id = f.podcast_id
       WHERE f.user_id = ?`,
    )
    .all(userId)) {
    add(row.categories, 2);
  }
  for (const row of db
    .prepare<[number], { categories: string | null; plays: number }>(
      `SELECT p.categories, COUNT(*) AS plays FROM podcast_progress g
       JOIN podcast_episodes e ON e.id = g.episode_id JOIN podcasts p ON p.id = e.podcast_id
       WHERE g.user_id = ? GROUP BY p.id`,
    )
    .all(userId)) {
    add(row.categories, Math.min(row.plays, 10) * 0.3);
  }
  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([category]) => category);
}

export const followedFeedKeys = (userId: number) => {
  const feeds = new Set<string>();
  const providers = new Set<string>();
  for (const row of db
    .prepare<[number], { feed_url: string }>(
      `SELECT s.feed_url FROM podcast_follows f JOIN podcast_sources s ON s.podcast_id = f.podcast_id
       WHERE f.user_id = ?`,
    )
    .all(userId)) {
    feeds.add(
      row.feed_url
        .replace(/^https?:\/\//i, "")
        .replace(/\/+$/, "")
        .toLowerCase(),
    );
  }
  for (const row of db
    .prepare<[number], { provider: string; external_id: string }>(
      `SELECT i.provider, i.external_id FROM podcast_follows f
       JOIN podcast_provider_ids i ON i.podcast_id = f.podcast_id WHERE f.user_id = ?`,
    )
    .all(userId)) {
    providers.add(`${row.provider}:${row.external_id}`);
  }
  return { feeds, providers };
};
