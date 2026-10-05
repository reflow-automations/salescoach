// Settings window (variant A): a guided setup in three steps (connect, profile, this call)
// with a dock that always says whether you can start and what is still missing.
// Stored keys are never shown; the renderer only learns whether one is set.
// All text comes from src/shared/i18n.ts. A language change re-renders the text live and never
// touches the value of a field, so nothing you are typing gets lost.
import type { ImportResult } from "../coach/profile-import";
import type { CoachApi } from "../main/preload";
import { joinList, normLang, t, type Lang, type MessageKey } from "../shared/i18n";
import {
  DEFAULT_SETTINGS,
  EMPTY_PROFILE,
  type BrainProviderId,
  type ChatGPTStatus,
  type EarsProviderId,
  type Profile,
  type PublicSettingsState,
  type SecretName,
  type Settings,
} from "../shared/types";
import { applyI18n } from "./i18n-dom";

const coach = (window as unknown as { coach: CoachApi }).coach;

/** The language of the settings; English until they are loaded. */
let lang: Lang = "en";
const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars);

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Element #${id} is missing in settings.html`);
  return node as T;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type MsgKind = "ok" | "warn" | "error" | "info";
const msgTimers = new WeakMap<HTMLElement, number>();

/** Shows a short message; "ok" messages fade after a few seconds. */
function setMsg(target: HTMLElement, text: string, kind: MsgKind = "info"): void {
  window.clearTimeout(msgTimers.get(target));
  target.textContent = text;
  target.className = `msg ${kind}`;
  if (kind === "ok" && text) {
    msgTimers.set(
      target,
      window.setTimeout(() => {
        target.textContent = "";
        target.className = "msg";
      }, 2500),
    );
  }
}

function debounce(fn: () => void, ms: number): { run: () => void; flush: () => void } {
  let timer: number | undefined;
  return {
    run: () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        fn();
      }, ms);
    },
    flush: () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
      fn();
    },
  };
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

// ---------- tabs ----------

const TAB_KEY = "salescoach.settingsTab";
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"));
/** Each step has its own buttons in the dock; only the active step's group is shown. */
const dockGroups = Array.from(document.querySelectorAll<HTMLElement>(".dock-actions[data-for]"));

function showTab(name: string): void {
  if (!tabs.some((t) => t.dataset.tab === name)) name = "conn";
  for (const t of tabs) {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
    t.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(`panel-${t.dataset.tab}`);
    if (panel) panel.hidden = !active;
  }
  for (const g of dockGroups) g.hidden = g.dataset.for !== name;
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    /* storage unavailable */
  }
}

tabs.forEach((t, i) => {
  t.addEventListener("click", () => showTab(t.dataset.tab ?? "conn"));
  t.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.dataset.tab ?? "conn");
    next.focus();
  });
});

let savedTab = "conn";
try {
  savedTab = localStorage.getItem(TAB_KEY) ?? "conn";
} catch {
  /* storage unavailable */
}
showTab(savedTab);

// "Next: ..." in the dock: go to the next step and start at its top.
const nextBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-next]"));
for (const btn of nextBtns) {
  btn.addEventListener("click", () => {
    const next = btn.dataset.next ?? "conn";
    showTab(next);
    window.scrollTo(0, 0);
    document.getElementById(`tab-${next}`)?.focus();
  });
}

// ---------- state ----------

let state: PublicSettingsState = {
  settings: { ...DEFAULT_SETTINGS },
  hasSecret: { geminiKey: false, openaiKey: false },
  chatgpt: { connected: false, sharing: false, models: [] },
  callBrief: "",
};
let loaded = false;

// ---------- 1. Connect ----------

const earsSel = el<HTMLSelectElement>("ears");
const brainSel = el<HTMLSelectElement>("brain");
const brainHint = el("brainHint");
const readinessEl = el("readiness");
const readyTitle = el("readyTitle");
const readyDetail = el("readyDetail");
const moreOptions = el<HTMLDetailsElement>("moreOptions");
const stepState = { conn: el("stepConn"), profile: el("stepProfile"), call: el("stepCall") };
const languageSel = el<HTMLSelectElement>("language");
const autoTipsBox = el<HTMLInputElement>("autoTips");
const geminiModelInput = el<HTMLInputElement>("geminiModel");
const openaiModelInput = el<HTMLInputElement>("openaiModel");
const hkHelp = el("hkHelp");
const hkToggle = el("hkToggle");
const saveSettingsBtn = el<HTMLButtonElement>("saveSettings");
const settingsMsg = el("settingsMsg");

const cgOut = el("cgOut");
const cgIn = el("cgIn");
const cgSignInBtn = el<HTMLButtonElement>("cgSignIn");
const cgProgress = el("cgProgress");
const cgEmail = el("cgEmail");
const cgSharing = el("cgSharing");
const cgModelSel = el<HTMLSelectElement>("chatgptModel");
const cgPlanNote = el("cgPlanNote");
const cgUsageBtn = el<HTMLButtonElement>("cgUsage");
const cgSignOutBtn = el<HTMLButtonElement>("cgSignOut");
const cgMsg = el("cgMsg");

const KEY_UI: Record<SecretName, { input: HTMLInputElement; save: HTMLButtonElement; badge: HTMLElement; msg: HTMLElement; label: MessageKey }> = {
  geminiKey: {
    input: el<HTMLInputElement>("geminiKey"),
    save: el<HTMLButtonElement>("geminiKeySave"),
    badge: el("geminiKeyState"),
    msg: el("geminiKeyMsg"),
    label: "label.geminiKey",
  },
  openaiKey: {
    input: el<HTMLInputElement>("openaiKey"),
    save: el<HTMLButtonElement>("openaiKeySave"),
    badge: el("openaiKeyState"),
    msg: el("openaiKeyMsg"),
    label: "label.openaiKey",
  },
};

function prettyHotkey(accel: string): string {
  return accel.replace(/CommandOrControl|CmdOrCtrl/gi, "Ctrl").replace(/\+/g, " + ");
}

function ensureOption(select: HTMLSelectElement, value: string, label = value): void {
  if (!value || Array.from(select.options).some((o) => o.value === value)) return;
  select.append(new Option(label, value));
}

/** Fills the form controls. Only on load, so a save never overwrites what you are typing. */
function renderForm(s: Settings): void {
  earsSel.value = s.ears;
  brainSel.value = s.brain;
  ensureOption(languageSel, s.language);
  languageSel.value = s.language;
  autoTipsBox.checked = s.autoTips;
  geminiModelInput.value = s.geminiModel;
  geminiModelInput.placeholder = DEFAULT_SETTINGS.geminiModel;
  openaiModelInput.value = s.openaiModel;
  openaiModelInput.placeholder = DEFAULT_SETTINGS.openaiModel;
  hkHelp.textContent = prettyHotkey(s.hotkeyHelp);
  hkToggle.textContent = prettyHotkey(s.hotkeyToggle);
}

function collectSettings(): Settings {
  const base = state.settings;
  const chatgptModel = state.chatgpt.connected && cgModelSel.value ? cgModelSel.value : base.chatgptModel;
  return {
    ...base,
    ears: earsSel.value as EarsProviderId,
    brain: brainSel.value as BrainProviderId,
    language: languageSel.value || base.language,
    autoTips: autoTipsBox.checked,
    geminiModel: geminiModelInput.value.trim() || DEFAULT_SETTINGS.geminiModel,
    openaiModel: openaiModelInput.value.trim() || DEFAULT_SETTINGS.openaiModel,
    chatgptModel,
  };
}

/** What still blocks Start, as message keys, so the dock can show them in any language. */
function missingForStart(s: Settings, has: Record<SecretName, boolean>, cg: ChatGPTStatus): MessageKey[] {
  const missing: MessageKey[] = [];
  const needGemini = s.ears === "gemini" || s.brain === "gemini";
  const needOpenAI = s.ears === "openai" || s.brain === "openai-key";
  // With the ChatGPT plan only the ears need a key; say so, or people think the login was enough.
  const earsOnly = s.brain === "chatgpt";
  if (needGemini && !has.geminiKey) missing.push(earsOnly ? "missing.earsKeyChatgpt" : "missing.geminiKey");
  if (needOpenAI && !has.openaiKey) missing.push(earsOnly ? "missing.earsKeyChatgpt" : "missing.openaiKey");
  if (s.brain === "chatgpt") {
    if (!cg.connected) missing.push("missing.chatgptSignIn");
    else if (!cg.sharing) missing.push("missing.chatgptSharing");
    else if (!s.chatgptModel) missing.push("missing.chatgptModel");
  }
  return missing;
}

let connMissing: MessageKey[] = [];
let usedMore = false;

type StepLevel = "done" | "partial" | "todo" | "missing" | "loading";

function setStep(name: keyof typeof stepState, level: StepLevel, text: string): void {
  stepState[name].textContent = text;
  const tab = document.getElementById(`tab-${name}`);
  if (tab) tab.dataset.state = level;
}

/**
 * The three step labels and the dock. Only a missing key or login blocks Start;
 * the profile and the brief make the tips better, so they are advice, not blockers.
 */
function renderProgress(): void {
  if (!loaded) return;
  const ready = connMissing.length === 0;
  setStep("conn", ready ? "done" : "missing", tr(ready ? "step.ready" : "step.notReady"));

  const total = FIELDS.length;
  const filled = profileLoaded ? total - emptyFieldLabels().length : -1;
  if (filled < 0) setStep("profile", "loading", tr("step.notLoaded"));
  else if (filled === total) setStep("profile", "done", tr("step.ready"));
  else if (filled === 0) setStep("profile", "todo", tr("step.empty"));
  else setStep("profile", "partial", tr("step.filledOf", { filled, total }));
  profileCount.textContent = filled < 0 ? "" : tr("step.filledOf", { filled: Math.max(filled, 0), total });
  profileCount.className = `badge ${filled === total ? "ok" : "off"}`;

  const hasBrief = !!briefInput.value.trim();
  setStep("call", hasBrief ? "done" : "todo", tr(hasBrief ? "step.filled" : "step.empty"));

  for (const btn of nextBtns) {
    const from = btn.dataset.next === "profile" ? ready : filled > 0;
    btn.classList.toggle("primary", from);
    btn.classList.toggle("ghost", !from);
  }

  readinessEl.className = `readiness ${ready ? "ok" : "warn"}`;
  if (!ready) {
    readyTitle.textContent = tr("ready.notTitle");
    readyDetail.textContent = tr("ready.needed", { items: joinList(lang, connMissing.map((k) => tr(k, { label: tr(earsSel.value === "openai" ? "label.openaiKey" : "label.geminiKey") }))) });
    return;
  }
  readyTitle.textContent = tr("ready.title");
  if (filled === 0) readyDetail.textContent = tr("ready.profileEmpty");
  else if (filled > 0 && filled < total) readyDetail.textContent = tr("ready.profilePartial");
  else if (!hasBrief) readyDetail.textContent = tr("ready.noBrief");
  else readyDetail.textContent = tr("ready.go");
}

/** Everything that depends on state but is not a form input you type in. */
function renderStatus(): void {
  const s = collectSettings();

  for (const name of Object.keys(KEY_UI) as SecretName[]) {
    const ui = KEY_UI[name];
    const set = !!state.hasSecret[name];
    ui.badge.textContent = tr(set ? "badge.set" : "badge.notSet");
    ui.badge.className = `badge ${set ? "ok" : "off"}`;
  }

  connMissing = missingForStart(s, state.hasSecret, state.chatgpt);
  renderProgress();

  // OpenAI and ChatGPT live behind a disclosure; it opens itself as soon as you use them.
  const usesMore = s.ears !== "gemini" || s.brain !== "gemini" || state.hasSecret.openaiKey || state.chatgpt.connected;
  if (usesMore && !usedMore) moreOptions.open = true;
  usedMore = usesMore;

  const hints: Record<BrainProviderId, MessageKey> = {
    gemini: "brainHint.gemini",
    "openai-key": "brainHint.openaiKey",
    chatgpt: "brainHint.chatgpt",
  };
  brainHint.textContent = hints[s.brain] ? tr(hints[s.brain]) : "";

  renderChatGPT();
}

let renderedModels = "";

function renderChatGPT(): void {
  const cg = state.chatgpt;
  cgOut.hidden = cg.connected;
  cgIn.hidden = !cg.connected;
  if (!cg.connected) return;

  cgEmail.textContent = cg.email || tr("cg.unknownAccount");
  if (cg.sharing) {
    cgSharing.textContent = tr("cg.sharingOn");
    cgSharing.className = "msg ok";
  } else {
    cgSharing.textContent = tr("cg.sharingOff");
    cgSharing.className = "msg warn";
  }

  const current = state.settings.chatgptModel;
  const key = JSON.stringify([cg.models, current, cg.sharing, lang]);
  if (key !== renderedModels) {
    renderedModels = key;
    const options = cg.models.map((m) => new Option(m.displayName || m.slug, m.slug));
    if (!options.length) {
      options.push(new Option(tr(cg.sharing ? "cg.noModels" : "cg.enableFirst"), ""));
    }
    cgModelSel.replaceChildren(...options);
    if (current) ensureOption(cgModelSel, current);
    cgModelSel.value = current || cgModelSel.options[0]?.value || "";
    cgModelSel.disabled = !cg.models.length;
  }
  cgPlanNote.hidden = brainSel.value !== "chatgpt";
}

async function saveSettings(feedback: boolean): Promise<void> {
  if (!loaded) return;
  const next = collectSettings();
  try {
    const st = (await coach.saveSettings(next)) as PublicSettingsState | undefined;
    if (st?.settings) state = st;
    else state = { ...state, settings: next };
    syncLanguage();
    renderStatus();
    if (feedback) setMsg(settingsMsg, tr("common.saved"), "ok");
  } catch (err) {
    setMsg(settingsMsg, tr("common.saveFailed", { error: errorText(err) }), "error");
  }
}

/** Fast models first: a live tip is useless when it arrives after the moment has passed. */
export function fastestModel(models: { slug: string }[]): string {
  const fast = models.find((m) => /mini|nano|instant|fast|flash|lite/i.test(m.slug));
  return (fast ?? models[0]).slug;
}

/** If a ChatGPT model list is available but none is chosen, pick the fastest one. */
async function ensureChatGPTModel(): Promise<void> {
  const cg = state.chatgpt;
  if (!cg.connected || !cg.sharing || !cg.models.length || state.settings.chatgptModel) return;
  cgModelSel.value = fastestModel(cg.models);
  await saveSettings(false);
}

// Selects and the checkbox save immediately; text fields save when you leave them.
for (const control of [earsSel, brainSel, languageSel, autoTipsBox, cgModelSel]) {
  control.addEventListener("change", () => void saveSettings(true));
}
for (const input of [geminiModelInput, openaiModelInput]) {
  input.addEventListener("change", () => void saveSettings(true));
}
brainSel.addEventListener("change", renderStatus);
// The ChatGPT plan cannot transcribe. Without an OpenAI key, the free Gemini ears are the only way to listen.
brainSel.addEventListener("change", () => {
  if (brainSel.value === "chatgpt" && earsSel.value === "openai" && !state.hasSecret.openaiKey) {
    earsSel.value = "gemini";
    void saveSettings(true);
  }
});
saveSettingsBtn.addEventListener("click", () => void saveSettings(true));

async function saveKey(name: SecretName): Promise<void> {
  const ui = KEY_UI[name];
  const value = ui.input.value.trim();
  if (!value && !state.hasSecret[name]) {
    setMsg(ui.msg, tr("key.pasteFirst"), "warn");
    ui.input.focus();
    return;
  }
  if (!value && !window.confirm(tr("key.confirmRemove", { label: tr(ui.label) }))) return;
  ui.save.disabled = true;
  try {
    const has = (await coach.setSecret(name, value)) as Record<SecretName, boolean>;
    state = { ...state, hasSecret: has };
    ui.input.value = "";
    setMsg(ui.msg, tr(value ? "common.saved" : "key.removed"), "ok");
    renderStatus();
  } catch (err) {
    setMsg(ui.msg, tr("common.saveFailed", { error: errorText(err) }), "error");
  } finally {
    ui.save.disabled = false;
  }
}

for (const name of Object.keys(KEY_UI) as SecretName[]) {
  const ui = KEY_UI[name];
  ui.save.addEventListener("click", () => void saveKey(name));
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void saveKey(name);
  });
}

for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-copy]"))) {
  btn.addEventListener("click", async () => {
    const ok = await copyText(btn.dataset.copy ?? "");
    btn.textContent = tr(ok ? "common.copied" : "common.copyManual");
    window.setTimeout(() => (btn.textContent = tr("common.copyLink")), 2000);
  });
}

cgSignInBtn.addEventListener("click", async () => {
  cgSignInBtn.disabled = true;
  setMsg(cgProgress, tr("cg.browserOpens"), "info");
  try {
    const res = (await coach.chatgptSignIn()) as { ok: boolean; state?: PublicSettingsState; error?: string };
    if (res?.ok && res.state) {
      state = res.state;
      setMsg(cgProgress, "", "info");
      renderStatus();
      await ensureChatGPTModel();
      setMsg(cgMsg, tr("cg.connected"), "ok");
    } else {
      setMsg(cgProgress, res?.error || tr("cg.signInFailed"), "error");
    }
  } catch (err) {
    setMsg(cgProgress, tr("auth.failedWith", { reason: errorText(err) }), "error");
  } finally {
    cgSignInBtn.disabled = false;
  }
});

cgUsageBtn.addEventListener("click", () => {
  void Promise.resolve(coach.chatgptUsage()).catch((err: unknown) => setMsg(cgMsg, errorText(err), "error"));
});

cgSignOutBtn.addEventListener("click", async () => {
  cgSignOutBtn.disabled = true;
  try {
    state = (await coach.chatgptSignOut()) as PublicSettingsState;
    renderStatus();
    setMsg(cgProgress, tr("cg.signedOut"), "ok");
  } catch (err) {
    setMsg(cgMsg, tr("cg.signOutFailed", { error: errorText(err) }), "error");
  } finally {
    cgSignOutBtn.disabled = false;
  }
});

// ---------- 2. Profile ----------

/** Label and hint are message keys ("pf.<key>" and "pf.<key>.hint"). */
const FIELDS: { key: keyof Profile; label: MessageKey; hint: MessageKey; rows: number }[] = [
  { key: "whoAmI", label: "pf.whoAmI", hint: "pf.whoAmI.hint", rows: 3 },
  { key: "offer", label: "pf.offer", hint: "pf.offer.hint", rows: 4 },
  { key: "pricing", label: "pf.pricing", hint: "pf.pricing.hint", rows: 3 },
  { key: "idealCustomer", label: "pf.idealCustomer", hint: "pf.idealCustomer.hint", rows: 3 },
  { key: "cases", label: "pf.cases", hint: "pf.cases.hint", rows: 4 },
  { key: "objections", label: "pf.objections", hint: "pf.objections.hint", rows: 4 },
  { key: "rules", label: "pf.rules", hint: "pf.rules.hint", rows: 3 },
  { key: "tone", label: "pf.tone", hint: "pf.tone.hint", rows: 2 },
];

const profileFieldsEl = el("profileFields");
const profileCount = el("profileCount");
const profileInputs = {} as Record<keyof Profile, HTMLTextAreaElement>;
const profileMsg = el("profileMsg");
const saveProfileBtn = el<HTMLButtonElement>("saveProfile");
const copyPromptBtn = el<HTMLButtonElement>("copyPrompt");
const copyMsg = el("copyMsg");
const promptFallback = el<HTMLTextAreaElement>("promptFallback");
const importText = el<HTMLTextAreaElement>("importText");
const importBtn = el<HTMLButtonElement>("importBtn");
const importMsg = el("importMsg");

for (const f of FIELDS) {
  const wrap = document.createElement("div");
  wrap.className = "field profile-field";
  const label = document.createElement("label");
  label.htmlFor = `pf-${f.key}`;
  label.dataset.i18n = f.label;
  label.textContent = tr(f.label);
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.dataset.i18n = f.hint;
  hint.textContent = tr(f.hint);
  const ta = document.createElement("textarea");
  ta.id = `pf-${f.key}`;
  ta.rows = f.rows;
  ta.spellcheck = true;
  wrap.append(label, hint, ta);
  profileFieldsEl.append(wrap);
  profileInputs[f.key] = ta;
}

function collectProfile(): Profile {
  const p: Profile = { ...EMPTY_PROFILE };
  for (const f of FIELDS) p[f.key] = profileInputs[f.key].value.trim();
  return p;
}

function emptyFieldLabels(): string[] {
  return FIELDS.filter((f) => !profileInputs[f.key].value.trim()).map((f) => tr(f.label));
}

function markEmptyFields(): void {
  for (const f of FIELDS) {
    profileInputs[f.key].closest(".profile-field")?.classList.toggle("empty", !profileInputs[f.key].value.trim());
  }
  renderProgress();
}

let profileLoaded = false;

async function saveProfile(feedback: boolean): Promise<void> {
  if (!profileLoaded) return;
  try {
    await coach.saveProfile(collectProfile());
    if (feedback) setMsg(profileMsg, tr("profile.saved"), "ok");
  } catch (err) {
    setMsg(profileMsg, tr("common.saveFailed", { error: errorText(err) }), "error");
  }
}

const autoSaveProfile = debounce(() => void saveProfile(false), 1000);

for (const f of FIELDS) {
  profileInputs[f.key].addEventListener("input", () => {
    markEmptyFields();
    autoSaveProfile.run();
  });
}
saveProfileBtn.addEventListener("click", () => {
  autoSaveProfile.flush();
  void saveProfile(true);
});

copyPromptBtn.addEventListener("click", async () => {
  try {
    const text = String(await coach.getProfilePrompt());
    if (await copyText(text)) {
      promptFallback.hidden = true;
      setMsg(copyMsg, tr("profile.copied"), "ok");
    } else {
      promptFallback.value = text;
      promptFallback.hidden = false;
      promptFallback.focus();
      promptFallback.select();
      setMsg(copyMsg, tr("profile.copyFailed"), "warn");
    }
  } catch (err) {
    setMsg(copyMsg, tr("profile.promptFailed", { error: errorText(err) }), "error");
  }
});

importBtn.addEventListener("click", async () => {
  const text = importText.value.trim();
  if (!text) {
    setMsg(importMsg, tr("profile.pasteFirst"), "warn");
    importText.focus();
    return;
  }
  try {
    const res = (await coach.parseProfile(text)) as ImportResult;
    if (!res?.filled?.length) {
      setMsg(importMsg, tr("profile.notFound"), "error");
      return;
    }
    // Only overwrite what the answer filled in; keep your own text elsewhere.
    for (const key of res.filled) profileInputs[key].value = res.profile[key];
    markEmptyFields();
    autoSaveProfile.flush();
    await saveProfile(false);
    importText.value = "";
    const empty = emptyFieldLabels();
    if (empty.length) {
      setMsg(importMsg, tr("profile.importedEmpty", { fields: joinList(lang, empty) }), "warn");
    } else {
      setMsg(importMsg, tr("profile.importedAll"), "ok");
    }
  } catch (err) {
    setMsg(importMsg, tr("profile.importFailed", { error: errorText(err) }), "error");
  }
});

// ---------- 3. This call ----------

const briefInput = el<HTMLTextAreaElement>("brief");
const saveBriefBtn = el<HTMLButtonElement>("saveBrief");
const clearBriefBtn = el<HTMLButtonElement>("clearBrief");
const briefMsg = el("briefMsg");

async function saveBrief(feedback: boolean): Promise<void> {
  if (!loaded) return;
  try {
    await coach.saveBrief(briefInput.value);
    state = { ...state, callBrief: briefInput.value };
    if (feedback) setMsg(briefMsg, tr("common.saved"), "ok");
  } catch (err) {
    setMsg(briefMsg, tr("common.saveFailed", { error: errorText(err) }), "error");
  }
}

const autoSaveBrief = debounce(() => void saveBrief(false), 1000);
briefInput.addEventListener("input", () => {
  autoSaveBrief.run();
  renderProgress();
});
saveBriefBtn.addEventListener("click", () => {
  autoSaveBrief.flush();
  void saveBrief(true);
});
clearBriefBtn.addEventListener("click", () => {
  if (briefInput.value.trim() && !window.confirm(tr("call.confirmClear"))) return;
  briefInput.value = "";
  renderProgress();
  autoSaveBrief.flush();
  void saveBrief(true);
  briefInput.focus();
});

// Do not lose typing when the window closes during the debounce.
window.addEventListener("beforeunload", () => {
  autoSaveProfile.flush();
  autoSaveBrief.flush();
});

// ---------- language ----------

/** Puts every text in the language of the settings. Only text: the value of a field is never touched. */
function applyLanguage(): void {
  applyI18n(lang);
  document.title = tr("settings.title");
  if (loaded) renderStatus();
  else renderProgress();
}

/** Called whenever new settings arrive: switches the language when it changed. */
function syncLanguage(): void {
  const next = normLang(state.settings.language);
  if (next === lang) return;
  lang = next;
  applyLanguage();
}

applyLanguage();

// ---------- load ----------

async function init(): Promise<void> {
  try {
    const profile = (await coach.getProfile()) as Profile;
    for (const f of FIELDS) profileInputs[f.key].value = profile?.[f.key] ?? "";
    profileLoaded = true;
    markEmptyFields();
  } catch (err) {
    setMsg(profileMsg, tr("profile.loadFailed", { error: errorText(err) }), "error");
  }

  try {
    state = (await coach.getState()) as PublicSettingsState;
    lang = normLang(state.settings.language);
    applyLanguage();
    renderForm(state.settings);
    briefInput.value = state.callBrief ?? "";
    loaded = true;
    renderStatus();
    await ensureChatGPTModel();
  } catch (err) {
    readyTitle.textContent = tr("settings.loadFailedTitle");
    readyDetail.textContent = tr("settings.loadFailedDetail", { error: errorText(err) });
    readinessEl.className = "readiness error";
  }
}

// "auto" can also be switched in the overlay. Pick that up so a save here does not undo it.
function applyExternalSettings(s: Settings): void {
  state = { ...state, settings: s };
  autoTipsBox.checked = s.autoTips;
  if (languageSel.value !== s.language) {
    ensureOption(languageSel, s.language);
    languageSel.value = s.language;
  }
  syncLanguage();
  renderStatus();
}

coach.onSettings((payload) => applyExternalSettings(payload as Settings));

let lastRefresh = 0;
window.addEventListener("focus", () => {
  if (!loaded || Date.now() - lastRefresh < 5000) return;
  lastRefresh = Date.now();
  void (async () => {
    try {
      const st = (await coach.getState()) as PublicSettingsState;
      state = { ...st, settings: { ...state.settings, ...st.settings } };
      autoTipsBox.checked = st.settings.autoTips;
      syncLanguage();
      renderStatus();
    } catch {
      /* keep what we have */
    }
  })();
});

void init();
