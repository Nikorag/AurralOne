import { db } from "../config/db-sqlite.ts";
import { queueDownloads } from "./podcasts/downloads.ts";
import {
  followPodcast,
  releaseEpisodeDownload,
  requestEpisodeDownload,
  unfollowPodcast,
} from "./podcasts/follows.ts";
import { mediaStore } from "./podcasts/mediaStore.ts";
import { queueRefresh } from "./podcasts/refresh.ts";
import { importPodcastFeed } from "./podcasts/store.ts";
import {
  followedPodcasts,
  getEpisode,
  getPodcastView,
  listEpisodes,
  newestEpisodes,
} from "./podcasts/views.ts";
import type { EpisodeView, PodcastView } from "./podcasts/views.ts";

const MANUAL_REFRESH_GAP_MS = 30_000;
export const EPISODES_PER_CHANNEL = 100;
export const MAX_NEWEST_EPISODES = 100;

const CHANNEL_ID = /^podcast:(\d+)$/;
const EPISODE_ID = /^podcast-episode:(\d+)$/;

export const channelId = (id: number) => `podcast:${id}`;
export const episodeId = (id: number) => `podcast-episode:${id}`;

const parse = (pattern: RegExp, value: string) => {
  const id = Number(pattern.exec(value)?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export const parseChannelId = (value: string) => parse(CHANNEL_ID, value);
export const parseEpisodeId = (value: string) => parse(EPISODE_ID, value);

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : undefined);

// Every episode streams from the publisher when it isn't stored, so only an
// in-flight or failed download changes what a client can do with it.
const episodeStatus = (state: EpisodeView["download"]["state"]) => {
  if (state === "failed") return "error";
  if (state === "queued" || state === "pending" || state === "downloading") return "downloading";
  return "completed";
};

export function toPodcastEpisode(episode: EpisodeView) {
  const id = episodeId(episode.id);
  return {
    id,
    streamId: id,
    channelId: channelId(episode.podcastId),
    parent: channelId(episode.podcastId),
    isDir: false,
    isVideo: false,
    title: episode.title,
    album: episode.podcastTitle,
    artist: episode.podcastTitle,
    genre: "Podcast",
    description: episode.description,
    status: episodeStatus(episode.download.state),
    publishDate: iso(episode.publishedAt),
    year: episode.publishedAt ? new Date(episode.publishedAt).getUTCFullYear() : undefined,
    duration: episode.durationSeconds ? Math.round(episode.durationSeconds) : undefined,
    size: episode.download.bytes ?? undefined,
    coverArt: episode.imageUrl ? id : channelId(episode.podcastId),
    bookmarkPosition: episode.progress.positionSeconds
      ? Math.round(episode.progress.positionSeconds * 1000)
      : undefined,
    played: iso(episode.progress.played ? episode.progress.updatedAt : null),
    type: "podcast",
  };
}

export function toPodcastChannel(podcast: PodcastView, episodes?: EpisodeView[]) {
  return {
    id: channelId(podcast.id),
    url: podcast.feed.url ?? "",
    title: podcast.title,
    description: podcast.description,
    coverArt: podcast.imageUrl ? channelId(podcast.id) : undefined,
    originalImageUrl: podcast.imageUrl ?? undefined,
    status: podcast.feed.error ? "error" : "completed",
    errorMessage: podcast.feed.error ?? undefined,
    ...(episodes && { episode: episodes.map(toPodcastEpisode) }),
  };
}

export function getChannels(
  userId: number,
  { id, includeEpisodes }: { id?: number; includeEpisodes: boolean },
) {
  const podcasts =
    id === undefined
      ? followedPodcasts(userId)
      : [getPodcastView(userId, id)].filter((p) => p?.follow);
  return podcasts.flatMap((podcast) =>
    podcast
      ? toPodcastChannel(
          podcast,
          includeEpisodes
            ? listEpisodes(userId, podcast.id, { limit: EPISODES_PER_CHANNEL }).episodes
            : undefined,
        )
      : [],
  );
}

export const getNewestEpisodes = (userId: number, count: number) =>
  newestEpisodes(userId, Math.min(Math.max(count, 1), MAX_NEWEST_EPISODES)).map(toPodcastEpisode);

const storedAudio = db.prepare<[number, number], { path: string | null }>(
  `SELECT m.path FROM podcast_media m
   JOIN podcast_entitlements n ON n.episode_id = m.episode_id AND n.user_id = ?
   WHERE m.episode_id = ? AND m.status = 'downloaded'`,
);

export function resolvePodcastAudio(userId: number, id: number) {
  if (!getEpisode(userId, id)) return null;
  const stored = storedAudio.get(userId, id)?.path;
  return stored
    ? { kind: "file" as const, path: mediaStore.resolve(stored) }
    : { kind: "publisher" as const, episodeId: id };
}

export function podcastArtworkSource(userId: number, value: string) {
  const channel = parseChannelId(value);
  if (channel) return getPodcastView(userId, channel)?.imageUrl ?? null;
  const episode = parseEpisodeId(value);
  return (episode && getEpisode(userId, episode)?.imageUrl) || null;
}

const lastChecked = db.prepare<[number], { last_checked_at: number | null }>(
  "SELECT last_checked_at FROM podcast_sources WHERE podcast_id = ?",
);

export function refreshFollowedPodcasts(userId: number, now = Date.now()) {
  for (const podcast of followedPodcasts(userId)) {
    const last = lastChecked.get(podcast.id)?.last_checked_at;
    if (!last || now - last > MANUAL_REFRESH_GAP_MS) queueRefresh(podcast.id);
  }
}

export async function addChannel(userId: number, url: string) {
  const { podcastId } = await importPodcastFeed(url);
  queueDownloads(followPodcast(userId, podcastId).toDownload);
}

export function removeChannel(userId: number, id: number) {
  if (!getPodcastView(userId, id)?.follow) return false;
  unfollowPodcast(userId, id);
  return true;
}

export function downloadEpisode(userId: number, id: number) {
  if (!getEpisode(userId, id)) return false;
  if (requestEpisodeDownload(userId, id)) queueDownloads([id]);
  return true;
}

export function deleteEpisode(userId: number, id: number) {
  if (!getEpisode(userId, id)) return false;
  releaseEpisodeDownload(userId, id);
  return true;
}
