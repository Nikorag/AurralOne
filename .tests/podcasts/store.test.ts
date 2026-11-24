import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { http }, store] = await setupIsolatedBackend(
  "podcast-store",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../lib/http.ts"),
  () => import("../../backend/services/podcasts/store.ts"),
);

const rss = (items: Array<{ guid: string; url: string }>) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Show</title>
${items
  .map(
    ({ guid, url }) =>
      `<item><title>${guid}</title><guid>${guid}</guid><enclosure url="${url}" type="audio/mpeg"/></item>`,
  )
  .join("")}
</channel></rss>`;

const serve = (body: string, status = 200) =>
  vi.spyOn(http, "get").mockResolvedValue({
    status,
    statusText: "",
    headers: { etag: '"v1"' },
    data: Buffer.from(body),
  });

beforeEach(() => {
  db.exec("DELETE FROM podcasts");
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("a refresh adds only new episodes and keeps one row per guid", async () => {
  serve(rss([{ guid: "a", url: "https://cdn.example.com/a.mp3" }]));
  const first = await store.importPodcastFeed("https://example.com/feed.xml");
  assert.equal(first.newEpisodeIds.length, 1);

  serve(
    rss([
      { guid: "a", url: "https://cdn.example.com/a-moved.mp3" },
      { guid: "b", url: "https://cdn.example.com/b.mp3" },
    ]),
  );
  const refreshed = await store.refreshPodcast(first.podcastId);
  assert.equal(refreshed.newEpisodeIds.length, 1);
  assert.equal(count("podcast_episodes"), 2);
  const moved = db
    .prepare("SELECT enclosure_url AS u FROM podcast_episodes WHERE guid = 'a'")
    .get();
  assert.deepEqual(moved, { u: "https://cdn.example.com/a-moved.mp3" });
});

test("an episode whose guid changed is matched by its audio URL", async () => {
  serve(rss([{ guid: "old", url: "https://cdn.example.com/a.mp3" }]));
  const { podcastId } = await store.importPodcastFeed("https://example.com/feed.xml");
  serve(rss([{ guid: "new", url: "https://cdn.example.com/a.mp3" }]));
  const refreshed = await store.refreshPodcast(podcastId);
  assert.equal(refreshed.newEpisodeIds.length, 0);
  assert.equal(count("podcast_episodes"), 1);
});

test("the same show from another provider or scheme is not duplicated", async () => {
  serve(rss([{ guid: "a", url: "https://cdn.example.com/a.mp3" }]));
  const first = await store.importPodcastFeed("https://example.com/feed.xml", {
    name: "itunes",
    id: "1",
  });
  const sameFeed = await store.importPodcastFeed("http://example.com/feed.xml");
  const sameProvider = await store.importPodcastFeed("https://mirror.example.net/rss", {
    name: "itunes",
    id: "1",
  });
  assert.equal(sameFeed.podcastId, first.podcastId);
  assert.equal(sameProvider.podcastId, first.podcastId);
  assert.equal(count("podcasts"), 1);
});

test("a failing feed is backed off and records the error", async () => {
  serve(rss([{ guid: "a", url: "https://cdn.example.com/a.mp3" }]));
  const { podcastId } = await store.importPodcastFeed("https://example.com/feed.xml");
  serve("<html>down</html>");
  await assert.rejects(store.refreshPodcast(podcastId));
  const source = db
    .prepare("SELECT last_error AS e, failure_count AS f, next_check_at AS n FROM podcast_sources")
    .get() as { e: string; f: number; n: number };
  assert.match(source.e, /valid RSS/);
  assert.equal(source.f, 1);
  assert.ok(source.n > Date.now());
});

test("private and non-http feed URLs are refused", async () => {
  await assert.rejects(store.importPodcastFeed("http://127.0.0.1/feed.xml"), /public/i);
  await assert.rejects(store.importPodcastFeed("http://169.254.169.254/latest"), /public/i);
  await assert.rejects(store.importPodcastFeed("file:///etc/passwd"));
  assert.equal(count("podcasts"), 0);
});
