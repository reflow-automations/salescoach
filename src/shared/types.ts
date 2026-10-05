// Types shared by the main process and the renderer.

export type Speaker = "me" | "them";

export type EarsProviderId = "gemini" | "openai";
export type BrainProviderId = "openai-key" | "chatgpt" | "gemini";

export interface Settings {
  ears: EarsProviderId;
  brain: BrainProviderId;
  /** "en" (default) or "nl": the language of the app, of the calls and of the tips. */
  language: string;
  openaiModel: string;
  chatgptModel: string;
  geminiModel: string;
  autoTips: boolean;
  hotkeyHelp: string;
  hotkeyToggle: string;
}

export const DEFAULT_SETTINGS: Settings = {
  ears: "gemini",
  brain: "gemini",
  language: "en",
  openaiModel: "gpt-5.4-mini",
  chatgptModel: "",
  geminiModel: "gemini-3.5-flash-lite",
  autoTips: true,
  hotkeyHelp: "CommandOrControl+Shift+Space",
  hotkeyToggle: "CommandOrControl+Shift+H",
};

export type SecretName = "openaiKey" | "geminiKey";

/** The profile fields the coach knows about the user. All free text (markdown). */
export interface Profile {
  whoAmI: string;
  offer: string;
  pricing: string;
  idealCustomer: string;
  cases: string;
  objections: string;
  rules: string;
  tone: string;
}

export const EMPTY_PROFILE: Profile = {
  whoAmI: "",
  offer: "",
  pricing: "",
  idealCustomer: "",
  cases: "",
  objections: "",
  rules: "",
  tone: "",
};

export interface TranscriptEvent {
  speaker: Speaker;
  text: string;
  final: boolean;
  /** Stable id per utterance so the UI can replace interim text. */
  id: string;
}

export type TipEvent =
  | { kind: "start"; id: string; trigger: "hotkey" | "auto" }
  | { kind: "delta"; id: string; text: string }
  | { kind: "done"; id: string }
  | { kind: "skip"; id: string }
  | { kind: "error"; id: string; message: string };

export interface StatusEvent {
  listening: boolean;
  message?: string;
  level?: "info" | "warn" | "error";
}

export interface ChatGPTStatus {
  connected: boolean;
  sharing: boolean;
  email?: string;
  models: { slug: string; displayName: string }[];
}

export interface PublicSettingsState {
  settings: Settings;
  hasSecret: Record<SecretName, boolean>;
  chatgpt: ChatGPTStatus;
  callBrief: string;
}
