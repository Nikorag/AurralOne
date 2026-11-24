import * as v from "valibot";
import { http } from "../../../../lib/http.ts";
import createCache from "../../apiClients/simpleCache.ts";
import { findCategory, type DirectoryPodcast, type PodcastDirectory } from "./types.ts";

const cache = createCache<DirectoryPodcast[]>(3600, 200);

const lookupResult = v.object({
  results: v.array(
    v.looseObject({
      collectionId: v.number(),
      collectionName: v.string(),
      artistName: v.optional(v.string()),
      feedUrl: v.optional(v.string()),
      artworkUrl600: v.optional(v.string()),
      artworkUrl100: v.optional(v.string()),
      genres: v.optional(v.array(v.string())),
    }),
  ),
});

const topResult = v.object({
  feed: v.object({
    entry: v.optional(
      v.array(v.object({ id: v.object({ attributes: v.object({ "im:id": v.string() }) }) })),
    ),
  }),
});

const parse = <T extends v.GenericSchema>(schema: T, data: unknown) => {
  const result = v.safeParse(schema, data);
  if (!result.success) throw new Error("Unexpected response from the iTunes directory");
  return result.output;
};

const toPodcasts = (data: unknown): DirectoryPodcast[] =>
  parse(lookupResult, data).results.map((entry) => ({
    provider: "itunes",
    externalId: String(entry.collectionId),
    title: entry.collectionName,
    publisher: entry.artistName ?? null,
    description: null,
    imageUrl: entry.artworkUrl600 ?? entry.artworkUrl100 ?? null,
    feedUrl: entry.feedUrl ?? null,
    categories: (entry.genres ?? []).filter((genre) => genre !== "Podcasts"),
  }));

const cached = async (key: string, load: () => Promise<DirectoryPodcast[]>) => {
  const hit = cache.get(key);
  if (hit) return hit;
  const loaded = await load();
  cache.set(key, loaded);
  return loaded;
};

const json = async (url: string, query?: Record<string, string | number>) =>
  (await http.get(url, { query, timeoutMs: 10_000 })).data;

export const itunes: PodcastDirectory = {
  id: "itunes",
  label: "Apple Podcasts",
  available: () => true,
  search: (term, limit) =>
    cached(`search:${limit}:${term.toLowerCase()}`, async () =>
      toPodcasts(await json("https://itunes.apple.com/search", { media: "podcast", term, limit })),
    ),
  trending: ({ category, limit }) =>
    cached(`top:${limit}:${category ?? ""}`, async () => {
      const genre = findCategory(category)?.itunes;
      const top = parse(
        topResult,
        await json(
          `https://itunes.apple.com/us/rss/toppodcasts/limit=${limit}${genre ? `/genre=${genre}` : ""}/json`,
        ),
      );
      const ids = (top.feed.entry ?? []).map((entry) => entry.id.attributes["im:id"]);
      if (!ids.length) return [];
      const found = toPodcasts(
        await json("https://itunes.apple.com/lookup", { id: ids.join(",") }),
      );
      return ids.flatMap((id) => found.filter((podcast) => podcast.externalId === id));
    }),
};
