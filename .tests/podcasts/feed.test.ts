import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  parseDuration,
  parsePodcastFeed,
  PodcastFeedError,
} from "../../backend/services/podcasts/feed.ts";

const feed = (items: string) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Show &amp; Tell</title>
    <description>&lt;p&gt;About the show&lt;/p&gt;</description>
    <link>https://example.com</link>
    <language>en</language>
    <itunes:author>Some Publisher</itunes:author>
    <itunes:image href="https://example.com/art.jpg"/>
    <itunes:category text="Technology"/>
    ${items}
  </channel>
</rss>`;

test("reads show details and audio episodes from a podcast feed", () => {
  const parsed = parsePodcastFeed(
    feed(`
      <item>
        <title>One</title>
        <guid isPermaLink="false">abc-1</guid>
        <pubDate>Mon, 02 Jan 2023 10:00:00 GMT</pubDate>
        <itunes:duration>1:02:03</itunes:duration>
        <itunes:season>2</itunes:season>
        <itunes:episode>5</itunes:episode>
        <enclosure url="/audio/one.mp3" type="audio/mpeg" length="1234"/>
      </item>`),
    "https://example.com/feed.xml",
  );
  assert.equal(parsed.title, "Show & Tell");
  assert.equal(parsed.publisher, "Some Publisher");
  assert.equal(parsed.description, "About the show");
  assert.equal(parsed.imageUrl, "https://example.com/art.jpg");
  assert.deepEqual(parsed.episodes, [
    {
      guid: "abc-1",
      title: "One",
      description: "",
      publishedAt: Date.parse("2023-01-02T10:00:00Z"),
      durationSeconds: 3723,
      imageUrl: null,
      enclosureUrl: "https://example.com/audio/one.mp3",
      enclosureType: "audio/mpeg",
      enclosureBytes: 1234,
      season: 2,
      episodeNumber: 5,
    },
  ]);
});

test("skips items without playable audio and repeated guids", () => {
  const parsed = parsePodcastFeed(
    feed(`
      <item><title>Video</title><guid>v</guid><enclosure url="https://example.com/v.mp4" type="video/mp4"/></item>
      <item><title>Script</title><guid>s</guid><enclosure url="javascript:alert(1)" type="audio/mpeg"/></item>
      <item><title>Text only</title><guid>t</guid></item>
      <item><title>A</title><guid>a</guid><enclosure url="https://example.com/a.mp3" type="audio/mpeg"/></item>
      <item><title>A again</title><guid>a</guid><enclosure url="https://example.com/a2.mp3" type="audio/mpeg"/></item>`),
    "https://example.com/feed.xml",
  );
  assert.deepEqual(
    parsed.episodes.map((episode) => episode.title),
    ["A"],
  );
});

test("rejects feeds that are not usable podcasts", () => {
  assert.throws(
    () => parsePodcastFeed("<html><body>nope</body></html>", "https://e.com/"),
    PodcastFeedError,
  );
  assert.throws(() => parsePodcastFeed(feed(""), "https://e.com/"), /no audio episodes/);
});

test("reads durations as seconds, clock times, or nothing", () => {
  assert.equal(parseDuration("90"), 90);
  assert.equal(parseDuration("5:30"), 330);
  assert.equal(parseDuration("1:00:00"), 3600);
  assert.equal(parseDuration("soon"), null);
});
