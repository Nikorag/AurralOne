import { useState } from "react";
import { Mic } from "../../components/icons";
import { Select } from "../../components/Select";
import StatePanel from "../../components/StatePanel";
import { SkeletonFeedPage } from "../../components/Skeletons";
import { PodcastCard, podcastPath } from "../../components/podcasts/podcastUi";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { usePodcastLibrary } from "../../hooks/usePodcasts";
import { PodcastsHeader } from "./podcastShared";

const SORTS = [
  { value: "recent", label: "Recently updated" },
  { value: "name", label: "A to Z" },
  { value: "unplayed", label: "Most unplayed" },
] as const;

export default function PodcastLibraryPage() {
  useDocumentTitle("Following");
  const library = usePodcastLibrary();
  const [sort, setSort] = useState<(typeof SORTS)[number]["value"]>("recent");

  if (library.isPending) return <SkeletonFeedPage label="Loading your podcasts" />;
  if (library.isError) {
    return (
      <div className="podcast-page">
        <PodcastsHeader />
        <StatePanel
          role="alert"
          icon={<Mic />}
          title="Couldn't load your podcasts"
          onRetry={() => void library.refetch()}
          retrying={library.isFetching}
        />
      </div>
    );
  }

  const podcasts = [...library.data.podcasts];
  if (sort === "name") podcasts.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === "unplayed") podcasts.sort((a, b) => b.unplayed - a.unplayed);

  return (
    <div className="podcast-page">
      <PodcastsHeader />
      {podcasts.length ? (
        <>
          <div className="podcast-toolbar">
            <span className="podcast-feed-status">{podcasts.length} followed</span>
            <Select
              aria-label="Sort podcasts"
              value={sort}
              options={SORTS.map((entry) => ({ ...entry }))}
              onChange={setSort}
            />
          </div>
          <div className="podcast-grid">
            {podcasts.map((podcast) => (
              <PodcastCard
                key={podcast.id}
                podcast={podcast}
                to={podcastPath(podcast.id)}
                badge={podcast.unplayed > 0 ? `${podcast.unplayed} new` : null}
              />
            ))}
          </div>
        </>
      ) : (
        <StatePanel
          icon={<Mic />}
          title="You're not following any podcasts yet"
          message="Search for a show or paste an RSS feed URL to follow it."
        />
      )}
    </div>
  );
}
