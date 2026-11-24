import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { http }, downloads, storage, settings, store] =
  await setupIsolatedBackend(
    "podcast-downloads",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../lib/http.ts"),
    () => import("../../backend/services/podcasts/downloads.ts"),
    () => import("../../backend/services/podcasts/storage.ts"),
    () => import("../../backend/services/podcasts/settings.ts"),
    () => import("../../backend/services/podcasts/mediaStore.ts"),
  );

const audio = (size: number) => {
  const bytes = Buffer.alloc(size, 1);
  bytes.write("ID3", 0, "latin1");
  return bytes;
};

const serve = (body: Buffer, contentType = "audio/mpeg", declared = true) =>
  vi.spyOn(http, "get").mockImplementation(async (_url, options) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(body));
        controller.close();
      },
    });
    return {
      status: 200,
      statusText: "",
      headers: { "content-type": contentType },
      data: await options?.consume?.(
        stream,
        new Headers(declared ? { "content-length": String(body.length) } : {}),
        200,
      ),
    };
  });

const media = (episodeId: number) =>
  db
    .prepare("SELECT status, bytes, path FROM podcast_media WHERE episode_id = ?")
    .get(episodeId) as { status: string; bytes: number | null; path: string | null } | undefined;

const addEpisode = (
  id: number,
  { entitled = true, url = `https://cdn.example.com/${id}.mp3` } = {},
) => {
  db.prepare(
    `INSERT INTO podcast_episodes (id, podcast_id, guid, title, enclosure_url, created_at)
     VALUES (?, 1, ?, 'Ep', ?, 0)`,
  ).run(id, `g${id}`, url);
  db.prepare(
    "INSERT INTO podcast_media (episode_id, status, updated_at) VALUES (?, 'pending', 0)",
  ).run(id);
  if (entitled) {
    db.prepare(
      "INSERT INTO podcast_entitlements (user_id, episode_id, created_at) VALUES (1, ?, 0)",
    ).run(id);
  }
};

beforeEach(async () => {
  vi.restoreAllMocks();
  db.exec("DELETE FROM podcasts; DELETE FROM users");
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'x'), (2, 'b', 'x');
    INSERT INTO podcasts (id, title, created_at) VALUES (1, 'Show', 0);
  `);
  settings.savePodcastSettings({ storageLimitBytes: 1024 * 1024 });
  await fs.rm(store.mediaStore.root(), { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("progress is recorded while an episode downloads and cleared when it finishes", async () => {
  addEpisode(1);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = audio(1500);
  const second = Buffer.alloc(500, 2);
  vi.spyOn(http, "get").mockImplementation(async (_url, options) => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(first));
        await gate;
        controller.enqueue(new Uint8Array(second));
        controller.close();
      },
    });
    const data = await options?.consume?.(stream, new Headers({ "content-length": "2000" }), 200);
    return { status: 200, statusText: "", headers: { "content-type": "audio/mpeg" }, data };
  });

  const finished = downloads.downloadEpisode(1);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = db.prepare("SELECT progress_bytes AS p FROM podcast_media").get() as {
      p: number | null;
    };
    if (row.p) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const during = db
    .prepare("SELECT status, progress_bytes AS p, total_bytes AS t FROM podcast_media")
    .get();
  assert.deepEqual(during, { status: "downloading", p: 1500, t: 2000 });
  release();
  assert.equal(await finished, "downloaded");
  const after = db.prepare("SELECT progress_bytes AS p, total_bytes AS t FROM podcast_media").get();
  assert.deepEqual(after, { p: null, t: null });
});

test("two simultaneous downloads of one episode fetch and store it once", async () => {
  addEpisode(1);
  const get = serve(audio(2000));
  const results = await Promise.all([downloads.downloadEpisode(1), downloads.downloadEpisode(1)]);
  assert.deepEqual(results.sort(), ["claimed", "downloaded"]);
  assert.equal(get.mock.calls.length, 1);
  assert.deepEqual(await fs.readdir(store.mediaStore.root()), ["1.mp3"]);
  assert.equal(media(1)?.status, "downloaded");
  assert.equal(media(1)?.bytes, 2000);
});

test("an episode nobody needs any more is dropped instead of downloaded", async () => {
  addEpisode(1, { entitled: false });
  const get = serve(audio(10));
  assert.equal(await downloads.downloadEpisode(1), "unneeded");
  assert.equal(get.mock.calls.length, 0);
  assert.equal(media(1), undefined);
});

test("downloads that are not audio are refused and leave no file", async () => {
  addEpisode(1);
  serve(Buffer.from("<html>sign in</html>"), "text/html");
  assert.equal(await downloads.downloadEpisode(1), "failed");
  assert.equal(media(1)?.status, "failed");
  assert.deepEqual(await fs.readdir(store.mediaStore.root()), []);
});

test("an episode larger than the space left is cut off and waits for space", async () => {
  settings.savePodcastSettings({ storageLimitBytes: 5000 });
  addEpisode(1);
  serve(audio(20_000), "audio/mpeg", false);
  assert.equal(await downloads.downloadEpisode(1), "awaiting_storage");
  assert.equal(media(1)?.status, "awaiting_storage");
  assert.deepEqual(await fs.readdir(store.mediaStore.root()), []);
});

test("a full storage limit defers the download without touching what users keep", async () => {
  settings.savePodcastSettings({ storageLimitBytes: 5000 });
  addEpisode(1);
  addEpisode(2);
  serve(audio(4000));
  assert.equal(await downloads.downloadEpisode(1), "downloaded");
  serve(audio(4000));
  assert.equal(await downloads.downloadEpisode(2), "awaiting_storage");
  assert.equal(media(1)?.status, "downloaded");
  assert.equal(media(2)?.status, "awaiting_storage");

  db.prepare("DELETE FROM podcast_entitlements WHERE episode_id = 1").run();
  db.prepare("UPDATE podcast_media SET updated_at = 0, downloaded_at = 0").run();
  assert.equal(await downloads.downloadEpisode(2), "downloaded");
  assert.equal(media(1), undefined);
  assert.deepEqual(await fs.readdir(store.mediaStore.root()), ["2.mp3"]);
});

test("cleanup keeps media another user needs or someone just played", async () => {
  addEpisode(1);
  addEpisode(2);
  addEpisode(3);
  serve(audio(100));
  for (const id of [1, 2, 3]) await downloads.downloadEpisode(id);
  db.prepare("DELETE FROM podcast_entitlements WHERE episode_id = 3").run();
  db.prepare("INSERT INTO podcast_progress (user_id, episode_id, updated_at) VALUES (2, 3, ?)").run(
    Date.now(),
  );
  db.prepare("UPDATE podcast_media SET updated_at = 0").run();

  const result = await storage.removeUnreferencedMedia();
  assert.equal(result.removed, 0);
  db.prepare("DELETE FROM podcast_progress").run();
  db.prepare("DELETE FROM podcast_entitlements WHERE episode_id = 2").run();
  assert.equal((await storage.removeUnreferencedMedia()).removed, 2);
  assert.deepEqual(await fs.readdir(store.mediaStore.root()), ["1.mp3"]);
});

test("reconciling re-queues missing files and removes strays and old partial downloads", async () => {
  addEpisode(1);
  serve(audio(100));
  await downloads.downloadEpisode(1);
  await fs.rm(store.mediaStore.resolve("1.mp3"));
  const stray = store.mediaStore.resolve("99.mp3");
  const part = store.mediaStore.resolve("98.part");
  await fs.writeFile(stray, "x");
  await fs.writeFile(part, "x");
  const old = new Date(Date.now() - 48 * 3_600_000);
  await fs.utimes(stray, old, old);
  await fs.utimes(part, old, old);

  const result = await storage.reconcileStorage();
  assert.equal(result.missing, 1);
  assert.equal(result.orphans, 2);
  assert.equal(media(1)?.status, "pending");
  assert.deepEqual(await fs.readdir(store.mediaStore.root()), []);
});

test("an enclosure on a private address is never fetched", async () => {
  addEpisode(1, { url: "http://192.168.1.10/episode.mp3" });
  await assert.rejects(downloads.downloadEpisode(1), /public/i);
  assert.equal(media(1)?.status, "failed");
});

test("files are recognised by content, not by name", () => {
  assert.equal(
    downloads.sniffAudio(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00", "latin1")),
    "mp3",
  );
  assert.equal(
    downloads.sniffAudio(Buffer.from("\x00\x00\x00\x20ftypM4A \x00\x00", "latin1")),
    "m4a",
  );
  assert.equal(
    downloads.sniffAudio(Buffer.from("OggS\x00\x02\x00\x00\x00\x00\x00\x00", "latin1")),
    "ogg",
  );
  assert.equal(downloads.sniffAudio(Buffer.from("<!DOCTYPE html>")), null);
});
