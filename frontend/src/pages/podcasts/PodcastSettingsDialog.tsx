import { useId, useState } from "react";
import { ModalBackdrop } from "../../components/ModalBackdrop";
import PillToggle from "../../components/PillToggle";
import { Select } from "../../components/Select";
import { useModalDialog } from "../../hooks/useModalDialog";
import {
  useUnfollowPodcast,
  useUpdatePodcastSettings,
  type Podcast,
} from "../../hooks/usePodcasts";

const KEEP_OPTIONS = [1, 3, 5, 10, 20, 50, 100, 200];

type Follow = NonNullable<Podcast["follow"]>;

export function PodcastSettingsDialog({
  podcast,
  follow,
  onClose,
}: {
  podcast: Podcast;
  follow: Follow;
  onClose: () => void;
}) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({ open: true, onClose });
  const update = useUpdatePodcastSettings();
  const save = (change: Parameters<typeof update.mutate>[0]) => update.mutate(change);
  const keepOptions = KEEP_OPTIONS.includes(follow.keepLatest)
    ? KEEP_OPTIONS
    : [...KEEP_OPTIONS, follow.keepLatest].sort((a, b) => a - b);

  return (
    <ModalBackdrop onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artist-modal podcast-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="podcast-dialog__title">
          {podcast.title}
        </h3>
        <div className="podcast-settings">
          <div className="podcast-settings__row">
            <span>
              Download new episodes automatically
              <span className="podcast-settings__help">
                Off means episodes only download when you ask.
              </span>
            </span>
            <PillToggle
              aria-label="Download new episodes automatically"
              checked={follow.autoDownload}
              onChange={(event) => save({ id: podcast.id, autoDownload: event.target.checked })}
            />
          </div>
          <div className="podcast-settings__row">
            <span>
              Notify me about new episodes
              <span className="podcast-settings__help">
                Adds them to your Inbox, and to any webhook that listens for podcast episodes.
              </span>
            </span>
            <PillToggle
              aria-label="Notify me about new episodes"
              checked={follow.notify}
              onChange={(event) => save({ id: podcast.id, notify: event.target.checked })}
            />
          </div>
          <div className="podcast-settings__row">
            <span>
              Keep the latest
              <span className="podcast-settings__help">
                How many recent episodes stay on the server for you.
              </span>
            </span>
            <Select
              aria-label="Episodes to keep"
              value={follow.keepLatest}
              disabled={!follow.autoDownload}
              options={keepOptions.map((value) => ({ value, label: `${value} episodes` }))}
              onChange={(keepLatest) => save({ id: podcast.id, keepLatest })}
            />
          </div>
          <div className="podcast-settings__row">
            <span>
              Remove played episodes
              <span className="podcast-settings__help">
                Played episodes leave your downloads. Your progress stays.
              </span>
            </span>
            <PillToggle
              aria-label="Remove played episodes"
              checked={follow.removePlayed}
              onChange={(event) => save({ id: podcast.id, removePlayed: event.target.checked })}
            />
          </div>
        </div>
        <div className="podcast-dialog__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

export function UnfollowDialog({ podcast, onClose }: { podcast: Podcast; onClose: () => void }) {
  const titleId = useId();
  const unfollow = useUnfollowPodcast();
  const [removeHistory, setRemoveHistory] = useState(false);
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: true,
    onClose,
    closeDisabled: unfollow.isPending,
  });
  return (
    <ModalBackdrop onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artist-modal podcast-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="podcast-dialog__title">
          Unfollow {podcast.title}?
        </h3>
        <p className="artist-modal__subcopy">
          Your downloads of this show are released. Other people who follow it keep theirs.
        </p>
        <label className="podcast-settings__row">
          <span>
            Also erase my listening history for this show
            <span className="podcast-settings__help">
              Leave this off to keep your progress if you follow again.
            </span>
          </span>
          <input
            type="checkbox"
            checked={removeHistory}
            onChange={(event) => setRemoveHistory(event.target.checked)}
          />
        </label>
        <div className="podcast-dialog__actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={unfollow.isPending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={unfollow.isPending}
            onClick={() =>
              unfollow.mutate({ id: podcast.id, removeHistory }, { onSuccess: onClose })
            }
          >
            Unfollow
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
