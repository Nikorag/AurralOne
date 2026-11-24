import { Hono } from "hono";
import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAdmin, requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { podcastStatus, refreshAllNow, retryFailedDownloads } from "../services/podcasts/admin.ts";
import * as discover from "../services/podcasts/discover.ts";
import { queueDownloads } from "../services/podcasts/downloads.ts";
import {
  followPodcast,
  releaseEpisodeDownload,
  requestEpisodeDownload,
  unfollowPodcast,
  updateFollowSettings,
} from "../services/podcasts/follows.ts";
import { mediaStore } from "../services/podcasts/mediaStore.ts";
import {
  markPlayed,
  markUnplayed,
  removeEpisodeHistory,
  saveProgress,
} from "../services/podcasts/progress.ts";
import { reconcilePodcastStorage, refreshAndReconcile } from "../services/podcasts/refresh.ts";
import { getPodcastSettings, savePodcastSettings } from "../services/podcasts/settings.ts";
import { importPodcastFeed } from "../services/podcasts/store.ts";
import {
  activeDownloads,
  continueListening,
  EPISODE_FILTERS,
  followedPodcasts,
  getEpisode,
  getPodcastView,
  listeningHistory,
  listEpisodes,
  newEpisodes,
  recentlyPlayedPodcasts,
} from "../services/podcasts/views.ts";
import { db } from "../config/db-sqlite.ts";
import { sendAudioFile } from "../services/audioFileStream.ts";
import { sendViaNode } from "./shared/sendViaNode.ts";

const MANUAL_REFRESH_GAP_MS = 30_000;

const id = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const page = v.object({
  offset: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0))),
});

const episodesQuery = v.object({
  filter: v.optional(v.picklist(EPISODE_FILTERS)),
  sort: v.optional(v.picklist(["newest", "oldest"])),
  offset: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0))),
});

const importBody = v.object({
  feedUrl: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  provider: v.optional(v.pipe(v.string(), v.maxLength(40))),
  externalId: v.optional(v.pipe(v.string(), v.maxLength(100))),
  follow: v.optional(v.boolean()),
});

const settingsBody = v.object({
  keepLatest: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
  autoDownload: v.optional(v.boolean()),
  removePlayed: v.optional(v.boolean()),
});

const progressBody = v.object({
  positionSeconds: v.pipe(v.number(), v.minValue(0)),
  durationSeconds: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
  clientTime: v.number(),
  deviceId: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(80)))),
  ended: v.optional(v.boolean()),
});

const adminSettingsBody = v.object({
  storageLimitBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  refreshIntervalMinutes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(15), v.maxValue(1440)),
  ),
  podcastIndexKey: v.optional(v.pipe(v.string(), v.maxLength(200))),
  podcastIndexSecret: v.optional(v.pipe(v.string(), v.maxLength(200))),
});

const notFound = { error: "Not found" };

const failure = (error: unknown, fallback: string) => ({
  error: fallback,
  message: asAppError(error)?.message ?? String(error),
});

export default new Hono<AppEnv>()
  .basePath("/podcasts")
  .use(requireAuth, requireUserAccount, noCache)
  .get("/home", (c) => {
    const userId = c.var.user.id;
    return c.json(
      {
        continueListening: continueListening(userId),
        newEpisodes: newEpisodes(userId),
        following: followedPodcasts(userId).slice(0, 20),
        recentlyPlayed: recentlyPlayedPodcasts(userId),
        categories: discover.categories(),
        providers: discover.directoriesAvailable(),
      },
      200,
    );
  })
  .get("/discover", async (c) => {
    const userId = c.var.user.id;
    const [trending, recommended, newShows] = await Promise.allSettled([
      discover.trending(userId),
      discover.recommended(userId),
      discover.newShows(userId),
    ]);
    const value = <T>(result: PromiseSettledResult<T>, empty: T) =>
      result.status === "fulfilled" ? result.value : empty;
    return c.json(
      {
        trending: value(trending, []),
        recommended: value(recommended, { interests: [], podcasts: [] }),
        newShows: value(newShows, []),
        unavailable: [trending, recommended, newShows].every((r) => r.status === "rejected"),
      },
      200,
    );
  })
  .get("/browse/:category", async (c) => {
    try {
      return c.json(
        { podcasts: await discover.trending(c.var.user.id, c.req.param("category")) },
        200,
      );
    } catch (error) {
      return c.json(failure(error, "Directories unavailable"), 502);
    }
  })
  .get(
    "/search",
    validate(
      "query",
      v.object({ q: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(200)) }),
    ),
    async (c) => {
      try {
        return c.json(
          { podcasts: await discover.search(c.var.user.id, c.req.valid("query").q) },
          200,
        );
      } catch (error) {
        return c.json(failure(error, "Search unavailable"), 502);
      }
    },
  )
  .post("/import", validate("json", importBody), async (c) => {
    const { feedUrl, provider, externalId, follow } = c.req.valid("json");
    try {
      const { podcastId } = await importPodcastFeed(
        feedUrl,
        provider && externalId ? { name: provider, id: externalId } : undefined,
      );
      if (follow) queueDownloads(followPodcast(c.var.user.id, podcastId).toDownload);
      return c.json({ podcast: getPodcastView(c.var.user.id, podcastId) }, 200);
    } catch (error) {
      return c.json(
        { error: "Couldn't add this feed", message: asAppError(error)?.message ?? "Invalid feed" },
        422,
      );
    }
  })
  .get("/downloads", (c) => c.json({ downloads: activeDownloads(c.var.user.id) }, 200))
  .get("/library", (c) => c.json({ podcasts: followedPodcasts(c.var.user.id) }, 200))
  .get("/history", validate("query", page), (c) =>
    c.json(listeningHistory(c.var.user.id, { offset: c.req.valid("query").offset }), 200),
  )
  .get("/admin/status", requireAdmin, (c) => c.json(podcastStatus(), 200))
  .patch("/admin/settings", requireAdmin, validate("json", adminSettingsBody), (c) => {
    const patch = c.req.valid("json");
    const next = { ...getPodcastSettings(), ...patch };
    savePodcastSettings(next);
    return c.json(podcastStatus(), 200);
  })
  .post("/admin/reconcile", requireAdmin, async (c) => {
    const result = await reconcilePodcastStorage();
    return c.json({ ...result, status: podcastStatus() }, 200);
  })
  .post("/admin/refresh", requireAdmin, (c) => c.json({ queued: refreshAllNow() }, 200))
  .post("/admin/retry-failed", requireAdmin, (c) =>
    c.json({ retried: retryFailedDownloads(), status: podcastStatus() }, 200),
  )
  .get("/episodes/:id", (c) => {
    const episode = getEpisode(c.var.user.id, id(c.req.param("id")) ?? 0);
    return episode ? c.json({ episode }, 200) : c.json(notFound, 404);
  })
  .get("/episodes/:id/audio", async (c) => {
    const episodeId = id(c.req.param("id"));
    const row = episodeId
      ? db
          .prepare<[number, number], { path: string | null }>(
            `SELECT m.path FROM podcast_media m
             JOIN podcast_entitlements n ON n.episode_id = m.episode_id AND n.user_id = ?
             WHERE m.episode_id = ? AND m.status = 'downloaded'`,
          )
          .get(c.var.user.id, episodeId)
      : undefined;
    if (!row?.path) return c.json(notFound, 404);
    const sent = await sendViaNode(c, sendAudioFile, mediaStore.resolve(row.path));
    return sent || c.json(notFound, 404);
  })
  .put("/episodes/:id/progress", validate("json", progressBody), (c) => {
    const result = saveProgress(c.var.user.id, id(c.req.param("id")) ?? 0, c.req.valid("json"));
    return result
      ? c.json(
          {
            applied: result.applied,
            episode: getEpisode(c.var.user.id, id(c.req.param("id")) ?? 0),
          },
          200,
        )
      : c.json(notFound, 404);
  })
  .post("/episodes/:id/played", (c) => {
    const episodeId = id(c.req.param("id")) ?? 0;
    return markPlayed(c.var.user.id, episodeId)
      ? c.json({ episode: getEpisode(c.var.user.id, episodeId) }, 200)
      : c.json(notFound, 404);
  })
  .delete("/episodes/:id/played", (c) => {
    const episodeId = id(c.req.param("id")) ?? 0;
    return markUnplayed(c.var.user.id, episodeId)
      ? c.json({ episode: getEpisode(c.var.user.id, episodeId) }, 200)
      : c.json(notFound, 404);
  })
  .delete("/episodes/:id/history", (c) => {
    removeEpisodeHistory(c.var.user.id, id(c.req.param("id")) ?? 0);
    return c.json({ ok: true }, 200);
  })
  .post("/episodes/:id/download", (c) => {
    const episodeId = id(c.req.param("id")) ?? 0;
    if (!getEpisode(c.var.user.id, episodeId)) return c.json(notFound, 404);
    if (requestEpisodeDownload(c.var.user.id, episodeId)) queueDownloads([episodeId]);
    return c.json({ episode: getEpisode(c.var.user.id, episodeId) }, 200);
  })
  .delete("/episodes/:id/download", (c) => {
    const episodeId = id(c.req.param("id")) ?? 0;
    if (!getEpisode(c.var.user.id, episodeId)) return c.json(notFound, 404);
    releaseEpisodeDownload(c.var.user.id, episodeId);
    return c.json({ episode: getEpisode(c.var.user.id, episodeId) }, 200);
  })
  .get("/:id", (c) => {
    const podcast = getPodcastView(c.var.user.id, id(c.req.param("id")) ?? 0);
    return podcast ? c.json({ podcast }, 200) : c.json(notFound, 404);
  })
  .get("/:id/episodes", validate("query", episodesQuery), (c) => {
    const podcastId = id(c.req.param("id"));
    if (!podcastId || !getPodcastView(c.var.user.id, podcastId)) return c.json(notFound, 404);
    return c.json(listEpisodes(c.var.user.id, podcastId, c.req.valid("query")), 200);
  })
  .put("/:id/follow", (c) => {
    const podcastId = id(c.req.param("id"));
    if (!podcastId || !getPodcastView(c.var.user.id, podcastId)) return c.json(notFound, 404);
    queueDownloads(followPodcast(c.var.user.id, podcastId).toDownload);
    return c.json({ podcast: getPodcastView(c.var.user.id, podcastId) }, 200);
  })
  .delete(
    "/:id/follow",
    validate("query", v.object({ removeHistory: v.optional(v.literal("true")) })),
    (c) => {
      const podcastId = id(c.req.param("id"));
      if (!podcastId || !getPodcastView(c.var.user.id, podcastId)) return c.json(notFound, 404);
      unfollowPodcast(c.var.user.id, podcastId, {
        removeHistory: c.req.valid("query").removeHistory === "true",
      });
      return c.json({ podcast: getPodcastView(c.var.user.id, podcastId) }, 200);
    },
  )
  .patch("/:id/settings", validate("json", settingsBody), (c) => {
    const podcastId = id(c.req.param("id")) ?? 0;
    const result = updateFollowSettings(c.var.user.id, podcastId, c.req.valid("json"));
    if (!result) return c.json(notFound, 404);
    queueDownloads(result.toDownload);
    return c.json({ podcast: getPodcastView(c.var.user.id, podcastId) }, 200);
  })
  .post("/:id/refresh", async (c) => {
    const podcastId = id(c.req.param("id"));
    const podcast = podcastId ? getPodcastView(c.var.user.id, podcastId) : null;
    if (!podcastId || !podcast) return c.json(notFound, 404);
    const last = db
      .prepare<[number], { last_checked_at: number | null }>(
        "SELECT last_checked_at FROM podcast_sources WHERE podcast_id = ?",
      )
      .get(podcastId)?.last_checked_at;
    if (!last || Date.now() - last > MANUAL_REFRESH_GAP_MS) {
      try {
        await refreshAndReconcile(podcastId);
      } catch {}
    }
    return c.json({ podcast: getPodcastView(c.var.user.id, podcastId) }, 200);
  });
