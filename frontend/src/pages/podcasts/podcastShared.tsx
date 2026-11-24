import { useState, type FormEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { AlertCircle, Search } from "../../components/icons";
import RouteLink from "../../components/RouteLink";
import { SkeletonRail } from "../../components/Skeletons";
import {
  directoryCardPodcast,
  PodcastCard,
  podcastPath,
} from "../../components/podcasts/podcastUi";
import { useImportPodcast, type DirectoryPodcast } from "../../hooks/usePodcasts";
import { getApiErrorMessage } from "../../utils/api/errors";
import "../../components/podcasts/podcasts.css";

const TABS = [
  { to: "/podcasts", label: "Home" },
  { to: "/podcasts/library", label: "Following" },
  { to: "/podcasts/history", label: "History" },
] as const;

export function PodcastsHeader({ title = "Podcasts" }: { title?: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [term, setTerm] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = term.trim();
    if (value) void navigate(`/podcasts/search?q=${encodeURIComponent(value)}`);
  };
  return (
    <header className="podcast-page__header">
      <h1 className="page-title">{title}</h1>
      <form className="podcast-search" onSubmit={submit} role="search">
        <input
          type="search"
          className="input"
          value={term}
          placeholder="Search podcasts or paste an RSS feed URL"
          aria-label="Search podcasts or add an RSS feed"
          onChange={(event) => setTerm(event.target.value)}
        />
        <button type="submit" className="btn btn-secondary" disabled={term.trim().length < 2}>
          <Search className="artist-icon-sm" aria-hidden="true" />
          Search
        </button>
      </form>
      <nav className="podcast-page__tabs" aria-label="Podcast sections">
        {TABS.map((tab) => (
          <RouteLink
            key={tab.to}
            to={tab.to}
            className={`artist-tab${pathname === tab.to ? " is-active" : ""}`}
            aria-current={pathname === tab.to ? "page" : undefined}
          >
            {tab.label}
          </RouteLink>
        ))}
      </nav>
    </header>
  );
}

export function PodcastSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="podcast-section" aria-label={title}>
      <div className="podcast-section__head">
        <h2 className="podcast-section__title">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PodcastNotice({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <p className="podcast-notice" role="alert">
      <AlertCircle aria-hidden="true" />
      <span>{children}</span>
      {onRetry ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </p>
  );
}

export function useOpenDirectoryPodcast() {
  const navigate = useNavigate();
  const importPodcast = useImportPodcast();
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const open = async (podcast: DirectoryPodcast) => {
    if (podcast.podcastId) {
      void navigate(podcastPath(podcast.podcastId));
      return;
    }
    if (!podcast.feedUrl) return;
    const key = `${podcast.provider}:${podcast.externalId}`;
    setOpeningKey(key);
    try {
      const { podcast: imported } = await importPodcast.mutateAsync({
        feedUrl: podcast.feedUrl,
        provider: podcast.provider,
        externalId: podcast.externalId,
      });
      if (imported) void navigate(podcastPath(imported.id));
    } catch {
      return;
    } finally {
      setOpeningKey(null);
    }
  };
  return { open, openingKey };
}

export function DirectoryResults({
  podcasts,
  rail = false,
}: {
  podcasts: DirectoryPodcast[];
  rail?: boolean;
}) {
  const { open, openingKey } = useOpenDirectoryPodcast();
  const cards = podcasts.map((podcast) => {
    const key = `${podcast.provider}:${podcast.externalId}`;
    return (
      <div key={key} className={rail ? "podcast-card is-rail" : undefined}>
        <PodcastCard
          podcast={directoryCardPodcast(podcast)}
          onOpen={() => void open(podcast)}
          busy={openingKey === key}
          badge={podcast.following ? "Following" : null}
        />
      </div>
    );
  });
  return rail ? (
    <div className="podcast-rail">{cards}</div>
  ) : (
    <div className="podcast-grid">{cards}</div>
  );
}

export const PodcastRailSkeleton = () => <SkeletonRail count={7} kind="album" />;

export const errorText = (error: unknown, fallback: string) => getApiErrorMessage(error, fallback);
