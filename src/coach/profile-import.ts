// "Let your own AI write your profile": a prompt the user pastes into ChatGPT or
// Claude (which already know them through memory), and a parser for the answer.
import { EMPTY_PROFILE, type Profile } from "../shared/types";

export const START_MARK = "=== SALESCOACH PROFILE START ===";
export const END_MARK = "=== SALESCOACH PROFILE END ===";

/** Machine-readable section keys used in the pasted answer. */
const KEYS: Record<string, keyof Profile> = {
  WHO_AM_I: "whoAmI",
  OFFER: "offer",
  PRICING: "pricing",
  IDEAL_CUSTOMER: "idealCustomer",
  CASES: "cases",
  OBJECTIONS: "objections",
  RULES: "rules",
  TONE: "tone",
};

const SECTIONS_NL = `## WHO_AM_I
Wie ik ben, mijn bedrijf, mijn achtergrond en wat ik goed kan.
## OFFER
Wat ik verkoop: diensten of producten, wat de klant krijgt, hoe lang het duurt.
## PRICING
Mijn prijzen en voorwaarden. Alleen wat je zeker weet; anders "onbekend".
## IDEAL_CUSTOMER
Mijn ideale klant: branche, grootte, rol van de beslisser, typische pijnpunten.
## CASES
Resultaten en voorbeelden die ik mag noemen, met cijfers als die er zijn. Geen namen van klanten tenzij ik dat zeg.
## OBJECTIONS
Bezwaren die ik vaak hoor en hoe ik ze graag beantwoord.
## RULES
Dingen die ik nooit wil zeggen of beloven in een gesprek.
## TONE
Hoe ik praat: formeel of informeel, tutoyeren of niet, direct of voorzichtig.`;

const SECTIONS_EN = `## WHO_AM_I
Who I am, my company, my background and what I am good at.
## OFFER
What I sell: services or products, what the customer gets, how long it takes.
## PRICING
My prices and terms. Only what you know for sure; otherwise "unknown".
## IDEAL_CUSTOMER
My ideal customer: industry, size, role of the decision maker, typical pains.
## CASES
Results and examples I may mention, with numbers where available. No customer names unless I say so.
## OBJECTIONS
Objections I often hear and how I like to answer them.
## RULES
Things I never want to say or promise in a call.
## TONE
How I talk: formal or informal, direct or careful.`;

export function profilePrompt(language: string): string {
  if (language.toLowerCase().startsWith("nl")) {
    return `Ik gebruik een AI-salescoach die meeluistert in mijn verkoopgesprekken. Die coach moet mij goed kennen. Help me mijn profiel te vullen.

1. Gebruik alles wat je al over mij weet uit je geheugen en onze eerdere gesprekken.
2. Ontbreekt er belangrijke informatie, stel me dan eerst maximaal 5 korte vragen, en wacht op mijn antwoorden.
3. Geef daarna het profiel in precies dit formaat, tussen de twee markeringen, met precies deze kopjes. Schrijf onder elk kopje in de ik-vorm, kort en concreet, in bullets mag. Verzin niets: weet je iets niet, schrijf dan "onbekend".

${START_MARK}
${SECTIONS_NL}
${END_MARK}`;
  }
  return `I use an AI sales coach that listens to my sales calls. The coach needs to know me well. Help me fill in my profile.

1. Use everything you already know about me from your memory and our earlier chats.
2. If important information is missing, first ask me at most 5 short questions and wait for my answers.
3. Then give the profile in exactly this format, between the two markers, with exactly these headings. Write in the first person, short and concrete, bullets are fine. Do not invent anything: if you do not know, write "unknown".

${START_MARK}
${SECTIONS_EN}
${END_MARK}`;
}

export interface ImportResult {
  profile: Profile;
  filled: (keyof Profile)[];
  missing: (keyof Profile)[];
  /** Every heading still held the prompt's own description: the prompt was pasted, not the answer. */
  promptOnly: boolean;
}

// A single "onbekend", optionally as one bullet ("- onbekend"), means the field is empty.
const UNKNOWN = /^(?:[-*•]\s*)?(onbekend|unknown|n\.?v\.?t\.?|-)\.?$/i;

const normalize = (body: string) => body.replace(/^[-*•]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The description line under each heading of the prompt, in both languages (the language may change in between). */
const TEMPLATE_BODIES = new Set(
  [SECTIONS_NL, SECTIONS_EN].flatMap((sections) => [...sections.matchAll(/^## [A-Z_]+\n(.+)$/gm)].map((m) => normalize(m[1]))),
);

interface Parsed {
  profile: Profile;
  headings: number;
  templates: number;
}

function parseSections(text: string): Parsed {
  const profile: Profile = { ...EMPTY_PROFILE };
  // "## OFFER", "## **OFFER**", "**## OFFER**", "## **OFFER:**", "## OFFER:" and a bare
  // "OFFER" line (a copied rendered answer loses its "##") all count.
  const re = /^[ \t]*\**[ \t]*(?:#{1,4}[ \t]*)?\**[ \t]*([A-Z_]+)[ \t]*:?[ \t]*\**[ \t]*:?[ \t]*$/gm;
  const hits: { key: keyof Profile; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const key = KEYS[m[1].toUpperCase()];
    if (key) hits.push({ key, start: m.index, end: m.index + m[0].length });
  }
  let templates = 0;
  hits.forEach((h, i) => {
    const body = text.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : undefined).trim();
    if (TEMPLATE_BODIES.has(normalize(body))) templates++;
    else if (body && !UNKNOWN.test(body)) profile[h.key] = body;
  });
  return { profile, headings: hits.length, templates };
}

/** Parses the answer pasted back from ChatGPT/Claude. Tolerant of missing markers and bold headings. */
export function parseProfile(pasted: string): ImportResult {
  const text = pasted.replace(/\r\n/g, "\n");
  // A copied conversation also holds the prompt with its own markers and template, and a
  // model may name the markers in a sentence. So: the last marker block that has content.
  const blocks: Parsed[] = [];
  for (let s = text.indexOf(START_MARK); s !== -1; s = text.indexOf(START_MARK, s + 1)) {
    const from = s + START_MARK.length;
    const e = text.indexOf(END_MARK, from);
    blocks.push(parseSections(text.slice(from, e === -1 ? undefined : e)));
  }
  const chosen =
    blocks.findLast((b) => Object.values(b.profile).some(Boolean)) ??
    blocks.findLast((b) => b.headings > b.templates) ?? // an answer that only says "onbekend"
    blocks.findLast((b) => b.headings > 0) ?? // only the prompt
    parseSections(text);

  const all = Object.keys(EMPTY_PROFILE) as (keyof Profile)[];
  const filled = all.filter((k) => chosen.profile[k]);
  const promptOnly = chosen.headings > 0 && chosen.templates === chosen.headings;
  return { profile: chosen.profile, filled, missing: all.filter((k) => !chosen.profile[k]), promptOnly };
}
