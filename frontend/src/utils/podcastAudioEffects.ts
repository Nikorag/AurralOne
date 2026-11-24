import { createSilenceTrimmer, rootMeanSquare } from "./silenceTrim.ts";

export type PodcastEffects = { voiceBoost: boolean; trimSilence: boolean };

const CHECK_EVERY_MS = 50;
const FAST_FACTOR = 2.5;
const MAX_RATE = 4;

export const canProcessSource = (src: string) => {
  if (typeof AudioContext === "undefined") return false;
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
};

export function createAudioEffects(audio: HTMLAudioElement, baseRate: () => number) {
  type Graph = {
    context: AudioContext;
    highpass: BiquadFilterNode;
    presence: BiquadFilterNode;
    compressor: DynamicsCompressorNode;
    makeup: GainNode;
    analyser: AnalyserNode;
  };
  let graph: Graph | null = null;
  let timer: number | null = null;
  const trimmer = createSilenceTrimmer();

  const build = (): Graph => {
    const context = new AudioContext();
    const source = context.createMediaElementSource(audio);
    const highpass = context.createBiquadFilter();
    highpass.type = "highpass";
    const presence = context.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 2800;
    presence.Q.value = 1;
    const compressor = context.createDynamicsCompressor();
    const makeup = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(highpass).connect(presence).connect(compressor).connect(makeup);
    makeup.connect(context.destination);
    source.connect(analyser);
    return { context, highpass, presence, compressor, makeup, analyser };
  };

  const stopTrimming = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    trimmer.reset();
    audio.playbackRate = baseRate();
  };

  const startTrimming = (current: Graph) => {
    if (timer !== null) return;
    const samples = new Float32Array(current.analyser.fftSize);
    timer = window.setInterval(() => {
      if (audio.paused) return;
      current.analyser.getFloatTimeDomainData(samples);
      const fast = trimmer.update(rootMeanSquare(samples), performance.now());
      audio.playbackRate = fast ? Math.min(MAX_RATE, baseRate() * FAST_FACTOR) : baseRate();
    }, CHECK_EVERY_MS);
  };

  return {
    apply(effects: PodcastEffects) {
      if (!effects.voiceBoost && !effects.trimSilence && !graph) return;
      try {
        graph ??= build();
      } catch {
        return;
      }
      const { context, highpass, presence, compressor, makeup } = graph;
      void context.resume();
      const boost = effects.voiceBoost;
      highpass.frequency.value = boost ? 80 : 10;
      presence.gain.value = boost ? 4 : 0;
      compressor.threshold.value = boost ? -30 : 0;
      compressor.knee.value = boost ? 24 : 30;
      compressor.ratio.value = boost ? 4 : 1;
      compressor.attack.value = 0.01;
      compressor.release.value = 0.25;
      makeup.gain.value = boost ? 1.6 : 1;
      if (effects.trimSilence) startTrimming(graph);
      else stopTrimming();
    },
    refreshRate() {
      if (timer === null) audio.playbackRate = baseRate();
    },
  };
}
