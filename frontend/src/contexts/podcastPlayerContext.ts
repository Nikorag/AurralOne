import { createContext, useContext, useSyncExternalStore } from "react";
import type { PodcastEpisode } from "../hooks/usePodcasts.ts";
import type { SleepOption, SleepTimer } from "../utils/podcastSleep.ts";
import type { PodcastEffects } from "../utils/podcastAudioEffects.ts";

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const SKIP_BACK_OPTIONS = [10, 15, 30, 45, 60] as const;
export const SKIP_FORWARD_OPTIONS = [15, 30, 45, 60, 90] as const;

export type PodcastPlayerValue = {
  episode: PodcastEpisode | null;
  queue: PodcastEpisode[];
  isPlaying: boolean;
  isLoading: boolean;
  error: string | null;
  rate: number;
  skipBack: number;
  skipForward: number;
  showBar: boolean;
  sleep: SleepTimer;
  effects: PodcastEffects;
  effectsAvailable: boolean;
  setEffects: (change: Partial<PodcastEffects>) => void;
  setSleep: (option: SleepOption) => void;
  isCurrent: (episodeId: number) => boolean;
  play: (episode: PodcastEpisode) => void;
  toggle: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  skip: (direction: 1 | -1) => void;
  setRate: (rate: number) => void;
  setSkip: (change: { back?: number; forward?: number }) => void;
  enqueue: (episode: PodcastEpisode, next?: boolean) => void;
  removeFromQueue: (episodeId: number) => void;
  playNext: () => void;
  stop: () => void;
};

export type PodcastPositionStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => { position: number; duration: number };
};

export const PodcastPlayerContext = createContext<PodcastPlayerValue | null>(null);
export const PodcastPositionContext = createContext<PodcastPositionStore | null>(null);

export function usePodcastPlayer() {
  const context = useContext(PodcastPlayerContext);
  if (!context) throw new Error("usePodcastPlayer must be used within PodcastPlayerProvider");
  return context;
}

export function usePodcastPosition() {
  const store = useContext(PodcastPositionContext);
  if (!store) throw new Error("usePodcastPosition must be used within PodcastPlayerProvider");
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
