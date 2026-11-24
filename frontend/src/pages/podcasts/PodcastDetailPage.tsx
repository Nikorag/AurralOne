import { useMemo, useState } from "react";
import { useLocation, useParams } from "react-router";
import { AlertCircle, Mic, Play, RefreshCw, Settings, Share } from "../../components/icons";
import { LibraryItemMenu } from "../../components/LibraryItemMenu";
import { Select } from "../../components/Select";
import StatePanel from "../../components/StatePanel";
import TooltipButton from "../../components/TooltipButton";
import { SkeletonFeedPage } from "../../components/Skeletons";
import { EpisodeRow, PodcastArt } from "../../components/podcasts/podcastUi";
import { formatPublished } from "../../components/podcasts/podcastFormat";
import { usePodcastPlayer } from "../../contexts/podcastPlayerContext";
import { useToast } from "../../contexts/ToastContext";
import { getAppBasePath } from "../../utils/basePath";
import { copyText, sharedEpisodeId, showLink } from "../../utils/podcastLinks";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import {
  useFollowPodcast,
  usePodcast,
  usePodcastEpisode,
  usePodcastEpisodes,
  useRefreshPodcast,
  type EpisodeFilter,
  type EpisodeSort,
} from "../../hooks/usePodcasts";
import { PodcastSettingsDialog, UnfollowDialog } from "./PodcastSettingsDialog";
import { PodcastsHeader } from "./podcastShared";

const FILTERS: { value: EpisodeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unplayed", label: "Unplayed" },
  { value: "in_progress", label: "In progress" },
  { value: "downloaded", label: "Downloaded" },
  { value: "played", label: "Played" },
];

const SORTS: { value: EpisodeSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

const EMPTY_MESSAGES: Record<EpisodeFilter, string> = {
  all: "This feed has no episodes yet.",
  unplayed: "You're all caught up.",
  in_progress: "Nothing in progress.",
  downloaded: "No episodes of this show are on the server for you.",
  played: "You haven't finished any episodes yet.",
};

export default function PodcastDetailPage() {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const player = usePodcastPlayer();
  const { search } = useLocation();
  const { showError, showSuccess } = useToast();
  const sharedId = sharedEpisodeId(search, id);
  const sharedEpisode = usePodcastEpisode(sharedId).data?.episode;
  const podcastQuery = usePodcast(id);
  const podcast = podcastQuery.data?.podcast;
  useDocumentTitle(podcast?.title ?? "Podcast");

  const [filter, setFilter] = useState<EpisodeFilter>("all");
  const [sort, setSort] = useState<EpisodeSort>("newest");
  const [expanded, setExpanded] = useState(false);
  const [dialog, setDialog] = useState<"settings" | "unfollow" | null>(null);
  const episodesQuery = usePodcastEpisodes(id, filter, sort);
  const follow = useFollowPodcast();
  const refresh = useRefreshPodcast();
  const episodes = useMemo(
    () => episodesQuery.data?.pages.flatMap((page) => page.episodes) ?? [],
    [episodesQuery.data],
  );

  if (podcastQuery.isPending) return <SkeletonFeedPage label="Loading podcast" />;
  if (podcastQuery.isError || !podcast) {
    return (
      <div className="podcast-page">
        <PodcastsHeader />
        <StatePanel
          role="alert"
          icon={<Mic />}
          title="Couldn't load this podcast"
          message="It may have been removed, or the server isn't reachable."
          onRetry={() => void podcastQuery.refetch()}
          retrying={podcastQuery.isFetching}
        />
      </div>
    );
  }

  const following = podcast.follow;
  const next = episodes.find((episode) => !episode.progress.played);
  const resume = episodes.find(
    (episode) => !episode.progress.played && episode.progress.positionSeconds > 5,
  );
  const target = resume ?? next ?? episodes[0];
  const feedFailed = Boolean(podcast.feed.error);

  return (
    <div className="podcast-page">
      <header className="podcast-hero">
        <PodcastArt src={podcast.imageUrl} className="podcast-hero__art" />
        <div className="podcast-hero__copy">
          <h1 className="page-title">{podcast.title}</h1>
          {podcast.publisher ? (
            <p className="podcast-hero__publisher">{podcast.publisher}</p>
          ) : null}
          {podcast.description ? (
            <div>
              <p className={`podcast-hero__description${expanded ? "" : " is-clamped"}`}>
                {podcast.description}
              </p>
              {podcast.description.length > 220 ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="podcast-hero__actions">
            {target ? (
              <button type="button" className="btn btn-primary" onClick={() => player.play(target)}>
                <Play className="artist-icon-sm" aria-hidden="true" />
                {resume ? "Continue" : next ? "Play next episode" : "Play latest"}
              </button>
            ) : null}
            {following ? (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setDialog("unfollow")}
                >
                  Following
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setDialog("settings")}
                >
                  <Settings className="artist-icon-sm" aria-hidden="true" />
                  Download settings
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={follow.isPending}
                onClick={() => follow.mutate({ id: podcast.id })}
              >
                Follow
              </button>
            )}
            <LibraryItemMenu
              label={podcast.title}
              contextMenu={false}
              triggerIcon={<Share aria-hidden="true" />}
              triggerLabel="Share"
              triggerClassName="btn btn-ghost btn-icon"
              items={[
                {
                  id: "copy-feed",
                  label: "Copy RSS feed URL",
                  description: "Works in any podcast app",
                  onSelect: async () => {
                    if (podcast.feed.url && (await copyText(podcast.feed.url))) {
                      showSuccess("Feed URL copied");
                    } else showError("Couldn't copy the feed URL");
                  },
                },
                {
                  id: "copy-link",
                  label: "Copy link to this show",
                  description: "Opens it for people on this server",
                  onSelect: async () => {
                    const link = showLink(window.location.origin, getAppBasePath(), podcast.id);
                    if (await copyText(link)) showSuccess("Link copied");
                    else showError("Couldn't copy the link");
                  },
                },
              ]}
            />
            <TooltipButton
              label="Check for new episodes"
              className="btn btn-ghost btn-icon"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate({ id: podcast.id })}
            >
              <RefreshCw className="artist-icon-sm" aria-hidden="true" />
            </TooltipButton>
          </div>
          <p className="podcast-feed-status" data-tone={feedFailed ? "danger" : undefined}>
            {feedFailed ? (
              <>
                <AlertCircle className="artist-icon-xs" aria-hidden="true" /> Last refresh failed:{" "}
                {podcast.feed.error}.{" "}
              </>
            ) : null}
            {podcast.feed.lastSuccessAt
              ? `Last updated ${formatPublished(podcast.feed.lastSuccessAt)}`
              : "Not refreshed yet"}
            {podcast.categories.length ? ` · ${podcast.categories.join(", ")}` : ""}
          </p>
        </div>
      </header>

      {sharedEpisode && sharedEpisode.podcastId === podcast.id ? (
        <section className="podcast-section" aria-label="Shared episode">
          <h2 className="podcast-section__title">Shared with you</h2>
          <EpisodeRow episode={sharedEpisode} />
        </section>
      ) : null}

      <section className="podcast-section" aria-label="Episodes">
        <div className="podcast-toolbar">
          <div className="podcast-page__tabs" role="group" aria-label="Episode filter">
            {FILTERS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                className={`artist-tab${entry.value === filter ? " is-active" : ""}`}
                aria-pressed={entry.value === filter}
                onClick={() => setFilter(entry.value)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <Select aria-label="Sort episodes" value={sort} options={SORTS} onChange={setSort} />
        </div>
        {episodesQuery.isPending ? (
          <SkeletonFeedPage label="Loading episodes" />
        ) : episodesQuery.isError ? (
          <StatePanel
            role="alert"
            icon={<AlertCircle />}
            title="Couldn't load episodes"
            onRetry={() => void episodesQuery.refetch()}
            retrying={episodesQuery.isFetching}
          />
        ) : episodes.length ? (
          <>
            <div className="podcast-episodes" role="list">
              {episodes.map((episode) => (
                <div role="listitem" key={episode.id}>
                  <EpisodeRow episode={episode} />
                </div>
              ))}
            </div>
            {episodesQuery.hasNextPage ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={episodesQuery.isFetchingNextPage}
                onClick={() => void episodesQuery.fetchNextPage()}
              >
                Show more episodes
              </button>
            ) : null}
          </>
        ) : (
          <StatePanel icon={<Mic />} title={EMPTY_MESSAGES[filter]} />
        )}
      </section>

      {dialog === "settings" && following ? (
        <PodcastSettingsDialog
          podcast={podcast}
          follow={following}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "unfollow" ? (
        <UnfollowDialog podcast={podcast} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}
