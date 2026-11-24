import { db } from "../../config/db-sqlite.ts";
import { dbOps } from "../../db/helpers/index.ts";

const RECENT_MS = 14 * 86_400_000;
const KEEP_MS = 30 * 86_400_000;
const MAX_SEPARATE = 3;

export function notifyNewEpisodes(podcastId: number, episodeIds: number[], now = Date.now()) {
  if (!episodeIds.length) return;
  const followers = db
    .prepare<[number], { user_id: number }>(
      "SELECT user_id FROM podcast_follows WHERE podcast_id = ? AND notify = 1",
    )
    .all(podcastId);
  if (!followers.length) return;

  const podcast = db
    .prepare<[number], { title: string; image_url: string | null }>(
      "SELECT title, image_url FROM podcasts WHERE id = ?",
    )
    .get(podcastId);
  if (!podcast) return;

  const placeholders = episodeIds.map(() => "?").join(",");
  const recent = db
    .prepare<number[], { id: number; title: string; image_url: string | null }>(
      `SELECT id, title, image_url FROM podcast_episodes
       WHERE id IN (${placeholders}) AND (published_at IS NULL OR published_at > ?)
       ORDER BY published_at DESC, id DESC`,
    )
    .all(...episodeIds, now - RECENT_MS);
  if (!recent.length) return;

  const items =
    recent.length <= MAX_SEPARATE
      ? recent.map((episode) => ({
          sourceKey: `episode:${episode.id}`,
          title: episode.title,
          imageUrl: episode.image_url ?? podcast.image_url,
          episodeId: episode.id,
        }))
      : [
          {
            sourceKey: `batch:${podcastId}:${now}`,
            title: `${recent.length} new episodes`,
            imageUrl: podcast.image_url,
            episodeId: null,
          },
        ];

  for (const { user_id: userId } of followers) {
    for (const item of items) {
      dbOps.upsertInboxItem({
        userId,
        kind: "podcast",
        sourceKey: item.sourceKey,
        title: item.title,
        subtitle: podcast.title,
        href: `/podcasts/${podcastId}`,
        imageUrl: item.imageUrl,
        metadata: { podcastId, episodeId: item.episodeId },
        expiresAt: now + KEEP_MS,
        createdAt: now,
      });
    }
  }

  void import("../notificationService.ts").then(({ notifyPodcastEpisode }) =>
    notifyPodcastEpisode({
      podcastTitle: podcast.title,
      episodeTitle:
        recent.length === 1 ? (recent[0]?.title ?? "") : `${recent.length} new episodes`,
    }),
  );
}
