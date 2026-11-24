import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { http }, chapters] = await setupIsolatedBackend(
  "podcast-chapters",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../lib/http.ts"),
  () => import("../../backend/services/podcasts/chapters.ts"),
);

const reply = (data: unknown) => ({
  status: 200,
  statusText: "",
  headers: {},
  data: Buffer.from(JSON.stringify(data)),
});

beforeEach(() => {
  vi.restoreAllMocks();
  db.exec("DELETE FROM podcasts");
  db.exec(`
    INSERT INTO podcasts (id, title, created_at) VALUES (1, 'Show', 0);
    INSERT INTO podcast_episodes (id, podcast_id, guid, title, enclosure_url, chapters_url, created_at)
      VALUES (1, 1, 'g1', 'One', 'https://cdn.example.com/1.mp3', 'https://example.com/c.json', 0),
             (2, 1, 'g2', 'Two', 'https://cdn.example.com/2.mp3', NULL, 0);
  `);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("chapters are sorted, and hidden, negative and same-second ones are dropped", () => {
  const parsed = chapters.parseChapters({
    chapters: [
      { startTime: 120 },
      { startTime: 60.9, title: "Later in that second" },
      { startTime: 0, title: "Intro" },
      { startTime: 60.2, title: "Same second" },
      { startTime: 90, title: "Hidden", toc: false },
      { startTime: -5, title: "Before the start" },
    ],
  });
  assert.deepEqual(
    parsed.map((chapter) => [chapter.startSeconds, chapter.title]),
    [
      [0, "Intro"],
      [60, "Same second"],
      [120, "Chapter 4"],
    ],
  );
  assert.deepEqual(chapters.parseChapters({ nope: true }), []);
  assert.deepEqual(chapters.parseChapters("not json"), []);
});

test("titles lose markup and only http links survive", () => {
  const [chapter] = chapters.parseChapters({
    chapters: [
      {
        startTime: 10,
        title: "<b>Clean</b>   me",
        img: "javascript:alert(1)",
        url: "https://a.example/x",
      },
    ],
  });
  assert.deepEqual(chapter, {
    startSeconds: 10,
    title: "Clean me",
    imageUrl: null,
    url: "https://a.example/x",
  });
});

test("chapters are fetched once and then served from the database", async () => {
  const get = vi.spyOn(http, "get").mockResolvedValue(
    reply({
      version: "1.2.0",
      chapters: [
        { startTime: 0, title: "Start" },
        { startTime: 30, title: "Next" },
      ],
    }),
  );
  const first = await chapters.getChapters(1);
  const second = await chapters.getChapters(1);
  assert.deepEqual(
    first.map((chapter) => chapter.title),
    ["Start", "Next"],
  );
  assert.deepEqual(second, first);
  assert.equal(get.mock.calls.length, 1);
  assert.equal(get.mock.calls[0]?.[1]?.publicOnly, true);
});

test("an episode without a chapters link never makes a request", async () => {
  const get = vi.spyOn(http, "get");
  assert.deepEqual(await chapters.getChapters(2), []);
  assert.equal(get.mock.calls.length, 0);
});

test("a broken chapters link is not retried for an hour", async () => {
  const get = vi.spyOn(http, "get").mockRejectedValue(new Error("Request timed out"));
  const now = 1_000_000;
  assert.deepEqual(await chapters.getChapters(1, now), []);
  assert.deepEqual(await chapters.getChapters(1, now + 30 * 60_000), []);
  assert.equal(get.mock.calls.length, 1);
  assert.deepEqual(await chapters.getChapters(1, now + 61 * 60_000), []);
  assert.equal(get.mock.calls.length, 2);
});
