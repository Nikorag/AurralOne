import { createJobWorker } from "./jobs/worker.ts";
import { podcastDownloadQueue, podcastRefreshQueue } from "./jobs/queues.ts";
import { downloadEpisode, podcastDownloadSchema } from "./podcasts/downloads.ts";
import { podcastRefreshSchema, refreshAndReconcile } from "./podcasts/refresh.ts";

export const { start: startPodcastDownloadWorker } = createJobWorker(podcastDownloadQueue, {
  schema: podcastDownloadSchema,
  interruptible: true,
  processJob: ({ episodeId }, _job, { signal }) => downloadEpisode(episodeId, signal),
});

export const { start: startPodcastRefreshWorker } = createJobWorker(podcastRefreshQueue, {
  schema: podcastRefreshSchema,
  processJob: ({ podcastId }) => refreshAndReconcile(podcastId),
});
