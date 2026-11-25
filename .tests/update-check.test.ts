import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { feedFromRelease, selectAvailableUpdate } from "../backend/services/updates.ts";

const commits = ["eeeeeee", "ddddddd", "ccccccc", "bbbbbbb"].map((sha) => ({
  sha: `${sha}${"0".repeat(33)}`,
  subject: `change ${sha[0]}`,
}));

const feed = {
  stable: { version: "2.10.0", url: "https://github.com/r/2.10.0", notes: ["fix: x"] },
  nightly: { version: "nightly.512+eeeeeee", sha: "eeeeeee", commits },
};

test("stable installs only see a newer release", () => {
  assert.equal(selectAvailableUpdate("2.9.3", feed)?.latest, "2.10.0");
  assert.equal(selectAvailableUpdate("2.10.0", feed), null);
  assert.equal(selectAvailableUpdate("2.11.0", feed), null);
  assert.equal(selectAvailableUpdate("2.9.3", null), null);
});

test("nightly installs see the commits since their build, oldest first", () => {
  assert.deepEqual(selectAvailableUpdate("nightly.510+ccccccc", feed), {
    channel: "nightly",
    current: "ccccccc",
    latest: "eeeeeee",
    url: "https://github.com/lklynet/aurral/compare/ccccccc...eeeeeee",
    notes: ["change d", "change e"],
  });
  assert.deepEqual(selectAvailableUpdate("nightly.400+aaaaaaa", feed)?.notes, [
    "change b",
    "change c",
    "change d",
    "change e",
  ]);
});

test("a nightly newer than the feed is not offered an older build", () => {
  assert.equal(selectAvailableUpdate("nightly.512+eeeeeee", feed), null);
  assert.equal(selectAvailableUpdate("nightly.513+fffffff", feed), null);
  assert.equal(selectAvailableUpdate("2.9.0", { ...feed, stable: null }), null);
});

test("a fork's latest GitHub release becomes the stable update", () => {
  const forkFeed = feedFromRelease({
    tag_name: "v1.1.0",
    html_url: "https://github.com/Nikorag/AurralOne/releases/tag/v1.1.0",
    body: "## What's Changed\n* feat: add a thing by @a in https://github.com/x/pull/1\n",
  });
  assert.deepEqual(forkFeed.stable, {
    version: "1.1.0",
    url: "https://github.com/Nikorag/AurralOne/releases/tag/v1.1.0",
    notes: ["feat: add a thing by @a"],
  });
  assert.equal(selectAvailableUpdate("1.0.0", forkFeed)?.latest, "1.1.0");
  assert.equal(selectAvailableUpdate("1.1.0", forkFeed), null);
  assert.equal(selectAvailableUpdate("nightly.5+abcdef0", forkFeed), null);
});
