import { parseFeed } from "@rowanmanning/feed-parser";
import { XMLParser } from "fast-xml-parser";
import { decode } from "html-entities";
import { http } from "../../../lib/http.ts";

const MAX_FEED_BYTES = 15 * 1024 ** 2;
const MAX_EPISODES = 2000;
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"]);

export class PodcastFeedError extends Error {}

export interface ParsedEpisode {
  guid: string;
  title: string;
  description: string;
  publishedAt: number | null;
  durationSeconds: number | null;
  imageUrl: string | null;
  enclosureUrl: string;
  enclosureType: string | null;
  enclosureBytes: number | null;
  season: number | null;
  episodeNumber: number | null;
  chaptersUrl: string | null;
}

export interface ParsedPodcast {
  title: string;
  publisher: string | null;
  description: string;
  imageUrl: string | null;
  language: string | null;
  websiteUrl: string | null;
  categories: string[];
  episodes: ParsedEpisode[];
}

const text = (value: unknown, max: number) =>
  decode(
    String(value ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, max);

const httpUrl = (value: unknown, base: string) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

const positiveInt = (value: unknown) => {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export function parseDuration(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(raw)) return null;
  const seconds = raw.split(":").reduce((total, part) => total * 60 + Number.parseFloat(part), 0);
  return seconds > 0 ? Math.round(seconds) : null;
}

const isAudio = (mimeType: string | null, url: string) => {
  if (mimeType?.startsWith("audio/")) return true;
  if (mimeType && mimeType !== "application/octet-stream") return false;
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.has(extension);
};

type XmlNode = Record<string, unknown>;

const asNodes = (value: unknown): XmlNode[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is XmlNode => typeof entry === "object" && entry !== null,
  );

const itunesDetails = (xml: string) => {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => name === "item",
    processEntities: false,
  });
  const parsed: unknown = parser.parse(xml);
  const [root] = asNodes(parsed);
  const [channel] = asNodes(asNodes(root?.rss)[0]?.channel);
  const items = new Map<
    string,
    {
      duration: number | null;
      season: number | null;
      episode: number | null;
      chapters: string | null;
    }
  >();
  for (const item of asNodes(channel?.item)) {
    const [enclosure] = asNodes(item.enclosure);
    const key = String(
      (asNodes(item.guid)[0]?.["#text"] ?? item.guid ?? enclosure?.["@_url"] ?? "") as string,
    ).trim();
    if (!key) continue;
    items.set(key, {
      duration: parseDuration(item["itunes:duration"]),
      season: positiveInt(item["itunes:season"]),
      episode: positiveInt(item["itunes:episode"]),
      chapters: asNodes(item["podcast:chapters"])[0]?.["@_url"]?.toString() ?? null,
    });
  }
  return { author: text(channel?.["itunes:author"], 200) || null, items };
};

export function parsePodcastFeed(xml: string, feedUrl: string): ParsedPodcast {
  let feed: ReturnType<typeof parseFeed>;
  try {
    feed = parseFeed(xml);
  } catch {
    throw new PodcastFeedError("This isn't a valid RSS feed");
  }
  const title = text(feed.title, 300);
  if (!title) throw new PodcastFeedError("The feed has no title");

  let details: ReturnType<typeof itunesDetails> | null = null;
  try {
    details = itunesDetails(xml);
  } catch {
    details = null;
  }

  const seen = new Set<string>();
  const episodes: ParsedEpisode[] = [];
  for (const item of feed.items) {
    const enclosure = item.media.find((media) => {
      const url = httpUrl(media.url, feedUrl);
      return url && media.type !== "image" && isAudio(media.mimeType ?? null, url);
    });
    const enclosureUrl = enclosure && httpUrl(enclosure.url, feedUrl);
    if (!enclosure || !enclosureUrl) continue;
    const guid = String(item.id || "").trim() || enclosureUrl;
    if (seen.has(guid)) continue;
    seen.add(guid);
    const itunes = details?.items.get(guid) ?? details?.items.get(enclosureUrl);
    episodes.push({
      guid: guid.slice(0, 500),
      title: text(item.title, 500) || "Untitled episode",
      description: text(item.description || item.content, 4000),
      publishedAt: (item.published || item.updated)?.getTime() ?? null,
      durationSeconds: itunes?.duration ?? null,
      imageUrl: httpUrl(item.image?.url, feedUrl),
      enclosureUrl,
      enclosureType: enclosure.mimeType ?? null,
      enclosureBytes: enclosure.length ?? null,
      season: itunes?.season ?? null,
      episodeNumber: itunes?.episode ?? null,
      chaptersUrl: httpUrl(itunes?.chapters, feedUrl),
    });
    if (episodes.length >= MAX_EPISODES) break;
  }
  if (!episodes.length) throw new PodcastFeedError("The feed has no audio episodes");

  return {
    title,
    publisher: details?.author || text(feed.authors[0]?.name, 200) || null,
    description: text(feed.description, 4000),
    imageUrl: httpUrl(feed.image?.url, feedUrl),
    language: text(feed.language, 20) || null,
    websiteUrl: httpUrl(feed.url, feedUrl),
    categories: [
      ...new Set(feed.categories.map((category) => text(category.label || category.term, 80))),
    ]
      .filter(Boolean)
      .slice(0, 10),
    episodes,
  };
}

export async function fetchPodcastFeed(
  url: string,
  {
    etag,
    lastModified,
    signal,
  }: { etag?: string | null; lastModified?: string | null; signal?: AbortSignal } = {},
) {
  const response = await http.get(url, {
    publicOnly: true,
    responseType: "buffer",
    maxBytes: MAX_FEED_BYTES,
    timeoutMs: 20_000,
    signal,
    okStatus: (status) => (status >= 200 && status < 300) || status === 304,
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      ...(etag && { "If-None-Match": etag }),
      ...(lastModified && { "If-Modified-Since": lastModified }),
    },
  });
  const validators = {
    etag: response.headers.etag ?? null,
    lastModified: response.headers["last-modified"] ?? null,
  };
  if (response.status === 304) return { notModified: true as const, ...validators };
  const xml = Buffer.isBuffer(response.data) ? response.data.toString("utf8") : "";
  return { notModified: false as const, podcast: parsePodcastFeed(xml, url), ...validators };
}
