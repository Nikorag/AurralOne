export const SLEEP_MINUTES = [5, 15, 30, 45, 60] as const;

export type SleepOption = "off" | "episode" | (typeof SLEEP_MINUTES)[number];
export type SleepTimer = { mode: "off" } | { mode: "episode" } | { mode: "time"; endsAt: number };

export const sleepTimerFor = (option: SleepOption, now: number): SleepTimer =>
  option === "off"
    ? { mode: "off" }
    : option === "episode"
      ? { mode: "episode" }
      : { mode: "time", endsAt: now + option * 60_000 };

export const sleepOptionOf = (sleep: SleepTimer, now: number): SleepOption => {
  if (sleep.mode !== "time") return sleep.mode;
  const minutes = Math.max(0, sleep.endsAt - now) / 60_000;
  return SLEEP_MINUTES.reduce((best, option) =>
    Math.abs(option - minutes) < Math.abs(best - minutes) ? option : best,
  );
};

export const sleepLabel = (option: SleepOption) =>
  option === "off" ? "Off" : option === "episode" ? "End of episode" : `${option} minutes`;

export const sleepRemaining = (sleep: SleepTimer, now: number) =>
  sleep.mode === "time" ? Math.max(0, Math.ceil((sleep.endsAt - now) / 1000)) : null;

export const stopsAtEnd = (sleep: SleepTimer) => sleep.mode === "episode";
