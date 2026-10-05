// Preview-only stand-in for the Electron preload bridge (window.coach).
//
// Loaded as a classic script BEFORE the page's module script, so the real renderer code
// finds window.coach exactly as it would inside Electron. Everything runs in memory and
// all data is fictional (seller Sam Carter, Carter Web Studio in English, Lisa de Vries,
// Vries Webdesign in Dutch; see examples/).
//
// Pick a language with ?lang=en|nl (default en): it sets the language of the settings, so
// the pages, the demo call and the tips follow it.
// Pick a scenario with ?scene=NAME (list: preview/scenes.json). After DOMContentLoaded
// the scene plays its events through the handlers the page registered (onTip,
// onTranscript, onStatus, onSettings) and then sets window.__sceneReady = true.
// scripts/shots.cjs waits for that flag before it takes a screenshot.
//
// Drive it by hand from the devtools console with window.__mock (emit, streamTip, state).

import { parseProfile, profilePrompt } from "../src/coach/profile-import";
import type { CoachApi } from "../src/main/preload";
import { normLang, t } from "../src/shared/i18n";
import {
  DEFAULT_SETTINGS,
  EMPTY_PROFILE,
  type ChatGPTStatus,
  type Profile,
  type PublicSettingsState,
  type SecretName,
  type Settings,
  type Speaker,
  type StatusEvent,
  type TipEvent,
  type TranscriptEvent,
} from "../src/shared/types";
import briefExampleEn from "../examples/call-brief-example.en.md";
import briefExampleNl from "../examples/call-brief-example.nl.md";
import profileExampleEn from "../examples/profile-example.en.md";
import profileExampleNl from "../examples/profile-example.nl.md";
import scenes from "./scenes.json";

declare global {
  interface Window {
    __sceneReady?: boolean;
    __sceneError?: string;
    __mock?: unknown;
  }
}

/**
 * CoachApi with one relaxation: an unsubscribe function may return anything
 * (ipcRenderer.removeListener returns the IpcRenderer, nobody uses that value).
 * Every method of the real bridge must still be present with a compatible signature.
 */
type Unsub<T> = T extends (fn: infer F) => () => unknown ? (fn: F) => () => unknown : T;
type MockCoachApi = { [K in keyof CoachApi]: Unsub<CoachApi[K]> };

// Captured before any scene patches timers or the clock.
const realSetTimeout = window.setTimeout.bind(window);
const realNow = Date.now.bind(Date);
const sleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = realNow() + timeoutMs;
  while (realNow() < until) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

// ---------- scene selection ----------

type Page = "overlay" | "settings";
const page: Page =
  /settings\.html$/i.test(location.pathname) || document.documentElement.classList.contains("settings-root") ? "settings" : "overlay";
const sceneNames = (page === "settings" ? scenes.settings : scenes.overlay).map((s) => s.name);
const requested = new URLSearchParams(location.search).get("scene") ?? "";
let scene = requested || sceneNames[0];
if (!sceneNames.includes(scene)) {
  console.warn(`[mock] Onbekende scene "${requested}" voor ${page}. Kies uit: ${sceneNames.join(", ")}.`);
  scene = sceneNames[0];
}
document.documentElement.dataset.scene = scene;

const lang = normLang(new URLSearchParams(location.search).get("lang") ?? "en");
document.documentElement.dataset.previewLang = lang;
const nl = lang === "nl";

// ---------- demo data ----------

const FULL_PROFILE: Profile = { ...EMPTY_PROFILE, ...parseProfile(nl ? profileExampleNl : profileExampleEn).profile };
const PARTIAL_KEYS: (keyof Profile)[] = ["whoAmI", "offer", "pricing", "idealCustomer", "tone"];
const PARTIAL_PROFILE: Profile = { ...EMPTY_PROFILE };
for (const k of PARTIAL_KEYS) PARTIAL_PROFILE[k] = FULL_PROFILE[k];

/** The brief example without its explanation above the "---" line. */
const briefExample = nl ? briefExampleNl : briefExampleEn;
const BRIEF = (briefExample.split(/^---[ \t]*$/m)[1] ?? briefExample).trim();

const CHATGPT_MODELS: ChatGPTStatus["models"] = [
  { slug: "gpt-5.5", displayName: "GPT-5.5" },
  { slug: "gpt-5.5-mini", displayName: "GPT-5.5 mini" },
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
];
const CHATGPT_CONNECTED: ChatGPTStatus = {
  connected: true,
  sharing: true,
  email: nl ? "lisa@vrieswebdesign.nl" : "sam@carterwebstudio.example",
  models: CHATGPT_MODELS,
};
const CHATGPT_DISCONNECTED: ChatGPTStatus = { connected: false, sharing: false, models: [] };

/** A first call with Pete Hollis or Peter Hoogendoorn (fictional, see examples/call-brief-example.*.md). */
const CALL: [Speaker, string][] = nl
  ? [
      ["me", "Hoe komen nieuwe klanten nu bij jullie binnen, Peter?"],
      ["them", "Vooral via Google en mond-tot-mond. Onze site is van 2018."],
      ["me", "Hoeveel offerteaanvragen komen er via die site binnen?"],
      ["them", "Weinig. Twee per maand misschien, de rest belt gewoon."],
      ["me", "En wat is een gemiddelde klus voor jullie waard?"],
      ["them", "Een nieuwe ketel zo'n 2.500 euro. Maar 3.450 voor een site vind ik best veel."],
    ]
  : [
      ["me", "How do new customers find you at the moment, Pete?"],
      ["them", "Mostly through Google and word of mouth. Our site is from 2018."],
      ["me", "How many quote requests come in through that site?"],
      ["them", "Not many. Two a month maybe, the rest just call us."],
      ["me", "And what is an average job worth to you?"],
      ["them", "A new boiler is about 2,500. But 3,450 for a website feels like a lot."],
    ];

const TIPS = nl
  ? [
      "Vraag waarmee hij het vergelijkt. Verdedig de prijs niet.\n? Wat levert één extra ketelklus per maand je op?",
      "Vraag rustig wat er bij het vorige bureau misging.\n? Wat moet er nu anders gaan dan toen?",
      "Prik nu een datum voor de gratis website-scan.\n? Past dinsdag of donderdag je beter?",
    ]
  : [
      "Ask what he compares it with. Do not defend the price.\n? What is one extra boiler job a month worth to you?",
      "Ask calmly what went wrong with the last web company.\n? What has to go differently this time?",
      "Set a date for the free website check now.\n? Does Tuesday or Thursday suit you better?",
    ];

/** Same texts as main.ts sends. */
const MISSING_KEY = {
  gemini: t(lang, "main.missingKey", { label: t(lang, "label.geminiKey") }),
  openai: t(lang, "main.missingKey", { label: t(lang, "label.openaiKey") }),
};

// ---------- in-memory state ----------

interface MockState {
  settings: Settings;
  hasSecret: Record<SecretName, boolean>;
  chatgpt: ChatGPTStatus;
  callBrief: string;
  profile: Profile;
  listening: boolean;
  audioChunks: number;
}

const state: MockState = {
  settings: { ...DEFAULT_SETTINGS, language: lang },
  hasSecret: { geminiKey: true, openaiKey: false },
  chatgpt: structuredClone(CHATGPT_DISCONNECTED),
  callBrief: BRIEF,
  profile: { ...FULL_PROFILE },
  listening: false,
  audioChunks: 0,
};

switch (scene) {
  case "missing":
    state.hasSecret = { geminiKey: false, openaiKey: false };
    state.profile = { ...EMPTY_PROFILE };
    state.callBrief = "";
    break;
  case "ready":
    state.chatgpt = structuredClone(CHATGPT_CONNECTED);
    state.settings = { ...state.settings, brain: "chatgpt", chatgptModel: CHATGPT_MODELS[0].slug };
    break;
  case "profile":
    state.profile = { ...PARTIAL_PROFILE };
    break;
  case "error":
    state.hasSecret = { geminiKey: false, openaiKey: false };
    break;
}

function publicState(): PublicSettingsState {
  return structuredClone({
    settings: state.settings,
    hasSecret: state.hasSecret,
    chatgpt: state.chatgpt,
    callBrief: state.callBrief,
  });
}

/** Same check as main.ts does when the ears start. */
function startProblem(): string | null {
  const ears = state.settings.ears;
  if (ears === "gemini" && !state.hasSecret.geminiKey) return MISSING_KEY.gemini;
  if (ears === "openai" && !state.hasSecret.openaiKey) return MISSING_KEY.openai;
  return null;
}

// ---------- events ----------

type Channel = "tip" | "transcript" | "status" | "settings";
type Handler = (payload: unknown) => void;
const handlers: Record<Channel, Set<Handler>> = {
  tip: new Set(),
  transcript: new Set(),
  status: new Set(),
  settings: new Set(),
};

/** Like webContents.send: the payload is copied, as IPC would. */
function emit(channel: Channel, payload: TipEvent | TranscriptEvent | StatusEvent | Settings): void {
  for (const fn of [...handlers[channel]]) {
    try {
      fn(structuredClone(payload));
    } catch (err) {
      console.error(`[mock] ${channel}-handler gaf een fout`, err);
    }
  }
}

const on = (channel: Channel) => (fn: Handler) => {
  handlers[channel].add(fn);
  return () => {
    handlers[channel].delete(fn);
  };
};

let tipSeq = 0;
let tipIndex = 0;
let streaming = false;

/** Streams a tip like the coach does: start, small deltas, then done (unless finish is false). */
async function streamTip(
  text: string,
  trigger: "hotkey" | "auto",
  opts: { finish?: boolean; dropWords?: number; stepMs?: number } = {},
): Promise<string> {
  const { finish = true, dropWords = 0, stepMs = 60 } = opts;
  const id = `tip-${++tipSeq}`;
  streaming = true;
  try {
    emit("tip", { kind: "start", id, trigger });
    const words = text.match(/\S+\s*/g) ?? [];
    const sent = dropWords ? words.slice(0, -dropWords) : words;
    for (let i = 0; i < sent.length; i += 2) {
      await sleep(stepMs);
      emit("tip", { kind: "delta", id, text: sent.slice(i, i + 2).join("") });
    }
    if (finish) {
      await sleep(stepMs);
      emit("tip", { kind: "done", id });
    }
  } finally {
    streaming = false;
  }
  return id;
}

let lineSeq = 0;

/** Sends call lines as the ears would: an interim version first, then the final text. */
async function say(lines: [Speaker, string][]): Promise<void> {
  for (const [speaker, text] of lines) {
    const id = `${speaker}-${++lineSeq}`;
    const words = text.split(" ");
    emit("transcript", { speaker, id, final: false, text: words.slice(0, Math.ceil(words.length * 0.6)).join(" ") });
    await sleep(15);
    emit("transcript", { speaker, id, final: true, text });
    await sleep(15);
  }
}

// ---------- fake microphone and system audio ----------
// startCapture() in capture.ts asks for the mic and the screen loopback. In preview mode
// nothing real is requested: both return a silent stream from an AudioContext destination.

let workletNodes = 0;

function silentStream(): MediaStream {
  // Same sample rate as capture.ts, so the stream can be connected without resampling.
  const ctx = new AudioContext({ sampleRate: 16000 });
  return ctx.createMediaStreamDestination().stream;
}

try {
  const fake = {
    getUserMedia: async (_c?: MediaStreamConstraints) => silentStream(),
    getDisplayMedia: async (_c?: DisplayMediaStreamOptions) => silentStream(),
  };
  const md = navigator.mediaDevices as MediaDevices | undefined;
  if (md) {
    Object.defineProperty(md, "getUserMedia", { value: fake.getUserMedia, configurable: true, writable: true });
    Object.defineProperty(md, "getDisplayMedia", { value: fake.getDisplayMedia, configurable: true, writable: true });
  } else {
    Object.defineProperty(navigator, "mediaDevices", { value: fake, configurable: true });
  }
  // Count worklet nodes: capture.ts creates two (me and them) as its very last step.
  const Orig = window.AudioWorkletNode;
  if (Orig) {
    window.AudioWorkletNode = class extends Orig {
      constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
        super(...args);
        workletNodes++;
      }
    };
  }
} catch (err) {
  console.warn("[mock] Kon de audio-opname niet vervangen", err);
}

// ---------- the bridge ----------

let stateServed = 0;

const coach = {
  // overlay
  sendAudio: (_speaker: Speaker, _chunk: ArrayBuffer) => {
    state.audioChunks++;
  },
  startListening: async () => {
    await sleep(40);
    const problem = startProblem();
    if (problem) return { ok: false, error: problem };
    state.listening = true;
    // main.ts sends this status before it answers the invoke.
    emit("status", { listening: true, message: t(lang, "status.listening"), level: "info" });
    return { ok: true };
  },
  stopListening: async () => {
    await sleep(20);
    state.listening = false;
    emit("status", { listening: false, message: t(lang, "status.stopped"), level: "info" });
  },
  requestTip: async () => {
    if (streaming) return;
    const text = TIPS[tipIndex++ % TIPS.length];
    void streamTip(text, "hotkey");
  },
  openSettings: async () => {
    console.info("[mock] Zou nu het instellingenvenster openen (open settings.html in de preview).");
  },
  hideOverlay: async () => {
    console.info("[mock] Zou nu de overlay verbergen.");
  },
  captureEnded: async (_kind: Speaker, reason: string) => {
    console.info(`[mock] Opname gestopt: ${reason}`);
  },
  onTranscript: on("transcript"),
  onTip: on("tip"),
  onStatus: on("status"),
  onSettings: on("settings"),
  // settings window
  getState: async () => {
    await sleep(10);
    stateServed++;
    return publicState();
  },
  saveSettings: async (s: unknown) => {
    await sleep(10);
    state.settings = { ...state.settings, ...(s as Partial<Settings>) };
    emit("settings", state.settings);
    return publicState();
  },
  setSecret: async (name: string, value: string) => {
    await sleep(10);
    if (name !== "geminiKey" && name !== "openaiKey") throw new Error(t(lang, "main.unknownSecret"));
    // The value itself is never kept: the preview only needs to know that a key is set.
    state.hasSecret = { ...state.hasSecret, [name]: !!String(value ?? "").trim() };
    return { ...state.hasSecret };
  },
  getProfile: async () => {
    await sleep(10);
    return structuredClone(state.profile);
  },
  saveProfile: async (p: unknown) => {
    await sleep(10);
    state.profile = { ...EMPTY_PROFILE, ...(p as Partial<Profile>) };
  },
  getProfilePrompt: async () => profilePrompt(state.settings.language),
  parseProfile: async (text: string) => parseProfile(text),
  saveBrief: async (text: string) => {
    await sleep(10);
    state.callBrief = String(text ?? "");
  },
  chatgptSignIn: async () => {
    await sleep(900); // the browser login round trip
    state.chatgpt = structuredClone(CHATGPT_CONNECTED);
    return { ok: true, state: publicState() };
  },
  chatgptSignOut: async () => {
    await sleep(10);
    state.chatgpt = structuredClone(CHATGPT_DISCONNECTED);
    return publicState();
  },
  chatgptUsage: async () => {
    console.info("[mock] Zou nu de ChatGPT-gebruikspagina in de browser openen.");
  },
} satisfies MockCoachApi;

// The bridge grows while the app is built. A method that preload.ts gained but this mock does not
// know yet must not crash the preview: it becomes a no-op (an "onX" subscription returns an
// unsubscribe function, anything else a resolved promise) and a console warning names it.
const NOT_A_METHOD = new Set(["then", "toJSON", "toString", "valueOf", "constructor"]);
const warned = new Set<string>();
const bridge = new Proxy(coach, {
  get(target, prop, receiver) {
    if (typeof prop === "symbol" || prop in target || NOT_A_METHOD.has(prop) || !/^[a-z][A-Za-z0-9]*$/.test(prop)) {
      return Reflect.get(target, prop, receiver);
    }
    if (!warned.has(prop)) {
      warned.add(prop);
      console.warn(`[mock] window.coach.${prop} bestaat nog niet in preview/mock-coach.ts en doet hier niets.`);
    }
    return /^on[A-Z]/.test(prop) ? () => () => undefined : async () => undefined;
  },
});

Object.defineProperty(window, "coach", { value: bridge, enumerable: true, configurable: false, writable: false });

// ---------- "tip-old": make the 25 s timer run out right away ----------
// overlay.ts marks a tip old with window.setTimeout(..., 25_000). In this scene timers of
// 20 s or more fire after 30 ms, the clock (Date.now) jumps ahead, and running CSS
// animations are moved forward, so other designs that age a tip differently follow too.

let clockOffset = 0;
if (scene === "tip-old") {
  const patched = (handler: TimerHandler, timeout?: number, ...args: unknown[]): number =>
    realSetTimeout(handler, typeof timeout === "number" && timeout >= 20_000 ? 30 : timeout, ...args);
  window.setTimeout = patched as typeof window.setTimeout;
  Date.now = () => realNow() + clockOffset;
}

async function ageTip(): Promise<void> {
  clockOffset += 26_000;
  for (const anim of document.getAnimations?.() ?? []) {
    try {
      anim.currentTime = Number(anim.currentTime ?? 0) + 26_000;
    } catch {
      /* some animations cannot be moved */
    }
  }
  // Long enough for a design that checks the age once per second.
  await sleep(1100);
}

// ---------- scene runners ----------

function findButton(selectors: string[], text?: RegExp): HTMLElement | null {
  for (const sel of selectors) {
    const node = document.querySelector<HTMLElement>(sel);
    if (node) return node;
  }
  if (!text) return null;
  return Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) => text.test(b.textContent?.trim() ?? "")) ?? null;
}

/** Starts listening the way a user does: by clicking Start. */
async function clickStart(): Promise<void> {
  const btn = findButton(["#listen", "[data-action='listen']"], /^start$/i);
  if (!btn) throw new Error("Startknop niet gevonden");
  const before = workletNodes;
  const willStart = !startProblem();
  btn.click();
  if (willStart) {
    if (!(await waitFor(() => workletNodes >= before + 2, 4000))) console.warn("[mock] Audio-opname leek niet te starten");
  }
  await sleep(willStart ? 80 : 200);
}

async function openTranscript(): Promise<void> {
  const btn = findButton(["#transcriptBtn", "[data-action='transcript']"], /^t$/i);
  if (!btn) throw new Error("Transcriptknop niet gevonden");
  btn.click();
  await sleep(60);
}

async function runOverlayScene(): Promise<void> {
  await waitFor(() => stateServed > 0, 2000);
  emit("settings", state.settings);
  switch (scene) {
    case "idle":
      break;
    case "listening":
      await clickStart();
      await say(CALL.slice(0, 2));
      break;
    case "tip-live":
      await clickStart();
      await say(CALL);
      await streamTip(TIPS[0], "auto", { finish: false, dropWords: 1 });
      break;
    case "tip-done":
      await clickStart();
      await say(CALL);
      await streamTip(TIPS[0], "auto");
      break;
    case "tip-old":
      await clickStart();
      await say(CALL);
      await streamTip(TIPS[0], "auto");
      await ageTip();
      break;
    case "error":
      await clickStart();
      break;
    case "warn":
      await clickStart();
      await say(CALL.slice(0, 2));
      emit("status", { listening: true, level: "warn", message: t(lang, "ears.dropped", { why: "code 1006", seconds: 2 }) });
      break;
    case "transcript":
      await clickStart();
      await say(CALL);
      await streamTip(TIPS[0], "auto");
      await openTranscript();
      break;
  }
}

async function runSettingsScene(): Promise<void> {
  await waitFor(() => stateServed > 0, 2000);
  const tab = scene === "profile" ? "profile" : scene === "brief" ? "call" : "conn";
  const btn = findButton([`[data-tab="${tab}"]`, `#tab-${tab}`]);
  if (!btn) throw new Error(`Tabblad ${tab} niet gevonden`);
  btn.click();
  window.scrollTo(0, 0);
}

// ---------- overlay window background ----------
// The real overlay window paints #131C2B (BrowserWindow backgroundColor) behind a page whose
// body is transparent. A browser tab or an iframe paints white there instead, which turns the
// translucent panel grey. So the preview gives the root that colour, unless the page itself
// paints a background. Set through the CSSOM, which the page's CSP (style-src 'self') allows.
const OVERLAY_WINDOW_BG = "#131C2B";

function emulateWindowBackground(): void {
  if (page !== "overlay" || !document.body) return;
  const clear = (node: Element) => /^(transparent|rgba\(.*,\s*0\))$/.test(getComputedStyle(node).backgroundColor);
  if (clear(document.documentElement) && clear(document.body)) document.documentElement.style.backgroundColor = OVERLAY_WINDOW_BG;
}

async function play(): Promise<void> {
  emulateWindowBackground();
  await sleep(200);
  try {
    if (page === "settings") await runSettingsScene();
    else await runOverlayScene();
  } catch (err) {
    window.__sceneError = err instanceof Error ? err.message : String(err);
    console.error(`[mock] Scene ${scene} liep vast:`, err);
  }
  await sleep(100);
  window.__sceneReady = true;
  document.documentElement.dataset.sceneReady = "true";
}

window.__mock = { page, scene, lang, scenes, state, emit, streamTip, say, tips: TIPS, call: CALL };

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void play(), { once: true });
else void play();
