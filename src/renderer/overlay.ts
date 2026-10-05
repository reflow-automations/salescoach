// Overlay window (variant A, prompter strip): start/stop listening, show live tips and an optional transcript.
// Model text is only ever rendered with textContent, never as HTML.
// All text comes from src/shared/i18n.ts in the language of the settings, and follows a change live.
import type { CoachApi } from "../main/preload";
import { MESSAGES, normLang, t, type Lang, type MessageKey } from "../shared/i18n";
import type { PublicSettingsState, Settings, StatusEvent, TipEvent, TranscriptEvent } from "../shared/types";
import { startCapture, type Capture } from "./capture";
import { applyI18n } from "./i18n-dom";

const coach = (window as unknown as { coach: CoachApi }).coach;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Element #${id} is missing in overlay.html`);
  return node as T;
}

const listenBtn = el<HTMLButtonElement>("listen");
const tipBtn = el<HTMLButtonElement>("tipBtn");
const autoBox = el<HTMLInputElement>("auto");
const statusEl = el("status");
const edge = el("edge");
const tipEl = el("tip");
const transcriptEl = el("transcript");
const transcriptBtn = el<HTMLButtonElement>("transcriptBtn");
const settingsBtn = el<HTMLButtonElement>("settingsBtn");
const hideBtn = el<HTMLButtonElement>("hideBtn");

const OLD_AFTER_MS = 25_000;
const MAX_TRANSCRIPT_LINES = 8;
const ERROR_HOLD_MS = 3_000;
const WARN_RECOVER_MS = 5_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The language of the settings; English until they are loaded. */
let lang: Lang = "en";
const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars);

function prettyHotkey(accel: string): string {
  return accel.replace(/CommandOrControl|CmdOrCtrl/gi, "Ctrl");
}

// ---------- status line (the edge at the top of the window plus a short label) ----------

type DotLevel = "listening" | "stopped" | "warn" | "error";
const DOT_TITLES: Record<DotLevel, MessageKey> = {
  listening: "status.listening",
  stopped: "status.stopped",
  warn: "status.warn",
  error: "status.error",
};

let dotLevel: DotLevel = "stopped";
let warnAt = 0;
/** After a local error, a plain "Stopped" from main must not wipe the error message. */
let holdErrorUntil = 0;
/** What the status label shows: a key is shown again in a new language, a text from main stays as it is. */
let statusText: { key: MessageKey } | { text: string } = { key: "status.stopped" };

function setStatus(message: { key: MessageKey } | { text: string }, level: DotLevel): void {
  dotLevel = level;
  statusText = message;
  if (level === "warn") warnAt = Date.now();
  renderStatus();
  statusEl.dataset.level = level;
  edge.className = `edge ${level}`;
}

function renderStatus(): void {
  const message = "key" in statusText ? tr(statusText.key) : statusText.text;
  statusEl.textContent = message;
  statusEl.title = message;
}

/** Main's plain "Listening" and "Stopped" become keys again, so they follow a language change. */
function statusFromMain(message: string): { key: MessageKey } | { text: string } {
  for (const key of ["status.listening", "status.stopped"] as const) {
    if (Object.values(MESSAGES).some((m) => m[key] === message)) return { key };
  }
  return { text: message };
}

// ---------- start / stop ----------

type ListenState = "stopped" | "starting" | "listening" | "stopping";
let listenState: ListenState = "stopped";
let capture: Capture | null = null;

function setListenState(next: ListenState): void {
  listenState = next;
  const labels: Record<ListenState, MessageKey> = {
    stopped: "overlay.start",
    starting: "overlay.starting",
    listening: "overlay.stop",
    stopping: "overlay.stopping",
  };
  listenBtn.textContent = tr(labels[next]);
  listenBtn.disabled = next === "starting" || next === "stopping";
  listenBtn.classList.toggle("primary", next === "stopped" || next === "starting");
  listenBtn.classList.toggle("quiet", next === "listening" || next === "stopping");
  listenBtn.title = tr(next === "listening" ? "overlay.stopTitle" : "overlay.startTitle");
  if (showingEmpty) showEmpty();
}

/** Starting failed: a short label up top, the full message (with what to do) where the tip goes. */
function fail(message: string): void {
  holdErrorUntil = Date.now() + ERROR_HOLD_MS;
  setStatus({ key: "overlay.startFailed" }, "error");
  showTipMessage(message, "error");
}

async function start(): Promise<void> {
  if (listenState !== "stopped") return;
  setListenState("starting");
  holdErrorUntil = 0;
  setStatus({ key: "overlay.starting" }, "stopped");

  let res: { ok: boolean; error?: string };
  try {
    res = (await coach.startListening()) as { ok: boolean; error?: string };
  } catch (err) {
    res = { ok: false, error: errorText(err) };
  }
  if (!res?.ok) {
    setListenState("stopped");
    fail(res?.error || tr("overlay.startFailedRetry"));
    return;
  }

  try {
    capture = await startCapture((speaker, chunk) => coach.sendAudio(speaker, chunk), { language: lang });
  } catch (err) {
    capture = null;
    try {
      await coach.stopListening();
    } catch {
      /* main already stopped or is gone */
    }
    setListenState("stopped");
    fail(errorText(err));
    return;
  }
  setListenState("listening");
}

async function stop(): Promise<void> {
  if (listenState !== "listening") return;
  setListenState("stopping");
  stopCapture();
  try {
    await coach.stopListening();
  } catch {
    /* ignore */
  }
  setListenState("stopped");
  settleTip();
}

function stopCapture(): void {
  try {
    capture?.stop();
  } catch {
    /* already stopped */
  }
  capture = null;
}

listenBtn.addEventListener("click", () => {
  if (listenState === "stopped") void start();
  else if (listenState === "listening") void stop();
});

coach.onStatus((payload) => {
  const s = payload as StatusEvent;
  // Main stopped on its own: release the microphone and loopback capture too.
  if (!s.listening && listenState === "listening") {
    stopCapture();
    setListenState("stopped");
    settleTip();
  }
  const level = s.level ?? "info";
  if (!s.listening && level === "info" && Date.now() < holdErrorUntil) return;
  const dotFor: DotLevel = level === "error" ? "error" : level === "warn" ? "warn" : s.listening ? "listening" : "stopped";
  setStatus(s.message ? statusFromMain(s.message) : { key: DOT_TITLES[dotFor] }, dotFor);
});

// ---------- tips ----------

let currentTipId: string | null = null;
let tipText = "";
let oldTimer: number | undefined;
/** True while the tip area shows the empty-state hint instead of a tip or an error. */
let showingEmpty = true;

function armOldTimer(): void {
  window.clearTimeout(oldTimer);
  tipEl.classList.remove("old");
  oldTimer = window.setTimeout(() => tipEl.classList.add("old"), OLD_AFTER_MS);
}

/** Line 1 is the tip; a line starting with "? " is a question to ask. */
function splitTip(text: string): { main: string; question: string } {
  const main: string[] = [];
  const questions: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\?(\s|$)/.test(line)) questions.push(line.replace(/^\?\s*/, ""));
    else main.push(line);
  }
  return { main: main.join(" "), question: questions.join(" ") };
}

/**
 * Each sentence of line 1 is its own inline block, so a line break falls between sentences
 * (like a prompter) instead of halfway through one. "3.450" is not split: only a stop followed by a space is.
 */
function sentenceNodes(text: string): Node[] {
  const nodes: Node[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!sentence) continue;
    if (nodes.length) nodes.push(document.createTextNode(" "));
    const span = document.createElement("span");
    span.className = "sent";
    span.textContent = sentence;
    nodes.push(span);
  }
  return nodes;
}

function renderTip(): void {
  showingEmpty = false;
  const { main, question } = splitTip(tipText);
  const mainEl = document.createElement("div");
  mainEl.className = "tip-main";
  mainEl.replaceChildren(...sentenceNodes(main));
  const nodes: HTMLElement[] = [mainEl];
  if (question) {
    const q = document.createElement("div");
    q.className = "question";
    q.textContent = question;
    nodes.push(q);
  }
  tipEl.replaceChildren(...nodes);
}

/** What the tip area says when there is no tip: it follows the real state. */
function emptyMessage(): string {
  const key = prettyHotkey(settings?.hotkeyHelp ?? "Ctrl+Shift+Space");
  if (listenState === "listening" || listenState === "stopping") {
    return tr(settings?.autoTips === false ? "overlay.emptyManual" : "overlay.emptyAuto", { key });
  }
  return tr("overlay.emptyIdle", { key });
}

function showEmpty(): void {
  window.clearTimeout(oldTimer);
  currentTipId = null;
  tipText = "";
  showingEmpty = true;
  tipEl.className = "tip muted";
  tipEl.textContent = emptyMessage();
}

function showTipMessage(message: string, kind: "error" | "muted"): void {
  window.clearTimeout(oldTimer);
  currentTipId = null;
  tipText = "";
  showingEmpty = false;
  tipEl.className = `tip ${kind}`;
  const text = document.createElement("span");
  text.className = "tip-msg";
  text.textContent = message;
  const nodes: HTMLElement[] = [text];
  // An error that points at the settings gets the way there right next to it.
  if (kind === "error" && /instelling|setting/i.test(message)) {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "inline-action";
    go.dataset.i18n = "overlay.openSettings";
    go.textContent = tr("overlay.openSettings");
    go.addEventListener("click", () => void coach.openSettings());
    nodes.push(go);
  }
  tipEl.replaceChildren(...nodes);
  if (kind === "error") armOldTimer();
}

/** A running tip was cancelled (stop): finish it visually. */
function settleTip(): void {
  if (!tipEl.classList.contains("live")) return;
  tipEl.classList.remove("live", "pending");
  if (!tipText.trim()) showEmpty();
  else armOldTimer();
}

coach.onTip((payload) => {
  const e = payload as TipEvent;
  switch (e.kind) {
    case "start":
      currentTipId = e.id;
      tipText = "";
      tipEl.className = `tip live pending ${e.trigger}`;
      renderTip();
      armOldTimer();
      break;
    case "delta":
      if (e.id !== currentTipId) return;
      tipText += e.text;
      tipEl.classList.remove("pending");
      renderTip();
      armOldTimer();
      break;
    case "done":
      if (e.id !== currentTipId) return;
      tipEl.classList.remove("live", "pending");
      tipEl.classList.add("complete");
      if (!tipText.trim()) showEmpty();
      else armOldTimer();
      break;
    case "skip":
      // The coach decided there was nothing worth saying: keep the previous tip.
      break;
    case "error":
      showTipMessage(e.message, "error");
      currentTipId = e.id;
      break;
  }
});

tipBtn.addEventListener("click", () => {
  void Promise.resolve(coach.requestTip()).catch((err: unknown) => showTipMessage(errorText(err), "error"));
});

// ---------- auto tips ----------

let settings: Settings | null = null;

function applySettings(s: Settings): void {
  settings = s;
  autoBox.checked = !!s.autoTips;
  autoBox.disabled = false;
  const next = normLang(s.language);
  if (next !== lang) {
    lang = next;
    applyLanguage();
  }
  renderHotkeyTitles();
  if (showingEmpty) showEmpty();
}

function renderHotkeyTitles(): void {
  if (!settings) return;
  tipBtn.title = tr("overlay.tipNowTitle", { key: prettyHotkey(settings.hotkeyHelp) });
  hideBtn.title = tr("overlay.hideTitle", { key: prettyHotkey(settings.hotkeyToggle) });
}

/** Puts every text of the window in the current language, without touching what it shows. */
function applyLanguage(): void {
  applyI18n(lang);
  setListenState(listenState);
  renderStatus();
  renderTranscriptButton();
  renderHotkeyTitles();
}

autoBox.disabled = true;
autoBox.addEventListener("change", async () => {
  if (!settings) return;
  const wanted = autoBox.checked;
  try {
    const st = (await coach.saveSettings({ ...settings, autoTips: wanted })) as PublicSettingsState | undefined;
    if (st?.settings) applySettings(st.settings);
  } catch (err) {
    autoBox.checked = !wanted;
    setStatus({ text: tr("common.saveFailed", { error: errorText(err) }) }, "warn");
  }
});

coach.onSettings((payload) => applySettings(payload as Settings));

void (async () => {
  try {
    const st = (await coach.getState()) as PublicSettingsState;
    if (!settings) applySettings(st.settings);
  } catch (err) {
    setStatus({ text: tr("overlay.loadFailed", { error: errorText(err) }) }, "warn");
  }
})();

// ---------- transcript ----------

const lines = new Map<string, HTMLElement>();

function trimTranscript(): void {
  while (transcriptEl.children.length > MAX_TRANSCRIPT_LINES) {
    const first = transcriptEl.firstElementChild as HTMLElement | null;
    if (!first) break;
    if (first.dataset.id) lines.delete(first.dataset.id);
    first.remove();
  }
}

coach.onTranscript((payload) => {
  const e = payload as TranscriptEvent;
  const text = e.text.trim();
  let row = lines.get(e.id);
  if (!row) {
    if (!text) return;
    row = document.createElement("div");
    row.dataset.id = e.id;
    const who = document.createElement("span");
    who.className = "who";
    who.dataset.i18n = e.speaker === "me" ? "overlay.me" : "overlay.them";
    who.textContent = tr(who.dataset.i18n as MessageKey);
    const body = document.createElement("span");
    body.className = "text";
    row.append(who, body);
    transcriptEl.append(row);
    lines.set(e.id, row);
    trimTranscript();
  }
  if (e.final && !text) {
    lines.delete(e.id);
    row.remove();
    return;
  }
  row.className = `line ${e.speaker} ${e.final ? "final" : "interim"}`;
  const body = row.querySelector<HTMLElement>(".text");
  if (body) body.textContent = text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  // Words are coming in again, so a reconnect warning is over.
  if (e.final && dotLevel === "warn" && listenState === "listening" && Date.now() - warnAt > WARN_RECOVER_MS) {
    setStatus({ key: "status.listening" }, "listening");
  }
});

function renderTranscriptButton(): void {
  const label = tr(transcriptEl.classList.contains("hidden") ? "overlay.showTranscript" : "overlay.hideTranscript");
  transcriptBtn.title = label;
  transcriptBtn.setAttribute("aria-label", label);
}

transcriptBtn.addEventListener("click", () => {
  const show = transcriptEl.classList.toggle("hidden") === false;
  document.body.classList.toggle("with-transcript", show);
  transcriptBtn.classList.toggle("active", show);
  transcriptBtn.setAttribute("aria-pressed", String(show));
  renderTranscriptButton();
  if (show) transcriptEl.scrollTop = transcriptEl.scrollHeight;
});

// ---------- window buttons ----------

settingsBtn.addEventListener("click", () => void coach.openSettings());
hideBtn.addEventListener("click", () => void coach.hideOverlay());

window.addEventListener("beforeunload", () => stopCapture());

// ---------- initial state ----------

transcriptBtn.setAttribute("aria-pressed", "false");
applyLanguage();
setListenState("stopped");
setStatus({ key: "status.stopped" }, "stopped");
showEmpty();
