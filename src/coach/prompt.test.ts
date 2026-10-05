import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_PROFILE, type Profile } from "../shared/types";
import { PASS, TipCleaner, buildInput, buildInstructions, cleanTip, languageName, passVerdict, playbookFor, profileToText } from "./prompt";

const LABELS: Record<keyof Profile, string> = {
  whoAmI: "### Who I am and what I can do",
  offer: "### What I sell",
  pricing: "### My prices (only use these, never invent)",
  idealCustomer: "### My ideal customer",
  cases: "### Cases and results I may mention",
  objections: "### Objections I often hear and how I like to answer",
  rules: "### My hard rules (always follow)",
  tone: "### My tone of voice",
};

test("buildInstructions only includes profile labels for filled fields", () => {
  const profile: Profile = { ...EMPTY_PROFILE, offer: "Automatiseringen voor het MKB.", pricing: "  425 euro per maand  ", tone: "   \n  " };
  const s = buildInstructions(profile, "", "nl");
  assert.ok(s.includes(`${LABELS.offer}\nAutomatiseringen voor het MKB.`));
  assert.ok(s.includes(`${LABELS.pricing}\n425 euro per maand`), "pricing should be trimmed");
  for (const k of ["whoAmI", "idealCustomer", "cases", "objections", "rules", "tone"] as const) {
    assert.ok(!s.includes(LABELS[k]), `label for empty field ${k} should not be present`);
  }
  assert.ok(!s.includes("has not filled in a profile"));
});

test("buildInstructions with an empty profile says so", () => {
  const s = buildInstructions(EMPTY_PROFILE, "", "nl");
  assert.ok(s.includes("The user has not filled in a profile yet"));
  for (const label of Object.values(LABELS)) assert.ok(!s.includes(label));
});

test("profileToText keeps the profile order", () => {
  const t = profileToText({ ...EMPTY_PROFILE, tone: "Direct.", whoAmI: "Rogier." });
  assert.ok(t.indexOf(LABELS.whoAmI) < t.indexOf(LABELS.tone));
});

test("buildInstructions includes the call brief, or (none) when empty", () => {
  const withBrief = buildInstructions(EMPTY_PROFILE, "  Gesprek met Jan van Bakkerij De Korst, wil minder telefoon.  ", "nl");
  assert.ok(withBrief.includes("## Brief for this call\nGesprek met Jan van Bakkerij De Korst, wil minder telefoon."));
  const without = buildInstructions(EMPTY_PROFILE, "   ", "nl");
  assert.ok(without.includes("## Brief for this call\n(none)"));
});

test("buildInstructions names the call language", () => {
  assert.ok(buildInstructions(EMPTY_PROFILE, "", "nl").includes("during a Dutch sales call"));
  assert.ok(buildInstructions(EMPTY_PROFILE, "", "nl").includes("Write in Dutch."));
  assert.ok(buildInstructions(EMPTY_PROFILE, "", "en-US").includes("Write in English."));
});

test("languageName maps codes and falls back to the code", () => {
  assert.equal(languageName("nl"), "Dutch");
  assert.equal(languageName("NL-be"), "Dutch");
  assert.equal(languageName("de"), "German");
  assert.equal(languageName("pt"), "pt");
});

test("buildInstructions contains the PASS rule and the hotkey never-PASS rule", () => {
  const s = buildInstructions(EMPTY_PROFILE, "", "nl");
  assert.equal(PASS, "PASS");
  assert.ok(s.includes(`answer exactly ${PASS} and nothing else`));
  assert.ok(s.includes("For a HOTKEY request always give a tip, never PASS."));
});

test("buildInstructions includes the output format and the playbook", () => {
  const s = buildInstructions(EMPTY_PROFILE, "", "nl");
  assert.ok(s.includes("## Output format (strict)"));
  assert.ok(s.includes("starting with '? '"));
  assert.ok(s.includes("# Sales playbook for a live call coach"), "playbook text should be appended");
  assert.ok(s.indexOf("## Profile of the user") < s.indexOf("## Brief for this call"));
});

test("buildInput labels ME and THEM and keeps order", () => {
  const s = buildInput(
    [
      { speaker: "me", text: "Wat kost dat jullie nu per maand?" },
      { speaker: "them", text: "Geen idee eerlijk gezegd." },
    ],
    "auto",
  );
  assert.ok(s.includes("ME: Wat kost dat jullie nu per maand?\nTHEM: Geen idee eerlijk gezegd."));
});

test("buildInput marks HOTKEY and AUTO requests", () => {
  assert.ok(buildInput([], "hotkey").startsWith("HOTKEY request."));
  assert.ok(buildInput([], "auto").startsWith("AUTO request."));
});

test("buildInput with no lines says nothing yet", () => {
  assert.ok(buildInput([], "hotkey").includes("(nothing yet)"));
});

// ---------- output contract ----------

const EM = "\u2014";
const EN = "\u2013";

const CLEAN_CASES: [string, string][] = [
  ["Vraag wat het probleem nu kost.", "Vraag wat het probleem nu kost."],
  ["**Vraag:** Wat kost dit probleem je nu per maand?", "Wat kost dit probleem je nu per maand?"],
  ["Tip: Noem eerst de pijn, dan de prijs.", "Noem eerst de pijn, dan de prijs."],
  ["**Tip**: Noem de pilot.", "Noem de pilot."],
  ["Say: ask for the budget.", "ask for the budget."],
  [`Noem eerst de pijn ${EM} dan de prijs.`, "Noem eerst de pijn, dan de prijs."],
  [`Noem eerst de pijn${EM}dan de prijs.`, "Noem eerst de pijn, dan de prijs."],
  [`Wacht even ${EN} laat ze praten.`, "Wacht even, laat ze praten."],
  [`Reken op 10${EN}20 uur.`, "Reken op 10-20 uur."],
  [`Vraag door ${EM}`, "Vraag door"],
  ['Zeg: "Wat kost het je nu per maand?"', "Wat kost het je nu per maand?"],
  ["„Wat kost het nu?”", "Wat kost het nu?"],
  ['"Klinkt goed." Vraag dan naar "de pilot".', 'Klinkt goed. Vraag dan naar "de pilot".'],
  ["‘Wat kost het nu?’", "Wat kost het nu?"],
  ["Dat is 's avonds lastig, net als auto's.", "Dat is 's avonds lastig, net als auto's."],
  ["`Stel een open vraag.`", "Stel een open vraag."],
  ["Stel een *open* vraag over __budget__.", "Stel een open vraag over budget."],
  ["- Vraag naar het budget.", "Vraag naar het budget."],
  ["1. Vraag naar het budget.", "Vraag naar het budget."],
  ["1.5 uur is genoeg.", "1.5 uur is genoeg."],
  ["> Vraag naar het budget.", "Vraag naar het budget."],
  ["## Tip\nVraag wat het kost.", "Vraag wat het kost."],
  ["Tip:\nVraag wat het kost.", "Vraag wat het kost."],
  ["Tipping point: vraag nu door.", "Tipping point: vraag nu door."],
  ["Passend voorstel: begin klein.", "Passend voorstel: begin klein."],
  ["Vraag naar het budget.\n? Wie beslist er mee?", "Vraag naar het budget.\n? Wie beslist er mee?"],
  ["Vraag naar het budget.\n?Wie beslist er mee?", "Vraag naar het budget.\n? Wie beslist er mee?"],
  ["Vraag naar het budget.\n**Vraag:** Wie beslist er mee?", "Vraag naar het budget.\n? Wie beslist er mee?"],
  ["? Wie beslist er mee?", "Wie beslist er mee?"],
  ["Regel een.\n\nRegel twee.\nRegel drie.", "Regel een.\nRegel twee."],
  ["Vraag naar het budget.\n---\n? Wie beslist er mee?", "Vraag naar het budget.\n? Wie beslist er mee?"],
  ["Vraag  naar\r\nhet budget.\r\n", "Vraag naar\nhet budget."],
  ["**PASS**", "PASS"],
  ["", ""],
];

for (const [raw, want] of CLEAN_CASES) {
  test(`cleanTip(${JSON.stringify(raw)})`, () => {
    assert.equal(cleanTip(raw), want);
    assert.ok(!/[\u2013\u2014]/.test(cleanTip(raw)));
  });
}

test("TipCleaner only ever grows its text, for every chunk size, and ends on cleanTip", () => {
  for (const [raw] of CLEAN_CASES) {
    for (let size = 1; size <= Math.max(1, raw.length); size++) {
      const c = new TipCleaner();
      let prev = "";
      for (let i = 0; i < raw.length; i += size) {
        const next = c.push(raw.slice(i, i + size));
        assert.ok(next.startsWith(prev), `${JSON.stringify(raw)} size ${size}: ${JSON.stringify(prev)} -> ${JSON.stringify(next)}`);
        prev = next;
      }
      const end = c.finish();
      assert.ok(end.startsWith(prev), `${JSON.stringify(raw)} size ${size}: final ${JSON.stringify(end)} after ${JSON.stringify(prev)}`);
      assert.equal(end, cleanTip(raw));
    }
  }
});

test("TipCleaner holds back a word that may still become a label", () => {
  const c = new TipCleaner();
  assert.equal(c.push("Vra"), "");
  assert.equal(c.push("ag"), "");
  assert.equal(c.push(" wat"), "Vraag wat");
});

const VERDICTS: [string, boolean, ReturnType<typeof passVerdict>][] = [
  ["PASS", true, "pass"],
  ["PASS", false, "undecided"],
  ["pass", true, "pass"],
  ["Pass", true, "pass"],
  ["PASS.", false, "pass"],
  ["PASS\nGeen tip.", false, "pass"],
  ["PASS Geen bezwaar.", false, "pass"],
  ["'PASS'", true, "pass"],
  ["", false, "undecided"],
  ["", true, "pass"],
  ["P", false, "undecided"],
  ["Pas", false, "undecided"],
  ["Pas op: nog geen prijs.", false, "tip"],
  ["Pass the discount, ask for budget first.", false, "tip"],
  ["Passend voorstel", false, "tip"],
  ["Passing on price", false, "tip"],
  ["Vraag naar het budget.", false, "tip"],
];

for (const [text, ended, want] of VERDICTS) {
  test(`passVerdict(${JSON.stringify(text)}, ${ended}) is ${want}`, () => {
    assert.equal(passVerdict(text, ended), want);
  });
}

// ---------- still speaking ----------

test("buildInput marks an unfinished last THEM line with (still speaking)", () => {
  const s = buildInput(
    [
      { speaker: "them", text: "Eerste punt.", partial: true },
      { speaker: "me", text: "Ja?" },
      { speaker: "them", text: "Dat vind ik best", partial: true },
    ],
    "auto",
    { stillSpeaking: true },
  );
  assert.ok(s.includes("THEM: Dat vind ik best (still speaking)"), s);
  assert.ok(s.includes("THEM: Eerste punt.\n"), "only the last THEM line is marked");
});

test("buildInput only marks (still speaking) for a draft request", () => {
  const lines = [{ speaker: "them" as const, text: "Dat vind ik best", partial: true }];
  assert.ok(!buildInput(lines, "auto").includes("(still speaking)"), "a normal auto request");
  assert.ok(!buildInput(lines, "hotkey").includes("(still speaking)"), "a hotkey request");
  assert.ok(buildInput(lines, "auto", { stillSpeaking: true }).includes("(still speaking)"), "a draft request");
});

test("buildInput does not mark a finished THEM line or an unfinished ME line", () => {
  const s = buildInput(
    [
      { speaker: "them", text: "Dat vind ik te duur." },
      { speaker: "me", text: "Waarmee vergelijk je", partial: true },
    ],
    "auto",
    { stillSpeaking: true },
  );
  assert.ok(!s.includes("(still speaking)"), s);
});

test("buildInstructions explains (still speaking): anticipate and keep it short", () => {
  const s = buildInstructions(EMPTY_PROFILE, "", "en");
  assert.ok(s.includes("(still speaking) is not finished yet"));
  assert.ok(s.includes("anticipate where the sentence is going"));
  assert.ok(s.includes("extra short"));
});

// ---------- kind of call ----------

test("buildInstructions without a call type is a sales call with the sales playbook", () => {
  const s = buildInstructions(EMPTY_PROFILE, "", "en");
  assert.equal(s, buildInstructions(EMPTY_PROFILE, "", "en", "sales"));
  assert.ok(s.includes("the seller, labelled ME"));
  assert.ok(s.includes("# Sales playbook for a live call coach"));
  assert.ok(!s.includes("# Job interview playbook"));
  assert.ok(s.includes("an objection, a buying signal"));
});

test("buildInstructions for a job interview: candidate and interviewer, interview playbook, structure hints", () => {
  const s = buildInstructions(EMPTY_PROFILE, "Vacature: AI-specialist, 32 uur.", "nl", "interview");
  assert.ok(s.includes("the candidate, labelled ME"), s);
  assert.ok(s.includes("during a Dutch job interview"));
  assert.ok(s.includes("the interviewer, labelled THEM"));
  assert.ok(s.includes("# Job interview playbook"));
  assert.ok(!s.includes("# Sales playbook"));
  assert.ok(!s.includes("seller"));
  assert.ok(s.includes("Every real interview question deserves a short structure hint"));
  assert.ok(s.includes(`Smalltalk, introductions and THEM explaining the company or the role get ${PASS}`));
  assert.ok(s.includes("## Brief for this call (the vacancy and the user's key points)\nVacature: AI-specialist, 32 uur."));
  assert.ok(s.includes("This profile was written for sales calls"));
});

test("buildInstructions for a meeting: participant, meeting playbook, decisions and owners", () => {
  const s = buildInstructions(EMPTY_PROFILE, "", "en", "meeting");
  assert.ok(s.includes("a participant, labelled ME"));
  assert.ok(s.includes("during an English meeting."), s.slice(0, 300));
  assert.ok(s.includes("# Meeting playbook"));
  assert.ok(!s.includes("# Sales playbook"));
  assert.ok(s.includes("a decision, an owner and a date"));
  assert.ok(s.includes("## Brief for this call (agenda and goals)\n(none)"));
});

test("every call type keeps the shared rules: format, AUTO PASS, HOTKEY, still speaking, no inventing", () => {
  for (const type of ["sales", "interview", "meeting"] as const) {
    const s = buildInstructions(EMPTY_PROFILE, "", "en", type);
    assert.ok(s.includes("## Output format (strict)"), type);
    assert.ok(s.includes(`answer exactly ${PASS} and nothing else`), type);
    assert.ok(s.includes("For a HOTKEY request always give a tip, never PASS."), type);
    assert.ok(s.includes("(still speaking) is not finished yet"), type);
    assert.match(s, /Only use facts/, type);
    assert.match(s, /## 7\. Things to never do|## 6\. Things to never do/, type);
    assert.doesNotMatch(s, /[\u2013\u2014]/, `${type}: no em or en dash`);
  }
});

test("playbookFor gives each call type its own playbook", () => {
  assert.ok(playbookFor("sales").startsWith("# Sales playbook"));
  assert.ok(playbookFor("interview").startsWith("# Job interview playbook"));
  assert.ok(playbookFor("meeting").startsWith("# Meeting playbook"));
  assert.match(playbookFor("interview"), /range first/);
  assert.match(playbookFor("interview"), /STAR/);
  assert.match(playbookFor("meeting"), /owner/);
});
