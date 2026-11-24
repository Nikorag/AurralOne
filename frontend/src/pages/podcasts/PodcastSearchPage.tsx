import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Plus, Search } from "../../components/icons";
import StatePanel from "../../components/StatePanel";
import { SkeletonSearchResults } from "../../components/Skeletons";
import { podcastPath } from "../../components/podcasts/podcastUi";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useImportPodcast, usePodcastSearch } from "../../hooks/usePodcasts";
import { DirectoryResults, errorText, PodcastsHeader } from "./podcastShared";

const looksLikeUrl = (value: string) => /^(https?|feed):\/\//i.test(value.trim());

function AddFeed({ url }: { url: string }) {
  const navigate = useNavigate();
  const importPodcast = useImportPodcast();
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      const { podcast } = await importPodcast.mutateAsync({ feedUrl: url });
      if (podcast) void navigate(podcastPath(podcast.id));
    } catch (failure) {
      setError(errorText(failure, "This URL doesn't have a usable podcast feed"));
    }
  };
  return (
    <StatePanel
      icon={<Plus />}
      title="Add this RSS feed"
      message={url}
      role={error ? "alert" : undefined}
    >
      {error ? <p className="artist-modal__error">{error}</p> : null}
      <button
        type="button"
        className="btn btn-primary"
        disabled={importPodcast.isPending}
        onClick={() => void add()}
      >
        {importPodcast.isPending ? "Checking feed…" : "Add podcast"}
      </button>
    </StatePanel>
  );
}

export default function PodcastSearchPage() {
  const [params] = useSearchParams();
  const term = (params.get("q") ?? "").trim();
  useDocumentTitle(term ? `Podcasts: ${term}` : "Search podcasts");
  const isUrl = looksLikeUrl(term);
  const search = usePodcastSearch(isUrl ? "" : term);
  return (
    <div className="podcast-page">
      <PodcastsHeader title="Search podcasts" />
      {isUrl ? (
        <AddFeed url={term} />
      ) : search.isPending && term.length >= 2 ? (
        <SkeletonSearchResults />
      ) : search.isError ? (
        <StatePanel
          role="alert"
          icon={<Search />}
          title="Couldn't load search results"
          message={errorText(search.error, "The podcast directories didn't respond.")}
          onRetry={() => void search.refetch()}
          retrying={search.isFetching}
        />
      ) : search.data?.podcasts.length ? (
        <DirectoryResults podcasts={search.data.podcasts} />
      ) : (
        <StatePanel
          icon={<Search />}
          title={term.length >= 2 ? `No podcasts found for "${term}"` : "Search for a podcast"}
          message="You can also paste a podcast's RSS feed URL to add it directly."
        />
      )}
    </div>
  );
}
