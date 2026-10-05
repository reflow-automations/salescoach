// The coach keeps the transcript and decides when to ask the brain for a tip.
// No Electron imports, so it can be unit tested.
import type { Brain } from "../main/providers/brain";
import { t } from "../shared/i18n";
import type { TipEvent, TranscriptEvent } from "../shared/types";
import { buildInput, passVerdict, TipCleaner, type Line } from "./prompt";

export interface CoachDeps {
  brain: () => Brain;
  instructions: () => string;
  autoTips: () => boolean;
  emit: (e: TipEvent) => void;
  now?: () => number;
  /** Language of the coach's own messages ("en" or "nl"). Default English. */
  language?: () => string;
}

const CONTEXT_MS = 4 * 60 * 1000; // conversation window sent to the brain
const MAX_LINES = 40;
const STALE_INTERIM_MS = 30_000; // interim text without an update for 30 s lost its final (dropped socket)
const AUTO_DEBOUNCE_MS = 900; // wait for THEM to finish their thought
const AUTO_COOLDOWN_MS = 8000; // no new auto tip within 8 s of a tip that was shown
const AUTO_MIN_INTERVAL_MS = 3000; // at most one auto request per 3 s, also when the answer was PASS
const MIN_WORDS_FOR_AUTO = 3;
/** "No tip found" in English; with `language` the coach uses that language. */
export const NO_TIP_MESSAGE = t("en", "coach.noTip");

type Trigger = "hotkey" | "auto";

interface Segment {
  id: string;
  speaker: TranscriptEvent["speaker"];
  text: string;
  final: boolean;
  at: number;
  updatedAt: number;
}

interface Request {
  ctrl: AbortController;
  id: string;
  trigger: Trigger;
  /** "start" was emitted, so the overlay shows this tip and needs an ending. */
  started: boolean;
}

export class Coach {
  private segments: Segment[] = [];
  private inflight: Request | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private lastTipAt = 0;
  private lastAutoRequestAt = 0;
  private tipCounter = 0;
  private readonly now: () => number;

  constructor(private readonly deps: CoachDeps) {
    this.now = deps.now ?? Date.now;
  }

  reset(): void {
    this.cancel();
    this.segments = [];
    this.lastTipAt = 0;
    this.lastAutoRequestAt = 0;
  }

  onTranscript(e: TranscriptEvent): void {
    const now = this.now();
    const existing = this.segments.find((s) => s.id === e.id);
    if (existing) {
      existing.text = e.text;
      existing.final = e.final;
      existing.updatedAt = now;
    } else {
      this.segments.push({ ...e, at: now, updatedAt: now });
    }
    this.prune();
    if (e.final && e.speaker === "them" && this.deps.autoTips() && wordCount(e.text) >= MIN_WORDS_FOR_AUTO) {
      if (this.autoTimer) clearTimeout(this.autoTimer);
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        // Never cut off a tip that is already on screen, such as a slow hotkey tip.
        if (this.inflight?.started) return;
        const now = this.now();
        if (now - this.lastTipAt >= AUTO_COOLDOWN_MS && now - this.lastAutoRequestAt >= AUTO_MIN_INTERVAL_MS) {
          this.lastAutoRequestAt = now;
          void this.requestTip("auto");
        }
      }, AUTO_DEBOUNCE_MS);
    }
  }

  /** Conversation lines for the brain: consecutive segments of one speaker are merged. */
  lines(): Line[] {
    const out: Line[] = [];
    for (const s of this.segments) {
      const text = s.text.trim();
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && last.speaker === s.speaker) last.text += ` ${text}`;
      else out.push({ speaker: s.speaker, text });
    }
    return out;
  }

  cancel(): void {
    this.abortInflight();
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }

  /** Stops the running request. A tip the overlay already shows always gets its ending. */
  private abortInflight(): void {
    const req = this.inflight;
    if (!req) return;
    this.inflight = null;
    req.ctrl.abort();
    if (req.started) this.deps.emit({ kind: "done", id: req.id });
  }

  async requestTip(trigger: Trigger): Promise<void> {
    // A newer request always wins; a hotkey also beats a running auto tip.
    this.abortInflight();
    const req: Request = { ctrl: new AbortController(), id: `tip-${++this.tipCounter}`, trigger, started: false };
    this.inflight = req;
    const { ctrl, id } = req;
    const live = () => this.inflight === req;

    // Output is cleaned and held back until we know it is not PASS. The cooldown only
    // starts when a tip is actually shown, so a PASS on smalltalk never blocks the tip
    // for an objection right after it.
    const cleaner = new TipCleaner();
    let verdict: ReturnType<typeof passVerdict> = "undecided";
    let sent = 0;
    let sawDelta = false;
    const start = () => {
      if (req.started) return;
      req.started = true;
      this.lastTipAt = this.now();
      this.deps.emit({ kind: "start", id, trigger });
    };
    const show = (text: string) => {
      start();
      // The cleaned text only grows, so the new part is always a suffix.
      if (text.length > sent) this.deps.emit({ kind: "delta", id, text: text.slice(sent) });
      sent = Math.max(sent, text.length);
    };
    const nothingToSay = () => {
      // Auto: keep the previous tip. Hotkey: the user asked, so say that nothing came back.
      if (trigger === "auto") this.deps.emit({ kind: "skip", id });
      else this.deps.emit({ kind: "error", id, message: t(this.deps.language?.() ?? "en", "coach.noTip") });
    };
    // A hotkey shows its loading state at once.
    if (trigger === "hotkey") start();

    this.prune();
    try {
      const full = await this.deps.brain()({
        instructions: this.deps.instructions(),
        input: buildInput(this.lines(), trigger),
        signal: ctrl.signal,
        onDelta: (d) => {
          if (!live() || verdict === "pass") return;
          sawDelta = true;
          const text = cleaner.push(d);
          if (verdict === "undecided") verdict = passVerdict(text, false);
          if (verdict === "pass") ctrl.abort();
          else if (verdict === "tip") show(text);
        },
      });
      if (!live()) return; // superseded or cancelled: abortInflight already closed it
      if (!sawDelta && full) cleaner.push(full);
      const text = cleaner.finish();
      if (verdict === "undecided") verdict = passVerdict(text, true);
      if (verdict === "pass") {
        nothingToSay();
        return;
      }
      show(text);
      this.lastTipAt = this.now(); // a slow tip still gets its full cooldown on screen
      this.deps.emit({ kind: "done", id });
    } catch (err) {
      if (!live()) return;
      if (verdict === "pass") {
        nothingToSay(); // we aborted the stream ourselves
        return;
      }
      start();
      this.deps.emit({ kind: "error", id, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (this.inflight === req) this.inflight = null;
    }
  }

  private prune(): void {
    const now = this.now();
    this.segments = this.segments
      .filter((s) => (s.final ? s.at >= now - CONTEXT_MS : now - s.updatedAt < STALE_INTERIM_MS))
      .slice(-MAX_LINES);
  }
}

function wordCount(t: string): number {
  return t.trim().split(/\s+/).filter(Boolean).length;
}
