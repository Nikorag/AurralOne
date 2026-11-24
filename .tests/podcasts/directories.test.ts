import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { http }, directories, settings] = await setupIsolatedBackend(
  "podcast-directories",
  () => import("../../lib/http.ts"),
  () => import("../../backend/services/podcasts/directories/index.ts"),
  () => import("../../backend/services/podcasts/settings.ts"),
);

const reply = (data: unknown) => ({ status: 200, statusText: "", headers: {}, data });

const itunesSearch = {
  results: [
    {
      collectionId: 1,
      collectionName: "Shared Show",
      artistName: "Apple Pub",
      feedUrl: "https://example.com/feed.xml",
      artworkUrl600: "https://img/1.jpg",
      genres: ["Podcasts", "Technology"],
    },
    { collectionId: 2, collectionName: "No Feed" },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  settings.savePodcastSettings({ podcastIndexKey: "", podcastIndexSecret: "" });
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("iTunes results are normalised and feedless ones are dropped", async () => {
  vi.spyOn(http, "get").mockResolvedValue(reply(itunesSearch));
  const results = await directories.searchPodcasts("itunes-only");
  assert.deepEqual(results, [
    {
      provider: "itunes",
      externalId: "1",
      title: "Shared Show",
      publisher: "Apple Pub",
      description: null,
      imageUrl: "https://img/1.jpg",
      feedUrl: "https://example.com/feed.xml",
      categories: ["Technology"],
    },
  ]);
});

test("Apple's JSON arrives as text because it is served as text/javascript", async () => {
  vi.spyOn(http, "get").mockResolvedValue(reply(JSON.stringify(itunesSearch)));
  const results = await directories.searchPodcasts("served-as-text");
  assert.deepEqual(
    results.map((podcast) => podcast.title),
    ["Shared Show"],
  );
});

test("Podcast Index is only used once configured, and signs each request", async () => {
  const get = vi.spyOn(http, "get").mockImplementation((url) =>
    Promise.resolve(
      reply(
        url.includes("podcastindex")
          ? {
              feeds: [
                { id: 9, title: "Shared Show", url: "https://example.com/feed.xml/" },
                { id: 10, title: "Other", url: "https://other.example/rss", author: "Them" },
              ],
            }
          : itunesSearch,
      ),
    ),
  );
  await directories.searchPodcasts("before-config");
  assert.equal(get.mock.calls.filter(([url]) => url.includes("podcastindex")).length, 0);

  settings.savePodcastSettings({ podcastIndexKey: "key", podcastIndexSecret: "secret" });
  const results = await directories.searchPodcasts("merged");
  assert.deepEqual(
    results.map((podcast) => [podcast.provider, podcast.title]),
    [
      ["itunes", "Shared Show"],
      ["podcastindex", "Other"],
    ],
  );
  const call = get.mock.calls.find(([url]) => url.includes("podcastindex"));
  const headers = call?.[1]?.headers ?? {};
  assert.equal(
    headers.Authorization,
    createHash("sha1").update(`keysecret${headers["X-Auth-Date"]}`).digest("hex"),
  );
});

test("one failing directory does not hide the other, and all failing is an error", async () => {
  settings.savePodcastSettings({ podcastIndexKey: "key", podcastIndexSecret: "secret" });
  vi.spyOn(http, "get").mockImplementation((url) =>
    url.includes("podcastindex")
      ? Promise.reject(new Error("down"))
      : Promise.resolve(reply(itunesSearch)),
  );
  assert.equal((await directories.searchPodcasts("partial")).length, 1);

  vi.spyOn(http, "get").mockRejectedValue(new Error("down"));
  await assert.rejects(directories.searchPodcasts("everything-down"), /unavailable/);
});
