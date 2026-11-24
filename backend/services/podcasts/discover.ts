import { findPodcastId, normalizeFeedUrl } from "./store.ts";
import { getFollow } from "./follows.ts";
import {
  availableDirectories,
  PODCAST_CATEGORIES,
  recentPodcasts,
  searchPodcasts,
  trendingPodcasts,
  type DirectoryPodcast,
} from "./directories/index.ts";
import { followedFeedKeys, interestCategories } from "./views.ts";

export const annotate = (userId: number, podcasts: DirectoryPodcast[]) =>
  podcasts.map((podcast) => {
    let podcastId: number | undefined;
    try {
      podcastId = podcast.feedUrl
        ? findPodcastId(normalizeFeedUrl(podcast.feedUrl), {
            name: podcast.provider,
            id: podcast.externalId,
          })
        : undefined;
    } catch {
      podcastId = undefined;
    }
    return {
      ...podcast,
      podcastId: podcastId ?? null,
      following: podcastId !== undefined && getFollow(userId, podcastId) !== undefined,
    };
  });

export const directoriesAvailable = () =>
  availableDirectories().map(({ id, label }) => ({ id, label }));

export const categories = () => PODCAST_CATEGORIES.map(({ id, label }) => ({ id, label }));

export const search = async (userId: number, term: string) =>
  annotate(userId, await searchPodcasts(term));

export const trending = async (userId: number, category?: string) =>
  annotate(userId, await trendingPodcasts(category));

export const newShows = async (userId: number) => annotate(userId, await recentPodcasts(20));

export async function recommended(userId: number) {
  const interests = interestCategories(userId);
  const labels = interests.flatMap((name) =>
    PODCAST_CATEGORIES.filter(
      (category) =>
        category.label.toLowerCase() === name.toLowerCase() ||
        name.toLowerCase().includes(category.label.toLowerCase()),
    ).map((category) => category.id),
  );
  const picked = [...new Set(labels)].slice(0, 2);
  const lists = await Promise.allSettled(picked.map((category) => trendingPodcasts(category, 15)));
  const known = followedFeedKeys(userId);
  const seen = new Set<string>();
  const results: DirectoryPodcast[] = [];
  const longest = Math.max(
    0,
    ...lists.map((list) => (list.status === "fulfilled" ? list.value.length : 0)),
  );
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const podcast = list.status === "fulfilled" ? list.value[index] : undefined;
      if (!podcast?.feedUrl) continue;
      const feedKey = podcast.feedUrl
        .replace(/^https?:\/\//i, "")
        .replace(/\/+$/, "")
        .toLowerCase();
      if (
        known.feeds.has(feedKey) ||
        known.providers.has(`${podcast.provider}:${podcast.externalId}`)
      )
        continue;
      if (seen.has(feedKey)) continue;
      seen.add(feedKey);
      results.push(podcast);
    }
  }
  return { interests, podcasts: annotate(userId, results.slice(0, 16)) };
}
