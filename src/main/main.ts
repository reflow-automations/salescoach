// Electron main process: windows, hotkeys, providers and the coach.
// All API keys and tokens stay in this process; the renderer never sees them.
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } from "electron";
import { join } from "node:path";
import { Coach } from "../coach/coach";
import { profilePrompt, parseProfile } from "../coach/profile-import";
import { buildInstructions } from "../coach/prompt";
import { t, type MessageKey } from "../shared/i18n";
import { DEFAULT_SETTINGS, type PublicSettingsState, type SecretName, type Settings, type Speaker, type StatusEvent, type TipEvent, type TranscriptEvent } from "../shared/types";
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
let settings: Settings;
let ears: Partial<Record<Speaker, EarsSession>> = {};
let listening = false;
/** Bumped on every start, so late callbacks from closed ears sessions are ignored. */
let earsGeneration = 0;

const coach = new Coach({
  brain: () => makeBrain(),
  instructions: () => buildInstructions(store.loadProfile(), store.loadCallBrief(), settings.language),
  autoTips: () => settings.autoTips,
  language: () => settings.language,
  emit: (e: TipEvent) => overlay?.webContents.send("tip", e),
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
  const apiKey = requireSecret(earsSecret());
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
  // First, so whatever the closing sessions still report is dropped and cannot stop us twice.
  listening = false;
  const old = ears;
  ears = {};
  for (const e of Object.values(old)) e?.close();
  coach.cancel();
  sendStatus(status);
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
  ipcMain.handle("settings:save", (_e, s: Settings) => {
    const prev = settings;
    settings = { ...settings, ...s };
    store.saveSettings(settings);
    // Everything below must not throw: the settings are already saved.
    if (settings.hotkeyHelp !== prev.hotkeyHelp || settings.hotkeyToggle !== prev.hotkeyToggle) registerHotkeys();
    overlay?.webContents.send("settings", settings);
    settingsWin?.webContents.send("settings", settings);
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
}

// ---------- app ----------

// One instance only: two would spend the same rotating ChatGPT refresh token and fight over the hotkeys.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on("second-instance", () => overlay?.show());

app.whenReady().then(() => {
  if (!primary) return;
  settings = store.loadSettings();
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

// `npm run smoke`: open both windows, report renderer errors, quit. No keys or audio needed.
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
