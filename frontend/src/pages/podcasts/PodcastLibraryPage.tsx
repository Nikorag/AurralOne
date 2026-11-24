import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Mic } from "../../components/icons";
import { Select } from "../../components/Select";
import StatePanel from "../../components/StatePanel";
import { SkeletonFeedPage } from "../../components/Skeletons";
import { PodcastCard, podcastPath } from "../../components/podcasts/podcastUi";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useToast } from "../../contexts/ToastContext";
import {
  downloadOpml,
  invalidatePodcasts,
  useClearPodcastImports,
  useImportOpml,
  usePodcastImports,
  usePodcastLibrary,
} from "../../hooks/usePodcasts";
import { PodcastsHeader } from "./podcastShared";

const SORTS = [
  { value: "recent", label: "Recently updated" },
  { value: "name", label: "A to Z" },
  { value: "unplayed", label: "Most unplayed" },
] as const;

function OpmlControls() {
  const { showError } = useToast();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const importOpml = useImportOpml();
  const clear = useClearPodcastImports();
  const imports = usePodcastImports();
  const status = imports.data;
  const wasPending = useRef(0);

  useEffect(() => {
    if (wasPending.current > 0 && (status?.pending ?? 0) === 0)
      void invalidatePodcasts(queryClient);
    wasPending.current = status?.pending ?? 0;
  }, [queryClient, status?.pending]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2_000_000) {
      showError("That file is too large to be a podcast list");
      return;
    }
    importOpml.mutate(await file.text(), { onSuccess: () => void imports.refetch() });
    if (input.current) input.current.value = "";
  };

  return (
    <>
      <div className="podcast-hero__actions">
        <input
          ref={input}
          type="file"
          accept=".opml,.xml,text/xml,text/x-opml"
          hidden
          aria-label="Choose an OPML file"
          onChange={(event) => void choose(event.target.files?.[0])}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={importOpml.isPending}
          onClick={() => input.current?.click()}
        >
          Import OPML
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() =>
            void downloadOpml().catch(() => showError("Couldn't export your podcasts"))
          }
        >
          Export OPML
        </button>
      </div>
      {status && status.total > 0 ? (
        <section className="podcast-import" aria-live="polite">
          <p>
            {status.pending > 0
              ? `Importing: ${status.done + status.failed} of ${status.total} done`
              : `Imported ${status.done} ${status.done === 1 ? "podcast" : "podcasts"}${
                  status.failed ? `, ${status.failed} couldn't be added` : ""
                }`}
            {status.pending === 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={clear.isPending}
                onClick={() => clear.mutate()}
              >
                Dismiss
              </button>
            ) : null}
          </p>
          {status.failures.length ? (
            <ul className="podcast-import__failures">
              {status.failures.map((failure) => (
                <li key={failure.feedUrl}>
                  <span>{failure.title || failure.feedUrl}</span>
                  <span className="podcast-feed-status" data-tone="danger">
                    {failure.error}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

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
      <OpmlControls />
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
