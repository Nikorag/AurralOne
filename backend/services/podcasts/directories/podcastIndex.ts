import { createHash } from "node:crypto";
import * as v from "valibot";
import { http } from "../../../../lib/http.ts";
import createCache from "../../apiClients/simpleCache.ts";
import { getPodcastSettings } from "../settings.ts";
import { findCategory, type DirectoryPodcast, type PodcastDirectory } from "./types.ts";

const API = "https://api.podcastindex.org/api/1.0";
const cache = createCache<DirectoryPodcast[]>(3600, 200);

const feeds = v.object({
  feeds: v.array(
    v.looseObject({
      id: v.number(),
      title: v.string(),
      author: v.optional(v.nullable(v.string())),
      description: v.optional(v.nullable(v.string())),
      url: v.optional(v.nullable(v.string())),
      image: v.optional(v.nullable(v.string())),
      artwork: v.optional(v.nullable(v.string())),
      categories: v.optional(v.nullable(v.record(v.string(), v.string()))),
    }),
  ),
});

const credentials = () => {
  const { podcastIndexKey, podcastIndexSecret } = getPodcastSettings();
  return podcastIndexKey && podcastIndexSecret
    ? { key: podcastIndexKey, secret: podcastIndexSecret }
    : null;
};

const get = async (path: string, query: Record<string, string | number>) => {
  const auth = credentials();
  if (!auth) throw new Error("Podcast Index is not configured");
  const date = String(Math.floor(Date.now() / 1000));
  const { data } = await http.get(`${API}${path}`, {
    query,
    timeoutMs: 10_000,
    headers: {
      "X-Auth-Key": auth.key,
      "X-Auth-Date": date,
      Authorization: createHash("sha1").update(`${auth.key}${auth.secret}${date}`).digest("hex"),
    },
  });
  const parsed = v.safeParse(feeds, data);
  if (!parsed.success) throw new Error("Unexpected response from Podcast Index");
  return parsed.output.feeds.map((feed): DirectoryPodcast => ({
    provider: "podcastindex",
    externalId: String(feed.id),
    title: feed.title,
    publisher: feed.author || null,
    description: feed.description || null,
    imageUrl: feed.artwork || feed.image || null,
    feedUrl: feed.url || null,
    categories: Object.values(feed.categories ?? {}),
  }));
};

const cached = async (key: string, load: () => Promise<DirectoryPodcast[]>) => {
  const hit = cache.get(key);
  if (hit) return hit;
  const loaded = await load();
  cache.set(key, loaded);
  return loaded;
};

export const podcastIndex: PodcastDirectory = {
  id: "podcastindex",
  label: "Podcast Index",
  available: () => credentials() !== null,
  search: (term, limit) =>
    cached(`search:${limit}:${term.toLowerCase()}`, () =>
      get("/search/byterm", { q: term, max: limit }),
    ),
  trending: ({ category, limit }) =>
    cached(`trending:${limit}:${category ?? ""}`, () =>
      get("/podcasts/trending", {
        max: limit,
        lang: "en",
        ...(findCategory(category) && { cat: findCategory(category)?.label ?? "" }),
      }),
    ),
};
