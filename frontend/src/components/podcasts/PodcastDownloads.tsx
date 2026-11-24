import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "../icons";
import RouteLink from "../RouteLink";
import {
  invalidatePodcasts,
  useEpisodeAction,
  usePodcastDownloads,
  type PodcastDownload,
} from "../../hooks/usePodcasts";
import { describeProgress } from "./podcastFormat";
import { PodcastArt, podcastPath } from "./podcastUi";
import "./podcasts.css";

const LABELS: Record<PodcastDownload["state"], string> = {
  pending: "Queued",
  queued: "Queued",
  downloading: "Downloading",
  awaiting_storage: "Waiting for storage",
  failed: "Failed",
};

export function PodcastDownloads() {
  const queryClient = useQueryClient();
  const { data } = usePodcastDownloads();
  const action = useEpisodeAction();
  const downloads = data?.downloads ?? [];
  const running = downloads.filter(
    (item) => item.state !== "failed" && item.state !== "awaiting_storage",
  ).length;
  const wasRunning = useRef(0);

  useEffect(() => {
    if (wasRunning.current > running) void invalidatePodcasts(queryClient);
    wasRunning.current = running;
  }, [queryClient, running]);

  if (!downloads.length) return null;
  return (
    <section className="podcast-downloads" aria-label="Podcast downloads">
      <h2 className="podcast-section__title">Podcast downloads</h2>
      <div className="podcast-episodes" role="list">
        {downloads.map((item) => (
          <div
            key={item.episodeId}
            role="listitem"
            className="podcast-download"
            data-state={item.state}
          >
            <PodcastArt src={item.imageUrl} className="podcast-download__art" />
            <div className="podcast-download__main">
              <span className="podcast-download__title">{item.title}</span>
              <RouteLink to={podcastPath(item.podcastId)} className="podcast-download__show">
                {item.podcastTitle}
              </RouteLink>
              {item.error ? <span className="podcast-download__error">{item.error}</span> : null}
              {item.progress ? (
                <>
                  <span className="podcast-download__show">{describeProgress(item.progress)}</span>
                  {item.progress.fraction !== null ? (
                    <span
                      className="podcast-episode__bar"
                      role="progressbar"
                      aria-label="Download progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(item.progress.fraction * 100)}
                    >
                      <span style={{ width: `${item.progress.fraction * 100}%` }} />
                    </span>
                  ) : null}
                </>
              ) : null}
            </div>
            <span
              className="podcast-chip"
              data-tone={
                item.state === "failed"
                  ? "danger"
                  : item.state === "awaiting_storage"
                    ? "warning"
                    : "muted"
              }
            >
              {item.state === "failed" || item.state === "awaiting_storage" ? (
                <AlertCircle aria-hidden="true" />
              ) : null}
              {LABELS[item.state]}
            </span>
            {item.state === "failed" || item.state === "awaiting_storage" ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: item.episodeId, action: "download" })}
              >
                Retry
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
