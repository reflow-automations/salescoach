// Captures the microphone (me) and the system audio (them) as 16 kHz PCM16 chunks.
import { t } from "../shared/i18n";
import type { Speaker } from "../shared/types";

export interface Capture {
  /** Stops both streams and closes their audio graphs. Safe to call more than once. */
  stop(): void;
}

export interface CaptureOptions {
  /**
   * Called once when a stream ends by itself (device unplugged, Bluetooth headset dropped).
   * Capture has already stopped everything by then. The reason is a sentence for the user.
   */
  onEnded?: (speaker: Speaker, reason: string) => void;
  /** Language of the texts for the user ("en" or "nl"). Default English. */
  language?: string;
}

const endedReason = (speaker: Speaker, lang?: string): string => t(lang, speaker === "me" ? "capture.micEnded" : "capture.pcEnded");

type CaptureEndedFn = (speaker: Speaker, reason: string) => void;

/** Tells main, when the preload offers captureEnded (older preloads do not). */
function reportEnded(speaker: Speaker, reason: string): void {
  const api = (globalThis as { coach?: { captureEnded?: unknown } }).coach;
  if (typeof api?.captureEnded === "function") (api.captureEnded as CaptureEndedFn)(speaker, reason);
}

function stopTracks(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}

async function pipe(stream: MediaStream, onChunk: (chunk: ArrayBuffer) => void): Promise<() => void> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    stopTracks(stream);
    ctx.close().catch(() => {
      /* already closed */
    });
  };
  try {
    await ctx.audioWorklet.addModule("pcm-worklet.js");
    const src = ctx.createMediaStreamSource(stream);
    // Mono in, so a stereo loopback is mixed down (0.5 * (L + R)) instead of losing the right side.
    // The worklet also averages whatever channels still arrive.
    const node = new AudioWorkletNode(ctx, "pcm-chunker", {
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    // Chunks already queued in the port must not leak out after stop.
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (!closed) onChunk(e.data);
    };
    src.connect(node);
    // The node must reach the destination graph to keep processing, but silently.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
  } catch (err) {
    close();
    throw err;
  }
  return close;
}

export async function startCapture(
  send: (speaker: Speaker, chunk: ArrayBuffer) => void,
  opts: CaptureOptions = {},
): Promise<Capture> {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false,
  });
  let system: MediaStream;
  try {
    system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    stopTracks(mic);
    throw new Error(t(opts.language, "capture.pcFailed", { error: (err as Error).message }));
  }
  // We only need the loopback audio; drop the screen video right away.
  system.getVideoTracks().forEach((t) => {
    t.stop();
    system.removeTrack(t);
  });
  if (system.getAudioTracks().length === 0) {
    stopTracks(mic);
    throw new Error(t(opts.language, "capture.noPcAudio"));
  }

  const streams: [Speaker, MediaStream][] = [
    ["me", mic],
    ["them", system],
  ];
  // allSettled: when one pipe fails, the other must not keep its device and AudioContext open.
  const results = await Promise.allSettled(streams.map(([speaker, s]) => pipe(s, (c) => send(speaker, c))));
  const closers = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const abort = (): void => {
    closers.forEach((close) => close());
    stopTracks(mic);
    stopTracks(system);
  };
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    abort();
    throw failed.reason;
  }
  // A track can end during the awaits above, before any listener exists, and would never fire again.
  const deadSpeaker = streams.find(([, s]) => s.getAudioTracks().some((t) => t.readyState === "ended"))?.[0];
  if (deadSpeaker) {
    abort();
    throw new Error(endedReason(deadSpeaker, opts.language));
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    closers.forEach((close) => close());
  };

  // Our own track.stop() never fires "ended", so this only reacts to devices that go away.
  // A headset is often mic and output at once: both tracks end, the first one reports.
  const onTrackEnded = (speaker: Speaker): void => {
    if (stopped) return;
    stop();
    const reason = endedReason(speaker, opts.language);
    try {
      opts.onEnded?.(speaker, reason);
    } finally {
      reportEnded(speaker, reason);
    }
  };
  for (const [speaker, s] of streams) {
    s.getAudioTracks().forEach((t) => t.addEventListener("ended", () => onTrackEnded(speaker), { once: true }));
  }

  return { stop };
}
