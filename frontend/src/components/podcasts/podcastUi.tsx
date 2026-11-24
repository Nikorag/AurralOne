import { useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  Ellipsis,
  ListEnd,
  ListStart,
  Mic,
  Pause,
  Play,
  Trash2,
} from "../icons";
import { LibraryItemMenu, type LibraryMenuItem } from "../LibraryItemMenu";
import RouteLink from "../RouteLink";
import {
  useEpisodeAction,
  type DirectoryPodcast,
  type Podcast,
  type PodcastEpisode,
} from "../../hooks/usePodcasts";
import { usePodcastPlayer } from "../../contexts/podcastPlayerContext";
import { useToast } from "../../contexts/ToastContext";
import { getAppBasePath } from "../../utils/basePath";
import { copyText, episodeLink } from "../../utils/podcastLinks";
import {
  DOWNLOAD_LABELS,
  episodeProgress,
  formatBytes,
  formatLength,
  formatPublished,
  isNewEpisode,
} from "./podcastFormat";
import "./podcasts.css";

export const podcastPath = (id: number) => `/podcasts/${id}`;

export function PodcastArt({
  src,
  className = "",
}: {
  src: string | null | undefined;
  title?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`podcast-art${className ? ` ${className}` : ""}`} aria-hidden="true">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="podcast-art__fallback">
          <Mic />
        </span>
      )}
    </span>
  );
}

type CardPodcast = Pick<Podcast, "title" | "publisher" | "imageUrl">;

export function PodcastCard({
  podcast,
  to,
  onOpen,
  badge,
  busy = false,
}: {
  podcast: CardPodcast;
  to?: string;
  onOpen?: () => void;
  badge?: string | null;
  busy?: boolean;
}) {
  const cover = (
    <>
      <PodcastArt src={podcast.imageUrl} title={podcast.title} />
      {badge ? <span className="podcast-card__badge">{badge}</span> : null}
    </>
  );
  return (
    <article className="podcast-card">
      {to ? (
        <RouteLink to={to} className="podcast-card__cover" aria-label={`Open ${podcast.title}`}>
          {cover}
        </RouteLink>
      ) : (
        <button
          type="button"
          className="podcast-card__cover"
          onClick={onOpen}
          disabled={busy}
          aria-label={`Open ${podcast.title}`}
        >
          {cover}
        </button>
      )}
      <div className="podcast-card__body">
        {to ? (
          <RouteLink to={to} className="podcast-card__title">
            {podcast.title}
          </RouteLink>
        ) : (
          <button type="button" className="podcast-card__title" onClick={onOpen} disabled={busy}>
            {podcast.title}
          </button>
        )}
        {podcast.publisher ? <span className="podcast-card__meta">{podcast.publisher}</span> : null}
      </div>
    </article>
  );
}

export const directoryCardPodcast = (podcast: DirectoryPodcast): CardPodcast => ({
  title: podcast.title,
  publisher: podcast.publisher,
  imageUrl: podcast.imageUrl,
});

function StateChip({ episode }: { episode: PodcastEpisode }) {
  const { state, bytes, progress } = episode.download;
  const label = DOWNLOAD_LABELS[state];
  if (!label) return null;
  const tone = state === "failed" ? "danger" : state === "awaiting_storage" ? "warning" : "muted";
  return (
    <span className="podcast-chip" data-tone={tone}>
      {state === "failed" || state === "awaiting_storage" ? (
        <AlertCircle aria-hidden="true" />
      ) : null}
      {state === "downloaded" ? <Check aria-hidden="true" /> : null}
      {label}
      {state === "downloaded" && bytes ? ` · ${formatBytes(bytes)}` : ""}
      {state === "downloading" && progress?.fraction != null
        ? ` ${Math.round(progress.fraction * 100)}%`
        : ""}
    </span>
  );
}

export function EpisodeRow({
  episode,
  showPodcast = false,
  canDownload = true,
  removable = false,
}: {
  episode: PodcastEpisode;
  showPodcast?: boolean;
  canDownload?: boolean;
  removable?: boolean;
}) {
  const player = usePodcastPlayer();
  const action = useEpisodeAction();
  const { showError, showSuccess } = useToast();
  const current = player.isCurrent(episode.id);
  const playing = current && player.isPlaying;
  const { fraction, started, played, remaining } = episodeProgress(episode);
  const state = episode.download.state;
  const onServer = state !== "feed";

  const items: LibraryMenuItem[] = [
    {
      id: "queue-next",
      label: "Play next",
      icon: ListStart,
      onSelect: () => player.enqueue(episode, true),
    },
    {
      id: "queue-end",
      label: "Add to queue",
      icon: ListEnd,
      onSelect: () => player.enqueue(episode),
    },
    {
      id: "copy-link",
      label: "Copy link to episode",
      separatorBefore: true,
      onSelect: async () => {
        const link = episodeLink(
          window.location.origin,
          getAppBasePath(),
          episode.podcastId,
          episode.id,
        );
        if (await copyText(link)) showSuccess("Link copied");
        else showError("Couldn't copy the link");
      },
    },
    played
      ? {
          id: "unplayed",
          label: "Mark as unplayed",
          onSelect: () => action.mutate({ id: episode.id, action: "unplayed" }),
        }
      : {
          id: "played",
          label: "Mark as played",
          onSelect: () => action.mutate({ id: episode.id, action: "played" }),
        },
    ...(started
      ? [
          {
            id: "reset",
            label: "Reset progress",
            onSelect: () => action.mutate({ id: episode.id, action: "unplayed" }),
          },
        ]
      : []),
    ...(canDownload
      ? [
          onServer
            ? {
                id: "remove-download",
                label: "Remove from my downloads",
                icon: Trash2,
                separatorBefore: true,
                onSelect: () => action.mutate({ id: episode.id, action: "remove-download" }),
              }
            : {
                id: "download",
                label: "Download to server",
                icon: Download,
                separatorBefore: true,
                onSelect: () => action.mutate({ id: episode.id, action: "download" }),
              },
        ]
      : []),
    ...(removable
      ? [
          {
            id: "remove-history",
            label: "Remove from history",
            danger: true,
            separatorBefore: true,
            onSelect: () => action.mutate({ id: episode.id, action: "remove-history" }),
          },
        ]
      : []),
  ];

  const meta = [
    showPodcast ? episode.podcastTitle : null,
    formatPublished(episode.publishedAt),
    played
      ? "Played"
      : started
        ? `${formatLength(remaining)} left`
        : formatLength(episode.durationSeconds),
  ].filter(Boolean);

  return (
    <article
      className={`podcast-episode${current ? " is-current" : ""}${played ? " is-played" : ""}`}
    >
      <PodcastArt
        src={episode.imageUrl}
        title={episode.podcastTitle}
        className="podcast-episode__art"
      />
      <div className="podcast-episode__main">
        <div className="podcast-episode__title-row">
          {isNewEpisode(episode) ? (
            <span className="podcast-chip" data-tone="accent">
              New
            </span>
          ) : null}
          <RouteLink to={podcastPath(episode.podcastId)} className="podcast-episode__title">
            {episode.title}
          </RouteLink>
        </div>
        {episode.description ? (
          <p className="podcast-episode__description">{episode.description}</p>
        ) : null}
        <div className="podcast-episode__meta">
          <span>{meta.join(" · ")}</span>
          <StateChip episode={episode} />
        </div>
        {started ? (
          <div
            className="podcast-episode__bar"
            role="progressbar"
            aria-label="Listening progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
          >
            <span style={{ width: `${fraction * 100}%` }} />
          </div>
        ) : null}
      </div>
      <div className="podcast-episode__actions">
        <button
          type="button"
          className="podcast-play"
          aria-label={`${playing ? "Pause" : "Play"} ${episode.title}`}
          onClick={() => (playing ? player.pause() : player.play(episode))}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
        <LibraryItemMenu
          label={episode.title}
          contextMenu={false}
          triggerIcon={<Ellipsis aria-hidden="true" />}
          triggerLabel="Episode options"
          triggerClassName="btn btn-ghost btn-icon btn-xs"
          items={items}
        />
      </div>
    </article>
  );
}

export function EpisodeList({
  episodes,
  showPodcast,
  removable,
}: {
  episodes: PodcastEpisode[];
  showPodcast?: boolean;
  removable?: boolean;
}) {
  return (
    <div className="podcast-episodes" role="list">
      {episodes.map((episode) => (
        <div role="listitem" key={episode.id}>
          <EpisodeRow episode={episode} showPodcast={showPodcast} removable={removable} />
        </div>
      ))}
    </div>
  );
}
