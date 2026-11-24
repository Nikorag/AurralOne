import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, follows, views] = await setupIsolatedBackend(
  "podcast-follows",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/podcasts/follows.ts"),
  () => import("../../backend/services/podcasts/views.ts"),
);

const EPISODES = 10;

beforeEach(() => {
  db.exec("DELETE FROM podcasts; DELETE FROM users");
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'x'), (2, 'b', 'x');
    INSERT INTO podcasts (id, title, created_at) VALUES (1, 'Show', 0);
  `);
  const insert = db.prepare(
    `INSERT INTO podcast_episodes (id, podcast_id, guid, title, enclosure_url, published_at, created_at)
     VALUES (?, 1, ?, ?, ?, ?, 0)`,
  );
  for (let id = 1; id <= EPISODES; id += 1) {
    insert.run(id, `g${id}`, `Ep ${id}`, `https://cdn.example.com/${id}.mp3`, id * 1000);
  }
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const entitled = (userId: number) =>
  db
    .prepare<[number], { episode_id: number }>(
      "SELECT episode_id FROM podcast_entitlements WHERE user_id = ? ORDER BY episode_id DESC",
    )
    .all(userId)
    .map((row) => row.episode_id);

const mediaCount = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM podcast_media").get() as { n: number }).n;

test("followers keep their own number of latest episodes over one shared set of media", () => {
  follows.followPodcast(1, 1);
  follows.followPodcast(2, 1);
  follows.updateFollowSettings(1, 1, { keepLatest: 2 });
  follows.updateFollowSettings(2, 1, { keepLatest: 5 });

  assert.deepEqual(entitled(1), [10, 9]);
  assert.deepEqual(entitled(2), [10, 9, 8, 7, 6]);
  assert.equal(mediaCount(), 5);
});

test("lowering retention releases episodes and raising it asks for more", () => {
  follows.followPodcast(1, 1);
  assert.deepEqual(entitled(1), [10, 9, 8, 7, 6]);
  follows.updateFollowSettings(1, 1, { keepLatest: 1 });
  assert.deepEqual(entitled(1), [10]);
  const raised = follows.updateFollowSettings(1, 1, { keepLatest: 3 });
  assert.deepEqual(entitled(1), [10, 9, 8]);
  assert.deepEqual(
    raised?.toDownload.sort((a, b) => a - b),
    [8, 9, 10],
  );
});

test("manual-only follows download nothing until asked, and asked episodes stay", () => {
  follows.followPodcast(1, 1);
  follows.updateFollowSettings(1, 1, { autoDownload: false });
  assert.deepEqual(entitled(1), []);

  follows.requestEpisodeDownload(1, 2);
  follows.updateFollowSettings(1, 1, { keepLatest: 1 });
  assert.deepEqual(entitled(1), [2]);
  assert.equal(follows.releaseEpisodeDownload(1, 2), true);
  assert.deepEqual(entitled(1), []);
});

test("a manual request upgrades an episode that retention would have released", () => {
  follows.followPodcast(1, 1);
  follows.requestEpisodeDownload(1, 10);
  follows.updateFollowSettings(1, 1, { autoDownload: false });
  assert.deepEqual(entitled(1), [10]);
});

test("played episodes are released when the follow removes played ones", () => {
  follows.followPodcast(1, 1);
  db.prepare(
    "INSERT INTO podcast_progress (user_id, episode_id, played, updated_at) VALUES (1, 10, 1, 0)",
  ).run();
  follows.updateFollowSettings(1, 1, { removePlayed: true });
  assert.deepEqual(entitled(1), [9, 8, 7, 6]);
});

test("unfollowing releases only that user's episodes and keeps their history", () => {
  follows.followPodcast(1, 1);
  follows.followPodcast(2, 1);
  db.prepare(
    "INSERT INTO podcast_progress (user_id, episode_id, position_seconds, updated_at) VALUES (1, 10, 30, 0)",
  ).run();

  follows.unfollowPodcast(1, 1);
  assert.deepEqual(entitled(1), []);
  assert.deepEqual(entitled(2), [10, 9, 8, 7, 6]);
  assert.equal(mediaCount(), 5);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM podcast_progress").get() as { n: number }).n,
    1,
  );

  follows.followPodcast(1, 1);
  follows.unfollowPodcast(1, 1, { removeHistory: true });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM podcast_progress").get() as { n: number }).n,
    0,
  );
});

test("following twice does not duplicate anything", () => {
  follows.followPodcast(1, 1);
  follows.followPodcast(1, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM podcast_follows").get() as { n: number }).n,
    1,
  );
  assert.equal(entitled(1).length, 5);
});

test("downloads in progress are listed for the user who keeps them, and a failed one can be retried", () => {
  follows.followPodcast(1, 1);
  db.prepare("UPDATE podcast_media SET status = 'downloading' WHERE episode_id = 10").run();
  db.prepare(
    "UPDATE podcast_media SET status = 'failed', error = 'Reset' WHERE episode_id = 9",
  ).run();
  db.prepare("UPDATE podcast_media SET status = 'downloaded' WHERE episode_id = 8").run();

  const mine = views.activeDownloads(1);
  assert.deepEqual(
    mine.map((item) => [item.episodeId, item.state, item.error]),
    [
      [10, "downloading", null],
      [7, "pending", null],
      [6, "pending", null],
      [9, "failed", "Reset"],
    ],
  );
  assert.deepEqual(views.activeDownloads(2), []);

  assert.equal(follows.requestEpisodeDownload(1, 9), true);
  assert.equal(follows.requestEpisodeDownload(1, 10), false);
});
