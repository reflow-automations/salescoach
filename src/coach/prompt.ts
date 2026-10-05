// Builds the instructions (system prompt) and the per-request input for the brain.
import playbook from "./playbook.md";
import type { Profile, Speaker } from "../shared/types";

export const PASS = "PASS";

const LANGUAGE_NAMES: Record<string, string> = { nl: "Dutch", en: "English", de: "German", fr: "French", es: "Spanish" };

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase().split("-")[0]] ?? code;
}

const PROFILE_LABELS: Record<keyof Profile, string> = {
  whoAmI: "Who I am and what I can do",
  offer: "What I sell",
  pricing: "My prices (only use these, never invent)",
  idealCustomer: "My ideal customer",
  cases: "Cases and results I may mention",
  objections: "Objections I often hear and how I like to answer",
  rules: "My hard rules (always follow)",
  tone: "My tone of voice",
};

export function profileToText(p: Profile): string {
  const parts = (Object.keys(PROFILE_LABELS) as (keyof Profile)[])
    .filter((k) => p[k].trim())
    .map((k) => `### ${PROFILE_LABELS[k]}\n${p[k].trim()}`);
  return parts.length ? parts.join("\n\n") : "(The user has not filled in a profile yet. Give general but concrete sales advice.)";
}

export function buildInstructions(profile: Profile, callBrief: string, language: string): string {
  const lang = languageName(language);
  return [
    `You are a live sales coach whispering to the user (the seller, labelled ME) during a ${lang} sales call. The other party is labelled THEM. Only the user sees your output, on a small overlay next to their camera. They glance at it for one second while talking.`,
    "",
    "## Output format (strict)",
    `- Write in ${lang}.`,
    "- Line 1: what to say or do next, max 15 words. Prefer a sentence they can say literally.",
    "- Optional line 2, starting with '? ': one short question they can ask. Only if it helps.",
    "- No preamble, no labels like 'Tip:', no markdown, no emojis, no em dashes or en dashes.",
    `- If you get an AUTO request and THEM did not raise an objection, a buying signal, a direct question or an important fact, answer exactly ${PASS} and nothing else.`,
    "- For a HOTKEY request always give a tip, never PASS.",
    "",
    "## How to choose the tip",
    "- React to the LAST thing THEM said, in the context of the whole call.",
    "- Follow the playbook below. Prefer a question over a pitch. Prefer short over complete.",
    "- Only use facts, prices, cases and promises from the profile and the call brief. If the user would need information you do not have, suggest they say they will check and follow up by email.",
    "- If THEM asks something the user must answer factually and the profile has the answer, give that answer in the user's words.",
    "",
    "## Profile of the user",
    profileToText(profile),
    "",
    "## Brief for this call",
    callBrief.trim() || "(none)",
    "",
    playbook,
  ].join("\n");
}

export interface Line {
  speaker: Speaker;
  text: string;
}

export function buildInput(lines: Line[], trigger: "hotkey" | "auto"): string {
  const convo = lines.map((l) => `${l.speaker === "me" ? "ME" : "THEM"}: ${l.text}`).join("\n");
  return `${trigger === "hotkey" ? "HOTKEY" : "AUTO"} request.\n\nConversation so far (most recent last):\n${convo || "(nothing yet)"}`;
}

// ---------- output contract ----------
// Models do not always follow the output format above, so the coach cleans the text
// while it streams. The overlay appends deltas, so the cleaned text may only ever grow:
// characters whose meaning depends on what follows are held back until it arrives.

const MAX_TIP_LINES = 2;
const LABELS = ["tip", "tipp", "zeg", "say", "sag", "antwoord", "answer", "suggestie", "suggestion", "conseil", "consejo", "vraag", "question", "frage", "pregunta"];
const QUESTION_LABELS = new Set(["vraag", "question", "frage", "pregunta"]);
// "Tip:", "**Vraag:**" and "Zeg *:" all count; the markup around the label is stripped separately.
const LABEL = new RegExp(`^(${LABELS.join("|")})[ \\t*_]*:`, "i");
/** Markup, quotes, dashes and spaces: what they turn into depends on the next character. */
const UNSETTLED_TAIL = /[\s*_`"'“”‘’„«»=\-\u2013\u2014]+$/u;
// Single straight quotes stay: in Dutch they are often apostrophes ('s avonds, auto's).
const OPEN_QUOTES = `"“”„«‘`;
const CLOSE_QUOTES: Record<string, string> = { '"': '"”', "“": '”"', "”": '”"', "„": '”“"', "«": "»" };

interface LineStart {
  rest: string;
  question: boolean;
  quote: string;
}

/** Strips bullets, headings, emphasis, an opening quote and a "?" marker from the start of a line. */
function stripLineStart(s: string, into: LineStart = { rest: "", question: false, quote: "" }): LineStart {
  let rest = s;
  for (;;) {
    const m = /^(?:\s+|[*_`#>•]+|[-\u2013\u2014](?=\s)|\d{1,2}[.)](?=\s))/u.exec(rest);
    if (m) rest = rest.slice(m[0].length);
    else if (rest && OPEN_QUOTES.includes(rest[0])) {
      into.quote = rest[0];
      rest = rest.slice(1);
    } else if (rest[0] === "?") {
      into.question = true;
      rest = rest.slice(1);
    } else break;
  }
  into.rest = rest;
  return into;
}

function tidy(text: string, quote: string): string {
  let t = text;
  // The quote that opened the line closes at its first matching quote.
  const closers = [...(CLOSE_QUOTES[quote] ?? "")].map((c) => t.indexOf(c)).filter((i) => i >= 0);
  if (closers.length) {
    const i = Math.min(...closers);
    t = t.slice(0, i) + t.slice(i + 1);
  }
  return t
    .replace(/\*+|`+|__+/g, "")
    .replace(/[ \t]*\u2014[ \t]*/g, ", ")
    .replace(/[ \t]+\u2013[ \t]+/g, ", ")
    .replace(/\u2013/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[,\s]+/, "")
    .trim();
}

/** One line in overlay format. A line that is still streaming only returns what is settled. */
function cleanLine(raw: string, complete: boolean, index: number): string {
  const start = stripLineStart(complete ? raw : raw.replace(UNSETTLED_TAIL, ""));
  const label = LABEL.exec(start.rest);
  if (label) {
    if (QUESTION_LABELS.has(label[1].toLowerCase())) start.question = true;
    stripLineStart(start.rest.slice(label[0].length), start);
  }
  let rest = start.rest;
  if (!complete) {
    // "Vra" may still become "Vraag:", "1" may become the bullet "1. ".
    const maybeLabel = !label && LABELS.some((l) => l.startsWith(rest.toLowerCase()));
    if (maybeLabel || /^\d{1,2}[.)]?$/.test(rest)) return "";
  } else {
    rest = rest.replace(/[\s*_`]+$/u, "").replace(/[ \t]*[\u2013\u2014]+$/u, "");
    if (start.quote === "‘") rest = rest.replace(/[’']$/u, "");
    // A markdown rule, an empty bullet or a lone heading like "Tip".
    if (/^[-=_*\s]*$/.test(rest) || (!label && LABELS.includes(rest.toLowerCase()))) return "";
  }
  const text = tidy(rest, start.quote);
  if (!text) return "";
  return start.question && index > 0 ? `? ${text}` : text;
}

/**
 * Turns raw model output into the overlay format: no labels, markdown, quotes around the
 * tip or em/en dashes, at most two lines, a second-line question as "? ...".
 * push() returns the settled text so far; every result starts with the previous one.
 */
export class TipCleaner {
  private raw = "";

  push(chunk: string): string {
    this.raw += chunk;
    return this.render(false);
  }

  /** The cleaned text once the stream has ended. */
  finish(): string {
    return this.render(true);
  }

  private render(ended: boolean): string {
    const lines = this.raw.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length && out.length < MAX_TIP_LINES; i++) {
      const text = cleanLine(lines[i], ended || i < lines.length - 1, out.length);
      if (text) out.push(text);
    }
    return out.join("\n");
  }
}

export function cleanTip(raw: string): string {
  const c = new TipCleaner();
  c.push(raw);
  return c.finish();
}

/**
 * Is the (cleaned) answer PASS? "PASS", "PASS." and "PASS Geen tip" are, in any wrapping.
 * "Pass the discount", "Passend voorstel" and "Pas op" are real tips. While streaming,
 * "undecided" means: wait for more text.
 */
export function passVerdict(cleaned: string, ended: boolean): "pass" | "tip" | "undecided" {
  const t = cleaned.replace(/^['‘’]+/u, "");
  if (!t) return ended ? "pass" : "undecided";
  const head = t.slice(0, PASS.length);
  if (head.toUpperCase() !== PASS) return !ended && PASS.startsWith(t.toUpperCase()) ? "undecided" : "tip";
  const next = t[PASS.length];
  if (next === undefined) return ended ? "pass" : "undecided";
  if (/[\p{L}\p{N}_]/u.test(next)) return "tip";
  // A space and a word after it: only the shouted PASS is the signal.
  if (next === " " || next === "\t") return head === PASS ? "pass" : "tip";
  return "pass";
}
