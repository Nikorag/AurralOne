import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, { http }, notify, refresh, follows] =
  await setupIsolatedBackend(
    "podcast-notify",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../lib/http.ts"),
    () => import("../../backend/services/podcasts/notify.ts"),
    () => import("../../backend/services/podcasts/refresh.ts"),
    () => import("../../backend/services/podcasts/follows.ts"),
    () => import("../../backend/services/notificationService.ts"),
  );

const NOW = Date.now();
const DAY = 86_400_000;

const inbox = (userId: number) =>
  dbOps
    .getInboxItems(userId, { kinds: ["podcast"] })
    .flatMap((item) => (item ? [`${item.title} | ${item.subtitle} | ${item.href}`] : []))
    .sort();

const addEpisode = (id: number, publishedAt: number | null) =>
  db
    .prepare(
      `INSERT INTO podcast_episodes (id, podcast_id, guid, title, enclosure_url, published_at, created_at)
       VALUES (?, 1, ?, ?, ?, ?, 0)`,
    )
    .run(id, `g${id}`, `Episode ${id}`, `https://cdn.example.com/${id}.mp3`, publishedAt);

beforeEach(() => {
  vi.restoreAllMocks();
  db.exec("DELETE FROM podcasts; DELETE FROM users; DELETE FROM inbox_items");
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'x'), (2, 'b', 'x'), (3, 'c', 'x');
    INSERT INTO podcasts (id, title, created_at) VALUES (1, 'The Show', 0);
    INSERT INTO podcast_sources (podcast_id, feed_url) VALUES (1, 'https://example.com/feed.xml');
    INSERT INTO podcast_follows (user_id, podcast_id, followed_at, notify) VALUES (1, 1, 0, 1), (2, 1, 0, 0);
  `);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("only followers who asked to be notified get an Inbox item for a new episode", () => {
  addEpisode(1, NOW - DAY);
  notify.notifyNewEpisodes(1, [1], NOW);
  assert.deepEqual(inbox(1), ["Episode 1 | The Show | /podcasts/1"]);
  assert.deepEqual(inbox(2), []);
  assert.deepEqual(inbox(3), []);
});

test("old episodes found by a feed backfill are not announced", () => {
  addEpisode(1, NOW - 60 * DAY);
  addEpisode(2, NOW - DAY);
  notify.notifyNewEpisodes(1, [1, 2], NOW);
  assert.deepEqual(inbox(1), ["Episode 2 | The Show | /podcasts/1"]);
});

test("a burst of new episodes becomes one Inbox item", () => {
  for (const id of [1, 2, 3, 4]) addEpisode(id, NOW - id * 1000);
  notify.notifyNewEpisodes(1, [1, 2, 3, 4], NOW);
  assert.deepEqual(inbox(1), ["4 new episodes | The Show | /podcasts/1"]);
});

test("announcing the same episode twice does not add a second item", () => {
  addEpisode(1, NOW - DAY);
  notify.notifyNewEpisodes(1, [1], NOW);
  notify.notifyNewEpisodes(1, [1], NOW + 1000);
  assert.equal(inbox(1).length, 1);
});

test("a refresh that finds a new episode notifies the follower, and a quiet one does not", async () => {
  const feed = (guids: string[]) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>The Show</title>${guids
      .map(
        (guid) =>
          `<item><title>Ep ${guid}</title><guid>${guid}</guid><pubDate>${new Date().toUTCString()}</pubDate><enclosure url="https://cdn.example.com/${guid}.mp3" type="audio/mpeg"/></item>`,
      )
      .join("")}</channel></rss>`;
  const serve = (guids: string[]) =>
    vi.spyOn(http, "get").mockResolvedValue({
      status: 200,
      statusText: "",
      headers: {},
      data: Buffer.from(feed(guids)),
    });

  serve(["a"]);
  await refresh.refreshAndReconcile(1);
  assert.equal(inbox(1).length, 1);

  await refresh.refreshAndReconcile(1);
  assert.equal(inbox(1).length, 1);

  serve(["a", "b"]);
  await refresh.refreshAndReconcile(1);
  assert.deepEqual(inbox(1), ["Ep a | The Show | /podcasts/1", "Ep b | The Show | /podcasts/1"]);
  assert.deepEqual(inbox(2), []);
});

test("the notify flag is stored per follow and can be turned on", () => {
  follows.followPodcast(3, 1);
  assert.equal(follows.getFollow(3, 1)?.notify, 0);
  follows.updateFollowSettings(3, 1, { notify: true });
  assert.equal(follows.getFollow(3, 1)?.notify, 1);
});
