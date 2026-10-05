// Overlay window (variant A, prompter strip): start/stop listening, show live tips and an optional transcript.
// Model text is only ever rendered with textContent, never as HTML.
// All text comes from src/shared/i18n.ts in the language of the settings, and follows a change live.
import type { CoachApi } from "../main/preload";
import { MESSAGES, normLang, t, type Lang, type MessageKey } from "../shared/i18n";
import { normCallType, type CallType, type PublicSettingsState, type Settings, type StatusEvent, type TipEvent, type TipLabel, type TranscriptEvent } from "../shared/types";
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
const callTypeSel = el<HTMLSelectElement>("callType");
const statusEl = el("status");
const edge = el("edge");
const tipEl = el("tip");
const historyEl = el("history");
const transcriptEl = el("transcript");
const transcriptBtn = el<HTMLButtonElement>("transcriptBtn");
const settingsBtn = el<HTMLButtonElement>("settingsBtn");
const hideBtn = el<HTMLButtonElement>("hideBtn");
const afterCall = el("afterCall");
const feedbackBtn = el<HTMLButtonElement>("feedbackBtn");
const callLengthEl = el("callLength");

const OLD_AFTER_MS = 25_000;
const MAX_TRANSCRIPT_LINES = 8;
const MAX_HISTORY = 3;
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
  renderAfterCall();
}

// ---------- after the call ----------

/** Length in minutes of the call that just ended, when it is long enough for feedback; 0 hides the button. */
let feedbackCallMinutes = 0;

function renderAfterCall(): void {
  afterCall.hidden = !feedbackCallMinutes || listenState !== "stopped";
  document.body.classList.toggle("call-ended", !afterCall.hidden);
  callLengthEl.textContent = feedbackCallMinutes ? tr("overlay.callLength", { n: feedbackCallMinutes }) : "";
}

feedbackBtn.addEventListener("click", () => {
  void Promise.resolve(coach.openFeedback()).catch((err: unknown) => showTipMessage(errorText(err), "error"));
});

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
  clearHistory(); // a new call starts with a clean list
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
  // Only now: when starting fails, the button for the previous call stays.
  feedbackCallMinutes = 0;
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
  // Main says with every stop whether there is a call long enough for feedback.
  if (!s.listening && s.feedback !== undefined) feedbackCallMinutes = s.feedback ? Math.max(1, s.callMinutes ?? 1) : 0;
  renderAfterCall();
  const level = s.level ?? "info";
  if (!s.listening && level === "info" && Date.now() < holdErrorUntil) return;
  const dotFor: DotLevel = level === "error" ? "error" : level === "warn" ? "warn" : s.listening ? "listening" : "stopped";
  setStatus(s.message ? statusFromMain(s.message) : { key: DOT_TITLES[dotFor] }, dotFor);
});

// ---------- tips ----------

/** The tip on top and the few before it, so a tip that was replaced can still be read. */
interface TipEntry {
  id: string;
  text: string;
  label?: TipLabel;
  at: number;
  /** THEM was still talking when it came: it may still be refined. */
  draft: boolean;
}

let currentTipId: string | null = null;
let tipText = "";
/** Label, time and draft state of the tip on top (its text is tipText). Null for a message or the empty state. */
let current: TipEntry | null = null;
/** Earlier tips, newest first. */
let history: TipEntry[] = [];
/** A refinement of the tip on top started: its first words replace the old text, so nothing flickers. */
let replacing = false;
/** The tip a refinement is replacing, until its first words arrive: it goes to the history if the refinement fails. */
let replacedTip: TipEntry | null = null;
let oldTimer: number | undefined;
/** True while the tip area shows the empty-state hint instead of a tip or an error. */
let showingEmpty = true;

function armOldTimer(): void {
  window.clearTimeout(oldTimer);
  tipEl.classList.remove("old");
  oldTimer = window.setTimeout(() => {
    tipEl.classList.add("old");
    // An old tip is no longer "still listening".
    if (current?.draft) {
      current.draft = false;
      tipEl.classList.remove("draft");
      if (tipText) renderTip();
    }
  }, OLD_AFTER_MS);
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
  if (current?.draft && main) {
    // A small dot says: THEM is still talking, this tip may still change.
    const dot = document.createElement("span");
    dot.className = "listening-dot";
    dot.title = tr("overlay.draftTitle");
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", tr("overlay.draftTitle"));
    mainEl.prepend(dot);
  }
  const nodes: HTMLElement[] = [mainEl];
  if (question) {
    const q = document.createElement("div");
    q.className = "question";
    q.textContent = question;
    nodes.push(q);
  }
  tipEl.replaceChildren(...nodes);
}

/** The tip on top moves into the history (only a tip with text). */
function archiveCurrent(): void {
  const top = current;
  if (top && currentTipId === top.id && tipText.trim()) {
    history = [{ ...top, text: tipText, draft: false }, ...history.filter((h) => h.id !== top.id)].slice(0, MAX_HISTORY);
  }
  current = null;
  renderHistory();
}

function ageText(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return seconds < 60 ? tr("overlay.ageSeconds", { n: seconds }) : tr("overlay.ageMinutes", { n: Math.floor(seconds / 60) });
}

function renderHistory(): void {
  const rows = history.map((h) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "hist-row";
    row.dataset.id = h.id;
    row.title = tr("overlay.historyRestore");
    row.setAttribute("role", "listitem");
    if (h.label) {
      const label = document.createElement("span");
      label.className = "hist-label";
      label.textContent = tr(`tipLabel.${h.label}`);
      row.append(label);
    }
    const text = document.createElement("span");
    text.className = "hist-text";
    text.textContent = splitTip(h.text).main || h.text;
    const age = document.createElement("span");
    age.className = "hist-age";
    age.dataset.at = String(h.at);
    age.textContent = ageText(h.at);
    row.append(text, age);
    row.addEventListener("click", () => restoreTip(h.id));
    return row;
  });
  historyEl.replaceChildren(...rows);
}

function renderAges(): void {
  for (const age of historyEl.querySelectorAll<HTMLElement>(".hist-age")) age.textContent = ageText(Number(age.dataset.at));
}

/** A tip from the history goes back on top; the tip that was there takes its place in the list. */
function restoreTip(id: string): void {
  const entry = history.find((h) => h.id === id);
  if (!entry) return;
  history = history.filter((h) => h.id !== id);
  archiveCurrent();
  current = { ...entry, draft: false };
  currentTipId = entry.id;
  tipText = entry.text;
  replacing = false;
  tipEl.className = "tip complete";
  renderTip();
  armOldTimer();
}

function clearHistory(): void {
  history = [];
  renderHistory();
}

/** What the tip area says when there is no tip: it follows the real state. */
function emptyMessage(): string {
  const key = prettyHotkey(settings?.hotkeyHelp ?? "Ctrl+Shift+Space");
  if (listenState === "listening" || listenState === "stopping") {
    if (settings?.autoTips === false) return tr("overlay.emptyManual", { key });
    const auto: Record<CallType, MessageKey> = { sales: "overlay.emptyAuto", interview: "overlay.emptyAutoInterview", meeting: "overlay.emptyAutoMeeting" };
    return tr(auto[normCallType(settings?.callType)], { key });
  }
  return tr("overlay.emptyIdle", { key });
}

function showEmpty(): void {
  window.clearTimeout(oldTimer);
  currentTipId = null;
  current = null;
  tipText = "";
  replacing = false;
  replacedTip = null;
  showingEmpty = true;
  tipEl.className = "tip muted";
  tipEl.textContent = emptyMessage();
}

function showTipMessage(message: string, kind: "error" | "muted"): void {
  window.clearTimeout(oldTimer);
  currentTipId = null;
  current = null;
  tipText = "";
  replacing = false;
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

/** A running tip was cancelled (stop): finish it visually. A draft tip is no longer waiting either. */
function settleTip(): void {
  replacing = false;
  if (current?.draft) {
    current.draft = false;
    tipEl.classList.remove("draft");
    if (tipText.trim()) renderTip();
  }
  if (!tipEl.classList.contains("live")) return;
  tipEl.classList.remove("live", "pending", "refine");
  if (!tipText.trim()) showEmpty();
  else armOldTimer();
}

coach.onTip((payload) => {
  const e = payload as TipEvent;
  switch (e.kind) {
    case "start": {
      // A refinement of the tip on top (same sentence of THEM) swaps the text in place.
      const refine = !!e.replaces && e.replaces === currentTipId && !!current && !!tipText.trim();
      const label = e.label ?? (refine ? current?.label : undefined);
      replacedTip = refine && current ? { ...current, text: tipText, draft: false } : null;
      if (!refine) archiveCurrent();
      current = { id: e.id, text: "", label, at: Date.now(), draft: !!e.draft };
      currentTipId = e.id;
      replacing = refine;
      if (refine) {
        tipEl.className = `tip live refine ${e.trigger}${e.draft ? " draft" : ""}`;
      } else {
        tipText = "";
        tipEl.className = `tip live pending ${e.trigger}${e.draft ? " draft" : ""}`;
      }
      renderTip();
      armOldTimer();
      break;
    }
    case "delta":
      if (e.id !== currentTipId) {
        // A tip that was moved into the history while it still streamed keeps growing there.
        const h = history.find((x) => x.id === e.id);
        if (h) {
          h.text += e.text;
          renderHistory();
        }
        return;
      }
      if (replacing) {
        tipText = "";
        replacing = false;
        replacedTip = null;
      }
      tipText += e.text;
      tipEl.classList.remove("pending");
      renderTip();
      armOldTimer();
      break;
    case "done":
      if (e.id !== currentTipId) return;
      replacing = false;
      tipEl.classList.remove("live", "pending", "refine");
      tipEl.classList.add("complete");
      if (!tipText.trim()) showEmpty();
      else armOldTimer();
      break;
    case "final":
      // THEM finished and the draft tip still fits: it stays, now as a normal tip.
      if (e.id !== currentTipId || !current?.draft) return;
      current.draft = false;
      tipEl.classList.remove("draft");
      if (tipText.trim()) renderTip();
      break;
    case "skip":
      // The coach decided there was nothing worth saying: keep the previous tip.
      break;
    case "retract":
      // A draft tip the coach no longer stands behind (the full sentence did not call for it): it
      // leaves the screen and is not kept in the history either.
      history = history.filter((h) => h.id !== e.id);
      renderHistory();
      if (e.id === currentTipId) showEmpty();
      break;
    case "error":
      if (e.id !== currentTipId) archiveCurrent();
      else if (replacing && replacedTip?.text.trim()) {
        // A refinement failed before its first word: the tip it was replacing stays readable.
        const old = replacedTip;
        history = [old, ...history.filter((h) => h.id !== old.id)].slice(0, MAX_HISTORY);
        renderHistory();
      }
      replacedTip = null;
      showTipMessage(e.message, "error");
      currentTipId = e.id;
      break;
  }
});

window.setInterval(renderAges, 1000);

tipBtn.addEventListener("click", () => {
  void Promise.resolve(coach.requestTip()).catch((err: unknown) => showTipMessage(errorText(err), "error"));
});

// ---------- auto tips ----------

let settings: Settings | null = null;

function applySettings(s: Settings): void {
  settings = s;
  autoBox.checked = !!s.autoTips;
  autoBox.disabled = false;
  callTypeSel.value = normCallType(s.callType);
  callTypeSel.disabled = false;
  fitCallType();
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
  fitCallType();
  setListenState(listenState);
  renderStatus();
  renderTranscriptButton();
  renderHotkeyTitles();
  renderHistory();
  renderAfterCall();
  if (tipText.trim()) renderTip();
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

/** A select is as wide as its longest option; this one fits the chosen option, so the chevron sits right after it. */
function fitCallType(): void {
  const text = callTypeSel.selectedOptions[0]?.textContent ?? "";
  const cs = getComputedStyle(callTypeSel);
  if (!text) return;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  callTypeSel.style.width = `${Math.ceil(ctx.measureText(text).width + chrome) + 1}px`;
}

// The kind of call applies to the next tip and to the feedback; the ears keep running.
callTypeSel.disabled = true;
callTypeSel.addEventListener("change", fitCallType);
void document.fonts?.ready.then(fitCallType);
callTypeSel.addEventListener("change", async () => {
  if (!settings) return;
  const before = normCallType(settings.callType);
  const wanted = normCallType(callTypeSel.value);
  try {
    const st = (await coach.saveSettings({ ...settings, callType: wanted })) as PublicSettingsState | undefined;
    if (st?.settings) applySettings(st.settings);
  } catch (err) {
    callTypeSel.value = before;
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
