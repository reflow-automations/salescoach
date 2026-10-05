// Types shared by the main process and the renderer.

export type Speaker = "me" | "them";

export type EarsProviderId = "gemini" | "openai";
export type BrainProviderId = "openai-key" | "chatgpt" | "gemini";
/** Which model writes the feedback after the call: "same" uses the live brain. */
export type FeedbackBrainId = "same" | BrainProviderId;

/** The kind of call: it picks the playbook, the roles in the prompt, the early-trigger words and the feedback. */
export type CallType = "sales" | "interview" | "meeting";
export const CALL_TYPES: readonly CallType[] = ["sales", "interview", "meeting"];

/** A stored or received value as a call type; anything unknown is "sales". */
export function normCallType(v: unknown): CallType {
  return v === "interview" || v === "meeting" ? v : "sales";
}

export interface Settings {
  ears: EarsProviderId;
  brain: BrainProviderId;
  /** "en" (default) or "nl": the language of the app, of the calls and of the tips. */
  language: string;
  /** "sales" (default): ME is the seller. "interview": ME is the candidate. "meeting": ME is a participant. */
  callType: CallType;
  openaiModel: string;
  chatgptModel: string;
  geminiModel: string;
  autoTips: boolean;
  /** Start a tip while THEM is still talking and refine it when they finish. Off: only after they finish. */
  tipsWhileSpeaking: boolean;
  hotkeyHelp: string;
  hotkeyToggle: string;
  /** The model for the feedback after the call. Speed does not matter there, so it may be a larger one. */
  feedbackBrain: FeedbackBrainId;
  /** Model name for feedbackBrain; empty uses that provider's model from the live brain settings. */
  feedbackModel: string;
}

export const DEFAULT_SETTINGS: Settings = {
  ears: "gemini",
  brain: "gemini",
  language: "en",
  callType: "sales",
  openaiModel: "gpt-6-luna",
  chatgptModel: "",
  geminiModel: "gemini-3.5-flash-lite",
  autoTips: true,
  tipsWhileSpeaking: true,
  hotkeyHelp: "CommandOrControl+Shift+Space",
  hotkeyToggle: "CommandOrControl+Shift+H",
  feedbackBrain: "same",
  feedbackModel: "",
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

/**
 * Category of what THEM said, used as a short label in the tip history ("Price", "Question").
 * Derived from the early-trigger words (src/coach/early-triggers.ts); the words themselves are never shown.
 * Which categories can occur depends on the call type.
 */
export type TipLabel =
  // sales
  | "price"
  | "budget"
  | "timing"
  | "think"
  | "info"
  | "decision"
  | "covered"
  | "experience"
  | "doubt"
  | "privacy"
  | "speed"
  | "contract"
  // job interview
  | "salary"
  | "hours"
  | "motivation"
  | "weakness"
  | "background"
  | "example"
  | "ownQuestions"
  // meeting
  | "decide"
  | "deadline"
  | "owner"
  | "risk"
  // every call type: THEM asked something
  | "question";

export type TipEvent =
  | {
      kind: "start";
      id: string;
      trigger: "hotkey" | "auto";
      /** THEM is still talking: the tip may still be refined. A "final" event (or a replacement) ends that. */
      draft?: boolean;
      /** Category of what THEM said, when known. */
      label?: TipLabel;
      /** This tip refines the tip with this id (same utterance): swap its text instead of adding a new tip. */
      replaces?: string;
    }
  | { kind: "delta"; id: string; text: string }
  | { kind: "done"; id: string }
  /** A draft tip stays as it is: THEM finished and what they said still fits it. */
  | { kind: "final"; id: string }
  | { kind: "skip"; id: string }
  /** A draft tip is withdrawn: a newer request for the same utterance answered PASS, so it no longer fits. */
  | { kind: "retract"; id: string }
  | { kind: "error"; id: string; message: string };

export interface StatusEvent {
  listening: boolean;
  message?: string;
  level?: "info" | "warn" | "error";
  /** Sent when listening stops: true when the call lasted long enough for feedback. */
  feedback?: boolean;
  /** Length of that call in whole minutes. */
  callMinutes?: number;
}

/** The call the feedback window is about. */
export interface FeedbackCallInfo {
  minutes: number;
  /** When the call ended (ms since 1970). */
  endedAt: number;
  /** The kind of call when it ended; the feedback is written for this kind. */
  callType?: CallType;
}

export type FeedbackResult = { ok: true; text: string; model: string } | { ok: false; error: string; aborted?: boolean };

export type FeedbackSaveResult = { ok: true; file: string } | { ok: false; canceled?: boolean; error?: string };

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

/** Model names that were defaults in older versions; on load they move to the current default. */
export const RETIRED_DEFAULTS: Partial<Record<"openaiModel" | "geminiModel", string[]>> = {
  openaiModel: ["gpt-5.4-mini"],
};

/** Larger models for the feedback after the call, when the feedback has its own provider (October 2026). */
export const FEEDBACK_DEFAULT_MODELS = { gemini: "gemini-3.8-flash", openai: "gpt-6.1-sol" } as const;
