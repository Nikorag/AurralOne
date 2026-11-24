import { Mic } from "../../components/icons";
import RouteLink from "../../components/RouteLink";
import StatePanel from "../../components/StatePanel";
import { SkeletonFeedPage } from "../../components/Skeletons";
import { EpisodeList, PodcastCard, podcastPath } from "../../components/podcasts/podcastUi";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { usePodcastDiscover, usePodcastHome } from "../../hooks/usePodcasts";
import {
  DirectoryResults,
  PodcastNotice,
  PodcastRailSkeleton,
  PodcastSection,
  PodcastsHeader,
} from "./podcastShared";

function Discover({ categories }: { categories: { id: string; label: string }[] }) {
  const discover = usePodcastDiscover();
  const data = discover.data;
  return (
    <>
      {discover.isPending ? (
        <PodcastSection title="Recommended for you">
          <PodcastRailSkeleton />
        </PodcastSection>
      ) : null}
      {discover.isError || data?.unavailable ? (
        <PodcastNotice onRetry={() => void discover.refetch()}>
          {"Couldn't load podcast directories. Following and searching by RSS still work."}
        </PodcastNotice>
      ) : null}
      {data?.recommended.podcasts.length ? (
        <PodcastSection title="Recommended for you">
          <DirectoryResults podcasts={data.recommended.podcasts} rail />
        </PodcastSection>
      ) : null}
      {data?.trending.length ? (
        <PodcastSection title="Popular and trending">
          <DirectoryResults podcasts={data.trending} rail />
        </PodcastSection>
      ) : null}
      {data?.newShows.length ? (
        <PodcastSection title="New shows">
          <DirectoryResults podcasts={data.newShows} rail />
        </PodcastSection>
      ) : null}
      <PodcastSection title="Browse categories">
        <div className="podcast-categories">
          {categories.map((category) => (
            <RouteLink
              key={category.id}
              to={`/podcasts/category/${category.id}`}
              className="artist-tab"
            >
              {category.label}
            </RouteLink>
          ))}
        </div>
      </PodcastSection>
    </>
  );
}

export default function PodcastsPage() {
  useDocumentTitle("Podcasts");
  const home = usePodcastHome();
  const data = home.data;

  if (home.isPending) return <SkeletonFeedPage label="Loading podcasts" />;
  if (home.isError || !data) {
    return (
      <div className="podcast-page">
        <PodcastsHeader />
        <StatePanel
          role="alert"
          icon={<Mic />}
          title="Couldn't load podcasts"
          message="Check your connection and try again."
          onRetry={() => void home.refetch()}
          retrying={home.isFetching}
        />
      </div>
    );
  }

  const empty =
    !data.continueListening.length && !data.newEpisodes.length && !data.following.length;

  return (
    <div className="podcast-page">
      <PodcastsHeader />
      {data.continueListening.length ? (
        <PodcastSection title="Continue listening">
          <EpisodeList episodes={data.continueListening.slice(0, 5)} showPodcast />
        </PodcastSection>
      ) : null}
      {data.newEpisodes.length ? (
        <PodcastSection title="New episodes">
          <EpisodeList episodes={data.newEpisodes.slice(0, 10)} showPodcast />
        </PodcastSection>
      ) : null}
      {data.following.length ? (
        <PodcastSection
          title="Following"
          action={
            <RouteLink to="/podcasts/library" className="section-show-all">
              Show all
            </RouteLink>
          }
        >
          <div className="podcast-rail">
            {data.following.map((podcast) => (
              <div key={podcast.id} className="podcast-card is-rail">
                <PodcastCard
                  podcast={podcast}
                  to={podcastPath(podcast.id)}
                  badge={podcast.unplayed > 0 ? `${podcast.unplayed} new` : null}
                />
              </div>
            ))}
          </div>
        </PodcastSection>
      ) : null}
      {data.recentlyPlayed.length ? (
        <PodcastSection title="Recently played">
          <div className="podcast-rail">
            {data.recentlyPlayed.map((podcast) => (
              <div key={podcast.id} className="podcast-card is-rail">
                <PodcastCard podcast={podcast} to={podcastPath(podcast.id)} />
              </div>
            ))}
          </div>
        </PodcastSection>
      ) : null}
      {empty ? (
        <StatePanel
          icon={<Mic />}
          title="Follow a podcast to get started"
          message="Pick something below, search for a show, or paste an RSS feed URL."
        />
      ) : null}
      <Discover categories={data.categories} />
    </div>
  );
}
