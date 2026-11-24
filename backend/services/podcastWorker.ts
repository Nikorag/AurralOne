import { createJobWorker } from "./jobs/worker.ts";
import { podcastDownloadQueue, podcastImportQueue, podcastRefreshQueue } from "./jobs/queues.ts";
import { podcastImportSchema, runPodcastImport } from "./podcasts/opml.ts";
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

export const { start: startPodcastImportWorker } = createJobWorker(podcastImportQueue, {
  schema: podcastImportSchema,
  processJob: ({ userId, feedUrl }) => runPodcastImport(userId, feedUrl),
});
