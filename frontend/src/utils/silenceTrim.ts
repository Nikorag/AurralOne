const QUIET = 0.012;
const LOUD = 0.02;
const HOLD_MS = 300;

export function createSilenceTrimmer({ quiet = QUIET, loud = LOUD, holdMs = HOLD_MS } = {}) {
  let quietSince: number | null = null;
  let skipping = false;
  return {
    update(level: number, now: number) {
      if (level >= loud) {
        quietSince = null;
        skipping = false;
      } else if (level < quiet) {
        quietSince ??= now;
        if (now - quietSince >= holdMs) skipping = true;
      }
      return skipping;
    },
    reset() {
      quietSince = null;
      skipping = false;
    },
  };
}

export const rootMeanSquare = (samples: ArrayLike<number>) => {
  if (!samples.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += (samples[index] ?? 0) ** 2;
  return Math.sqrt(sum / samples.length);
};
