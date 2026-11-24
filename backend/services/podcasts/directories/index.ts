import { itunes } from "./itunes.ts";
import { podcastIndex } from "./podcastIndex.ts";
import type { DirectoryPodcast, PodcastDirectory } from "./types.ts";

export { PODCAST_CATEGORIES } from "./types.ts";
export type { DirectoryPodcast, PodcastDirectory } from "./types.ts";

export const directories: PodcastDirectory[] = [itunes, podcastIndex];

export const availableDirectories = () => directories.filter((directory) => directory.available());

const identity = (podcast: DirectoryPodcast) =>
  podcast.feedUrl
    ? podcast.feedUrl
        .replace(/^https?:\/\//i, "")
        .replace(/\/+$/, "")
        .toLowerCase()
    : `${podcast.title}\n${podcast.publisher ?? ""}`.toLowerCase();

async function gather(load: (directory: PodcastDirectory) => Promise<DirectoryPodcast[]>) {
  const settled = await Promise.allSettled(availableDirectories().map(load));
  const seen = new Set<string>();
  const merged: DirectoryPodcast[] = [];
  const ranked = settled.map((result) => (result.status === "fulfilled" ? result.value : []));
  const longest = Math.max(0, ...ranked.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of ranked) {
      const podcast = list[index];
      if (!podcast || !podcast.feedUrl || seen.has(identity(podcast))) continue;
      seen.add(identity(podcast));
      merged.push(podcast);
    }
  }
  const failed = settled.length > 0 && settled.every((result) => result.status === "rejected");
  if (failed) throw new Error("Podcast directories are unavailable right now");
  return merged;
}

export const searchPodcasts = (term: string, limit = 25) =>
  gather((directory) => directory.search(term, limit));

export const recentPodcasts = (limit = 25) =>
  gather((directory) => directory.recent?.(limit) ?? Promise.resolve([]));

export const trendingPodcasts = (category: string | undefined, limit = 25) =>
  gather((directory) => directory.trending({ category, limit }));
