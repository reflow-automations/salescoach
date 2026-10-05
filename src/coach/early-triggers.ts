// Early-trigger words: a start signal, never a verdict.
// When one of these shows up in what THEM is still saying, the coach asks the brain for a tip
// right away instead of waiting for a pause. The brain still decides (PASS or a tip), so a false
// start only costs one extra request and nothing is shown. Text from these lists never reaches
// the overlay: only the category key is passed on, as a short label for the tip history.
// English and Dutch are always both checked, because calls mix them ("de pricing", "budget").
// Each call type has its own categories: a sales call listens for objections, a job interview
// for the questions an interviewer asks, a meeting for decisions, owners and dates.
// Words that turn up in almost any sentence ("kost", "why", "wie", "planning") are only listed as
// a specific phrase ("wat kost", "why do you want", "wie pakt"), so ordinary talk does not fire.
// No Electron or DOM imports, so it can be unit tested.
import type { CallType, TipLabel } from "../shared/types";

type Phrases = Partial<Record<Exclude<TipLabel, "question">, string[]>>;

/** Phrases per category, lowercase. A phrase matches whole words only ("duur" not in "duurt"). */
const SALES: Phrases = {
  price: [
    "price", "prices", "pricing", "expensive", "costs", "cost", "too much money", "costs too much", "a lot of money", "cheaper", "discount",
    "prijs", "prijzen", "duur", "dure", "wat kost", "hoeveel kost", "kosten", "te veel geld", "kost te veel", "veel geld", "goedkoper", "korting",
  ],
  budget: ["budget", "budgets", "afford", "money for", "budgetten", "geld voor"],
  timing: [
    "maybe later", "later this year", "not now", "not right now", "next year", "next quarter", "bad timing", "not the right time",
    "misschien later", "later terug", "later dit jaar", "nu niet", "niet nu", "volgend jaar", "volgend kwartaal", "na de zomer",
    "nu geen tijd", "geen tijd voor", "even niet",
  ],
  think: ["think about it", "think it over", "sleep on it", "over nadenken", "erover nadenken", "even nadenken", "nog nadenken", "bedenken", "laten bezinken"],
  info: [
    "send info", "send me info", "send some info", "send me some", "send information", "send me something", "email me", "brochure",
    "stuur info", "stuur me info", "stuur maar", "informatie sturen", "info sturen", "mail me", "mail maar", "toesturen",
  ],
  decision: [
    "discuss", "check with", "my partner", "my boss", "the board", "my colleague", "not my decision", "decide together",
    "overleggen", "even bespreken", "intern bespreken", "eerst bespreken", "mijn compagnon", "mijn partner", "mijn baas", "de directie",
    "samen beslissen", "voorleggen",
  ],
  covered: [
    "already have", "already use", "already work with", "we do it ourselves", "do it ourselves", "in house", "in-house",
    "hebben al een", "heb al een", "hebben we al", "doen we zelf", "zelf doen", "doen het zelf", "werken al met", "gebruiken al",
  ],
  experience: [
    "bad experience", "bad experiences", "burned before", "got burned", "disappointed", "did not work last time",
    "slechte ervaring", "slechte ervaringen", "teleurgesteld", "eerder misgegaan", "niet goed bevallen",
  ],
  doubt: [
    "does it work", "does that work", "will it work", "would that work", "proof", "guarantee", "not sure if", "not sure whether", "not convinced",
    "werkt dat ook", "werkt dat echt", "werkt het ook", "werkt het echt", "of dat werkt", "of het werkt", "bewijs", "garantie", "weet niet of", "twijfel",
  ],
  privacy: ["privacy", "gdpr", "avg", "data protection", "security", "beveiliging"],
  speed: [
    "how soon", "how fast", "how quickly", "how long does", "how long will", "how long until", "when can", "deadline",
    "hoe snel", "hoe lang duurt", "hoe lang voordat", "hoe vlot", "wanneer kan", "wanneer kunnen",
  ],
  contract: [
    "contract", "notice period", "cancel", "commitment", "lock in", "locked in",
    "opzeggen", "opzegtermijn", "looptijd", "vastzitten", "voorwaarden",
  ],
};

/** Job interview: the user is the candidate, THEM is the interviewer. */
const INTERVIEW: Phrases = {
  salary: [
    "salary", "salaries", "salary expectations", "compensation", "pay range", "pay scale", "wage", "benefits", "bonus", "lease car", "gross",
    "salaris", "salarisverwachting", "salarisindicatie", "salariswens", "loon", "verdienen", "wat verdien je", "bruto", "arbeidsvoorwaarden",
    "secundaire", "leaseauto", "inschaling", "salarisschaal", "welke schaal",
  ],
  hours: [
    "how many hours", "hours a week", "hours per week", "full time", "part time", "days a week", "office days", "in the office", "remote",
    "work from home", "hybrid",
    "hoeveel uren", "uren per week", "aantal uren", "hoeveel uur", "uur per week", "uur in de week", "fulltime", "parttime", "dagen per week",
    "kantoordagen", "op kantoor",
    "thuiswerken", "thuis werken", "hybride", "werkweek",
  ],
  motivation: [
    "why do you want", "why this", "why us", "why did you apply", "why are you leaving", "why would you", "motivation", "motivated",
    "what attracts you", "appeals to you", "what drew you",
    "waarom", "motivatie", "gemotiveerd", "spreekt je aan", "trekt je aan",
  ],
  weakness: [
    "weakness", "weaknesses", "weak point", "weak points", "pitfall", "pitfalls", "development point", "gap in your", "not good at",
    "zwakte", "zwaktes", "zwakke punt", "zwakke punten", "valkuil", "valkuilen", "verbeterpunt", "verbeterpunten", "ontwikkelpunt",
    "ontwikkelpunten", "gat in je cv", "minder goed in",
  ],
  background: [
    "your experience", "experience with", "experience in", "work experience", "your background", "worked with", "track record", "previous job",
    "last job", "previous role", "current role", "current job",
    "ervaring met", "ervaring heb je", "ervaring in", "werkervaring", "ervaringen met", "achtergrond", "vorige baan", "huidige baan",
    "vorige werkgever", "huidige werkgever", "huidige rol", "gewerkt met",
  ],
  example: [
    "example", "examples", "for instance", "a time when", "a time you", "situation where", "situation in which",
    "voorbeeld", "voorbeelden", "een keer dat", "een situatie", "situatie waarin", "situatie waar",
  ],
  ownQuestions: [
    "questions for us", "questions for me", "any questions", "do you have questions", "anything you want to ask", "want to ask us",
    "vragen voor ons", "vragen voor mij", "nog vragen", "vragen aan ons", "nog iets vragen", "iets willen vragen",
  ],
  // From the sales lists, because they come up in an interview too: the notice period, the start date.
  contract: SALES.contract,
  speed: SALES.speed,
};

/** A general meeting: the user is one of the participants. */
const MEETING: Phrases = {
  decide: [
    "decide", "decision", "decisions", "agree on", "agreed", "go ahead", "sign off", "approve", "vote",
    "besluit", "besluiten", "beslissen", "beslissing", "afspreken", "akkoord", "knoop doorhakken", "goedkeuren", "goedkeuring",
  ],
  deadline: [
    "deadline", "deadlines", "due date", "due by", "is due", "by when", "timeline", "end of the month",
    "uiterlijk", "voor wanneer", "wanneer klaar", "opleverdatum", "de planning halen", "achter op de planning", "einde van de maand",
  ],
  owner: [
    "who will", "who takes", "who picks", "who is going to", "who owns", "owner", "responsible", "pick this up", "pick that up",
    "take this on", "take that on",
    "wie pakt", "wie doet", "wie neemt", "wie gaat", "eigenaar", "verantwoordelijk", "oppakken", "trekker",
  ],
  budget: [...(SALES.budget ?? []), "cost", "costs", "kosten", "wat kost", "hoeveel kost"],
  risk: [
    "risk", "risks", "risky", "concern", "concerns", "worried", "is a problem", "the problem is", "is an issue", "the issue is", "what if",
    "risico", "risico's", "riskant", "zorgen over", "zorgen om", "bezorgd", "wordt een probleem", "is een probleem", "het probleem is",
    "wat als",
  ],
  timing: SALES.timing,
};

const TRIGGERS: Record<CallType, Phrases> = { sales: SALES, interview: INTERVIEW, meeting: MEETING };

/** Order of the label when one line hits several categories: the most specific one first, "question" last. */
export const LABEL_ORDER: readonly TipLabel[] = [
  // sales
  "price",
  "budget",
  "contract",
  "covered",
  "experience",
  "decision",
  "timing",
  "think",
  "info",
  "privacy",
  "speed",
  "doubt",
  // job interview
  "salary",
  "hours",
  "weakness",
  "ownQuestions",
  "motivation",
  "example",
  "background",
  // meeting
  "decide",
  "owner",
  "deadline",
  "risk",
  "question",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One regex per category; "in house" also matches "in-house" and line breaks between words. */
function patterns(phrases: Phrases): (readonly [TipLabel, RegExp])[] {
  return Object.entries(phrases).map(([category, list]) => {
    const alternatives = (list ?? []).map((p) => escape(p).replace(/(?:\\-| )+/g, "[\\s-]+"));
    return [category as TipLabel, new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "iu")] as const;
  });
}

const PATTERNS: Record<CallType, (readonly [TipLabel, RegExp])[]> = {
  sales: patterns(TRIGGERS.sales),
  interview: patterns(TRIGGERS.interview),
  meeting: patterns(TRIGGERS.meeting),
};

/** The categories a call type can produce, besides "question" (which every type has). */
export function categoriesFor(callType: CallType): TipLabel[] {
  return (PATTERNS[callType] ?? PATTERNS.sales).map(([c]) => c);
}

/**
 * Every category of this call type whose words appear in the text, plus "question" when it
 * contains a question mark. Without a call type: a sales call.
 */
export function triggerCategories(text: string, callType: CallType = "sales"): Set<TipLabel> {
  const found = new Set<TipLabel>();
  if (!text.trim()) return found;
  // Typographic apostrophes are normalised so "don’t" and "don't" behave the same.
  const t = text.replace(/[’‘]/g, "'");
  for (const [category, re] of PATTERNS[callType] ?? PATTERNS.sales) if (re.test(t)) found.add(category);
  if (t.includes("?")) found.add("question");
  return found;
}

/** The one label to show for a set of categories, or undefined when there is none. */
export function primaryLabel(categories: Iterable<TipLabel>): TipLabel | undefined {
  const set = new Set(categories);
  return LABEL_ORDER.find((c) => set.has(c));
}
