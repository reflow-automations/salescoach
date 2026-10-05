// The coach keeps the transcript and decides when to ask the brain for a tip.
// No Electron imports, so it can be unit tested.
//
// Two ways to an auto tip:
// - After a final THEM line (the classic path): wait 600 ms for THEM to go on, then ask.
// - While THEM is still talking (tipsWhileSpeaking): a "draft" request starts on interim text
//   when it has 6+ words and stopped growing for 350 ms, or has 4+ words and holds an
//   early-trigger word or a question mark. 6+ new words or a new trigger category restart it (at
//   most one request per 1.5 s). When the line becomes final, a draft tip based on nearly the same
//   words (fewer than 4 words different) stays and becomes final; otherwise it is refreshed once.
// Either way the brain decides what is shown: PASS shows nothing, and a PASS on a refinement
// withdraws the older draft tip. Auto and draft requests together stay under 10 per minute (the
// free tiers have low limits); a hotkey is always allowed. A failed auto tip is reported in the
// status line, not in the tip area.
import type { Brain } from "../main/providers/brain";
import { t } from "../shared/i18n";
import type { CallType, TipEvent, TipLabel, TranscriptEvent } from "../shared/types";
import { primaryLabel, triggerCategories } from "./early-triggers";
import { buildInput, passVerdict, TipCleaner, type Line } from "./prompt";

export interface CoachDeps {
  brain: () => Brain;
  instructions: () => string;
  autoTips: () => boolean;
  emit: (e: TipEvent) => void;
  now?: () => number;
  /** Language of the coach's own messages ("en" or "nl"). Default English. */
  language?: () => string;
  /** Start auto tips while THEM is still talking. Without it: only after a final line (the old behaviour). */
  tipsWhileSpeaking?: () => boolean;
  /** The kind of call: picks the early-trigger words and the labels. Default "sales". Read on every use, so a switch applies at once. */
  callType?: () => CallType;
  /** A short warning for the status line, e.g. an automatic tip that failed. */
  warn?: (message: string) => void;
}

const CONTEXT_MS = 4 * 60 * 1000; // conversation window sent to the brain
const MAX_LINES = 40; // at most this many segments go to the brain
// The whole call stays in memory (never on disk) for the feedback after the call.
const RETAIN_MS = 30 * 60 * 1000;
const MAX_RETAINED = 3000;
const STALE_INTERIM_MS = 30_000; // interim text without an update for 30 s lost its final (dropped socket)
const AUTO_DEBOUNCE_MS = 600; // wait for THEM to finish their thought
const AUTO_COOLDOWN_MS = 5000; // a shown tip stays at least 5 s before an auto tip replaces it
const AUTO_MIN_INTERVAL_MS = 3000; // at most one auto request per 3 s, also when the answer was PASS
const MIN_WORDS_FOR_AUTO = 3;
// Auto and draft requests together: at most this many per rolling minute, aborted ones included.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 10;
// Tips while THEM is still talking.
const DRAFT_MIN_WORDS = 6; // interim text this long starts a draft once it stops growing...
const DRAFT_STALL_MS = 350; // ...for this long
const DRAFT_NEW_WORDS = 6; // this many new words restart the draft request
const DRAFT_THROTTLE_MS = 1500; // at most one refinement per 1.5 s
const KEEP_DIFF_WORDS = 4; // a final line that differs less than this from the draft's text keeps the tip
const TRIGGER_MIN_WORDS = 4; // a trigger word or question mark only starts a draft once the line has this many words
const REFINE_ABORT_AFTER_MS = 3000; // a refinement waits this long for its own request that has not shown anything yet
const FINALIZED_MEMORY = 50; // ids of recent final THEM lines, so a corrected final is not handled twice
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

/** The early tip for one THEM utterance (one transcript id). */
interface Draft {
  segId: string;
  /** Interim text last seen, so a repeat of the same text does not restart the 350 ms wait. */
  seen: string;
  /** The utterance text the latest request for it used. */
  basis: string;
  /** Trigger categories in `basis`. */
  categories: Set<TipLabel>;
  requests: number;
  /** THEM finished this utterance. */
  final: boolean;
  /** The tip shown for this utterance, if any. */
  tipId: string | null;
  /** That tip was shown as a draft and has not been made final yet. */
  tipIsDraft: boolean;
}

interface Request {
  ctrl: AbortController;
  id: string;
  trigger: Trigger;
  /** "start" was emitted, so the overlay shows this tip and needs an ending. */
  started: boolean;
  /** When it was sent. */
  at: number;
  /** Set for an early request on what THEM is still saying. */
  draft?: Draft;
}

export class Coach {
  private segments: Segment[] = [];
  private inflight: Request | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private lastTipAt = 0;
  private lastAutoRequestAt = 0;
  /** When the auto and draft requests of the last minute were sent. */
  private autoRequestTimes: number[] = [];
  /** Ids of THEM lines that already had their final. */
  private finalized: string[] = [];
  private autoPending = false;
  private tipCounter = 0;
  private lastShownTipId: string | null = null;
  private draft: Draft | null = null;
  /** A (first or refined) draft request should go out as soon as it is allowed. */
  private draftWanted = false;
  private draftTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: CoachDeps) {
    this.now = deps.now ?? Date.now;
  }

  reset(): void {
    this.cancel();
    this.segments = [];
    this.lastTipAt = 0;
    this.lastAutoRequestAt = 0;
    this.autoRequestTimes = [];
    this.finalized = [];
    this.autoPending = false;
    this.lastShownTipId = null;
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
    if (e.speaker === "them") {
      if (this.earlyTips()) {
        if (this.onThemDraft(e)) return;
      } else if (this.draft) {
        this.dropDraft();
      }
    }
    if (e.final && e.speaker === "them" && this.deps.autoTips() && wordCount(e.text) >= MIN_WORDS_FOR_AUTO) {
      this.autoPending = true;
      this.scheduleAuto(AUTO_DEBOUNCE_MS);
    }
  }

  private callType(): CallType {
    return this.deps.callType?.() ?? "sales";
  }

  private earlyTips(): boolean {
    return this.deps.autoTips() && (this.deps.tipsWhileSpeaking?.() ?? false);
  }

  /**
   * Fires the pending auto tip as soon as it is allowed. A blocked tip is postponed, never
   * dropped: an objection that lands during the cooldown or while a tip streams still gets
   * its tip right after.
   */
  private scheduleAuto(minWait: number): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    const now = this.now();
    const wait = Math.max(minWait, this.lastTipAt + AUTO_COOLDOWN_MS - now, this.lastAutoRequestAt + AUTO_MIN_INTERVAL_MS - now, this.rateReadyAt() - now);
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      if (!this.autoPending || !this.deps.autoTips()) return;
      // Never cut off a tip that is still streaming; the finally block of requestTip retries.
      if (this.inflight?.started) return;
      const t = this.now();
      if (t - this.lastTipAt < AUTO_COOLDOWN_MS || t - this.lastAutoRequestAt < AUTO_MIN_INTERVAL_MS || t < this.rateReadyAt()) {
        this.scheduleAuto(0);
        return;
      }
      this.autoPending = false;
      this.noteAutoRequest(t);
      void this.requestTip("auto");
    }, Math.max(0, wait));
  }

  /** From when the rolling limit allows the next auto or draft request (0: now). */
  private rateReadyAt(): number {
    const from = this.now() - RATE_WINDOW_MS;
    this.autoRequestTimes = this.autoRequestTimes.filter((at) => at > from);
    const n = this.autoRequestTimes.length;
    return n < RATE_MAX_REQUESTS ? 0 : this.autoRequestTimes[n - RATE_MAX_REQUESTS] + RATE_WINDOW_MS;
  }

  private noteAutoRequest(at: number): void {
    this.lastAutoRequestAt = at;
    this.autoRequestTimes.push(at);
  }

  // ---------- tips while THEM is still talking ----------

  /** True when the draft logic took care of this THEM line; false sends a final line down the classic path. */
  private onThemDraft(e: TranscriptEvent): boolean {
    let d = this.draft?.segId === e.id ? this.draft : null;
    const text = e.text.trim();
    if (e.final) {
      // Nothing was said after all (the ears remove the interim line): no tip and no refresh.
      if (!text) {
        if (d) this.dropDraft();
        return true;
      }
      // A corrected final for a line that already had one (the OpenAI ears can send two).
      if (this.finalized.includes(e.id)) return true;
      this.finalized.push(e.id);
      if (this.finalized.length > FINALIZED_MEMORY) this.finalized.shift();
      if (!d || d.requests === 0) {
        // No early request went out for this line: the classic path after a final line. A draft
        // that was already waiting for its turn keeps it, however short the final line is.
        const wanted = !!d && this.draftWanted;
        if (d) this.dropDraft();
        if (!wanted) return false;
        this.autoPending = true;
        this.scheduleAuto(AUTO_DEBOUNCE_MS);
        return true;
      }
      this.clearStall();
      d.final = true;
      // Nearly the same words: keep the draft tip on screen, or wait for the request that is
      // still running (its tip comes in as final; a PASS on the unfinished words asks once more).
      const close = wordDiff(d.basis, text) < KEEP_DIFF_WORDS;
      if (close && ((d.tipId && d.tipIsDraft) || this.isRunning(d))) {
        this.cancelDraftWish();
        if (!this.isRunning(d)) this.finalizeDraftTip(d);
      } else {
        this.wantDraft(); // one refresh on the final text
      }
      return true;
    }

    if (!d) {
      if (!text) return true;
      // A new utterance: whatever was going on for the previous one is over. A tip it was still
      // waiting for becomes a normal auto tip, so it is postponed instead of lost.
      if (this.draft && this.draftWanted) {
        this.autoPending = true;
        this.scheduleAuto(0);
      }
      this.dropDraft();
      d = this.draft = { segId: e.id, seen: "", basis: "", categories: new Set(), requests: 0, final: false, tipId: null, tipIsDraft: false };
    }
    if (d.final || text === d.seen) return true;
    d.seen = text;
    const categories = triggerCategories(text, this.callType());
    // A trigger word or a question mark only counts once there are a few words: "Wat kost" can still become anything.
    const triggered = categories.size > 0 && wordCount(text) >= TRIGGER_MIN_WORDS;
    if (d.requests === 0) {
      if (this.draftWanted) return true; // waits for its turn and then uses the newest text
      if (triggered) this.wantDraft();
      else if (wordCount(text) >= DRAFT_MIN_WORDS) this.armStall(d);
      else this.clearStall();
      return true;
    }
    const grown = wordCount(text) - wordCount(d.basis) >= DRAFT_NEW_WORDS;
    const draft = d;
    const newCategory = triggered && [...categories].some((c) => !draft.categories.has(c));
    if (grown || newCategory) this.wantDraft();
    return true;
  }

  /** 350 ms without new words: THEM made a point, start the draft. */
  private armStall(d: Draft): void {
    this.clearStall();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.draft === d && d.requests === 0 && !d.final && this.earlyTips()) this.wantDraft();
    }, DRAFT_STALL_MS);
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private wantDraft(): void {
    this.draftWanted = true;
    // The draft request sees the whole conversation, so it also covers an auto tip that was
    // still waiting for an earlier final line.
    this.autoPending = false;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.scheduleDraft();
  }

  private cancelDraftWish(): void {
    this.draftWanted = false;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
  }

  /**
   * When the next draft request for `d` may go out. The first one waits like any auto tip (3 s
   * between requests, a shown tip stays 5 s). A refinement only waits 1.5 s after the last
   * request, and may replace its own tip at once.
   */
  private draftReadyAt(d: Draft): number {
    const refinement = d.requests > 0;
    let at = Math.max(this.lastAutoRequestAt + (refinement ? DRAFT_THROTTLE_MS : AUTO_MIN_INTERVAL_MS), this.rateReadyAt());
    const ownTipOnTop = d.tipId !== null && d.tipId === this.lastShownTipId;
    if (!ownTipOnTop) at = Math.max(at, this.lastTipAt + AUTO_COOLDOWN_MS);
    return at;
  }

  private scheduleDraft(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    const d = this.draft;
    if (!d || !this.draftWanted) return;
    this.draftTimer = setTimeout(() => this.fireDraft(), Math.max(0, this.draftReadyAt(d) - this.now()));
  }

  private fireDraft(): void {
    this.draftTimer = null;
    const d = this.draft;
    if (!d || !this.draftWanted) return;
    if (!this.earlyTips()) {
      this.dropDraft();
      return;
    }
    const running = this.inflight;
    // Never cut off another tip that is still streaming (a hotkey tip, or the tip for an earlier
    // line); the finally block of requestTip retries. Its own draft may be replaced.
    if (running?.started && running.draft !== d) return;
    // Its own request that has not shown anything yet may be about to answer (a slow first word):
    // let it finish, the finally block retries. Only one that hangs for 3 s is cut off.
    if (running && running.draft === d && !running.started) {
      const giveUpAt = running.at + REFINE_ABORT_AFTER_MS;
      if (this.now() < giveUpAt) {
        this.draftTimer = setTimeout(() => this.fireDraft(), giveUpAt - this.now());
        return;
      }
    }
    if (this.now() < this.draftReadyAt(d)) {
      this.scheduleDraft();
      return;
    }
    this.draftWanted = false;
    this.noteAutoRequest(this.now());
    void this.requestTip("auto", d);
  }

  private isRunning(d: Draft): boolean {
    return this.inflight?.draft === d;
  }

  /** The draft tip stays as it is. */
  private finalizeDraftTip(d: Draft): void {
    if (!d.tipId || !d.tipIsDraft) return;
    d.tipIsDraft = false;
    this.deps.emit({ kind: "final", id: d.tipId });
  }

  /** Forgets the current draft; a draft tip on screen becomes final (now, or when its request ends). */
  private dropDraft(): void {
    const d = this.draft;
    this.cancelDraftWish();
    this.clearStall();
    if (!d) return;
    this.draft = null;
    if (!this.isRunning(d)) this.finalizeDraftTip(d);
  }

  /** A draft request answered PASS. */
  private passOnDraft(d: Draft, stillSpeaking: boolean): void {
    // The draft tip on screen came from fewer words, and the model no longer stands behind it.
    if (d.tipId && d.tipIsDraft) {
      this.deps.emit({ kind: "retract", id: d.tipId });
      if (this.lastShownTipId === d.tipId) {
        // Nothing is on screen any more, so there is no tip to protect with the cooldown.
        this.lastShownTipId = null;
        this.lastTipAt = 0;
      }
      d.tipId = null;
      d.tipIsDraft = false;
    }
    // A PASS on words THEM was still saying, while the line is final by now and shows no tip:
    // "Wat kost" may be unclear, "Wat kost het per maand" is not. Ask once more on the whole line.
    if (stillSpeaking && d.final && !d.tipId && this.draft === d) this.wantDraft();
  }

  /** A draft whose request just ended: its tip is final when nothing will refine it any more. */
  private settleDraft(d: Draft | undefined): void {
    if (!d) return;
    if (this.draft !== d || (d.final && !this.draftWanted)) this.finalizeDraftTip(d);
  }

  // ---------- transcript ----------

  /** Conversation lines the brain sees (the last 4 minutes): consecutive segments of one speaker are merged. */
  lines(): Line[] {
    return this.mergedLines().map(({ speaker, text }) => ({ speaker, text }));
  }

  /**
   * The whole call so far (up to 30 minutes), for the feedback after the call, and how long it
   * lasted from the first to the last transcript segment. Only kept in memory; reset() clears it.
   */
  callTranscript(): { lines: Line[]; durationMs: number } {
    const segs = this.segments.filter((s) => s.text.trim());
    const lines = merge(segs).map(({ speaker, text }) => ({ speaker, text }));
    const durationMs = segs.length ? Math.max(0, Math.max(...segs.map((s) => s.updatedAt)) - segs[0].at) : 0;
    return { lines, durationMs };
  }

  /** Like lines(), but a line whose last part is still interim is marked partial (for the brain). */
  private mergedLines(): Line[] {
    const from = this.now() - CONTEXT_MS;
    return merge(this.segments.filter((s) => !s.final || s.at >= from).slice(-MAX_LINES));
  }

  private segmentText(id: string): string {
    return this.segments.find((s) => s.id === id)?.text.trim() ?? "";
  }

  // ---------- requests ----------

  cancel(): void {
    this.abortInflight();
    this.autoPending = false;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.dropDraft();
  }

  /** Stops the running request. A tip the overlay already shows always gets its ending. */
  private abortInflight(): void {
    const req = this.inflight;
    if (!req) return;
    this.inflight = null;
    req.ctrl.abort();
    if (req.started) this.deps.emit({ kind: "done", id: req.id });
    // A draft that was already let go of (THEM moved on) will not be refined any more.
    if (req.draft && req.draft !== this.draft) this.finalizeDraftTip(req.draft);
  }

  async requestTip(trigger: Trigger, draft?: Draft): Promise<void> {
    // A newer request always wins; a hotkey also beats a running auto tip.
    this.abortInflight();
    const req: Request = { ctrl: new AbortController(), id: `tip-${++this.tipCounter}`, trigger, started: false, at: this.now(), draft };
    // Only an early request on what THEM is still saying marks their line as unfinished.
    const stillSpeaking = !!draft && !draft.final;
    this.inflight = req;
    const { ctrl, id } = req;
    const live = () => this.inflight === req;

    this.prune();
    const lines = this.mergedLines();
    if (draft) {
      draft.requests++;
      draft.basis = this.segmentText(draft.segId) || draft.seen;
      draft.categories = triggerCategories(draft.basis, this.callType());
    }
    // Only a category key goes to the overlay, never the words that matched.
    const lastThem = [...lines].reverse().find((l) => l.speaker === "them");
    const label = lastThem ? primaryLabel(triggerCategories(lastThem.text, this.callType())) : undefined;

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
      this.lastShownTipId = id;
      const e: Extract<TipEvent, { kind: "start" }> = { kind: "start", id, trigger };
      if (draft) {
        if (!draft.final) e.draft = true;
        if (draft.tipId) e.replaces = draft.tipId;
        draft.tipId = id;
        draft.tipIsDraft = !draft.final;
      }
      if (label) e.label = label;
      this.deps.emit(e);
    };
    const show = (text: string) => {
      start();
      // The cleaned text only grows, so the new part is always a suffix.
      if (text.length > sent) this.deps.emit({ kind: "delta", id, text: text.slice(sent) });
      sent = Math.max(sent, text.length);
    };
    const lang = () => this.deps.language?.() ?? "en";
    const nothingToSay = () => {
      // Hotkey: the user asked, so say that nothing came back. Auto: keep the previous tip.
      if (trigger === "hotkey") {
        this.deps.emit({ kind: "error", id, message: t(lang(), "coach.noTip") });
        return;
      }
      this.deps.emit({ kind: "skip", id });
      if (draft) this.passOnDraft(draft, stillSpeaking);
    };
    // A hotkey shows its loading state at once.
    if (trigger === "hotkey") start();

    let ended = false;
    try {
      const full = await this.deps.brain()({
        instructions: this.deps.instructions(),
        input: buildInput(lines, trigger, { stillSpeaking }),
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
      ended = true;
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
      ended = true;
      if (verdict === "pass") {
        nothingToSay(); // we aborted the stream ourselves
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (trigger === "auto") {
        // An automatic tip that fails (a rate limit, a dropped connection) goes to the status line.
        // The tip area keeps what it shows: no new start, so nothing replaces a draft tip either.
        this.deps.emit(req.started ? { kind: "done", id } : { kind: "skip", id });
        this.deps.warn?.(t(lang(), "coach.autoTipFailed", { error: message }));
        return;
      }
      start();
      this.deps.emit({ kind: "error", id, message });
    } finally {
      if (this.inflight === req) {
        this.inflight = null;
        if (ended) this.settleDraft(draft);
        if (this.autoPending) this.scheduleAuto(0);
        if (this.draftWanted) this.scheduleDraft();
      }
    }
  }

  private prune(): void {
    const now = this.now();
    this.segments = this.segments
      .filter((s) => (s.final ? s.at >= now - RETAIN_MS : now - s.updatedAt < STALE_INTERIM_MS))
      .slice(-MAX_RETAINED);
  }
}

/** Merges consecutive segments of one speaker into one line; a line whose last part is interim is partial. */
function merge(segments: Segment[]): Line[] {
  const out: Line[] = [];
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker) {
      last.text += ` ${text}`;
      last.partial = !s.final;
    } else out.push({ speaker: s.speaker, text, partial: !s.final });
  }
  return out;
}

function wordCount(t: string): number {
  return t.trim().split(/\s+/).filter(Boolean).length;
}

function words(t: string): string[] {
  return t
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

/** How many words two versions of a line differ by: the longer one minus what they share in order. */
export function wordDiff(a: string, b: string): number {
  const x = words(a).slice(0, 200);
  const y = words(b).slice(0, 200);
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const row = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) row[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return Math.max(x.length, y.length) - prev[y.length];
}
