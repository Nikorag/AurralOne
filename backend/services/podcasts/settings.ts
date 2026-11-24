import { db } from "../../config/db-sqlite.ts";
import { decryptWithKey, encryptWithKey } from "../../config/encryption.ts";
import { getSettingsEncryptionKey } from "../../db/helpers/settings.ts";

const KEY = "podcasts";
const GB = 1024 ** 3;

export interface PodcastSettings {
  storageLimitBytes: number;
  refreshIntervalMinutes: number;
  podcastIndexKey: string;
  podcastIndexSecret: string;
}

export const DEFAULT_PODCAST_SETTINGS: PodcastSettings = {
  storageLimitBytes: 20 * GB,
  refreshIntervalMinutes: 120,
  podcastIndexKey: "",
  podcastIndexSecret: "",
};

const read = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?");
const write = db.prepare<[string, string]>(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
);

const number = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
};

export function getPodcastSettings(): PodcastSettings {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(read.get(KEY)?.value ?? "{}");
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch {}
  const secret = typeof stored.podcastIndexSecret === "string" ? stored.podcastIndexSecret : "";
  return {
    storageLimitBytes: number(
      stored.storageLimitBytes,
      DEFAULT_PODCAST_SETTINGS.storageLimitBytes,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    refreshIntervalMinutes: number(
      stored.refreshIntervalMinutes,
      DEFAULT_PODCAST_SETTINGS.refreshIntervalMinutes,
      15,
      24 * 60,
    ),
    podcastIndexKey: typeof stored.podcastIndexKey === "string" ? stored.podcastIndexKey : "",
    podcastIndexSecret: decryptWithKey(secret, getSettingsEncryptionKey()) ?? "",
  };
}

export function savePodcastSettings(patch: Partial<PodcastSettings>) {
  const next = { ...getPodcastSettings(), ...patch };
  write.run(
    KEY,
    JSON.stringify({
      ...next,
      podcastIndexSecret: encryptWithKey(next.podcastIndexSecret, getSettingsEncryptionKey()) ?? "",
    }),
  );
  return getPodcastSettings();
}
