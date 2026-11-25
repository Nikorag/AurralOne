import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import {
  compareReleaseVersions,
  extractReleaseNoteItems,
  parseNightlyVersion,
  releaseChannel,
} from "../../lib/release-version.ts";
import { APP_VERSION } from "../config/constants.ts";
import { dbOps } from "../db/helpers/index.ts";
import { logger } from "./logger.ts";
import { SHARE_ORIGIN } from "./shareLinks/store.ts";

const UPSTREAM_REPOSITORY = "lklynet/aurral";
const REPOSITORY = process.env.GITHUB_REPO || UPSTREAM_REPOSITORY;
const FEED_SETTING = "updates:feed";
const MAX_NIGHTLY_NOTES = 8;

const releaseSchema = v.object({
  tag_name: v.string(),
  html_url: v.string(),
  body: v.nullish(v.string()),
});

const feedSchema = v.object({
  stable: v.nullable(
    v.object({ version: v.string(), url: v.string(), notes: v.array(v.string()) }),
  ),
  nightly: v.nullable(
    v.object({
      version: v.string(),
      sha: v.string(),
      commits: v.array(v.object({ sha: v.string(), subject: v.string() })),
    }),
  ),
});

type UpdateFeed = v.InferOutput<typeof feedSchema>;

export function selectAvailableUpdate(version: string, feed: UpdateFeed | null) {
  const nightly = parseNightlyVersion(version);
  if (nightly) {
    const latest = parseNightlyVersion(feed?.nightly?.version);
    if (!feed?.nightly || !latest || latest.run <= nightly.run) return null;
    const { commits } = feed.nightly;
    const installedAt = commits.findIndex((commit) => commit.sha.startsWith(nightly.sha));
    const newer = installedAt === -1 ? commits : commits.slice(0, installedAt);
    return {
      channel: "nightly" as const,
      current: nightly.sha,
      latest: latest.sha,
      url: `https://github.com/${REPOSITORY}/compare/${nightly.sha}...${latest.sha}`,
      notes: newer
        .slice(0, MAX_NIGHTLY_NOTES)
        .map((commit) => commit.subject)
        .reverse(),
    };
  }
  if (!feed?.stable || compareReleaseVersions(feed.stable.version, version) <= 0) return null;
  return {
    channel: "stable" as const,
    current: version,
    latest: feed.stable.version,
    url: feed.stable.url,
    notes: feed.stable.notes,
  };
}

export const feedFromRelease = (release: v.InferOutput<typeof releaseSchema>): UpdateFeed => ({
  stable: {
    version: release.tag_name.replace(/^v/, ""),
    url: release.html_url,
    notes: extractReleaseNoteItems(release.body, MAX_NIGHTLY_NOTES),
  },
  nightly: null,
});

async function fetchFeed(everyHours: number) {
  const ownRepository = REPOSITORY !== UPSTREAM_REPOSITORY;
  const response = await fetch(
    ownRepository
      ? `https://api.github.com/repos/${REPOSITORY}/releases/latest`
      : `${SHARE_ORIGIN}/api/updates?version=${encodeURIComponent(APP_VERSION)}&every=${everyHours}`,
    {
      headers: {
        Accept: ownRepository ? "application/vnd.github+json" : "application/json",
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    throw new Error(`${ownRepository ? "GitHub" : "aurral.org"} answered ${response.status}`);
  }
  const body: unknown = await response.json();
  return ownRepository ? feedFromRelease(v.parse(releaseSchema, body)) : v.parse(feedSchema, body);
}

export function getAvailableUpdate() {
  return selectAvailableUpdate(APP_VERSION, dbOps.getJSONSetting(FEED_SETTING, feedSchema));
}

export async function checkForUpdates(everyHours: number) {
  if (!releaseChannel(APP_VERSION)) return;
  try {
    dbOps.setJSONSetting(FEED_SETTING, await fetchFeed(everyHours));
  } catch (error) {
    logger.debug("system", "Could not check for updates:", {
      message: asAppError(error)?.message,
    });
  }
}
