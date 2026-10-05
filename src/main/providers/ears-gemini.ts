// Gemini 3.5 Transcribe Live over the Live API WebSocket.
// Sessions are capped at 10 minutes and cannot be resumed, so we roll over to a
// fresh session every ~9 minutes. The next session gets no audio until we switch
// at a pause or turn end, so every chunk is transcribed by exactly one session.
import WebSocket from "ws";
import { t } from "../../shared/i18n";
import {
  HEALTHY_AFTER_MS,
  MAX_FAILED_ATTEMPTS,
  describeDrop,
  isFatalUpgradeStatus,
  newUtteranceId,
  openWebSocket,
  reconnectDelay,
  rms,
  upgradeStatus,
  type EarsOptions,
  type EarsSession,
  type OpenSocket,
} from "./ears";

const URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MODEL = "models/gemini-3.5-transcribe-live";
export const SESSION_CAP_MS = 10 * 60 * 1000; // the Live API closes a session after this
export const ROLLOVER_MS = 9 * 60 * 1000; // start opening the next session
const SWITCH_SAFETY_MS = 30 * 1000; // switch at the latest this long before the cap
export const SWITCH_DEADLINE_MS = 20 * 1000; // once the next session is ready, switch within this time even without a pause
const SWITCH_SILENCE_LEVEL = 0.012; // RMS below this counts as a pause
export const SWITCH_SILENCE_CHUNKS = 4; // ~400 ms of pause
const RETIRE_GRACE_MS = 3000; // a retired session gets this long to send its last words
const MAX_QUEUE_CHUNKS = 30; // ~3 s of audio buffered while (re)connecting

/** A close that retrying will not fix: bad key, no permission, unknown model or a rejected setup. */
export function isFatalGeminiClose(code: number, reason: string, wasReady: boolean): boolean {
  if (/api.?key|permission|unauthori[sz]ed|not found|not supported/i.test(reason)) return true;
  // 1007 (invalid payload) and 1008 (policy) before setupComplete mean the setup itself was refused.
  return !wasReady && (code === 1007 || code === 1008);
}

/** Wait before retrying a failed rollover: 2, 4, 8, 16, 20 s, but never past the switch safety margin. */
export function rolloverRetryDelay(failures: number, sessionAgeMs: number): number {
  const backoff = Math.min(2000 * 2 ** (failures - 1), 20_000);
  const left = SESSION_CAP_MS - SWITCH_SAFETY_MS - sessionAgeMs;
  return Math.min(backoff, Math.max(2000, left));
}

interface Conn {
  ws: WebSocket;
  openedAt: number;
  ready: boolean;
  readyAt: number;
  healthy: boolean; // the server kept talking after setupComplete
  retired: boolean; // replaced or closed by us; can never become current again
  goingAway: boolean;
  queue: Buffer[];
  interimId: string;
  lastInterim: string;
  lastError: string;
}

export function createGeminiEars(opts: EarsOptions, prefix: string, openSocket: OpenSocket = openWebSocket): EarsSession {
  let current: Conn | null = null; // owns the audio stream
  let pending: Conn | null = null; // next session during a rollover; gets no audio before the switch
  let closed = false;
  let failures = 0; // attempts in a row that never got healthy
  let rolloverFailures = 0;
  let dropped = false; // a reconnect warning is showing
  let quietChunks = 0;
  let rolloverTimer: NodeJS.Timeout | null = null;
  let switchTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const isOpen = (conn: Conn) => conn.ws.readyState === WebSocket.OPEN;

  function clearTimer(t: NodeJS.Timeout | null): null {
    if (t) clearTimeout(t);
    return null;
  }

  function fatal(message: string): void {
    if (closed) return;
    closed = true;
    rolloverTimer = clearTimer(rolloverTimer);
    switchTimer = clearTimer(switchTimer);
    reconnectTimer = clearTimer(reconnectTimer);
    for (const c of [current, pending]) if (c) retire(c);
    current = pending = null;
    opts.onFatal(message);
  }

  function open(): Conn {
    const ws = openSocket(`${URL}?key=${encodeURIComponent(opts.apiKey)}`);
    const conn: Conn = {
      ws,
      openedAt: Date.now(),
      ready: false,
      readyAt: 0,
      healthy: false,
      retired: false,
      goingAway: false,
      queue: [],
      interimId: newUtteranceId(prefix),
      lastInterim: "",
      lastError: "",
    };

    ws.on("open", () => {
      const transcription: Record<string, unknown> = {};
      if (opts.language) transcription.languageCodes = [opts.language];
      if (opts.vocabulary.length) transcription.customVocabulary = opts.vocabulary.slice(0, 100);
      ws.send(
        JSON.stringify({
          setup: {
            model: MODEL,
            generationConfig: { responseModalities: ["TEXT"] },
            inputAudioTranscription: transcription,
            realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
          },
        }),
      );
    });

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.setupComplete || msg.setup_complete) {
        onReady(conn);
        return;
      }
      if (conn.ready) conn.healthy = true;
      if (msg.goAway || msg.go_away) {
        if (conn === current && !closed) onGoAway(conn);
        return;
      }
      if (msg.error) {
        const text = msg.error.message ?? JSON.stringify(msg.error);
        conn.lastError = text;
        if (conn === current && !closed) opts.onStatus(`Gemini: ${text}`, "error");
        return;
      }
      const sc = msg.serverContent ?? msg.server_content;
      if (!sc) return;
      const interim = sc.interimInputTranscription?.text ?? sc.interim_input_transcription?.text;
      if (typeof interim === "string" && interim.trim()) {
        conn.lastInterim = interim;
        opts.onText({ id: conn.interimId, text: interim, final: false });
      }
      const fin = sc.inputTranscription?.text ?? sc.input_transcription?.text;
      if (typeof fin === "string" && fin.trim()) {
        opts.onText({ id: conn.interimId, text: fin, final: true });
        conn.interimId = newUtteranceId(prefix);
        conn.lastInterim = "";
        // A turn just ended: a clean moment to hand over to a ready next session.
        if (conn === current && pending?.ready) switchOver();
      }
    });

    ws.on("close", (code, reason) => onClose(conn, code, reason.toString()));

    ws.on("error", (err) => {
      conn.lastError = err.message;
      if (closed || conn !== current) return;
      const status = upgradeStatus(err);
      if (isFatalUpgradeStatus(status)) {
        fatal(t(opts.language, "ears.geminiBadKey", { status: String(status) }));
      }
      // Otherwise the close that always follows reports it.
    });

    return conn;
  }

  function sendChunk(conn: Conn, pcm: Buffer): void {
    if (!isOpen(conn)) return;
    conn.ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.toString("base64"), mimeType: "audio/pcm;rate=16000" } } }));
  }

  function onReady(conn: Conn): void {
    if (closed || conn.retired || (conn !== current && conn !== pending)) {
      retire(conn);
      return;
    }
    conn.ready = true;
    conn.readyAt = Date.now();
    if (conn === current) {
      for (const chunk of conn.queue) sendChunk(conn, chunk);
      conn.queue = [];
      rolloverFailures = 0;
      scheduleRollover(ROLLOVER_MS - (Date.now() - conn.openedAt));
      if (dropped) {
        dropped = false;
        opts.onStatus(t(opts.language, "ears.backListening"), "info");
      }
      return;
    }
    // The next session is ready. Wait for a pause or turn end, but not forever.
    if (!current || (current.ready && !isOpen(current)) || current.goingAway) {
      switchOver();
      return;
    }
    const left = SESSION_CAP_MS - SWITCH_SAFETY_MS - (Date.now() - current.openedAt);
    switchTimer = clearTimer(switchTimer);
    switchTimer = setTimeout(switchOver, Math.max(0, Math.min(SWITCH_DEADLINE_MS, left)));
  }

  /** Makes the pending session the one that gets audio, and lets the old one finish. */
  function switchOver(): void {
    const next = pending;
    if (closed || !next) return;
    switchTimer = clearTimer(switchTimer);
    const old = current;
    pending = null;
    current = next;
    quietChunks = 0;
    if (old) retire(old);
    if (next.ready) {
      rolloverFailures = 0;
      scheduleRollover(ROLLOVER_MS - (Date.now() - next.openedAt));
    }
    // Not ready yet (the old one died early): it queues audio until setupComplete.
  }

  /** Ends a session for good. A ready one gets audioStreamEnd and a moment for its last finals. */
  function retire(conn: Conn): void {
    if (conn.retired) return;
    conn.retired = true;
    conn.queue = [];
    if (!conn.ready || !isOpen(conn)) {
      try {
        conn.ws.terminate();
      } catch {
        /* already gone */
      }
      return;
    }
    try {
      conn.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch {
      /* ignore */
    }
    setTimeout(() => conn.ws.close(), RETIRE_GRACE_MS);
  }

  function onGoAway(conn: Conn): void {
    conn.goingAway = true;
    if (pending?.ready) switchOver();
    else if (!pending) {
      rolloverTimer = clearTimer(rolloverTimer);
      rollover();
    }
    // A pending session that is still connecting switches over as soon as it is ready.
  }

  function onClose(conn: Conn, code: number, reason: string): void {
    // Words that never got a final would otherwise hang as an interim line.
    if (conn.lastInterim) {
      opts.onText({ id: conn.interimId, text: conn.lastInterim, final: true });
      conn.lastInterim = "";
    }
    if (closed) return;
    if (conn === pending) {
      // The next session failed before the switch: try again, well before the cap.
      pending = null;
      switchTimer = clearTimer(switchTimer);
      if (current?.ready && !current.retired) {
        rolloverFailures += 1;
        scheduleRollover(rolloverRetryDelay(rolloverFailures, Date.now() - current.openedAt));
      }
      return;
    }
    if (conn !== current) return; // retired: it was finishing anyway
    if (isFatalGeminiClose(code, reason, conn.ready)) {
      fatal(t(opts.language, "ears.geminiRefused", { why: describeDrop(code, reason, conn.lastError) }));
      return;
    }
    if (pending) {
      // A rollover is under way: hand over now instead of opening a third session.
      switchOver();
      return;
    }
    const wasHealthy = conn.healthy || (conn.ready && Date.now() - conn.readyAt >= HEALTHY_AFTER_MS);
    failures = wasHealthy ? 0 : failures + 1;
    const why = describeDrop(code, reason, conn.lastError);
    if (failures >= MAX_FAILED_ATTEMPTS) {
      fatal(t(opts.language, "ears.gaveUp", { attempts: failures, why, provider: "Gemini" }));
      return;
    }
    const wait = reconnectDelay(failures);
    opts.onStatus(t(opts.language, "ears.dropped", { why, seconds: Math.round(wait / 1000) }), "warn");
    dropped = true;
    current = null;
    rolloverTimer = clearTimer(rolloverTimer);
    reconnectTimer = clearTimer(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed && !current) current = open();
    }, wait);
  }

  function scheduleRollover(delay: number): void {
    if (closed) return;
    rolloverTimer = clearTimer(rolloverTimer);
    rolloverTimer = setTimeout(rollover, Math.max(0, delay));
  }

  function rollover(): void {
    rolloverTimer = null;
    if (closed || pending || !current?.ready || current.retired) return;
    pending = open();
  }

  current = open();

  return {
    send(pcm) {
      if (closed || !current) return;
      quietChunks = rms(pcm) < SWITCH_SILENCE_LEVEL ? quietChunks + 1 : 0;
      // Hand over at a pause, or at once when the old session is leaving or gone.
      if (pending && ((current.ready && !isOpen(current)) || (pending.ready && (current.goingAway || quietChunks >= SWITCH_SILENCE_CHUNKS)))) {
        switchOver();
      }
      const c = current;
      if (c.ready) sendChunk(c, pcm);
      else if (c.queue.length < MAX_QUEUE_CHUNKS) c.queue.push(pcm);
    },
    close() {
      if (closed) return;
      closed = true;
      rolloverTimer = clearTimer(rolloverTimer);
      switchTimer = clearTimer(switchTimer);
      reconnectTimer = clearTimer(reconnectTimer);
      for (const c of [current, pending]) if (c) retire(c);
      current = pending = null;
    },
  };
}
