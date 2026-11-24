import { useParams } from "react-router";
import { Mic } from "../../components/icons";
import StatePanel from "../../components/StatePanel";
import { SkeletonSearchResults } from "../../components/Skeletons";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { usePodcastCategory, usePodcastHome } from "../../hooks/usePodcasts";
import { DirectoryResults, errorText, PodcastsHeader } from "./podcastShared";

export default function PodcastCategoryPage() {
  const { category = "" } = useParams();
  const home = usePodcastHome();
  const label = home.data?.categories.find((entry) => entry.id === category)?.label ?? "Category";
  useDocumentTitle(`${label} podcasts`);
  const podcasts = usePodcastCategory(category);
  return (
    <div className="podcast-page">
      <PodcastsHeader title={label} />
      {podcasts.isPending ? (
        <SkeletonSearchResults />
      ) : podcasts.isError ? (
        <StatePanel
          role="alert"
          icon={<Mic />}
          title="Couldn't load this category"
          message={errorText(podcasts.error, "The podcast directories didn't respond.")}
          onRetry={() => void podcasts.refetch()}
          retrying={podcasts.isFetching}
        />
      ) : podcasts.data.podcasts.length ? (
        <DirectoryResults podcasts={podcasts.data.podcasts} />
      ) : (
        <StatePanel icon={<Mic />} title="No podcasts in this category right now" />
      )}
    </div>
  );
}
