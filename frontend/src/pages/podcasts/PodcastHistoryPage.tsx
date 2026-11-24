import { Mic } from "../../components/icons";
import StatePanel from "../../components/StatePanel";
import { SkeletonFeedPage } from "../../components/Skeletons";
import { EpisodeList } from "../../components/podcasts/podcastUi";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { usePodcastHistory } from "../../hooks/usePodcasts";
import { PodcastsHeader } from "./podcastShared";

export default function PodcastHistoryPage() {
  useDocumentTitle("Podcast history");
  const history = usePodcastHistory();
  if (history.isPending) return <SkeletonFeedPage label="Loading your listening history" />;
  const episodes = history.data?.pages.flatMap((page) => page.episodes) ?? [];
  return (
    <div className="podcast-page">
      <PodcastsHeader />
      {history.isError ? (
        <StatePanel
          role="alert"
          icon={<Mic />}
          title="Couldn't load your listening history"
          onRetry={() => void history.refetch()}
          retrying={history.isFetching}
        />
      ) : episodes.length ? (
        <>
          <EpisodeList episodes={episodes} showPodcast removable />
          {history.hasNextPage ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Show more
            </button>
          ) : null}
        </>
      ) : (
        <StatePanel
          icon={<Mic />}
          title="Nothing here yet"
          message="Episodes you listen to will show up here."
        />
      )}
    </div>
  );
}
