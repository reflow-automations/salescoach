// Feedback window: asks main once for feedback on the call that just ended, shows it while it
// streams in, and offers Copy (for a CRM note) and Save as file. Nothing is stored unless the
// user saves. Model text is only ever rendered with textContent, never as HTML.
import { feedbackToMarkdown, formatScore, nextStepKeys, parseFeedback, type Feedback } from "../coach/feedback";
import type { CoachApi } from "../main/preload";
import { normLang, t, type Lang, type MessageKey } from "../shared/i18n";
import { normCallType, type CallType, type FeedbackCallInfo, type FeedbackResult, type PublicSettingsState, type Settings } from "../shared/types";
import { applyI18n } from "./i18n-dom";

const coach = (window as unknown as { coach: CoachApi }).coach;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Element #${id} is missing in feedback.html`);
  return node as T;
}

const subEl = el("fbSub");
const loadingEl = el("fbLoading");
const errorEl = el("fbError");
const errorText = el("fbErrorText");
const retryBtn = el<HTMLButtonElement>("fbRetry");
const settingsBtn = el<HTMLButtonElement>("fbSettings");
const contentEl = el("fbContent");
const writingEl = el("fbWriting");
const stateEl = el("fbState");
const stateTitle = el("fbStateTitle");
const stateDetail = el("fbStateDetail");
const msgEl = el("fbMsg");
const copyBtn = el<HTMLButtonElement>("fbCopy");
const saveBtn = el<HTMLButtonElement>("fbSave");

let lang: Lang = "en";
/** The kind of the call the feedback is about (from the settings until the call info is in): a meeting names the next step "decisions and action points". */
let callType: CallType = "sales";
const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Phase = "loading" | "streaming" | "done" | "error";
let phase: Phase = "loading";
let call: FeedbackCallInfo | null = null;
let model = "";
let answer = "";
let feedback: Feedback | null = null;
let error = "";
/** Deltas of an older request (before a retry) are ignored. */
let reqId = "";

// ---------- small helpers ----------

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Curly quotes, common in English and Dutch alike. */
const quoted = (s: string) => `“${s}”`;

let msgTimer: number | undefined;
function setMsg(text: string, kind: "ok" | "warn" | "error" | "info" = "info"): void {
  window.clearTimeout(msgTimer);
  msgEl.textContent = text;
  msgEl.className = `msg ${kind}`;
  if (kind === "ok" && text) msgTimer = window.setTimeout(() => setMsg(""), 4000);
}

/** "Call of 14 min, 5 October 2026 at 14:32, written by GPT-5.5" */
function subtitle(withModel: boolean): string {
  if (!call) return "";
  const parts = [tr("feedback.callOf", { n: call.minutes })];
  try {
    const when = new Intl.DateTimeFormat(lang === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(call.endedAt);
    parts.push(when);
  } catch {
    /* no date then */
  }
  if (withModel && model) parts.push(tr("feedback.writtenBy", { model }));
  return parts.join(", ");
}

// ---------- rendering ----------

function section(title: MessageKey, ...children: Node[]): HTMLElement {
  const s = node("section", "group fb-section");
  s.append(node("h3", undefined, tr(title)), ...children);
  return s;
}

function renderFeedback(fb: Feedback): Node[] {
  if (fb.raw) {
    const block = node("section", "fb-raw");
    block.append(node("p", "hint", tr("feedback.rawIntro")), node("div", "fb-raw-text", fb.raw));
    return [block];
  }
  const out: Node[] = [];
  const has = (k: Feedback["sections"][number]) => fb.sections.includes(k);

  if (fb.summary.length || fb.score) {
    const block = node("section", "lead-block fb-summary");
    const head = node("div", "fb-head");
    head.append(node("h2", undefined, tr("feedback.summary")));
    if (fb.score) {
      const score = node("span", "fb-score");
      score.setAttribute("role", "img");
      score.setAttribute("aria-label", `${tr("feedback.score")}: ${tr("feedback.scoreAria", { score: formatScore(fb.score.value, lang) })}`);
      score.append(node("span", "fb-score-n", formatScore(fb.score.value, lang)), node("span", "fb-score-of", "/10"));
      head.append(score);
    }
    block.append(head);
    for (const line of fb.summary) block.append(node("p", "fb-line", line));
    if (fb.score?.reason) block.append(node("p", "fb-score-reason", fb.score.reason));
    out.push(block);
  }

  if (fb.strengths.length) {
    const list = node("ol", "fb-list");
    for (const s of fb.strengths) {
      const li = node("li", "fb-item");
      if (s.quote) li.append(node("blockquote", "fb-quote", quoted(s.quote)));
      if (s.why) li.append(node("p", "fb-why", s.why));
      list.append(li);
    }
    out.push(section("feedback.strengths", list));
  }

  if (fb.improvements.length) {
    const list = node("ol", "fb-list");
    for (const i of fb.improvements) {
      const li = node("li", "fb-item");
      if (i.happened) li.append(node("p", "fb-happened", i.happened));
      if (i.better) {
        const practise = node("div", "fb-practise");
        practise.append(node("span", "fb-practise-label", tr("feedback.practise")), node("p", "fb-better", quoted(i.better)));
        li.append(practise);
      }
      list.append(li);
    }
    out.push(section("feedback.improvements", list));
  }

  if (has("nextStep")) {
    const keys = nextStepKeys(callType);
    out.push(section(keys.title, fb.nextStep ? node("p", "fb-next", fb.nextStep) : node("p", "fb-next none", tr(keys.none))));
  }

  if (fb.fillers.length) {
    const chips = node("ul", "fb-chips");
    for (const f of fb.fillers) chips.append(node("li", "fb-chip", f));
    out.push(section("feedback.fillers", chips));
  }
  return out;
}

function hasContent(fb: Feedback): boolean {
  return !!(fb.raw || fb.summary.length || fb.strengths.length || fb.improvements.length || fb.nextStep || fb.fillers.length || fb.score);
}

function render(): void {
  document.title = `${tr("feedback.title")}${call ? ` (${tr("feedback.callOf", { n: call.minutes })})` : ""}`;
  subEl.textContent = subtitle(phase === "done");
  subEl.hidden = !subEl.textContent;

  const showContent = (phase === "streaming" || phase === "done") && !!feedback && hasContent(feedback);
  loadingEl.hidden = !(phase === "loading" || (phase === "streaming" && !showContent));
  errorEl.hidden = phase !== "error";
  contentEl.hidden = !showContent;
  writingEl.hidden = !(phase === "streaming" && showContent);
  if (showContent && feedback) contentEl.replaceChildren(...renderFeedback(feedback));
  else contentEl.replaceChildren();

  if (phase === "error") {
    errorText.textContent = error;
    retryBtn.hidden = error === tr("feedback.noCall");
    settingsBtn.hidden = !/instelling|setting/i.test(error);
  }

  const done = phase === "done";
  copyBtn.disabled = !done;
  saveBtn.disabled = !done;
  // After an error there is nothing to copy or save; the dock only says what happened.
  copyBtn.hidden = phase === "error";
  saveBtn.hidden = phase === "error";
  stateEl.className = `readiness ${done ? "ok" : phase === "error" ? "error" : ""}`.trim();
  stateTitle.textContent = tr(done ? "feedback.readyTitle" : phase === "error" ? "feedback.errorTitle" : "feedback.busyTitle");
  stateDetail.textContent = phase === "error" ? "" : tr("feedback.privacy");
}

// Streamed text arrives in many small pieces; draw at most once per frame.
let frame = 0;
function scheduleRender(): void {
  if (frame) return;
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

// ---------- the request ----------

coach.onFeedbackDelta((payload) => {
  const d = payload as { reqId: string; text: string };
  if (d.reqId !== reqId || phase === "done" || phase === "error") return;
  answer += d.text;
  feedback = parseFeedback(answer, true);
  phase = "streaming";
  scheduleRender();
});

async function requestFeedback(): Promise<void> {
  reqId = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mine = reqId;
  phase = "loading";
  answer = "";
  feedback = null;
  error = "";
  setMsg("");
  render();
  let res: FeedbackResult;
  try {
    res = await coach.createFeedback(mine);
  } catch (err) {
    res = { ok: false, error: errText(err) };
  }
  if (mine !== reqId) return; // a newer request took over
  if (!res.ok) {
    if (res.aborted) return;
    phase = "error";
    error = res.error;
  } else {
    answer = res.text;
    model = res.model;
    feedback = parseFeedback(answer);
    if (hasContent(feedback)) phase = "done";
    else {
      phase = "error";
      error = tr("feedback.empty");
    }
  }
  render();
}

// ---------- copy and save ----------

function markdown(): string {
  return feedback ? feedbackToMarkdown(feedback, lang, { subtitle: subtitle(true), callType }) : "";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* clipboard permission may be denied; try the old way */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "offscreen";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

copyBtn.addEventListener("click", async () => {
  const ok = await copyText(markdown());
  setMsg(tr(ok ? "common.copied" : "feedback.copyFailed"), ok ? "ok" : "error");
});

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  try {
    const res = await coach.saveFeedback(markdown());
    if (res.ok) setMsg(tr("feedback.saved", { file: res.file }), "ok");
    else if (!res.canceled) setMsg(tr("common.saveFailed", { error: res.error ?? "" }), "error");
  } catch (err) {
    setMsg(tr("common.saveFailed", { error: errText(err) }), "error");
  } finally {
    saveBtn.disabled = phase !== "done";
  }
});

retryBtn.addEventListener("click", () => void requestFeedback());
settingsBtn.addEventListener("click", () => void coach.openSettings());

// ---------- language ----------

function applyLanguage(next: string): void {
  lang = normLang(next);
  applyI18n(lang);
  render();
}

coach.onSettings((payload) => {
  const s = payload as Settings;
  const nextType = normCallType(s.callType);
  // The feedback is written for the kind of the call itself; a switch afterwards does not change it.
  const typeChanged = !call?.callType && nextType !== callType;
  if (normLang(s.language) !== lang || typeChanged) {
    if (typeChanged) callType = nextType;
    applyLanguage(s.language);
  }
});

// ---------- start ----------

void (async () => {
  try {
    const st = (await coach.getState()) as PublicSettingsState;
    callType = normCallType(st.settings.callType);
    applyLanguage(st.settings.language);
  } catch {
    applyLanguage("en");
  }
  try {
    call = await coach.getFeedbackCall();
  } catch {
    call = null;
  }
  if (call?.callType) {
    callType = normCallType(call.callType);
    render();
  }
  await requestFeedback();
})();
