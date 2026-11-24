import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { userOps, dbOps }] = await setupIsolatedBackend(
  "podcast-routes",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
);

let server: Awaited<ReturnType<typeof startServerProcess>>;
const tokens: Record<string, string> = {};

const dig = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );

async function login(username: string) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  return String(dig(await response.json(), "token"));
}

async function call(user: string, route: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/podcasts${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tokens[user]}`,
      ...(init.body && { "Content-Type": "application/json" }),
    },
  });
  const text = await response.text();
  const body: unknown = text.startsWith("{") ? JSON.parse(text) : text;
  return { status: response.status, body };
}

beforeAll(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  server = await startServerProcess();
});

afterAll(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

beforeEach(async () => {
  resetDatabase(db);
  const hash = bcrypt.hashSync("password123", 4);
  userOps.createUser("admin", hash, "admin");
  userOps.createUser("ann", hash, "user");
  userOps.createUser("ben", hash, "user");
  for (const name of ["admin", "ann", "ben"]) tokens[name] = await login(name);
  db.exec(`
    INSERT INTO podcasts (id, title, created_at) VALUES (1, 'Show', 0);
    INSERT INTO podcast_sources (podcast_id, feed_url) VALUES (1, 'https://example.com/feed.xml');
    INSERT INTO podcast_episodes (id, podcast_id, guid, title, enclosure_url, published_at, created_at)
      VALUES (1, 1, 'g1', 'One', 'https://cdn.example.com/1.mp3', 1000, 0);
  `);
});

test("signed-out requests are refused", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/podcasts/library`);
  assert.equal(response.status, 401);
});

test("feeds on private addresses are refused with a useful message", async () => {
  for (const feedUrl of [
    "http://127.0.0.1:9/feed",
    "http://localhost/feed",
    "file:///etc/passwd",
  ]) {
    const result = await call("ann", "/import", {
      method: "POST",
      body: JSON.stringify({ feedUrl }),
    });
    assert.equal(result.status, 422, feedUrl);
    assert.equal(dig(result.body, "error"), "Couldn't add this feed");
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM podcasts").get() as { n: number }).n, 1);
});

test("two users follow the same show with their own settings and progress", async () => {
  await call("ann", "/1/follow", { method: "PUT" });
  await call("ben", "/1/follow", { method: "PUT" });
  await call("ann", "/1/settings", { method: "PATCH", body: JSON.stringify({ keepLatest: 1 }) });
  await call("ann", "/episodes/1/progress", {
    method: "PUT",
    body: JSON.stringify({ positionSeconds: 42, clientTime: Date.now() }),
  });

  const ann = await call("ann", "/1");
  const ben = await call("ben", "/1");
  assert.equal(dig(ann.body, "podcast", "follow", "keepLatest"), 1);
  assert.equal(dig(ben.body, "podcast", "follow", "keepLatest"), 5);
  assert.equal(
    dig((await call("ann", "/episodes/1")).body, "episode", "progress", "positionSeconds"),
    42,
  );
  assert.equal(
    dig((await call("ben", "/episodes/1")).body, "episode", "progress", "positionSeconds"),
    0,
  );
  assert.equal(dig((await call("ben", "/history")).body, "episodes", "length"), 0);

  await call("ann", "/1/follow", { method: "DELETE" });
  assert.equal(
    dig((await call("ann", "/episodes/1")).body, "episode", "progress", "positionSeconds"),
    42,
  );
  assert.equal(dig((await call("ben", "/1")).body, "podcast", "follow", "keepLatest"), 5);
  await call("ann", "/1/follow?removeHistory=true", { method: "DELETE" });
  assert.equal(
    dig((await call("ann", "/episodes/1")).body, "episode", "progress", "positionSeconds"),
    0,
  );
});

test("a downloaded file is only served to a user who keeps that episode", async () => {
  const folder = path.join(isolatedState.dataDir, "podcasts");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(
    path.join(folder, "1.mp3"),
    Buffer.concat([Buffer.from("ID3"), Buffer.alloc(500)]),
  );
  db.exec(`
    INSERT INTO podcast_media (episode_id, status, path, bytes, updated_at)
      VALUES (1, 'downloaded', '1.mp3', 503, 0);
  `);
  await call("ann", "/episodes/1/download", { method: "POST" });

  const mine = await call("ann", "/episodes/1/audio");
  assert.equal(mine.status, 200);
  assert.equal((await call("ben", "/episodes/1/audio")).status, 404);
  assert.equal(
    dig((await call("ben", "/episodes/1")).body, "episode", "download", "state"),
    "feed",
  );
  assert.equal(
    dig((await call("ann", "/episodes/1")).body, "episode", "download", "state"),
    "downloaded",
  );

  await call("ann", "/episodes/1/download", { method: "DELETE" });
  assert.equal((await call("ann", "/episodes/1/audio")).status, 404);
});

test("podcast administration is for admins, and the limit is configurable", async () => {
  assert.equal((await call("ann", "/admin/status")).status, 403);
  assert.equal(
    (
      await call("ann", "/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ storageLimitBytes: 1 }),
      })
    ).status,
    403,
  );
  const saved = await call("admin", "/admin/settings", {
    method: "PATCH",
    body: JSON.stringify({
      storageLimitBytes: 5_000_000_000,
      podcastIndexKey: "k",
      podcastIndexSecret: "s",
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal(dig(saved.body, "storage", "limitBytes"), 5_000_000_000);
  assert.equal(dig(saved.body, "settings", "hasPodcastIndexSecret"), true);
  assert.equal(JSON.stringify(saved.body).includes('"s"'), false);
  const status = await call("admin", "/admin/status");
  assert.equal(dig(status.body, "totals", "podcasts"), 1);
});
