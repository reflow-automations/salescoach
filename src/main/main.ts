// Electron main process: windows, hotkeys, providers and the coach.
// All API keys and tokens stay in this process; the renderer never sees them.
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell } from "electron";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Coach } from "../coach/coach";
import { buildFeedbackInput, buildFeedbackInstructions, FEEDBACK_MIN_MS, smartestModel } from "../coach/feedback";
import { profilePrompt, parseProfile } from "../coach/profile-import";
import { buildInstructions, type Line } from "../coach/prompt";
import { t, type MessageKey } from "../shared/i18n";
import {
  DEFAULT_SETTINGS,
  normCallType,
  type BrainProviderId,
  type CallType,
  type FeedbackCallInfo,
  type FeedbackResult,
  type FeedbackSaveResult,
  type PublicSettingsState,
  type SecretName,
  type Settings,
  type Speaker,
  type StatusEvent,
  type TipEvent,
  type TranscriptEvent,
  FEEDBACK_DEFAULT_MODELS,
  RETIRED_DEFAULTS,
} from "../shared/types";
import * as chatgpt from "./chatgpt-auth";
import type { Brain } from "./providers/brain";
import { createGeminiBrain } from "./providers/brain-gemini";
import { createOpenAIBrain } from "./providers/brain-openai";
import type { EarsOptions, EarsSession } from "./providers/ears";
import { createGeminiEars } from "./providers/ears-gemini";
import { createOpenAIEars } from "./providers/ears-openai";
import * as store from "./store";

let overlay: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let feedbackWin: BrowserWindow | null = null;
let settings: Settings;
let ears: Partial<Record<Speaker, EarsSession>> = {};
let listening = false;
/** Bumped on every start, so late callbacks from closed ears sessions are ignored. */
let earsGeneration = 0;

/**
 * The call that just ended, for the feedback window. Only in memory: nothing is written to disk
 * unless the user saves the feedback. The next call that is long enough for feedback replaces it;
 * a failed start or a very short call keeps it.
 */
let lastCall: { id: number; lines: Line[]; durationMs: number; endedAt: number; callType: CallType } | null = null;
let callCounter = 0;
/** The call the open feedback window shows. */
let feedbackWinCallId = 0;
/** The running feedback request; closing the window or a new request aborts it. */
let feedbackRun: AbortController | null = null;

const coach = new Coach({
  brain: () => makeBrain(),
  instructions: () => buildInstructions(store.loadProfile(), store.loadCallBrief(), settings.language, normCallType(settings.callType)),
  // Read on every request: a switch in the overlay or the settings applies to the next tip, without restarting the ears.
  callType: () => normCallType(settings.callType),
  autoTips: () => settings.autoTips,
  tipsWhileSpeaking: () => settings.tipsWhileSpeaking !== false,
  language: () => settings.language,
  emit: (e: TipEvent) => overlay?.webContents.send("tip", e),
  // A failed automatic tip (a rate limit, a dropped connection) goes to the status line, not over the tip.
  warn: (message) => {
    if (listening) sendStatus({ listening, message, level: "warn" });
  },
});

/** A user-facing text in the language of the settings. */
function tr(key: MessageKey, vars?: Record<string, string | number>): string {
  return t(settings?.language, key, vars);
}

function sendStatus(s: StatusEvent): void {
  overlay?.webContents.send("status", s);
}

/** Like sendStatus, but waits until the overlay page has loaded so the message is not lost. */
function sendStatusWhenReady(s: StatusEvent): void {
  const wc = overlay?.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.once("did-finish-load", () => sendStatus(s));
  else sendStatus(s);
}

// ---------- providers ----------

function requireSecret(name: SecretName): string {
  const v = store.getSecret(name);
  if (!v) throw new Error(tr("main.missingKey", { label: tr(name === "openaiKey" ? "label.openaiKey" : "label.geminiKey") }));
  return v;
}

function makeBrain(): Brain {
  switch (settings.brain) {
    case "openai-key": {
      const key = requireSecret("openaiKey");
      return createOpenAIBrain({ model: settings.openaiModel, getToken: async () => key, planUsage: false, language: settings.language });
    }
    case "chatgpt":
      if (!settings.chatgptModel) throw new Error(tr("main.chooseChatgptModel"));
      return createOpenAIBrain({ model: settings.chatgptModel, getToken: chatgpt.getAccessToken, planUsage: true, language: settings.language });
    case "gemini":
    default:
      return createGeminiBrain({ model: settings.geminiModel, apiKey: requireSecret("geminiKey") });
  }
}

/**
 * The brain for the feedback after the call. Speed does not matter there: more reasoning and room
 * for a long answer. Without its own setting it uses the provider and model of the live brain.
 */
// Model lists per provider, fetched with the user's own key so new models show up without an update.
const providerModelCache = new Map<string, { at: number; ids: string[] }>();

async function listProviderModels(provider: "gemini" | "openai"): Promise<string[]> {
  const key = store.getSecret(provider === "gemini" ? "geminiKey" : "openaiKey");
  if (!key) return [];
  const hit = providerModelCache.get(provider);
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.ids;
  // Only text models that can write a tip; no audio, image, embedding or realtime models.
  const skip = /realtime|audio|transcribe|tts|image|embed|search|live|vision|moderation|computer|codex|veo|imagen|aqa/i;
  let ids: string[] = [];
  try {
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) return [];
      const body: any = await res.json();
      ids = (body.data ?? []).map((m: any) => String(m.id)).filter((id: string) => /^(gpt-|o\d)/.test(id) && !skip.test(id));
    } else {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
      if (!res.ok) return [];
      const body: any = await res.json();
      ids = (body.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m.name).replace(/^models\//, ""))
        .filter((id: string) => id.startsWith("gemini") && !skip.test(id));
    }
  } catch {
    return [];
  }
  ids = [...new Set(ids)].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  providerModelCache.set(provider, { at: Date.now(), ids });
  return ids;
}

function makeFeedbackBrain(): { brain: Brain; model: string } {
  const own = !!settings.feedbackBrain && settings.feedbackBrain !== "same";
  const provider: BrainProviderId = own ? (settings.feedbackBrain as BrainProviderId) : settings.brain;
  const ownModel = own ? (settings.feedbackModel ?? "").trim() : "";
  switch (provider) {
    case "openai-key": {
      const key = requireSecret("openaiKey");
      // Also with "same": same service as the tips, but the smarter model; speed does not matter here.
      const model = ownModel || FEEDBACK_DEFAULT_MODELS.openai;
      return {
        model,
        brain: createOpenAIBrain({ model, getToken: async () => key, planUsage: false, language: settings.language, reasoningEffort: "low", verbosity: "medium", maxOutputTokens: 4000 }),
      };
    }
    case "chatgpt": {
      // Like the settings window: without a chosen feedback model, the larger one from the plan.
      const model = ownModel || (modelCache?.models.length ? smartestModel(modelCache.models) : "") || settings.chatgptModel;
      if (!model) throw new Error(tr(own ? "main.chooseFeedbackModel" : "main.chooseChatgptModel"));
      const name = modelCache?.models.find((m) => m.slug === model)?.displayName || model;
      // The plan rejects sampling fields, so no output cap; "medium" thinks longer than the live tips.
      return {
        model: name,
        brain: createOpenAIBrain({ model, getToken: chatgpt.getAccessToken, planUsage: true, language: settings.language, reasoningEffort: "medium", verbosity: "medium" }),
      };
    }
    case "gemini":
    default: {
      const model = ownModel || FEEDBACK_DEFAULT_MODELS.gemini;
      // No "minimal thinking" knob, and room for thinking plus the whole answer.
      return { model, brain: createGeminiBrain({ model, apiKey: requireSecret("geminiKey"), minimalThinking: false, maxOutputTokens: 8192, temperature: 0.3 }) };
    }
  }
}

function callMinutes(durationMs: number): number {
  return Math.max(1, Math.round(durationMs / 60_000));
}

/** 2026-10-05-1432 in local time, for the file name of saved feedback. */
function fileStamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function vocabulary(): string[] {
  // Company and product names from the first line of "who am I" and "offer" help recognition.
  const p = store.loadProfile();
  const words = `${p.whoAmI.split("\n")[0]} ${p.offer.split("\n")[0]}`.match(/\b[A-Z][\w-]{2,}\b/g) ?? [];
  return [...new Set(words)].slice(0, 30);
}

/** The secret the current ears provider needs. */
function earsSecret(): SecretName {
  return settings.ears === "openai" ? "openaiKey" : "geminiKey";
}

/**
 * Opens one ears session per speaker with the current settings. Their callbacks only count
 * while `generation` is the live one. Throws when the key is missing, before opening anything.
 */
function makeEars(generation: number): Record<Speaker, EarsSession> {
  // A closed session may still deliver text or errors for a few seconds; drop those.
  const live = () => listening && generation === earsGeneration;
  const needed = earsSecret();
  if (settings.brain === "chatgpt" && !store.getSecret(needed)) {
    // The ChatGPT plan only covers text (the tips); live transcription needs its own key.
    throw new Error(tr("main.earsKeyChatgpt", { label: tr(needed === "openaiKey" ? "label.openaiKey" : "label.geminiKey") }));
  }
  const apiKey = requireSecret(needed);
  const make = (speaker: Speaker): EarsSession => {
    const opts: EarsOptions = {
      apiKey,
      language: settings.language,
      vocabulary: vocabulary(),
      onText: (t) => {
        if (!live()) return;
        const e: TranscriptEvent = { speaker, ...t };
        coach.onTranscript(e);
        overlay?.webContents.send("transcript", e);
      },
      onStatus: (message, level) => {
        if (live()) sendStatus({ listening, message, level });
      },
      // Both speakers share the key, so both usually give up together: only the first one stops.
      onFatal: (message) => {
        if (live()) stopListening({ listening: false, message, level: "error" });
      },
    };
    return settings.ears === "openai" ? createOpenAIEars(opts, speaker) : createGeminiEars(opts, speaker);
  };
  return { me: make("me"), them: make("them") };
}

function startListening(): void {
  if (listening) return;
  const generation = ++earsGeneration;
  ears = makeEars(generation);
  listening = true;
  coach.reset();
  sendStatus({ listening: true, message: tr("status.listening"), level: "info" });
}

/** `status` replaces the plain "Stopped", so a stop because of an error shows only that error. */
function stopListening(status: StatusEvent = { listening: false, message: tr("status.stopped"), level: "info" }): void {
  const wasListening = listening;
  // First, so whatever the closing sessions still report is dropped and cannot stop us twice.
  listening = false;
  const old = ears;
  ears = {};
  for (const e of Object.values(old)) e?.close();
  coach.cancel();
  if (wasListening) {
    const { lines, durationMs } = coach.callTranscript();
    // The call type at the end of the call: the feedback is written for it, also when it is switched later.
    if (lines.length && durationMs >= FEEDBACK_MIN_MS) lastCall = { id: ++callCounter, lines, durationMs, endedAt: Date.now(), callType: normCallType(settings.callType) };
  }
  // The overlay offers feedback on a call of at least 2 minutes.
  const feedback = !!lastCall && lastCall.durationMs >= FEEDBACK_MIN_MS;
  sendStatus({ ...status, feedback, ...(lastCall ? { callMinutes: callMinutes(lastCall.durationMs) } : {}) });
}

/**
 * Another ears provider, language or key while listening: swap the sessions and keep the
 * capture, transcript and coach running. The new sessions are opened first, so a missing
 * key leaves the old ones working instead of stopping the call.
 */
function restartEars(): void {
  if (!listening) return;
  let next: Record<Speaker, EarsSession>;
  try {
    next = makeEars(earsGeneration + 1);
  } catch (err) {
    sendStatus({ listening, message: tr("main.restartKept", { error: (err as Error).message }), level: "warn" });
    return;
  }
  earsGeneration++;
  const old = ears;
  ears = next;
  for (const e of Object.values(old)) e?.close();
  sendStatus({ listening, message: tr("main.restarted"), level: "info" });
}

// ---------- windows ----------

function createOverlay(): void {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 560;
  overlay = new BrowserWindow({
    width,
    height: 210,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 8,
    // Opaque on purpose: Windows cannot resize transparent windows.
    frame: false,
    backgroundColor: "#131C2B",
    resizable: true,
    minWidth: 380,
    minHeight: 120,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: "Salescoach",
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setContentProtection(true); // invisible in screen shares and recordings
  overlay.loadFile(join(__dirname, "renderer", "overlay.html"));
  overlay.on("closed", () => {
    overlay = null;
    stopListening();
    app.quit();
  });
}

function openSettings(): void {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 820,
    title: tr("main.settingsTitle"),
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.setContentProtection(true);
  settingsWin.loadFile(join(__dirname, "renderer", "settings.html"));
  settingsWin.on("closed", () => (settingsWin = null));
}

/** The feedback window for the last call. A window that shows an older call loads the new one. */
function openFeedback(): void {
  const callId = lastCall?.id ?? 0;
  if (feedbackWin) {
    if (feedbackWinCallId !== callId) {
      feedbackWinCallId = callId;
      feedbackWin.webContents.reload();
    }
    if (feedbackWin.isMinimized()) feedbackWin.restore();
    feedbackWin.focus();
    return;
  }
  feedbackWinCallId = callId;
  const { workArea } = screen.getPrimaryDisplay();
  feedbackWin = new BrowserWindow({
    width: 720,
    height: Math.min(860, workArea.height - 40),
    minWidth: 460,
    minHeight: 420,
    title: tr("feedback.title"),
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  feedbackWin.setContentProtection(true); // the feedback quotes the call: keep it out of screen shares
  feedbackWin.loadFile(join(__dirname, "renderer", "feedback.html"));
  feedbackWin.on("closed", () => {
    feedbackWin = null;
    feedbackRun?.abort();
    feedbackRun = null;
  });
}

/** Electron throws on an accelerator it cannot parse and returns false when another program has it. */
function tryRegister(accel: unknown, action: () => void): "ok" | "taken" | "invalid" {
  if (typeof accel !== "string" || !accel.trim()) return "invalid";
  try {
    return globalShortcut.register(accel, action) ? "ok" : "taken";
  } catch {
    return "invalid";
  }
}

const prettyKey = (accel: string) => accel.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl");

/** Never throws: a broken hotkey in settings.json falls back to the default and shows a warning. */
function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const problems: string[] = [];
  const bind = (key: "hotkeyHelp" | "hotkeyToggle", action: () => void) => {
    const wanted: unknown = settings[key];
    const result = tryRegister(wanted, action);
    if (result === "taken") problems.push(tr("main.hotkeyTaken", { key: prettyKey(String(wanted)) }));
    if (result !== "invalid") return;
    // Keep the default in memory too, so the settings window shows the key that works.
    const fallback = DEFAULT_SETTINGS[key];
    settings = { ...settings, [key]: fallback };
    const label = typeof wanted === "string" && wanted.trim() ? `"${wanted}"` : tr("main.hotkeyFromFile");
    const vars = { label, key: prettyKey(fallback) };
    problems.push(tryRegister(fallback, action) === "ok" ? tr("main.hotkeyInvalidFallback", vars) : tr("main.hotkeyInvalidTaken", vars));
  };
  bind("hotkeyHelp", () => void coach.requestTip("hotkey"));
  bind("hotkeyToggle", () => {
    if (!overlay) return;
    if (overlay.isVisible()) overlay.hide();
    else overlay.showInactive();
  });
  if (problems.length) sendStatusWhenReady({ listening, message: problems.join(" "), level: "warn" });
}

// The ChatGPT model list is a network call; cache it so settings changes stay instant.
let modelCache: { at: number; models: PublicSettingsState["chatgpt"]["models"] } | null = null;
const MODEL_CACHE_MS = 10 * 60 * 1000;

async function publicState(): Promise<PublicSettingsState> {
  let cg = chatgpt.status();
  if (cg.sharing && (!modelCache || Date.now() - modelCache.at > MODEL_CACHE_MS)) {
    try {
      modelCache = { at: Date.now(), models: await chatgpt.listModels() };
    } catch {
      /* show connected without models */
    }
    // A dead refresh token inside listModels signs us out; report that in this answer, not the next.
    cg = chatgpt.status();
  }
  if (cg.sharing) {
    cg.models = modelCache?.models ?? [];
  } else {
    modelCache = null;
  }
  return { settings, hasSecret: store.hasSecrets(), chatgpt: cg, callBrief: store.loadCallBrief() };
}

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.on("audio", (_e, speaker: Speaker, chunk: ArrayBuffer) => {
    if (!listening) return;
    ears[speaker]?.send(Buffer.from(chunk));
  });
  ipcMain.handle("listen:start", () => {
    try {
      startListening();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("listen:stop", () => stopListening());
  ipcMain.handle("tip:request", () => coach.requestTip("hotkey"));
  ipcMain.handle("settings:open", () => openSettings());
  ipcMain.handle("overlay:hide", () => overlay?.hide());

  ipcMain.handle("capture:ended", (_e, kind: unknown, reason: unknown) => {
    // Mic and loopback often end together (a headset): the first report stops, the second finds nothing to do.
    if (!listening) return;
    console.warn(`Capture ${String(kind)} ended: ${String(reason)}`);
    stopListening({ listening: false, message: tr("main.captureEnded"), level: "error" });
  });

  ipcMain.handle("state:get", () => publicState());
  ipcMain.handle("models:list", (_e, provider: "gemini" | "openai") => listProviderModels(provider));
  ipcMain.handle("settings:save", (_e, s: Settings) => {
    const prev = settings;
    settings = { ...settings, ...s };
    store.saveSettings(settings);
    // Everything below must not throw: the settings are already saved.
    if (settings.hotkeyHelp !== prev.hotkeyHelp || settings.hotkeyToggle !== prev.hotkeyToggle) registerHotkeys();
    overlay?.webContents.send("settings", settings);
    settingsWin?.webContents.send("settings", settings);
    feedbackWin?.webContents.send("settings", settings);
    if (settings.ears !== prev.ears || settings.language !== prev.language) restartEars();
    return publicState();
  });
  ipcMain.handle("secret:set", (_e, name: SecretName, value: string) => {
    if (name !== "openaiKey" && name !== "geminiKey") throw new Error(tr("main.unknownSecret"));
    store.setSecret(name, value);
    if (name === earsSecret()) restartEars();
    return store.hasSecrets();
  });
  ipcMain.handle("profile:get", () => store.loadProfile());
  ipcMain.handle("profile:save", (_e, p) => store.saveProfile(p));
  ipcMain.handle("profile:prompt", () => profilePrompt(settings.language));
  ipcMain.handle("profile:parse", (_e, text: string) => parseProfile(text));
  ipcMain.handle("brief:save", (_e, text: string) => store.saveCallBrief(text));

  ipcMain.handle("chatgpt:signin", async () => {
    try {
      await chatgpt.signIn();
      modelCache = null;
      return { ok: true, state: await publicState() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("chatgpt:signout", () => {
    chatgpt.signOut();
    modelCache = null;
    return publicState();
  });
  ipcMain.handle("chatgpt:usage", () => shell.openExternal(chatgpt.CHATGPT_USAGE_URL));

  // ---- feedback after the call ----
  ipcMain.handle("feedback:open", () => openFeedback());
  ipcMain.handle("feedback:call", (): FeedbackCallInfo | null =>
    lastCall ? { minutes: callMinutes(lastCall.durationMs), endedAt: lastCall.endedAt, callType: lastCall.callType } : null,
  );
  // One request with the whole transcript. The text streams to the window as "feedback:delta" events
  // (tagged with the window's request id); the final text is the answer of this invoke.
  ipcMain.handle("feedback:create", async (e, reqId: unknown): Promise<FeedbackResult> => {
    const call = lastCall;
    if (!call || call.durationMs < FEEDBACK_MIN_MS) return { ok: false, error: tr("feedback.noCall") };
    feedbackRun?.abort();
    const ctrl = new AbortController();
    feedbackRun = ctrl;
    const sender = e.sender;
    const id = String(reqId ?? "");
    try {
      // The ChatGPT model list is needed to pick the default feedback model.
      if (settings.feedbackBrain === "chatgpt" && !settings.feedbackModel) await publicState();
      const { brain, model } = makeFeedbackBrain();
      const text = await brain({
        instructions: buildFeedbackInstructions({ profile: store.loadProfile(), callBrief: store.loadCallBrief(), language: settings.language, callType: call.callType }),
        input: buildFeedbackInput(call.lines, call.durationMs),
        signal: ctrl.signal,
        onDelta: (d) => {
          if (!ctrl.signal.aborted && !sender.isDestroyed()) sender.send("feedback:delta", { reqId: id, text: d });
        },
      });
      if (ctrl.signal.aborted) return { ok: false, error: "aborted", aborted: true };
      if (!text.trim()) return { ok: false, error: tr("feedback.empty") };
      return { ok: true, text, model };
    } catch (err) {
      if (ctrl.signal.aborted) return { ok: false, error: "aborted", aborted: true };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (feedbackRun === ctrl) feedbackRun = null;
    }
  });
  // Only here does anything about a call reach the disk: the user picked the file.
  ipcMain.handle("feedback:save", async (e, text: unknown): Promise<FeedbackSaveResult> => {
    if (typeof text !== "string" || !text.trim() || text.length > 1_000_000) return { ok: false, error: tr("feedback.empty") };
    const win = BrowserWindow.fromWebContents(e.sender);
    const options: Electron.SaveDialogOptions = {
      title: tr("feedback.save"),
      defaultPath: join(app.getPath("documents"), `salescoach-feedback-${fileStamp(lastCall?.endedAt ?? Date.now())}.md`),
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Text", extensions: ["txt"] },
      ],
    };
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      writeFileSync(res.filePath, text, { encoding: "utf8" });
      return { ok: true, file: basename(res.filePath) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}

// ---------- app ----------

// One instance only: two would spend the same rotating ChatGPT refresh token and fight over the hotkeys.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on("second-instance", () => overlay?.show());

app.whenReady().then(() => {
  if (!primary) return;
  settings = store.loadSettings();
  // Users who never changed the model move along with the default when it is retired.
  let migrated = false;
  for (const [field, old] of Object.entries(RETIRED_DEFAULTS) as [keyof typeof RETIRED_DEFAULTS, string[]][]) {
    if (old.includes(settings[field])) {
      settings = { ...settings, [field]: DEFAULT_SETTINGS[field] };
      migrated = true;
    }
  }
  if (migrated) store.saveSettings(settings);
  // The ChatGPT sign-in pages and errors follow the language of the settings.
  chatgpt.setLanguage(() => settings.language);
  store.setLanguage(() => settings.language);

  // System audio capture: hand the renderer a screen source with Windows loopback audio.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, callback) => {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      callback({ video: sources[0], audio: "loopback" });
    },
    { useSystemPicker: false },
  );
  // Only the microphone, display capture and writing to the clipboard (copy buttons) are allowed.
  const allowed = new Set<string>(["media", "display-capture", "clipboard-sanitized-write"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));

  registerIpc();
  createOverlay();
  registerHotkeys();
  if (process.env.SALESCOACH_SMOKE) void smokeTest();
});

// `npm run smoke`: open all windows, report renderer errors, quit. No keys or audio needed.
async function smokeTest(): Promise<void> {
  const problems: string[] = [];
  const watch = (name: string, win: BrowserWindow) => {
    win.webContents.on("console-message", (e) => {
      if (e.level === "error") problems.push(`${name} console: ${e.message}`);
    });
    win.webContents.on("render-process-gone", (_e, d) => problems.push(`${name} renderer gone: ${d.reason}`));
    win.webContents.on("did-fail-load", (_e, code, desc) => problems.push(`${name} load failed: ${code} ${desc}`));
  };
  const loaded = (win: BrowserWindow) =>
    new Promise<void>((r) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", () => r()) : r()));
  if (overlay) {
    watch("overlay", overlay);
    await loaded(overlay);
  }
  openSettings();
  if (settingsWin) {
    watch("settings", settingsWin);
    await loaded(settingsWin);
  }
  // Without a call the feedback window shows its "no call yet" state; it must load without errors.
  openFeedback();
  if (feedbackWin) {
    watch("feedback", feedbackWin);
    await loaded(feedbackWin);
  }
  await new Promise((r) => setTimeout(r, 2500));
  console.log(problems.length ? `SMOKE FAIL\n${problems.join("\n")}` : "SMOKE OK");
  app.exit(problems.length ? 1 : 0);
}

app.on("will-quit", () => {
  if (!primary) return;
  globalShortcut.unregisterAll();
  stopListening();
});

app.on("window-all-closed", () => app.quit());
