import type { Outside } from "./music.ts";

const SHOWS = (
  [
    ["Signal and Static", "Radio Lab Co", "Technology"],
    ["The Long Weekend", "Weekend Media", "Comedy"],
    ["Cold Case Files", "True Stories", "True Crime"],
    ["Deep Time", "Earth Science Hour", "Science"],
    ["Morning Brief", "Daily News Network", "News"],
    ["Second Draft", "Writers Room", "Arts"],
    ["The Pit Wall", "Motorsport Weekly", "Sports"],
    ["Small Business, Big Ideas", "Founder FM", "Business"],
  ] as const
).map(([title, artist, genre], index) => ({
  collectionId: 9100 + index,
  collectionName: title as string,
  artistName: artist as string,
  feedUrl: `https://feeds.eden.test/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.xml`,
  artworkUrl600: "",
  genres: ["Podcasts", genre],
}));

export const applePodcasts: Outside = {
  hosts: ["itunes.apple.com"],
  respond({ url }) {
    if (url.pathname === "/search") {
      const term = (url.searchParams.get("term") ?? "").toLowerCase();
      const results = SHOWS.filter(
        (show) =>
          show.collectionName.toLowerCase().includes(term) ||
          show.artistName.toLowerCase().includes(term),
      );
      return { resultCount: results.length, results };
    }
    if (url.pathname === "/lookup") {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      const results = SHOWS.filter((show) => ids.includes(String(show.collectionId)));
      return { resultCount: results.length, results };
    }
    if (/\/rss\/toppodcasts\//.test(url.pathname)) {
      return {
        feed: {
          entry: SHOWS.map((show) => ({
            id: { attributes: { "im:id": String(show.collectionId) } },
          })),
        },
      };
    }
    return undefined;
  },
};
