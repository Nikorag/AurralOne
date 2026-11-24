import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  sleepOptionOf,
  sleepRemaining,
  sleepTimerFor,
  stopsAtEnd,
} from "../../frontend/src/utils/podcastSleep.ts";

test("a timed sleep ends that many minutes from now and counts down", () => {
  const timer = sleepTimerFor(30, 1_000);
  assert.deepEqual(timer, { mode: "time", endsAt: 1_000 + 30 * 60_000 });
  assert.equal(sleepRemaining(timer, 1_000 + 29 * 60_000), 60);
  assert.equal(sleepRemaining(timer, 1_000 + 31 * 60_000), 0);
});

test("the timer reads back as the closest option, and only the end-of-episode timer stops at the end", () => {
  assert.equal(sleepOptionOf(sleepTimerFor(15, 0), 60_000), 15);
  assert.equal(sleepOptionOf(sleepTimerFor("episode", 0), 0), "episode");
  assert.equal(sleepOptionOf(sleepTimerFor("off", 0), 0), "off");
  assert.equal(stopsAtEnd(sleepTimerFor("episode", 0)), true);
  assert.equal(stopsAtEnd(sleepTimerFor(15, 0)), false);
  assert.equal(stopsAtEnd(sleepTimerFor("off", 0)), false);
});
