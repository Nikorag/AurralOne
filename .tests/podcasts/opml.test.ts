import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { http }, opml, follows] = await setupIsolatedBackend(
  "podcast-opml",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../lib/http.ts"),
  () => import("../../backend/services/podcasts/opml.ts"),
  () => import("../../backend/services/podcasts/follows.ts"),
);

const feedXml = (title: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>${title}</title>
<item><title>One</title><guid>1</guid><enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg"/></item>
</channel></rss>`;

const serve = (byUrl: Record<string, string | Error>) =>
  vi.spyOn(http, "get").mockImplementation(async (url) => {
    const body = byUrl[url];
    if (body === undefined || body instanceof Error) throw body ?? new Error("Not found");
    return { status: 200, statusText: "", headers: {}, data: Buffer.from(body) };
  });

beforeEach(() => {
  vi.restoreAllMocks();
  db.exec("DELETE FROM podcasts; DELETE FROM users");
  db.exec("INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'x'), (2, 'b', 'x')");
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const file = `<?xml version="1.0"?>
<opml version="2.0"><head><title>Subs</title></head><body>
  <outline text="Tech">
    <outline type="rss" text="Show &amp; Tell" xmlUrl="https://example.com/a.xml?x=1&amp;y=2"/>
    <outline type="rss" text="Dupe" xmlUrl="https://example.com/a.xml?x=1&amp;y=2"/>
  </outline>
  <outline type="rss" text="Plain" xmlUrl="http://example.com/b.xml"/>
  <outline type="rss" text="Bad" xmlUrl="ftp://example.com/c.xml"/>
  <outline type="rss" text="Local file" xmlUrl="file:///etc/passwd"/>
  <outline text="Folder without feeds"/>
</body></opml>`;

test("feeds are found inside folders, decoded, de-duplicated, and limited to http(s)", () => {
  assert.deepEqual(opml.parseOpml(file), [
    { feedUrl: "https://example.com/a.xml?x=1&y=2", title: "Show & Tell" },
    { feedUrl: "http://example.com/b.xml", title: "Plain" },
  ]);
  assert.equal(opml.parseOpml("<html></html>"), null);
});

test("importing queues one pending feed each and skips shows the user already follows", () => {
  db.exec(`
    INSERT INTO podcasts (id, title, created_at) VALUES (1, 'Plain', 0);
    INSERT INTO podcast_sources (podcast_id, feed_url) VALUES (1, 'http://example.com/b.xml');
  `);
  follows.followPodcast(1, 1);
  const result = opml.queueOpmlImport(1, file);
  assert.deepEqual(result, { queued: 1, alreadyFollowing: 1, skipped: 0 });
  assert.equal(opml.importStatus(1).pending, 1);
  assert.deepEqual(opml.queueOpmlImport(1, "<nope/>"), {
    error: "This doesn't look like an OPML file",
  });
});

test("each queued feed is added and followed, and a bad feed is reported without stopping the rest", async () => {
  serve({
    "https://example.com/a.xml?x=1&y=2": feedXml("Show"),
    "http://example.com/b.xml": new Error("Request timed out"),
  });
  opml.queueOpmlImport(1, file);
  await opml.runPodcastImport(1, "https://example.com/a.xml?x=1&y=2");
  await opml.runPodcastImport(1, "http://example.com/b.xml");

  const status = opml.importStatus(1);
  assert.deepEqual([status.total, status.done, status.failed, status.pending], [2, 1, 1, 0]);
  assert.deepEqual(
    status.failures.map((failure) => failure.error),
    ["Request timed out"],
  );
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM podcast_follows WHERE user_id = 1").get() as {
        n: number;
      }
    ).n,
    1,
  );
  assert.equal(opml.importStatus(2).total, 0);

  opml.clearFinishedImports(1);
  assert.equal(opml.importStatus(1).total, 0);
});

test("an export lists what the user follows, escapes it, and imports back unchanged", async () => {
  serve({ "https://example.com/a.xml?x=1&y=2": feedXml("Quotes &quot;&amp;&quot; &lt;Tags&gt;") });
  opml.queueOpmlImport(1, file);
  await opml.runPodcastImport(1, "https://example.com/a.xml?x=1&y=2");

  const exported = opml.exportOpml(1);
  assert.match(exported, /xmlUrl="https:\/\/example\.com\/a\.xml\?x=1&amp;y=2"/);
  assert.match(exported, /text="Quotes &quot;&amp;&quot;"/);
  assert.deepEqual(opml.parseOpml(exported), [
    { feedUrl: "https://example.com/a.xml?x=1&y=2", title: 'Quotes "&"' },
  ]);
  assert.equal(opml.parseOpml(opml.exportOpml(2))?.length, 0);
});
