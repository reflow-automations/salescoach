// "Ears": live speech-to-text. One session per speaker (mic = me, system audio = them).
// Audio in: 16 kHz mono PCM16 little-endian chunks of ~100 ms.
import WebSocket from "ws";

export interface EarsText {
  id: string;
  text: string;
  final: boolean;
}

export interface EarsOptions {
  apiKey: string;
  /** Language of the call ("en" or "nl"): what the recogniser listens for, and the language of the status texts. */
  language: string;
  /** Words the recogniser should expect (company names, product names). */
  vocabulary: string[];
  onText: (t: EarsText) => void;
  onStatus: (message: string, level: "info" | "warn" | "error") => void;
  /**
   * The session gave up for good (bad key, no access, unknown model, or too many
   * failed attempts in a row). Called at most once; the session no longer reconnects.
   */
  onFatal: (message: string) => void;
}

export interface EarsSession {
  send(pcm16k: Buffer): void;
  close(): void;
}

/** Opens the provider socket. Tests pass a fake; the app uses the real ws client. */
export type OpenSocket = (url: string, headers?: Record<string, string>) => WebSocket;
export const openWebSocket: OpenSocket = (url, headers) => new WebSocket(url, headers ? { headers } : undefined);

let counter = 0;
export function newUtteranceId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** Give up after this many attempts in a row that never got healthy. */
export const MAX_FAILED_ATTEMPTS = 5;
/** A confirmed session that stayed up this long counts as healthy, even in silence. */
export const HEALTHY_AFTER_MS = 30_000;

/** Wait before the next reconnect: 1 s after a healthy session, then 2, 4, 8, 10 s. */
export function reconnectDelay(failures: number): number {
  return Math.min(1000 * 2 ** failures, 10_000);
}

/**
 * HTTP status of a rejected WebSocket upgrade. ws only reports it in the error
 * text; an 'unexpected-response' listener would switch off ws's own abort handling.
 */
export function upgradeStatus(err: { message: string } | string): number | undefined {
  const m = /Unexpected server response: (\d+)/.exec(typeof err === "string" ? err : err.message);
  return m ? Number(m[1]) : undefined;
}

/** Upgrade rejections that retrying will not fix: bad key, no access, unknown endpoint or model. */
export function isFatalUpgradeStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 404;
}

/** Text for a dropped connection: close reason plus the last error, so the cause is not lost. */
export function describeDrop(code: number, reason: string, lastError: string): string {
  const parts = [reason.trim(), lastError.trim()].filter((p, i, all) => p !== "" && all.indexOf(p) === i);
  return parts.join(", ") || `code ${code}`;
}

/** Root-mean-square level of a PCM16 chunk, 0..1. */
export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** Linear resample of PCM16 mono from 16 kHz to 24 kHz. */
export function upsample16kTo24k(pcm: Buffer): Buffer {
  const inN = Math.floor(pcm.length / 2);
  const outN = Math.floor((inN * 3) / 2);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = (i * 2) / 3;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, inN - 1);
    const frac = pos - i0;
    const s = pcm.readInt16LE(i0 * 2) * (1 - frac) + pcm.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}
