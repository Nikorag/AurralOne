import { formatDate } from "../../utils/dateTime.ts";
import type { PodcastEpisode } from "../../hooks/usePodcasts.ts";

const DAY_MS = 86_400_000;

export function formatLength(seconds: number | null | undefined) {
  if (!seconds || seconds < 60) return seconds ? "1 min" : "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

export function formatBytes(bytes: number | null | undefined) {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatPublished(timestamp: number | null) {
  if (!timestamp) return "";
  const age = Date.now() - timestamp;
  if (age >= 0 && age < DAY_MS) return "Today";
  if (age >= 0 && age < 2 * DAY_MS) return "Yesterday";
  const date = new Date(timestamp);
  return formatDate(date, {
    month: "short",
    day: "numeric",
    ...(age > 300 * DAY_MS && { year: "numeric" }),
  });
}

export function episodeProgress(episode: PodcastEpisode) {
  const { positionSeconds, played } = episode.progress;
  const duration = episode.durationSeconds ?? 0;
  const fraction = duration > 0 ? Math.min(1, positionSeconds / duration) : 0;
  const started = !played && positionSeconds > 5;
  const remaining = started && duration > 0 ? Math.max(0, duration - positionSeconds) : 0;
  return { fraction, started, played, remaining };
}

export const isNewEpisode = (episode: PodcastEpisode) =>
  !episode.progress.played &&
  episode.progress.positionSeconds < 5 &&
  episode.publishedAt !== null &&
  Date.now() - episode.publishedAt < 7 * DAY_MS;

export const DOWNLOAD_LABELS = {
  feed: "",
  pending: "Queued",
  queued: "Queued",
  downloading: "Downloading",
  downloaded: "On server",
  failed: "Download failed",
  awaiting_storage: "Waiting for storage",
} as const;
