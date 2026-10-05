// Feedback after the call: builds one request with the whole transcript and parses the answer.
// No Electron or DOM imports: main, the feedback window and the tests all use it.
//
// The model answers in a fixed layout with English section markers (## SUMMARY, ## STRONG_MOMENTS,
// ...) and writes the content in the app language. The parser also accepts Dutch markers, markdown
// around them, text before the first marker and a partial answer while it still streams.
import { t, type MessageKey } from "../shared/i18n";
import type { CallType, Profile } from "../shared/types";
import { languageName, profileToText, type Line } from "./prompt";

export type { CallType };

/** A call needs at least this much talk (first to last transcript segment) before feedback makes sense. */
export const FEEDBACK_MIN_MS = 2 * 60 * 1000;

/** The transcript in the request is cut from the start beyond this many characters (about 30 minutes of talk). */
const MAX_TRANSCRIPT_CHARS = 60_000;

export const NONE = "NONE";

/** The default ChatGPT model for the feedback: a larger one, because speed does not matter after the call. */
export function smartestModel(models: { slug: string }[]): string {
  const big = models.find((m) => /sol|astra|pro/i.test(m.slug)) ?? models.find((m) => !/mini|nano|instant|fast|flash|lite|luna/i.test(m.slug));
  return (big ?? models[0])?.slug ?? "";
}

const CALL_TYPES: Record<CallType, { who: string; what: string; focus: string; rule?: string; nextStep: string; score: string }> = {
  sales: {
    who: "an experienced, honest and friendly sales coach",
    what: "sales call, where ME is the seller",
    focus: "asking good questions before pitching, listening, handling objections, talking value before price, and closing on a concrete next step",
    nextStep: "The next step both sides agreed on, with who and when if that was said.",
    score: "A score for ME from 1 to 10",
  },
  interview: {
    who: "an experienced, honest and friendly recruiter and interview coach",
    what: "job interview, where ME is the candidate and THEM is the interviewer",
    focus: "answering the core first, examples with a concrete result, naming numbers early, giving criteria instead of gut feeling, asking own questions, and handling salary and hours calmly",
    rule: "- Judge ME the way a recruiter assesses a candidate: clear answers, concrete examples with results, motivation for this role, and fit. Say in the summary or in an improvement whether hours, salary and ME's own questions came up, and how ME handled them. A topic that never came up is only worth mentioning when it matters for the next round.",
    nextStep: "The next step in the procedure that was agreed (a second round, an assessment, an offer, a call back), with who and when if that was said.",
    score: "A score for ME as a candidate from 1 to 10, as a recruiter would give it",
  },
  meeting: {
    who: "an experienced, honest and friendly meeting coach",
    what: "meeting, where ME is one of the participants",
    focus: "being clear and brief, getting to decisions, handling disagreement calmly, and ending with action points that have an owner and a date",
    rule: "- Judge whether the meeting ended with clear decisions and action points with an owner and a date, and what ME did to get there.",
    nextStep: "The decisions and action points that were agreed, each with who and when if that was said, in one or two lines.",
    score: "A score for ME from 1 to 10",
  },
};

export interface FeedbackOptions {
  profile: Profile;
  callBrief: string;
  /** Language of the app and of the feedback ("en" or "nl"). */
  language: string;
  callType?: CallType;
}

export function buildFeedbackInstructions(o: FeedbackOptions): string {
  const lang = languageName(o.language);
  const type = CALL_TYPES[o.callType ?? "sales"] ?? CALL_TYPES.sales;
  return [
    `You are ${type.who}. The user (labelled ME) just finished a ${lang} ${type.what}. The other party is labelled THEM. Give ME feedback so the next call goes better. Pay most attention to ${type.focus}.`,
    "",
    "## Rules",
    `- Write the content in ${lang}. Talk to the user directly ("you"). Keep the section markers below exactly as written, in English.`,
    "- Only quote words that literally appear in the transcript. Never invent quotes, numbers, prices, names or promises.",
    "- The transcript comes from speech recognition: it can contain small mistakes and miss punctuation. Do not comment on spelling.",
    "- Be concrete and short. Judge what ME said and did, not THEM.",
    ...(type.rule ? [type.rule] : []),
    "- No other headings, no bold or italics, no emojis, no em dashes or en dashes. No text before the first marker or after the last section.",
    "",
    "## Output format (strict)",
    "## SUMMARY",
    "Exactly three lines, one sentence each: what the call was about, how it went, and where it ended.",
    "## STRONG_MOMENTS",
    "Exactly two items, the strongest moments of ME. Each item is two lines:",
    "- QUOTE: a literal quote from one ME line",
    "  WHY: one sentence on why this worked",
    "## IMPROVEMENTS",
    "Exactly two items, the two things that would help ME most. Each item is two lines:",
    "- HAPPENED: what happened, in one or two sentences (you may quote the transcript)",
    "  BETTER: one better sentence that ME can practise and say literally next time",
    "## NEXT_STEP",
    `${type.nextStep} If nothing was agreed, write exactly: ${NONE}`,
    "## FILLER_WORDS",
    `Only when ME clearly and often used filler words: list them as "word (count)", separated by commas. Otherwise write exactly: ${NONE}`,
    "## SCORE",
    `${type.score} as "N/10: one sentence why". If the call is too short or unclear to judge, write exactly: ${NONE}`,
    "",
    "## Profile of the user (context, so you can tell whether ME used the right facts)",
    profileToText(o.profile),
    "",
    "## Brief for this call",
    o.callBrief.trim() || "(none)",
  ].join("\n");
}

export function buildFeedbackInput(lines: Line[], durationMs?: number): string {
  let convo = lines.map((l) => `${l.speaker === "me" ? "ME" : "THEM"}: ${l.text}`).join("\n");
  if (convo.length > MAX_TRANSCRIPT_CHARS) {
    const cut = convo.slice(-MAX_TRANSCRIPT_CHARS);
    convo = `(the start of the call is left out)\n${cut.slice(cut.indexOf("\n") + 1)}`;
  }
  const minutes = durationMs ? Math.max(1, Math.round(durationMs / 60_000)) : 0;
  const head = minutes ? `Transcript of the whole call (about ${minutes} minutes), oldest first:` : "Transcript of the whole call, oldest first:";
  return `${head}\n${convo || "(nothing was said)"}\n\nGive your feedback now, in the output format.`;
}

// ---------- parsing ----------

export type SectionKey = "summary" | "strengths" | "improvements" | "nextStep" | "fillers" | "score";

export interface Feedback {
  /** Up to five short lines (the model is asked for three). */
  summary: string[];
  strengths: { quote: string; why: string }[];
  improvements: { happened: string; better: string }[];
  /** null when no next step was agreed (or the section is missing: see `sections`). */
  nextStep: string | null;
  fillers: string[];
  score: { value: number; reason: string } | null;
  /** The sections the answer contains, in the order they came. */
  sections: SectionKey[];
  /** The whole (cleaned) answer, when it has no section markers at all. */
  raw?: string;
}

const SECTION_ALIASES: Record<string, SectionKey> = {
  SUMMARY: "summary",
  SAMENVATTING: "summary",
  STRONG_MOMENTS: "strengths",
  STRONGEST_MOMENTS: "strengths",
  STRENGTHS: "strengths",
  STERKE_MOMENTEN: "strengths",
  STERKSTE_MOMENTEN: "strengths",
  IMPROVEMENTS: "improvements",
  VERBETERPUNTEN: "improvements",
  NEXT_STEP: "nextStep",
  NEXT_STEPS: "nextStep",
  VERVOLGSTAP: "nextStep",
  VOLGENDE_STAP: "nextStep",
  AFGESPROKEN_VERVOLGSTAP: "nextStep",
  FILLER_WORDS: "fillers",
  FILLERS: "fillers",
  STOPWOORDEN: "fillers",
  STOPWOORDJES: "fillers",
  SCORE: "score",
  CIJFER: "score",
};

type ItemField = "quote" | "why" | "happened" | "better";
const ITEM_LABELS: Record<string, ItemField> = {
  QUOTE: "quote",
  CITAAT: "quote",
  WHY: "why",
  WAAROM: "why",
  HAPPENED: "happened",
  "WHAT HAPPENED": "happened",
  GEBEURD: "happened",
  "WAT GEBEURDE": "happened",
  "WAT ER GEBEURDE": "happened",
  BETTER: "better",
  BETER: "better",
  "BETTER SENTENCE": "better",
  "BETERE ZIN": "better",
  OEFENZIN: "better",
};

const MARKUP = /\*\*|__|`+/g;

/** Plain text without markdown emphasis and without em or en dashes. */
export function cleanText(s: string): string {
  return s
    .replace(MARKUP, "")
    .replace(/[ \t]*\u2014[ \t]*/g, ", ")
    .replace(/[ \t]+\u2013[ \t]+/g, ", ")
    .replace(/\u2013/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[,\s]+/, "")
    .trim();
}

const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["“", "”"],
  ["„", "”"],
  ["„", "“"],
  ["«", "»"],
  ["‘", "’"],
  ["'", "'"],
];

/** A quote without the quotation marks around it. */
function unquote(s: string): string {
  let q = cleanText(s);
  for (const [open, close] of QUOTE_PAIRS) {
    if (q.length > 1 && q.startsWith(open) && q.endsWith(close)) {
      q = q.slice(open.length, -close.length).trim();
      break;
    }
  }
  return q;
}

/** "## Summary", "**SUMMARY:**", "SAMENVATTING" or "### NEXT_STEP: demo on Tuesday": the section and any text after it. */
function headingOf(line: string): { key: SectionKey; rest: string } | null {
  // The name stops at the first character that is not a letter, space or underscore (a colon, "**", the end).
  const m = /^\s*(#{1,6}\s*)?(\*\*|__)?\s*([A-Za-z][A-Za-z _]{2,30})(?:\*\*|__)?\s*(:)?\s*(?:\*\*|__)?\s*(.*)$/.exec(line);
  if (!m) return null;
  const word = m[3].trim();
  const key = SECTION_ALIASES[word.toUpperCase().replace(/[\s_]+/g, "_")];
  if (!key) return null;
  const rest = m[5].trim();
  if (!rest) return { key, rest: "" };
  // Text on the same line only counts after a real marker: "## Score 7/10", "SCORE: 7/10" or "**Score:** 7/10".
  const marker = !!m[1] || (!!m[4] && (!!m[2] || word === word.toUpperCase()));
  return marker ? { key, rest } : null;
}

/** Strips a bullet or a number from the start of a line. */
function stripBullet(line: string): { text: string; bullet: boolean } {
  const m = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/.exec(line);
  return m ? { text: line.slice(m[0].length), bullet: true } : { text: line.trim(), bullet: false };
}

const LABEL_RE = new RegExp(`^(?:\\*\\*|__)?\\s*(${Object.keys(ITEM_LABELS).join("|")})\\s*(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?\\s*(.*)$`, "i");

function isNone(text: string): boolean {
  return /^(none|geen|nvt|n\/a|-)\.?$/i.test(cleanText(text).replace(/^["“]|["”]$/g, ""));
}

function parseItems<A extends ItemField, B extends ItemField>(body: string[], first: A, second: B): Record<A | B, string>[] {
  type Item = Record<A | B, string>;
  const items: Item[] = [];
  let cur: Item | null = null;
  let last: ItemField | null = null;
  const fresh = (): Item => ({ [first]: "", [second]: "" }) as Item;
  for (const raw of body) {
    if (!raw.trim()) continue;
    const { text, bullet } = stripBullet(raw);
    const label = LABEL_RE.exec(text);
    const field = label ? ITEM_LABELS[label[1].toUpperCase().replace(/\s+/g, " ")] : undefined;
    if (field === first || field === second) {
      const f = field as A | B;
      // A label that is already filled starts the next item; so does a bulleted first label.
      if (!cur || cur[f] || (bullet && f === first)) {
        cur = fresh();
        items.push(cur);
      }
      cur[f] = label![2].trim();
      last = f;
    } else if (bullet || !cur) {
      // An item without labels: the bullet text is its first field.
      cur = fresh();
      items.push(cur);
      cur[first] = text;
      last = first;
    } else if (last && (last === first || last === second)) {
      const f = last as A | B;
      cur[f] = `${cur[f]} ${text.trim()}`.trim();
    }
  }
  return items
    .map((it) => {
      const out = fresh();
      out[first] = first === "quote" || first === "better" ? unquote(it[first]) : cleanText(it[first]);
      out[second] = second === "quote" || second === "better" ? unquote(it[second]) : cleanText(it[second]);
      return out;
    })
    .filter((it) => it[first] || it[second]);
}

function parseScore(body: string[]): Feedback["score"] {
  for (const raw of body) {
    const line = cleanText(stripBullet(raw).text);
    if (!line) continue;
    if (isNone(line)) return null;
    const m = /(\d{1,2}(?:[.,]\d)?)\s*(?:\/|out of|op|van de|uit)\s*10\b/i.exec(line);
    if (!m) continue;
    const value = Math.min(10, Math.max(0, Number(m[1].replace(",", "."))));
    const reason = cleanText(line.slice(m.index + m[0].length).replace(/^[\s:.,;-]+/, ""));
    return { value, reason };
  }
  return null;
}

function parseFillers(body: string[]): string[] {
  const lines = body.filter((l) => l.trim());
  if (!lines.length) return [];
  const bulleted = lines.filter((l) => stripBullet(l).bullet);
  // One line separated by commas (as asked), or a bullet list. Text after it is not a filler word.
  const parts = bulleted.length ? bulleted.map((l) => stripBullet(l).text) : lines[0].split(/[,;]/);
  if (parts.length === 1 && isNone(parts[0])) return [];
  return parts
    .map((p) => cleanText(p).replace(/^["“'‘]([^"”'’]+)["”'’]/, "$1"))
    .filter((p) => p && !isNone(p) && p.length <= 40);
}

/** A last line that is still coming in and may turn into a section marker: "## STRO", "**NEXT_", "SCO". */
const MAYBE_MARKER = /^\s*(?:#|\*\*|__|[A-Z][A-Z_ ]*:?\s*$)/;

/**
 * Parses a complete or a still streaming answer. Missing sections are left empty.
 * `streaming`: the answer is not complete yet, so a half-written marker on the last line is
 * left out instead of showing up as text in the section above it.
 */
export function parseFeedback(text: string, streaming = false): Feedback {
  const fb: Feedback = { summary: [], strengths: [], improvements: [], nextStep: null, fillers: [], score: null, sections: [] };
  const bodies = new Map<SectionKey, string[]>();
  let current: string[] | null = null;
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  if (streaming && MAYBE_MARKER.test(all[all.length - 1]) && !headingOf(all[all.length - 1])) all.pop();
  for (const line of all) {
    const h = headingOf(line);
    if (h) {
      // A section that comes twice keeps adding to the first one.
      current = bodies.get(h.key) ?? [];
      if (!bodies.has(h.key)) {
        bodies.set(h.key, current);
        fb.sections.push(h.key);
      }
      if (h.rest) current.push(h.rest);
    } else if (current) {
      current.push(line);
    }
  }
  if (!fb.sections.length) {
    const raw = text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => cleanText(l.replace(/^\s*#{1,6}\s*/, "")))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (raw) fb.raw = raw;
    return fb;
  }
  for (const [key, body] of bodies) {
    switch (key) {
      case "summary":
        fb.summary = body
          .map((l) => cleanText(stripBullet(l).text))
          .filter(Boolean)
          .slice(0, 5);
        break;
      case "strengths":
        fb.strengths = parseItems(body, "quote", "why").slice(0, 3);
        break;
      case "improvements":
        fb.improvements = parseItems(body, "happened", "better").slice(0, 3);
        break;
      case "nextStep": {
        const lines = body.map((l) => cleanText(stripBullet(l).text)).filter(Boolean);
        fb.nextStep = !lines.length || isNone(lines[0]) ? null : lines.slice(0, 2).join(" ");
        break;
      }
      case "fillers":
        fb.fillers = parseFillers(body);
        break;
      case "score":
        fb.score = parseScore(body);
        break;
    }
  }
  return fb;
}

// ---------- plain text for copy and save ----------

export interface FeedbackMeta {
  /** For example "Call of 14 min, 5 October 2026 14:32". */
  subtitle?: string;
  /** The kind of call: a meeting calls the next step "decisions and action points". */
  callType?: CallType;
}

/** The heading of the next-step section and its text when nothing was agreed. */
export function nextStepKeys(callType?: CallType): { title: MessageKey; none: MessageKey } {
  return callType === "meeting"
    ? { title: "feedback.nextStepMeeting", none: "feedback.noNextStepMeeting" }
    : { title: "feedback.nextStep", none: "feedback.noNextStep" };
}

/** The feedback as markdown, in the app language: for the clipboard (a CRM note) and for a saved file. */
export function feedbackToMarkdown(fb: Feedback, language: string, meta: FeedbackMeta = {}): string {
  const tr = (key: MessageKey) => t(language, key);
  const out: string[] = [`# ${tr("feedback.title")}`];
  if (meta.subtitle) out.push("", meta.subtitle);
  if (fb.raw) {
    out.push("", fb.raw);
    return `${out.join("\n")}\n`;
  }
  const has = (k: SectionKey) => fb.sections.includes(k);
  if (has("summary") || fb.score) {
    out.push("", `## ${tr("feedback.summary")}`, "");
    out.push(...fb.summary);
    if (fb.score) out.push("", `${tr("feedback.score")}: ${formatScore(fb.score.value, language)}/10${fb.score.reason ? `. ${fb.score.reason}` : ""}`);
  }
  if (fb.strengths.length) {
    out.push("", `## ${tr("feedback.strengths")}`, "");
    for (const s of fb.strengths) out.push(`- "${s.quote}"${s.why ? `\n  ${s.why}` : ""}`);
  }
  if (fb.improvements.length) {
    out.push("", `## ${tr("feedback.improvements")}`, "");
    for (const i of fb.improvements) {
      out.push(`- ${i.happened}`);
      if (i.better) out.push(`  ${tr("feedback.practise")}: "${i.better}"`);
    }
  }
  const next = nextStepKeys(meta.callType);
  if (has("nextStep")) out.push("", `## ${tr(next.title)}`, "", fb.nextStep ?? tr(next.none));
  if (fb.fillers.length) out.push("", `## ${tr("feedback.fillers")}`, "", fb.fillers.join(", "));
  return `${out.join("\n")}\n`;
}

/** 7 stays "7", 7.5 becomes "7.5" (or "7,5" in Dutch when a language is given). */
export function formatScore(value: number, language?: string): string {
  const s = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return language && language.toLowerCase().startsWith("nl") ? s.replace(".", ",") : s;
}
