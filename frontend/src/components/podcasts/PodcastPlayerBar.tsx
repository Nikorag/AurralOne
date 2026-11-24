import { useEffect, useId, useState } from "react";
import { Moon, Pause, Play, RotateCcw, SkipBack, SkipForward, Stop, X } from "../icons";
import { ModalBackdrop } from "../ModalBackdrop";
import RouteLink from "../RouteLink";
import { Select } from "../Select";
import TooltipButton from "../TooltipButton";
import { useModalDialog } from "../../hooks/useModalDialog";
import {
  PLAYBACK_RATES,
  SKIP_BACK_OPTIONS,
  SKIP_FORWARD_OPTIONS,
  usePodcastPlayer,
  usePodcastPosition,
} from "../../contexts/podcastPlayerContext";
import { formatPlaybackTime } from "../../utils/playbackTime";
import {
  SLEEP_MINUTES,
  sleepLabel,
  sleepOptionOf,
  sleepRemaining,
  type SleepOption,
} from "../../utils/podcastSleep";
import { PodcastArt, podcastPath } from "./podcastUi";
import { formatLength } from "./podcastFormat";

const rateLabel = (rate: number) => `${rate}×`;

const SLEEP_OPTIONS: SleepOption[] = ["off", ...SLEEP_MINUTES, "episode"];

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function SleepChip({ onClick }: { onClick: () => void }) {
  const { sleep } = usePodcastPlayer();
  const now = useNow(sleep.mode === "time");
  if (sleep.mode === "off") return null;
  const remaining = sleepRemaining(sleep, now);
  return (
    <button type="button" className="btn btn-ghost btn-xs" onClick={onClick}>
      <Moon className="artist-icon-sm" aria-hidden="true" />
      {remaining === null ? "End of episode" : formatPlaybackTime(remaining)}
    </button>
  );
}

function Seek() {
  const player = usePodcastPlayer();
  const { position, duration: measured } = usePodcastPosition();
  const duration = measured || player.episode?.durationSeconds || 0;
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? position;
  const remaining = Math.max(0, duration - shown);
  return (
    <div className="podcast-player__progress">
      <span className="podcast-player__time">{formatPlaybackTime(shown)}</span>
      <input
        type="range"
        className="podcast-player__seek"
        min={0}
        max={Math.max(1, Math.floor(duration))}
        step={1}
        value={Math.min(shown, Math.max(1, duration))}
        disabled={!duration}
        aria-label="Seek"
        aria-valuetext={`${formatPlaybackTime(shown)} of ${formatPlaybackTime(duration)}`}
        onChange={(event) => setScrub(Number(event.target.value))}
        onPointerUp={() => {
          if (scrub !== null) player.seek(scrub);
          setScrub(null);
        }}
        onKeyUp={() => {
          if (scrub !== null) player.seek(scrub);
          setScrub(null);
        }}
        onBlur={() => setScrub(null)}
      />
      <span className="podcast-player__time">
        {duration ? `-${formatPlaybackTime(remaining)}` : "--:--"}
      </span>
    </div>
  );
}

function MiniProgress() {
  const player = usePodcastPlayer();
  const { position, duration: measured } = usePodcastPosition();
  const duration = measured || player.episode?.durationSeconds || 0;
  return (
    <span
      className={`global-player__mini-progress${player.isPlaying ? " is-playing" : ""}`}
      aria-hidden="true"
      style={{ "--progress": duration ? Math.min(1, position / duration) : 0 }}
    >
      <span />
    </span>
  );
}

export function PodcastNowPlaying({ onClose }: { onClose: () => void }) {
  const player = usePodcastPlayer();
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({ open: true, onClose });
  const { episode } = player;
  if (!episode) return null;
  return (
    <ModalBackdrop onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artist-modal podcast-now"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <PodcastArt src={episode.imageUrl} className="podcast-now__art" />
        <div className="podcast-now__head">
          <h3 id={titleId} className="podcast-now__title">
            {episode.title}
          </h3>
          <p className="podcast-now__show">
            <RouteLink to={podcastPath(episode.podcastId)} onClick={onClose}>
              {episode.podcastTitle}
            </RouteLink>
          </p>
          {player.error ? (
            <p className="artist-modal__error" role="alert">
              {player.error}
            </p>
          ) : null}
        </div>
        <Seek />
        <div className="podcast-now__controls">
          <TooltipButton
            label={`Back ${player.skipBack} seconds`}
            className="btn btn-ghost btn-icon podcast-now__skip"
            onClick={() => player.skip(-1)}
          >
            <RotateCcw aria-hidden="true" />
            <span>{player.skipBack}</span>
          </TooltipButton>
          <button
            type="button"
            className="podcast-play"
            aria-label={player.isPlaying ? "Pause" : "Play"}
            aria-busy={player.isLoading || undefined}
            onClick={player.toggle}
          >
            {player.isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </button>
          <TooltipButton
            label={`Forward ${player.skipForward} seconds`}
            className="btn btn-ghost btn-icon podcast-now__skip"
            onClick={() => player.skip(1)}
          >
            <span>{player.skipForward}</span>
            <SkipForward aria-hidden="true" />
          </TooltipButton>
        </div>
        <div className="podcast-now__options">
          <label>
            Speed{" "}
            <Select
              aria-label="Playback speed"
              value={player.rate}
              options={PLAYBACK_RATES.map((rate) => ({ value: rate, label: rateLabel(rate) }))}
              onChange={player.setRate}
            />
          </label>
          <label>
            Sleep timer{" "}
            <Select
              aria-label="Sleep timer"
              value={sleepOptionOf(player.sleep, Date.now())}
              options={SLEEP_OPTIONS.map((value) => ({ value, label: sleepLabel(value) }))}
              onChange={player.setSleep}
            />
          </label>
          <label>
            Back{" "}
            <Select
              aria-label="Skip back interval"
              value={player.skipBack}
              options={SKIP_BACK_OPTIONS.map((value) => ({ value, label: `${value}s` }))}
              onChange={(back) => player.setSkip({ back })}
            />
          </label>
          <label>
            Forward{" "}
            <Select
              aria-label="Skip forward interval"
              value={player.skipForward}
              options={SKIP_FORWARD_OPTIONS.map((value) => ({ value, label: `${value}s` }))}
              onChange={(forward) => player.setSkip({ forward })}
            />
          </label>
        </div>
        {player.queue.length ? (
          <section className="podcast-now__queue" aria-label="Up next">
            <h4 className="podcast-section__title">Up next</h4>
            {player.queue.map((item) => (
              <div key={item.id} className="podcast-now__queue-item">
                <span className="podcast-now__queue-title">
                  {item.title}
                  {item.durationSeconds ? ` · ${formatLength(item.durationSeconds)}` : ""}
                </span>
                <span>
                  <TooltipButton
                    label="Play now"
                    className="btn btn-ghost btn-icon btn-xs"
                    onClick={() => player.play(item)}
                  >
                    <Play aria-hidden="true" />
                  </TooltipButton>
                  <TooltipButton
                    label="Remove from queue"
                    className="btn btn-ghost btn-icon btn-xs"
                    onClick={() => player.removeFromQueue(item.id)}
                  >
                    <X aria-hidden="true" />
                  </TooltipButton>
                </span>
              </div>
            ))}
          </section>
        ) : null}
        {episode.description ? (
          <p className="podcast-now__description">{episode.description}</p>
        ) : null}
        <div className="artist-modal__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

export function PodcastPlayerBar() {
  const player = usePodcastPlayer();
  const [open, setOpen] = useState(false);
  const { episode } = player;
  if (!episode) return null;
  const nextRate = () => {
    const index = PLAYBACK_RATES.findIndex((rate) => rate === player.rate);
    player.setRate(PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1);
  };
  const playLabel = player.isPlaying ? "Pause" : "Play";

  return (
    <div className="global-player podcast-player" role="region" aria-label="Podcast player">
      <div className="global-player__mini">
        <MiniProgress />
        <button
          type="button"
          className="global-player__mini-open"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label={`Open now playing: ${episode.title}`}
        >
          <PodcastArt
            src={episode.imageUrl}
            className="global-player__art global-player__art--mini"
          />
          <span className="global-player__mini-copy">
            <span className="global-player__title">{episode.title}</span>
            <span className="global-player__subtitle">{player.error || episode.podcastTitle}</span>
          </span>
        </button>
        <button
          type="button"
          className="global-player__mini-control"
          onClick={() => player.skip(-1)}
          aria-label={`Back ${player.skipBack} seconds`}
        >
          <SkipBack aria-hidden="true" />
        </button>
        <button
          type="button"
          className="global-player__mini-control"
          onClick={player.toggle}
          aria-busy={player.isLoading || undefined}
          aria-label={playLabel}
        >
          {player.isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="global-player__mini-control"
          onClick={() => player.skip(1)}
          aria-label={`Forward ${player.skipForward} seconds`}
        >
          <SkipForward aria-hidden="true" />
        </button>
      </div>

      <div className="global-player__inner">
        <div className="global-player__track">
          <button
            type="button"
            className="global-player__minimize"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-label="Open now playing"
          >
            <PodcastArt
              src={episode.imageUrl}
              className="global-player__art global-player__art--bar"
            />
          </button>
          <div className="global-player__meta">
            <span className="global-player__title">
              <RouteLink to={podcastPath(episode.podcastId)} className="global-player__link">
                {episode.title}
              </RouteLink>
            </span>
            <span className="global-player__subtitle">{episode.podcastTitle}</span>
            {player.error ? (
              <span className="global-player__error" role="alert">
                {player.error}
              </span>
            ) : null}
          </div>
        </div>

        <div className="global-player__main">
          <div className="global-player__controls">
            <TooltipButton
              tooltipPlacement="top"
              label={`Back ${player.skipBack} seconds`}
              onClick={() => player.skip(-1)}
              className="btn btn-secondary btn-sm btn-icon global-player__control"
            >
              <RotateCcw className="artist-icon-sm" />
            </TooltipButton>
            <TooltipButton
              tooltipPlacement="top"
              label={playLabel}
              onClick={player.toggle}
              aria-busy={player.isLoading || undefined}
              className="btn btn-accent btn-sm btn-icon global-player__control global-player__control--primary"
            >
              {player.isPlaying ? (
                <Pause className="artist-icon-sm" />
              ) : (
                <Play className="artist-icon-sm" />
              )}
            </TooltipButton>
            <TooltipButton
              tooltipPlacement="top"
              label={`Forward ${player.skipForward} seconds`}
              onClick={() => player.skip(1)}
              className="btn btn-secondary btn-sm btn-icon global-player__control"
            >
              <SkipForward className="artist-icon-sm" />
            </TooltipButton>
            <TooltipButton
              tooltipPlacement="top"
              label="Playback speed"
              onClick={nextRate}
              className="btn btn-secondary btn-sm global-player__control podcast-player__speed"
            >
              {rateLabel(player.rate)}
            </TooltipButton>
          </div>
          <Seek />
        </div>

        <div className="global-player__side">
          <SleepChip onClick={() => setOpen(true)} />
          {player.queue.length ? (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setOpen(true)}>
              Up next · {player.queue.length}
            </button>
          ) : null}
          <TooltipButton
            tooltipPlacement="top"
            label="Stop and close"
            onClick={player.stop}
            className="btn btn-ghost btn-icon btn-xs"
          >
            <Stop className="artist-icon-sm" />
          </TooltipButton>
        </div>
      </div>
      {open ? <PodcastNowPlaying onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
