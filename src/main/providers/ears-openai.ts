// OpenAI gpt-live-transcribe over the Realtime WebSocket (transcription session).
// This model has no server VAD, so we detect end of speech ourselves and commit.
import type WebSocket from "ws";
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
  upsample16kTo24k,
  type EarsOptions,
  type EarsSession,
  type OpenSocket,
} from "./ears";

const URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const MODEL = "gpt-live-transcribe";
const SPEECH_LEVEL = 0.012; // RMS above this counts as speech
const SILENCE_COMMIT_MS = 700; // commit after this much silence following speech
const MAX_TURN_MS = 15000; // force a commit during long monologues
const CHUNK_MS = 100;
/** Interim text with no delta or completed event for this long is promoted to final. */
export const STALE_INTERIM_MS = 5000;

/** Error events that mean this key or account cannot transcribe at all, so retrying is pointless. */
export function isFatalOpenAIError(err: { code?: unknown; type?: unknown } | null | undefined): boolean {
  const code = typeof err?.code === "string" ? err.code : "";
  const type = typeof err?.type === "string" ? err.type : "";
  if (code === "invalid_api_key" || code === "insufficient_quota" || code === "model_not_found") return true;
  return /permission|unauthori[sz]ed|authentication/i.test(`${code} ${type}`);
}

export function createOpenAIEars(opts: EarsOptions, prefix: string, openSocket: OpenSocket = openWebSocket): EarsSession {
  let ws: WebSocket | null = null;
  let ready = false;
  let closed = false;
  let failures = 0; // attempts in a row that never got healthy
  let retryTimer: NodeJS.Timeout | null = null;
  let speechMs = 0;
  let silenceMs = 0;
  let hasUncommitted = false;
  const preroll: Buffer[] = [];
  const itemIds = new Map<string, string>(); // OpenAI item_id -> our utterance id
  const interim = new Map<string, string>();
  const staleTimers = new Map<string, NodeJS.Timeout>();
  // Ids we finalized ourselves; a late completed event may still correct the text.
  const promoted = new Set<string>();

  function fatal(message: string): void {
    if (closed) return;
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    try {
      ws?.terminate();
    } catch {
      /* already gone */
    }
    opts.onFatal(message);
  }

  function clearStale(id: string): void {
    const t = staleTimers.get(id);
    if (t) clearTimeout(t);
    staleTimers.delete(id);
  }

  /** Turns hanging interim text into a final line, so it does not stay "interim" forever. */
  function promote(id: string): void {
    clearStale(id);
    const text = interim.get(id);
    interim.delete(id);
    if (text?.trim()) {
      promoted.add(id);
      opts.onText({ id, text, final: true });
    }
  }

  function forget(itemId: string, id: string): void {
    itemIds.delete(itemId);
    interim.delete(id);
    promoted.delete(id);
    clearStale(id);
  }

  function finalizeAll(): void {
    for (const id of [...interim.keys()]) promote(id);
    itemIds.clear();
    promoted.clear();
  }

  function connect(): void {
    ready = false;
    const sock = openSocket(URL, { Authorization: `Bearer ${opts.apiKey}` });
    ws = sock;
    let lastError = "";
    let confirmedAt: number | null = null; // when our session.update was accepted
    let healthy = false; // confirmed and the server kept talking, or we got a transcript

    sock.on("open", () => {
      const transcription: Record<string, unknown> = { model: MODEL, delay: "low" };
      if (opts.language) transcription.languages = [opts.language];
      if (opts.vocabulary.length) transcription.keywords = opts.vocabulary.slice(0, 100);
      sock.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription, turn_detection: null } },
          },
        }),
      );
      // Do not reset the failure count here: the server can still reject the session.
      ready = true;
    });

    sock.on("message", (raw) => {
      if (sock !== ws) return;
      let ev: any;
      try {
        ev = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (ev.type === "session.updated" || ev.type === "transcription_session.updated") {
        confirmedAt ??= Date.now();
      } else if (confirmedAt !== null && ev.type !== "error") {
        healthy = true;
      }
      const ourId = (itemId: string) => {
        let id = itemIds.get(itemId);
        if (!id) {
          id = newUtteranceId(prefix);
          itemIds.set(itemId, id);
        }
        return id;
      };
      if (ev.type === "conversation.item.input_audio_transcription.delta" && typeof ev.delta === "string") {
        healthy = true;
        const id = ourId(ev.item_id);
        if (promoted.has(id)) return; // already shown as final; wait for completed
        const text = (interim.get(id) ?? "") + ev.delta;
        interim.set(id, text);
        clearStale(id);
        staleTimers.set(id, setTimeout(() => promote(id), STALE_INTERIM_MS));
        opts.onText({ id, text, final: false });
      } else if (ev.type === "conversation.item.input_audio_transcription.completed") {
        healthy = true;
        const known = itemIds.get(ev.item_id);
        const transcript = typeof ev.transcript === "string" ? ev.transcript : "";
        if (transcript.trim()) opts.onText({ id: known ?? newUtteranceId(prefix), text: transcript, final: true });
        // Nothing heard after all: a final with empty text removes the interim line.
        else if (known && (interim.has(known) || promoted.has(known))) opts.onText({ id: known, text: "", final: true });
        if (known) forget(ev.item_id, known);
      } else if (ev.type === "conversation.item.input_audio_transcription.failed") {
        const known = itemIds.get(ev.item_id);
        if (known) {
          promote(known); // keep the words we did get
          forget(ev.item_id, known);
        }
        opts.onStatus(t(opts.language, "ears.sentenceFailed", { error: ev.error?.message ?? t(opts.language, "ears.unknownError") }), "warn");
      } else if (ev.type === "error") {
        const err = ev.error ?? {};
        const msg = String(err.message ?? err.code ?? t(opts.language, "ears.unknownError"));
        if (isFatalOpenAIError(err)) {
          fatal(t(opts.language, "ears.openaiRefused", { message: msg.replace(/[.\s]+$/, "") }));
          return;
        }
        lastError = msg;
        // Committing an empty buffer is harmless; do not alarm the user.
        if (!/buffer.*(empty|too small)/i.test(msg)) opts.onStatus(`OpenAI: ${msg}`, "error");
      }
    });

    sock.on("close", (code, reason) => {
      if (sock !== ws) return;
      ready = false;
      finalizeAll();
      if (closed) return;
      const wasHealthy = healthy || (confirmedAt !== null && Date.now() - confirmedAt >= HEALTHY_AFTER_MS);
      failures = wasHealthy ? 0 : failures + 1;
      const why = describeDrop(code, reason.toString(), lastError);
      if (failures >= MAX_FAILED_ATTEMPTS) {
        fatal(t(opts.language, "ears.gaveUp", { attempts: failures, why, provider: "OpenAI" }));
        return;
      }
      const wait = reconnectDelay(failures);
      opts.onStatus(t(opts.language, "ears.dropped", { why, seconds: Math.round(wait / 1000) }), "warn");
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!closed) connect();
      }, wait);
    });

    sock.on("error", (err) => {
      if (closed || sock !== ws) return;
      const status = upgradeStatus(err);
      if (isFatalUpgradeStatus(status)) {
        fatal(t(opts.language, "ears.openaiBadKey", { model: MODEL, status: String(status) }));
        return;
      }
      // ws always follows an error with a close; that close reports it, so the
      // reconnect warning does not hide the cause.
      lastError = err.message;
    });
  }

  function commit(): void {
    if (ws && ready && hasUncommitted) ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    hasUncommitted = false;
    speechMs = 0;
    silenceMs = 0;
  }

  connect();

  return {
    send(pcm) {
      if (closed || !ws || !ready) return;
      const speaking = rms(pcm) > SPEECH_LEVEL;
      if (speaking) {
        speechMs += CHUNK_MS;
        silenceMs = 0;
      } else if (speechMs > 0) {
        silenceMs += CHUNK_MS;
      }
      // Only send audio around speech; skip long stretches of silence. Keep a short
      // pre-roll so the first syllable of a turn is not cut off.
      if (speechMs > 0) {
        const chunks = hasUncommitted ? [pcm] : [...preroll, pcm];
        for (const c of chunks) ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: upsample16kTo24k(c).toString("base64") }));
        preroll.length = 0;
        hasUncommitted = true;
      } else {
        preroll.push(pcm);
        if (preroll.length > 3) preroll.shift();
      }
      if ((speechMs > 0 && silenceMs >= SILENCE_COMMIT_MS) || speechMs >= MAX_TURN_MS) commit();
    },
    close() {
      if (closed) return;
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      commit();
      const sock = ws;
      setTimeout(() => sock?.close(), 2000);
    },
  };
}
