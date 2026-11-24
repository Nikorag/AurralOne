import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createSilenceTrimmer, rootMeanSquare } from "../../frontend/src/utils/silenceTrim.ts";

test("speech is never sped up, and a pause only is once it has lasted long enough", () => {
  const trimmer = createSilenceTrimmer();
  assert.equal(trimmer.update(0.2, 0), false);
  assert.equal(trimmer.update(0.001, 100), false);
  assert.equal(trimmer.update(0.001, 250), false);
  assert.equal(trimmer.update(0.001, 450), true);
  assert.equal(trimmer.update(0.001, 900), true);
});

test("sound brings the normal speed back, and a quiet-but-not-silent passage does not flip it", () => {
  const trimmer = createSilenceTrimmer();
  trimmer.update(0.001, 0);
  assert.equal(trimmer.update(0.001, 400), true);
  assert.equal(trimmer.update(0.015, 450), true);
  assert.equal(trimmer.update(0.05, 500), false);
  assert.equal(trimmer.update(0.015, 550), false);
  assert.equal(trimmer.update(0.001, 600), false);
});

test("a short quiet moment between words resets the pause timer", () => {
  const trimmer = createSilenceTrimmer();
  trimmer.update(0.001, 0);
  trimmer.update(0.3, 200);
  assert.equal(trimmer.update(0.001, 400), false);
  assert.equal(trimmer.update(0.001, 650), false);
  assert.equal(trimmer.update(0.001, 750), true);
});

test("loudness is the root mean square of the samples", () => {
  assert.equal(rootMeanSquare([]), 0);
  assert.equal(rootMeanSquare([0, 0, 0]), 0);
  assert.ok(Math.abs(rootMeanSquare([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-9);
});
