import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chapterIndexAt, type PodcastChapter } from "../../frontend/src/utils/podcastChapters.ts";

const chapters: PodcastChapter[] = [0, 60, 300].map((startSeconds) => ({
  startSeconds,
  title: `At ${startSeconds}`,
  imageUrl: null,
  url: null,
}));

test("the current chapter is the last one that has started", () => {
  assert.equal(chapterIndexAt(chapters, 0), 0);
  assert.equal(chapterIndexAt(chapters, 59.5), 0);
  assert.equal(chapterIndexAt(chapters, 59.8), 1);
  assert.equal(chapterIndexAt(chapters, 60), 1);
  assert.equal(chapterIndexAt(chapters, 299), 1);
  assert.equal(chapterIndexAt(chapters, 4000), 2);
});

test("before the first chapter, or with none, there is no current chapter", () => {
  assert.equal(chapterIndexAt([], 10), -1);
  assert.equal(chapterIndexAt([{ ...chapters[1]! }], 10), -1);
});
