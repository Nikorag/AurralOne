import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, progress, views, follows] = await setupIsolatedBackend(
  "podcast-progress",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/podcasts/progress.ts"),
  () => import("../../backend/services/podcasts/views.ts"),
  () => import("../../backend/services/podcasts/follows.ts"),
);

const NOW = 1_700_000_000_000;

beforeEach(() => {
  db.exec("DELETE FROM podcasts; DELETE FROM users");
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'x'), (2, 'b', 'x');
    INSERT INTO podcasts (id, title, created_at) VALUES (1, 'Show', 0);
  `);
  const insert = db.prepare(
    `INSERT INTO podcast_episodes
       (id, podcast_id, guid, title, enclosure_url, published_at, duration_seconds, created_at)
     VALUES (?, 1, ?, ?, ?, ?, 600, 0)`,
  );
  for (let id = 1; id <= 4; id += 1) {
    insert.run(id, `g${id}`, `Ep ${id}`, `https://cdn.example.com/${id}.mp3`, id * 1000);
  }
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const position = (userId: number, episodeId: number) =>
  progress.getProgress(userId, episodeId)?.position_seconds;

test("progress is saved per user and read back to resume", () => {
  progress.saveProgress(1, 1, { positionSeconds: 120, clientTime: NOW }, NOW);
  assert.equal(position(1, 1), 120);
  assert.equal(position(2, 1), undefined);
});

test("an older update from another device does not overwrite newer progress", () => {
  progress.saveProgress(
    1,
    1,
    { positionSeconds: 300, clientTime: NOW + 2000, deviceId: "phone" },
    NOW + 2000,
  );
  const stale = progress.saveProgress(
    1,
    1,
    { positionSeconds: 50, clientTime: NOW + 1000, deviceId: "laptop" },
    NOW + 3000,
  );
  assert.equal(stale?.applied, false);
  assert.equal(stale?.row.position_seconds, 300);
  const newer = progress.saveProgress(
    1,
    1,
    { positionSeconds: 400, clientTime: NOW + 4000, deviceId: "laptop" },
    NOW + 4000,
  );
  assert.equal(newer?.applied, true);
  assert.equal(position(1, 1), 400);
});

test("a client clock far in the future cannot lock out later updates", () => {
  progress.saveProgress(1, 1, { positionSeconds: 10, clientTime: NOW + 10 * 86_400_000 }, NOW);
  const stored = progress.getProgress(1, 1);
  assert.ok((stored?.updated_at ?? 0) <= NOW + 5 * 60_000);
  const later = progress.saveProgress(
    1,
    1,
    { positionSeconds: 20, clientTime: NOW + 6 * 60_000 },
    NOW + 6 * 60_000,
  );
  assert.equal(later?.applied, true);
});

test("reaching the end, or the last seconds, completes the episode", () => {
  progress.saveProgress(1, 1, { positionSeconds: 580, clientTime: NOW }, NOW);
  assert.equal(progress.getProgress(1, 1)?.played, 1);
  progress.saveProgress(1, 2, { positionSeconds: 100, clientTime: NOW, ended: true }, NOW);
  assert.equal(progress.getProgress(1, 2)?.played, 1);
  assert.equal(progress.getProgress(1, 2)?.position_seconds, 600);
  progress.saveProgress(1, 3, { positionSeconds: 100, clientTime: NOW }, NOW);
  assert.equal(progress.getProgress(1, 3)?.played, 0);
});

test("episodes can be marked played, unplayed and reset", () => {
  progress.saveProgress(1, 1, { positionSeconds: 100, clientTime: NOW }, NOW);
  progress.markPlayed(1, 1, NOW + 1);
  assert.equal(progress.getProgress(1, 1)?.played, 1);
  progress.markUnplayed(1, 1, NOW + 2);
  assert.deepEqual(
    [progress.getProgress(1, 1)?.played, progress.getProgress(1, 1)?.position_seconds],
    [0, 0],
  );
  progress.markPlayed(1, 4, NOW);
  assert.equal(progress.getProgress(1, 4)?.played, 1);
});

test("listening in one sitting is one history entry that grows", () => {
  const history = () =>
    db.prepare("SELECT COUNT(*) AS n, MAX(seconds) AS s FROM podcast_history").get() as {
      n: number;
      s: number;
    };
  progress.saveProgress(1, 1, { positionSeconds: 10, clientTime: NOW }, NOW);
  progress.saveProgress(1, 1, { positionSeconds: 40, clientTime: NOW + 30_000 }, NOW + 30_000);
  progress.saveProgress(1, 1, { positionSeconds: 70, clientTime: NOW + 60_000 }, NOW + 60_000);
  assert.deepEqual(history(), { n: 1, s: 60 });
  progress.saveProgress(
    1,
    1,
    { positionSeconds: 80, clientTime: NOW + 3 * 3_600_000 },
    NOW + 3 * 3_600_000,
  );
  assert.equal(history().n, 2);
});

test("finishing an episode releases it when the follow removes played ones", () => {
  follows.followPodcast(1, 1);
  follows.updateFollowSettings(1, 1, { removePlayed: true });
  const entitled = () =>
    (
      db.prepare("SELECT COUNT(*) AS n FROM podcast_entitlements WHERE episode_id = 4").get() as {
        n: number;
      }
    ).n;
  assert.equal(entitled(), 1);
  progress.saveProgress(1, 4, { positionSeconds: 600, clientTime: NOW, ended: true }, NOW);
  assert.equal(entitled(), 0);
});

test("episode lists filter by state and say what is on the server", () => {
  follows.followPodcast(1, 1);
  db.prepare("UPDATE podcast_media SET status = 'downloaded', bytes = 5, path = 'x.mp3'").run();
  db.prepare(
    "INSERT INTO podcast_entitlements (user_id, episode_id, created_at) VALUES (2, 1, 0)",
  ).run();
  progress.markPlayed(1, 4, NOW);
  progress.saveProgress(1, 3, { positionSeconds: 60, clientTime: NOW }, NOW);

  const ids = (filter: Parameters<typeof views.listEpisodes>[2] extends infer O ? O : never) =>
    views.listEpisodes(1, 1, filter).episodes.map((episode) => episode.id);
  assert.deepEqual(ids({ filter: "played" }), [4]);
  assert.deepEqual(ids({ filter: "in_progress" }), [3]);
  assert.deepEqual(ids({ filter: "unplayed" }), [3, 2, 1]);
  assert.deepEqual(ids({ filter: "all", sort: "oldest" }), [1, 2, 3, 4]);

  const mine = views.getEpisode(1, 2);
  assert.equal(mine?.download.state, "downloaded");
  assert.equal(mine?.audioUrl, "/api/podcasts/episodes/2/audio");
  const theirs = views.getEpisode(1, 1);
  assert.equal(theirs?.download.state, "downloaded");
  const other = views.getEpisode(2, 2);
  assert.equal(other?.download.state, "feed");
  assert.equal(other?.audioUrl, "https://cdn.example.com/2.mp3");
});

test("history and continue-listening read from progress, not from downloaded files", () => {
  progress.saveProgress(1, 3, { positionSeconds: 60, clientTime: NOW }, NOW);
  progress.saveProgress(1, 2, { positionSeconds: 90, clientTime: NOW + 1000 }, NOW + 1000);
  assert.deepEqual(
    views.continueListening(1).map((episode) => episode.id),
    [2, 3],
  );
  assert.deepEqual(
    views.listeningHistory(1).episodes.map((episode) => episode.id),
    [2, 3],
  );
  assert.equal(views.continueListening(2).length, 0);
});
