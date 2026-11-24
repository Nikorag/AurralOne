import * as v from "valibot";
import { podcastRefreshQueue } from "../jobs/queues.ts";
import { reconcilePodcast } from "./follows.ts";
import { queueDownloads, queueWaitingDownloads } from "./downloads.ts";
import { dueSourceIds, refreshPodcast } from "./store.ts";
import { reconcileStorage, resetInterruptedDownloads } from "./storage.ts";

export const podcastRefreshSchema = v.object({ podcastId: v.number() });

export const queueRefresh = (podcastId: number, priority = 0) =>
  podcastRefreshQueue.enqueue({ podcastId }, { dedupeKey: `podcast:${podcastId}`, priority });

export async function refreshAndReconcile(podcastId: number) {
  await refreshPodcast(podcastId);
  queueDownloads(reconcilePodcast(podcastId));
}

export function queueDueRefreshes() {
  const due = dueSourceIds();
  for (const podcastId of due) queueRefresh(podcastId);
  return due.length;
}

export async function reconcilePodcastStorage() {
  resetInterruptedDownloads();
  const result = await reconcileStorage();
  queueWaitingDownloads();
  return result;
}
