import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  addFeedLink,
  episodeLink,
  sharedEpisodeId,
  showLink,
} from "../../frontend/src/utils/podcastLinks.ts";

test("links point at the show and episode, under the app's base path", () => {
  assert.equal(showLink("https://aurral.example", "/", 4), "https://aurral.example/podcasts/4");
  assert.equal(
    episodeLink("https://aurral.example/", "/music", 4, 9),
    "https://aurral.example/music/podcasts/4?episode=9",
  );
  assert.equal(
    addFeedLink("https://aurral.example", "/", "https://feeds.example/a.xml?x=1&y=2"),
    "https://aurral.example/podcasts/search?q=https%3A%2F%2Ffeeds.example%2Fa.xml%3Fx%3D1%26y%3D2",
  );
});

test("only a plain positive episode number is accepted from a link", () => {
  assert.equal(sharedEpisodeId("?episode=9", 4), 9);
  assert.equal(sharedEpisodeId("", 4), null);
  assert.equal(sharedEpisodeId("?episode=abc", 4), null);
  assert.equal(sharedEpisodeId("?episode=-3", 4), null);
  assert.equal(sharedEpisodeId("?episode=1.5", 4), null);
});
