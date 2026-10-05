// Manual eval of the coach brain: runs the eval cases against a real model and
// writes a markdown report to evals/results/ (gitignored). Needs your own key in
// the environment; nothing is ever written to disk except the report.
//
//   $env:GEMINI_API_KEY="..."; npm run eval
//
// Env: EVAL_LANG (en | nl, default en: evals/cases.en.json with examples/profile-example.en.md,
// or evals/cases.json with examples/profile-example.nl.md), EVAL_PROVIDER (gemini | openai | dry,
// default gemini), GEMINI_API_KEY or OPENAI_API_KEY, EVAL_MODEL, EVAL_PROFILE, EVAL_ONLY
// (comma separated ids or categories), EVAL_GAP_MS (pause between cases, default 4000).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PASS, buildInput, buildInstructions, type Line } from "../src/coach/prompt";
import { parseProfile } from "../src/coach/profile-import";
import { BrainError, type Brain } from "../src/main/providers/brain";
import { createGeminiBrain } from "../src/main/providers/brain-gemini";
import { createOpenAIBrain } from "../src/main/providers/brain-openai";
import { normLang, type Lang } from "../src/shared/i18n";
import { DEFAULT_SETTINGS, EMPTY_PROFILE, normCallType, type CallType, type Profile } from "../src/shared/types";

interface EvalCase {
  id: string;
  category: string;
  /** The kind of call; a case without it is a sales call. */
  callType?: CallType;
  /** The brief for this call (for a job interview: the vacancy and the user's points). Default empty. */
  brief?: string;
  trigger: "auto" | "hotkey";
  lines: Line[];
  expect: string;
  shouldPass: boolean;
}

/** ok = passed, false = failed, null = not applicable to this answer. */
interface CheckResult {
  key: CheckKey;
  ok: boolean | null;
  note?: string;
}

interface CaseResult {
  c: EvalCase;
  text: string;
  error?: string;
  firstMs: number | null;
  totalMs: number;
  checks: CheckResult[];
}

const CHECKS = {
  noError: "Answer without an error",
  passCorrect: "PASS right (auto)",
  hotkeyTip: "Hotkey gives a tip",
  line1Words: "Line 1 at most 20 words",
  maxTwoLines: "At most 2 lines",
  line2Question: "Line 2 starts with '? '",
  noDashes: "No em dash or en dash",
  noTipPrefix: "No 'Tip:' in front",
} as const;
type CheckKey = keyof typeof CHECKS;

const ROOT = resolve(__dirname, "..");
const TIMEOUT_MS = 30_000;
const RATE_LIMIT_WAIT_MS = 20_000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---------- configuration ----------

/** The case file and the example profile for each language. */
const LANG_FILES: Record<Lang, { cases: string; profile: string }> = {
  en: { cases: "cases.en.json", profile: "profile-example.en.md" },
  nl: { cases: "cases.json", profile: "profile-example.nl.md" },
};

function readConfig() {
  const langRaw = (process.env.EVAL_LANG ?? "").trim().toLowerCase() || "en";
  if (langRaw !== "en" && langRaw !== "nl") fail(`Unknown EVAL_LANG "${langRaw}". Choose en or nl.`);
  const lang: Lang = normLang(langRaw);
  const provider = (process.env.EVAL_PROVIDER ?? "gemini").trim().toLowerCase() || "gemini";
  if (provider !== "gemini" && provider !== "openai" && provider !== "dry") {
    fail(`Unknown EVAL_PROVIDER "${provider}". Choose gemini, openai or dry (a dry run without AI).`);
  }
  let apiKey = "";
  if (provider !== "dry") {
    const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
    apiKey = (process.env[keyName] ?? "").trim();
    if (!apiKey) {
      const msg = [
        `No ${keyName} found, so the eval does not start (nothing was called).`,
        "",
        "Set your key for this PowerShell session only and try again:",
      ];
      if (provider === "openai") msg.push(`  $env:EVAL_PROVIDER="openai"`);
      msg.push(`  $env:${keyName}="your-key"`, "  npm run eval", "");
      msg.push(
        provider === "gemini"
          ? `Want to use OpenAI? Set $env:EVAL_PROVIDER="openai" and $env:OPENAI_API_KEY.`
          : "Want to use Gemini? Remove EVAL_PROVIDER and set $env:GEMINI_API_KEY.",
      );
      fail(msg.join("\n"));
    }
  }
  const model =
    (process.env.EVAL_MODEL ?? "").trim() ||
    (provider === "openai" ? DEFAULT_SETTINGS.openaiModel : provider === "gemini" ? DEFAULT_SETTINGS.geminiModel : "dry run");
  const gapRaw = Number(process.env.EVAL_GAP_MS);
  const gapMs = Number.isFinite(gapRaw) && gapRaw >= 0 ? gapRaw : provider === "dry" ? 0 : 4000;
  const only = (process.env.EVAL_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { lang, provider: provider as "gemini" | "openai" | "dry", apiKey, model, gapMs, only };
}

function loadProfile(lang: Lang): { profile: Profile; source: string; note?: string } {
  const fromEnv = (process.env.EVAL_PROFILE ?? "").trim();
  const path = fromEnv ? resolve(process.cwd(), fromEnv) : join(ROOT, "examples", LANG_FILES[lang].profile);
  const shown = (relative(ROOT, path) || path).split("\\").join("/");
  if (!existsSync(path)) {
    return {
      profile: { ...EMPTY_PROFILE },
      source: "empty profile",
      note: `Note: profile file ${shown} not found, the eval runs with an empty profile.`,
    };
  }
  const { profile, filled, missing } = parseProfile(readFileSync(path, "utf8"));
  const note =
    filled.length === 0
      ? `Note: no profile headings found in ${shown}, the eval runs with an empty profile.`
      : missing.length
        ? `Profile ${shown}: ${filled.length} of 8 parts filled in (empty: ${missing.join(", ")}).`
        : undefined;
  return { profile, source: shown, note };
}

function loadCases(lang: Lang, only: string[]): { cases: EvalCase[]; file: string } {
  const file = `evals/${LANG_FILES[lang].cases}`;
  let cases: EvalCase[];
  try {
    cases = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  } catch (err) {
    fail(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(cases) || cases.length === 0) fail(`${file} has no cases.`);
  if (only.length) {
    cases = cases.filter((c) => only.includes(c.id) || only.includes(c.category));
    if (!cases.length) fail(`EVAL_ONLY="${only.join(",")}" matches no case in ${file}.`);
  }
  return { cases, file };
}

function makeBrain(cfg: ReturnType<typeof readConfig>): Brain {
  if (cfg.provider === "gemini") return createGeminiBrain({ model: cfg.model, apiKey: cfg.apiKey });
  if (cfg.provider === "openai") return createOpenAIBrain({ model: cfg.model, getToken: async () => cfg.apiKey, planUsage: false });
  return dryBrain(cfg.lang);
}

/** Local stand-in so the harness and report can be checked without a key or costs. */
function dryBrain(lang: Lang): Brain {
  const tip =
    lang === "nl"
      ? "Vraag wat er nu precies twijfel geeft.\n? Wat moet er gebeuren om ja te zeggen?"
      : "Ask what exactly makes them hesitate.\n? What has to happen for you to say yes?";
  return async ({ input, onDelta, signal }) => {
    const answer = input.startsWith("AUTO") ? PASS : tip;
    let out = "";
    for (const chunk of answer.match(/.{1,8}/gs) ?? []) {
      if (signal.aborted) break;
      await sleep(3);
      out += chunk;
      onDelta(chunk);
    }
    return out;
  };
}

// ---------- running ----------

async function runCase(brain: Brain, instructions: string, c: EvalCase): Promise<CaseResult> {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const t0 = performance.now();
    const timing = { first: null as number | null };
    let streamed = "";
    let text = "";
    let error: string | undefined;
    try {
      const full = await brain({
        instructions,
        // A case with an unfinished THEM line stands for an early (draft) auto request, like the coach sends.
        input: buildInput(c.lines, c.trigger, { stillSpeaking: c.trigger === "auto" }),
        signal: ctrl.signal,
        onDelta: (d) => {
          if (timing.first === null && d) timing.first = performance.now() - t0;
          streamed += d;
        },
      });
      text = full || streamed;
    } catch (err) {
      if (err instanceof BrainError && err.status === 429 && attempt === 0) {
        clearTimeout(timer);
        console.log(`    rate limit hit (429), waiting ${RATE_LIMIT_WAIT_MS / 1000} s and trying once more...`);
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      error = ctrl.signal.aborted ? `No answer within ${TIMEOUT_MS / 1000} s` : err instanceof Error ? err.message : String(err);
      text = streamed;
    } finally {
      clearTimeout(timer);
    }
    const totalMs = performance.now() - t0;
    return { c, text, error, firstMs: timing.first, totalMs, checks: check(c, text, error) };
  }
}

/** Same idea as the coach: an answer that is the word PASS (optionally with punctuation). */
export function isPass(text: string): boolean {
  return new RegExp(`^${PASS}\\b`, "i").test(text.trim());
}

export function tipLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function check(c: EvalCase, text: string, error?: string): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (key: CheckKey, ok: boolean | null, note?: string) => out.push({ key, ok, note });
  const pass = isPass(text);
  const lines = tipLines(text);
  const isTip = !error && lines.length > 0 && !pass;

  add("noError", !error, error);
  add("passCorrect", c.trigger === "auto" && !error ? pass === c.shouldPass : null, c.trigger === "auto" && !error ? `expected ${c.shouldPass ? "PASS" : "tip"}, got ${pass ? "PASS" : lines.length ? "tip" : "empty"}` : undefined);
  add("hotkeyTip", c.trigger === "hotkey" && !error ? isTip : null, c.trigger === "hotkey" && !isTip && !error ? (pass ? "answered PASS" : "empty answer") : undefined);

  const words = isTip ? lines[0].split(/\s+/).filter(Boolean).length : 0;
  add("line1Words", isTip ? words <= 20 : null, isTip ? `${words} words` : undefined);
  add("maxTwoLines", isTip ? lines.length <= 2 : null, isTip ? `${lines.length} line(s)` : undefined);
  add("line2Question", isTip && lines.length >= 2 ? lines[1].startsWith("? ") : null);
  add("noDashes", text.trim() ? !/[\u2013\u2014]/.test(text) : null);
  add("noTipPrefix", isTip ? !/^[*_\s]*tip\s*:/i.test(lines[0]) : null);
  return out;
}

// ---------- report ----------

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const ms = (v: number | null) => (v === null ? "n/a" : `${Math.round(v)} ms`);
const pct = (ok: number, of: number) => (of ? `${Math.round((ok / of) * 100)}%` : "n/a");
const mark = (ok: boolean | null) => (ok === null ? "n/a" : ok ? "ok" : "FAIL");

function fence(text: string): string {
  const f = text.includes("```") ? "~~~" : "```";
  return `${f}text\n${text.trim() || "(empty)"}\n${f}`;
}

function report(
  meta: { lang: Lang; cases: string; provider: string; model: string; profile: string; note?: string; startedAt: Date },
  results: CaseResult[],
): string {
  const out: string[] = [];
  const firsts = results.map((r) => r.firstMs).filter((v): v is number => v !== null);
  const totals = results.filter((r) => !r.error).map((r) => r.totalMs);
  const allOk = results.filter((r) => r.checks.every((ch) => ch.ok !== false)).length;
  const auto = results.filter((r) => r.c.trigger === "auto" && !r.error);
  const missedTips = auto.filter((r) => !r.c.shouldPass && isPass(r.text)).length;
  const needlessTips = auto.filter((r) => r.c.shouldPass && !isPass(r.text)).length;

  out.push(`# Salescoach eval ${meta.startedAt.toISOString()}`, "");
  out.push(`- Language: ${meta.lang} (${meta.cases})`);
  out.push(`- Provider: ${meta.provider}${meta.provider === "dry" ? " (dry run, no real AI)" : ""}`);
  out.push(`- Model: ${meta.model}`);
  out.push(`- Profile: ${meta.profile}`);
  if (meta.note) out.push(`- Note: ${meta.note}`);
  out.push(`- Cases: ${results.length}, errors: ${results.filter((r) => r.error).length}`);
  out.push(`- All checks fine: ${allOk} of ${results.length} (${pct(allOk, results.length)})`);
  out.push(`- Median first token: ${ms(median(firsts))}, median total: ${ms(median(totals))}, slowest first token: ${ms(firsts.length ? Math.max(...firsts) : null)}`);
  out.push(`- Auto: wrong PASS (missed tip): ${missedTips}, needless tip (should have been PASS): ${needlessTips}`);
  out.push("", "## Summary per check", "", "| Check | Passed | Applicable | Score |", "| --- | --- | --- | --- |");
  for (const key of Object.keys(CHECKS) as CheckKey[]) {
    const applicable = results.map((r) => r.checks.find((ch) => ch.key === key)!).filter((ch) => ch.ok !== null);
    const ok = applicable.filter((ch) => ch.ok).length;
    out.push(`| ${CHECKS[key]} | ${ok} | ${applicable.length} | ${pct(ok, applicable.length)} |`);
  }
  out.push("", "Fill in your verdict for each case (for example good, so-so, wrong, plus why).", "", "## Cases");

  results.forEach((r, i) => {
    const { c } = r;
    out.push("", `### ${i + 1}. ${c.id} (${normCallType(c.callType)}, ${c.category}, ${c.trigger})`, "");
    if (c.brief?.trim()) out.push(`Brief: ${c.brief.trim().replace(/\s+/g, " ")}`, "");
    out.push("Excerpt:", "");
    for (const l of c.lines) out.push(`> ${l.speaker === "me" ? "ME" : "THEM"}: ${l.text}  `);
    out.push("", "Tip:", "", fence(r.text), "");
    out.push(`Time: first token ${ms(r.firstMs)}, total ${ms(r.totalMs)}`, "", "Checks:", "");
    for (const ch of r.checks) {
      if (ch.ok === null && !ch.note) continue;
      out.push(`- ${mark(ch.ok)}: ${CHECKS[ch.key]}${ch.note ? ` (${ch.note})` : ""}`);
    }
    out.push("", `Expected: ${c.expect}`, "", "Verdict:");
  });
  return out.join("\n") + "\n";
}

// ---------- main ----------

async function main(): Promise<void> {
  const cfg = readConfig();
  const { cases, file: casesFile } = loadCases(cfg.lang, cfg.only);
  const { profile, source, note } = loadProfile(cfg.lang);
  if (note) console.log(note);
  // The same instructions as the app, per kind of call and brief of the case.
  const instructionsCache = new Map<string, string>();
  const instructionsFor = (c: EvalCase): string => {
    const type = normCallType(c.callType);
    const brief = c.brief ?? "";
    const key = `${type}|${brief}`;
    let s = instructionsCache.get(key);
    if (s === undefined) instructionsCache.set(key, (s = buildInstructions(profile, brief, cfg.lang, type)));
    return s;
  };
  const brain = makeBrain(cfg);
  const startedAt = new Date();

  console.log(`Eval: ${cases.length} cases (${casesFile}, language ${cfg.lang}), provider ${cfg.provider}, model ${cfg.model}, pause ${cfg.gapMs} ms between cases.`);
  const results: CaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    if (i > 0 && cfg.gapMs > 0) await sleep(cfg.gapMs);
    const r = await runCase(brain, instructionsFor(cases[i]), cases[i]);
    results.push(r);
    const failed = r.checks.filter((ch) => ch.ok === false).map((ch) => CHECKS[ch.key]);
    const first = r.error ? `ERROR: ${r.error}` : tipLines(r.text)[0] ?? "(empty)";
    console.log(`[${i + 1}/${cases.length}] ${normCallType(cases[i].callType)} ${cases[i].id}: ${ms(r.firstMs)} | ${first}${failed.length ? ` | failed: ${failed.join(", ")}` : ""}`);
  }

  const dir = join(ROOT, "evals", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `eval-${startedAt.toISOString().replace(/:/g, "-")}.md`);
  writeFileSync(file, report({ lang: cfg.lang, cases: casesFile, provider: cfg.provider, model: cfg.model, profile: source, note, startedAt }, results), "utf8");
  console.log(`\nReport written: ${relative(process.cwd(), file) || file}`);

  if (results.every((r) => r.error)) {
    fail(`Every call failed. Check your key and the model "${cfg.model}". First error: ${results[0].error}`);
  }
}

main().catch((err) => fail(`Eval stopped: ${err instanceof Error ? err.message : String(err)}`));
