import { db } from "../config/db-sqlite.ts";
import { enqueueSystemTask } from "./jobs/systemTasks.ts";
import { logger } from "./logger.ts";

export const JELLYFIN_SCAN_DELAY_MS = 30_000;

const hasJellyfin = db.prepare<[], { found: number }>(
  "SELECT 1 AS found FROM history_servers WHERE provider = 'jellyfin' LIMIT 1",
);

// A burst of new files moves the one waiting job later, so Jellyfin scans once
// shortly after the last file lands. Nothing happens when Jellyfin isn't connected.
export function requestJellyfinScan() {
  if (!hasJellyfin.get()) return;
  try {
    enqueueSystemTask(
      { kind: "jellyfin-library-scan" },
      {
        delayMs: JELLYFIN_SCAN_DELAY_MS,
        mergeInto: (waiting) => ({ kind: "jellyfin-library-scan", ...waiting }),
      },
    );
  } catch (error) {
    logger.warn("jellyfin", "Could not queue a Jellyfin library scan", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
