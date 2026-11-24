import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAudioQueue } from "./audioQueueContext.ts";
import {
  PLAYBACK_RATES,
  PodcastPlayerContext,
  PodcastPositionContext,
  type PodcastPlayerValue,
  type PodcastPositionStore,
} from "./podcastPlayerContext.ts";
import { invalidatePodcasts, type PodcastEpisode } from "../hooks/usePodcasts.ts";
import { buildAuthenticatedApiUrl } from "../utils/api/core.ts";
import { podcastsClient } from "../utils/api/clients/podcasts.ts";
import { mediaSessionArtwork } from "../utils/mediaSession.ts";
import {
  sleepTimerFor,
  stopsAtEnd,
  type SleepOption,
  type SleepTimer,
} from "../utils/podcastSleep.ts";

const RATE_KEY = "podcastRate";
const SKIP_KEY = "podcastSkip";
const DEVICE_KEY = "podcastDeviceId";
const SAVE_EVERY_MS = 15_000;
const RESTART_WITHIN_SECONDS = 30;

const readNumber = (key: string, fallback: number) => {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

const readSkip = () => {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(SKIP_KEY) ?? "{}");
    const record = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
    const pick = (value: unknown, fallback: number) =>
      typeof value === "number" && value > 0 && value <= 300 ? value : fallback;
    return { back: pick(record.back, 15), forward: pick(record.forward, 30) };
  } catch {
    return { back: 15, forward: 30 };
  }
};

const deviceId = () => {
  try {
    let id = window.localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "browser";
  }
};

const sourceFor = (episode: PodcastEpisode) =>
  episode.audioUrl.startsWith("/api/")
    ? buildAuthenticatedApiUrl(episode.audioUrl.slice("/api".length))
    : episode.audioUrl;

const startPosition = (episode: PodcastEpisode) => {
  const { positionSeconds, played } = episode.progress;
  const duration = episode.durationSeconds ?? 0;
  if (positionSeconds < 5) return 0;
  if (played && duration > 0 && positionSeconds >= duration - RESTART_WITHIN_SECONDS) return 0;
  return positionSeconds;
};

export function PodcastPlayerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const music = useAudioQueue();
  const audio = useMemo(() => {
    const element = new Audio();
    element.preload = "metadata";
    return element;
  }, []);

  const [episode, setEpisode] = useState<PodcastEpisode | null>(null);
  const [queue, setQueue] = useState<PodcastEpisode[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRateState] = useState(() => readNumber(RATE_KEY, 1));
  const [skipIntervals, setSkipIntervals] = useState(readSkip);
  const [lastPlayer, setLastPlayer] = useState<"podcast" | "music">("podcast");
  const [sleep, setSleepState] = useState<SleepTimer>({ mode: "off" });
  const sleepRef = useRef(sleep);
  sleepRef.current = sleep;

  const episodeRef = useRef<PodcastEpisode | null>(null);
  const queueRef = useRef<PodcastEpisode[]>([]);
  const musicRef = useRef(music);
  musicRef.current = music;
  const playbackRate = useRef(rate);
  playbackRate.current = rate;

  const snapshot = useRef({ position: 0, duration: 0 });
  const listeners = useRef(new Set<() => void>());
  const positionStore = useMemo<PodcastPositionStore>(
    () => ({
      subscribe(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      getSnapshot: () => snapshot.current,
    }),
    [],
  );
  const publishPosition = useCallback(() => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const position = audio.currentTime;
    const current = snapshot.current;
    if (Math.abs(current.position - position) < 0.5 && current.duration === duration) return;
    snapshot.current = { position, duration };
    for (const listener of listeners.current) listener();
  }, [audio]);

  const save = useCallback(
    (ended = false, keepalive = false) => {
      const current = episodeRef.current;
      if (!current) return;
      const duration = Number.isFinite(audio.duration) ? audio.duration : undefined;
      void parseResponse(
        podcastsClient.episodes[":id"].progress.$put(
          {
            param: { id: String(current.id) },
            json: {
              positionSeconds: audio.currentTime,
              durationSeconds: duration,
              clientTime: Date.now(),
              deviceId: deviceId(),
              ended,
            },
          },
          { init: { keepalive } },
        ),
      ).catch(() => undefined);
    },
    [audio],
  );

  const refreshLists = useCallback(() => {
    void invalidatePodcasts(queryClient);
  }, [queryClient]);

  const load = useCallback(
    (next: PodcastEpisode) => {
      episodeRef.current = next;
      setEpisode(next);
      setError(null);
      setIsLoading(true);
      setLastPlayer("podcast");
      audio.src = sourceFor(next);
      audio.playbackRate = playbackRate.current;
      const resumeAt = startPosition(next);
      const onReady = () => {
        if (resumeAt > 0 && audio.currentTime < 1) audio.currentTime = resumeAt;
        publishPosition();
      };
      audio.addEventListener("loadedmetadata", onReady, { once: true });
      void audio.play().catch((failure: unknown) => {
        if (failure instanceof DOMException && failure.name === "AbortError") return;
        setIsLoading(false);
        setError(
          next.download.state === "downloaded"
            ? "Couldn't play this episode"
            : "Couldn't stream this episode. Download it to play it from your server.",
        );
      });
      void parseResponse(podcastsClient.episodes[":id"].$get({ param: { id: String(next.id) } }))
        .then(({ episode: fresh }) => {
          if (episodeRef.current?.id !== next.id || !fresh) return;
          const ahead = fresh.progress.positionSeconds;
          if (fresh.progress.updatedAt > next.progress.updatedAt && ahead > audio.currentTime + 5) {
            if (audio.currentTime < 30) audio.currentTime = ahead;
          }
        })
        .catch(() => undefined);
    },
    [audio, publishPosition],
  );

  const pauseMusic = useCallback(() => {
    if (musicRef.current.isPlaying) musicRef.current.togglePlayPause();
  }, []);

  const play = useCallback(
    (next: PodcastEpisode) => {
      pauseMusic();
      const current = episodeRef.current;
      if (current?.id === next.id) {
        setLastPlayer("podcast");
        if (audio.paused) void audio.play();
        return;
      }
      if (current) save();
      setQueue((items) => items.filter((item) => item.id !== next.id));
      load(next);
    },
    [audio, load, pauseMusic, save],
  );

  const playNext = useCallback(() => {
    const [next, ...rest] = queueRef.current;
    if (!next) return;
    if (episodeRef.current) save();
    setQueue(rest);
    load(next);
  }, [load, save]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    const onPlaying = () => {
      setIsPlaying(true);
      setIsLoading(false);
    };
    const onPause = () => {
      setIsPlaying(false);
      if (!audio.ended) {
        save();
        refreshLists();
      }
    };
    const onWaiting = () => setIsLoading(true);
    const onEnded = () => {
      setIsPlaying(false);
      save(true);
      refreshLists();
      if (stopsAtEnd(sleepRef.current)) setSleepState({ mode: "off" });
      else if (queueRef.current.length) playNext();
    };
    const onError = () => {
      if (!audio.src || !episodeRef.current) return;
      setIsPlaying(false);
      setIsLoading(false);
      setError(
        episodeRef.current.download.state === "downloaded"
          ? "Couldn't play this episode"
          : "Couldn't stream this episode. Download it to play it from your server.",
      );
    };
    const onRate = () => setRateState(audio.playbackRate);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.addEventListener("timeupdate", publishPosition);
    audio.addEventListener("durationchange", publishPosition);
    audio.addEventListener("loadedmetadata", publishPosition);
    audio.addEventListener("ratechange", onRate);
    return () => {
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("timeupdate", publishPosition);
      audio.removeEventListener("durationchange", publishPosition);
      audio.removeEventListener("loadedmetadata", publishPosition);
      audio.removeEventListener("ratechange", onRate);
    };
  }, [audio, playNext, publishPosition, refreshLists, save]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    const timer = window.setInterval(() => save(), SAVE_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [isPlaying, save]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden" && episodeRef.current) save(false, true);
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, [save]);

  useEffect(() => {
    audio.volume = music.volume;
    audio.muted = music.muted;
  }, [audio, music.volume, music.muted]);

  useEffect(() => {
    if (sleep.mode !== "time") return undefined;
    const timer = window.setTimeout(
      () => {
        audio.pause();
        setSleepState({ mode: "off" });
      },
      Math.max(0, sleep.endsAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [audio, sleep]);

  const setSleep = useCallback(
    (option: SleepOption) => setSleepState(sleepTimerFor(option, Date.now())),
    [],
  );

  const musicWasPlaying = useRef(music.isPlaying);
  useEffect(() => {
    if (music.isPlaying && !musicWasPlaying.current) {
      setLastPlayer("music");
      if (!audio.paused) audio.pause();
    }
    musicWasPlaying.current = music.isPlaying;
  }, [audio, music.isPlaying]);

  const toggle = useCallback(() => {
    if (!episodeRef.current) return;
    if (audio.paused) {
      pauseMusic();
      setLastPlayer("podcast");
      void audio.play();
    } else audio.pause();
  }, [audio, pauseMusic]);

  const seek = useCallback(
    (seconds: number) => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : Infinity;
      audio.currentTime = Math.max(0, Math.min(seconds, duration));
      publishPosition();
    },
    [audio, publishPosition],
  );

  const skip = useCallback(
    (direction: 1 | -1) =>
      seek(audio.currentTime + (direction === 1 ? skipIntervals.forward : -skipIntervals.back)),
    [audio, seek, skipIntervals],
  );

  const setRate = useCallback(
    (next: number) => {
      const value = PLAYBACK_RATES.find((candidate) => candidate === next) ?? 1;
      audio.playbackRate = value;
      setRateState(value);
      try {
        window.localStorage.setItem(RATE_KEY, String(value));
      } catch {}
    },
    [audio],
  );

  const setSkip = useCallback((change: { back?: number; forward?: number }) => {
    setSkipIntervals((current) => {
      const next = {
        back: change.back ?? current.back,
        forward: change.forward ?? current.forward,
      };
      try {
        window.localStorage.setItem(SKIP_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const enqueue = useCallback((item: PodcastEpisode, next = false) => {
    setQueue((items) => {
      if (episodeRef.current?.id === item.id) return items;
      const rest = items.filter((entry) => entry.id !== item.id);
      return next ? [item, ...rest] : [...rest, item];
    });
  }, []);

  const removeFromQueue = useCallback(
    (episodeId: number) => setQueue((items) => items.filter((item) => item.id !== episodeId)),
    [],
  );

  const stop = useCallback(() => {
    if (episodeRef.current) save();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    episodeRef.current = null;
    setEpisode(null);
    setQueue([]);
    setIsPlaying(false);
    setIsLoading(false);
    setError(null);
    setSleepState({ mode: "off" });
    snapshot.current = { position: 0, duration: 0 };
    for (const listener of listeners.current) listener();
    refreshLists();
  }, [audio, refreshLists, save]);

  const showBar = episode !== null && lastPlayer === "podcast";

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session || typeof MediaMetadata === "undefined" || !showBar || !episode) return undefined;
    session.metadata = new MediaMetadata({
      title: episode.title,
      artist: episode.podcastTitle,
      album: episode.podcastTitle,
      artwork: mediaSessionArtwork(episode.imageUrl, window.location.href),
    });
    session.playbackState = isPlaying ? "playing" : "paused";
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => toggle()],
      ["pause", () => audio.pause()],
      ["seekbackward", () => skip(-1)],
      ["seekforward", () => skip(1)],
      ["previoustrack", () => skip(-1)],
      ["nexttrack", () => (queueRef.current.length ? playNext() : skip(1))],
      [
        "seekto",
        (details) => {
          if (typeof details.seekTime === "number") seek(details.seekTime);
        },
      ],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {}
    }
    return undefined;
  }, [audio, episode, isPlaying, playNext, seek, showBar, skip, toggle]);

  const value = useMemo<PodcastPlayerValue>(
    () => ({
      episode,
      queue,
      isPlaying,
      isLoading,
      error,
      rate,
      skipBack: skipIntervals.back,
      skipForward: skipIntervals.forward,
      showBar,
      sleep,
      setSleep,
      isCurrent: (episodeId) => episode?.id === episodeId,
      play,
      toggle,
      pause: () => audio.pause(),
      seek,
      skip,
      setRate,
      setSkip,
      enqueue,
      removeFromQueue,
      playNext,
      stop,
    }),
    [
      audio,
      enqueue,
      episode,
      error,
      isLoading,
      isPlaying,
      play,
      playNext,
      queue,
      rate,
      removeFromQueue,
      seek,
      setRate,
      setSkip,
      setSleep,
      showBar,
      skip,
      sleep,
      skipIntervals,
      stop,
      toggle,
    ],
  );

  return (
    <PodcastPlayerContext.Provider value={value}>
      <PodcastPositionContext.Provider value={positionStore}>
        {children}
      </PodcastPositionContext.Provider>
    </PodcastPlayerContext.Provider>
  );
}
