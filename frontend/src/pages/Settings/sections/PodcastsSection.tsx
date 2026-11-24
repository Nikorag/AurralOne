import { DotLoader } from "../../../components/DotLoader";
import { Select } from "../../../components/Select";
import { formatBytes } from "../../../components/podcasts/podcastFormat";
import {
  usePodcastAdminAction,
  usePodcastAdminStatus,
  useSavePodcastAdminSettings,
} from "../../../hooks/usePodcasts";
import { SettingsCommitInput } from "../components/SettingsField";
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from "../SettingsLayout";
import "../../../components/podcasts/podcasts.css";

const GB = 1024 ** 3;
const INTERVALS = [15, 30, 60, 120, 360, 720, 1440];

const intervalLabel = (minutes: number) =>
  minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "1 hour" : `${minutes / 60} hours`;

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="podcast-admin__stat">
      <span className="podcast-admin__stat-value">{value}</span>
      <span className="podcast-admin__stat-label">{label}</span>
    </div>
  );
}

export function PodcastsSection() {
  const status = usePodcastAdminStatus();
  const save = useSavePodcastAdminSettings();
  const action = usePodcastAdminAction();
  const data = status.data;

  if (!data) {
    return (
      <SettingsPage title="Podcasts">
        {status.isError ? (
          <SettingsNote tone="error">Couldn&rsquo;t load podcast settings.</SettingsNote>
        ) : (
          <DotLoader size="sm" label="Loading podcast settings" />
        )}
      </SettingsPage>
    );
  }

  const { settings, storage, totals, queue, cleanup, failed, feedErrors, biggest, providers } =
    data;
  const limitGb = storage.limitBytes / GB;
  const usedShare = storage.limitBytes ? Math.min(1, storage.usedBytes / storage.limitBytes) : 0;
  const intervals = INTERVALS.includes(settings.refreshIntervalMinutes)
    ? INTERVALS
    : [...INTERVALS, settings.refreshIntervalMinutes].sort((a, b) => a - b);
  const podcastIndex = providers.find((provider) => provider.id === "podcastindex");

  return (
    <SettingsPage title="Podcasts">
      <SettingsGroup
        title="Storage"
        note={
          storage.pressure
            ? "Some episodes are waiting for space. Raise the limit or free space, and downloads continue on their own."
            : "Episodes are stored once and shared by everyone who follows the show."
        }
        actions={
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={action.isPending}
            onClick={() => action.mutate("reconcile")}
          >
            Check storage now
          </button>
        }
      >
        <div className="podcast-admin__stats">
          <Stat label="Used" value={formatBytes(storage.usedBytes)} />
          <Stat
            label="Available"
            value={
              storage.availableBytes === null ? "No limit" : formatBytes(storage.availableBytes)
            }
          />
          <Stat label="Episodes on server" value={totals.downloadedEpisodes} />
          <Stat
            label="Safe to remove"
            value={`${cleanup.episodes} · ${formatBytes(cleanup.bytes)}`}
          />
        </div>
        {storage.limitBytes ? (
          <div
            className="podcast-admin__meter"
            role="meter"
            aria-label="Podcast storage used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(usedShare * 100)}
            data-tone={usedShare > 0.9 ? "warning" : undefined}
          >
            <span style={{ width: `${usedShare * 100}%` }} />
          </div>
        ) : null}
        <SettingsRow
          label="Storage limit"
          htmlFor="podcast-storage-limit"
          help="In gigabytes. Use 0 for no limit. Episodes people keep are never removed to make room."
        >
          <SettingsCommitInput
            id="podcast-storage-limit"
            type="number"
            min={0}
            step={1}
            value={String(Number.isInteger(limitGb) ? limitGb : limitGb.toFixed(1))}
            onCommit={(value) => {
              const gb = Number(value);
              if (Number.isFinite(gb) && gb >= 0) {
                save.mutate({ storageLimitBytes: Math.round(gb * GB) });
              }
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Downloads"
        actions={
          queue.failed ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={action.isPending}
              onClick={() => action.mutate("retry-failed")}
            >
              Retry failed
            </button>
          ) : null
        }
      >
        <div className="podcast-admin__stats">
          <Stat label="Queued" value={queue.pending} />
          <Stat label="Downloading" value={queue.downloading} />
          <Stat label="Waiting for storage" value={queue.awaitingStorage} />
          <Stat label="Failed" value={queue.failed} />
        </div>
        {failed.map((item) => (
          <SettingsRow
            key={item.episode_id}
            label={item.title}
            help={`${item.podcast} · ${item.error ?? "Unknown error"} · ${item.attempts} attempts`}
            tone="error"
          />
        ))}
      </SettingsGroup>

      <SettingsGroup title="Feeds">
        <SettingsRow
          label="Check for new episodes every"
          help="Feeds are checked only when someone follows them, using the shortest wait each feed allows."
        >
          <Select
            aria-label="Feed refresh interval"
            value={settings.refreshIntervalMinutes}
            options={intervals.map((value) => ({ value, label: intervalLabel(value) }))}
            onChange={(refreshIntervalMinutes) => save.mutate({ refreshIntervalMinutes })}
          />
        </SettingsRow>
        <SettingsRow
          label="Refresh all followed feeds"
          help={`${totals.followedPodcasts} followed of ${totals.podcasts} podcasts, ${totals.episodes} episodes.`}
        >
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={action.isPending}
            onClick={() => action.mutate("refresh")}
          >
            Refresh now
          </button>
        </SettingsRow>
        {feedErrors.map((feed) => (
          <SettingsRow
            key={feed.podcast_id}
            label={feed.title}
            help={feed.last_error}
            tone="error"
          />
        ))}
      </SettingsGroup>

      <SettingsGroup
        title="Directories"
        note="Search and browse use these. Adding a show by RSS URL never needs one."
      >
        <SettingsRow label="Apple Podcasts" help="Always on. No account needed." />
        <SettingsRow
          label="Podcast Index key"
          htmlFor="podcast-index-key"
          help={
            podcastIndex?.available
              ? "Podcast Index is on."
              : "Optional. Get a free key at podcastindex.org to add its search, trending and new shows."
          }
        >
          <SettingsCommitInput
            id="podcast-index-key"
            value={settings.podcastIndexKey}
            autoComplete="off"
            onCommit={(podcastIndexKey) => save.mutate({ podcastIndexKey })}
          />
        </SettingsRow>
        <SettingsRow label="Podcast Index secret" htmlFor="podcast-index-secret">
          <SettingsCommitInput
            id="podcast-index-secret"
            type="password"
            autoComplete="new-password"
            placeholder={settings.hasPodcastIndexSecret ? "Saved" : ""}
            value=""
            onCommit={(podcastIndexSecret) => {
              if (podcastIndexSecret) save.mutate({ podcastIndexSecret });
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      {biggest.length ? (
        <SettingsGroup title="Largest shows on the server">
          {biggest.map((show) => (
            <SettingsRow key={show.id} label={show.title} help={`${show.episodes} episodes`}>
              {formatBytes(show.bytes)}
            </SettingsRow>
          ))}
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}
