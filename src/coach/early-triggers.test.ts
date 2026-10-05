import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL_ORDER, categoriesFor, primaryLabel, triggerCategories } from "./early-triggers";
import { MESSAGES } from "../shared/i18n";

const cats = (text: string) => [...triggerCategories(text)].sort();

for (const [text, expected] of [
  ["Honestly, that is quite expensive", ["price"]],
  ["Dat vind ik eerlijk gezegd te duur", ["price"]],
  ["Wat kost dat per maand", ["price"]],
  ["We don't have the budget this year", ["budget"]],
  ["Nu niet, misschien na de zomer", ["timing"]],
  ["Let me think about it", ["think"]],
  ["Ik moet er nog even over nadenken", ["think"]],
  ["Can you just send me some info", ["info"]],
  ["Stuur maar wat informatie", ["info"]],
  ["I need to discuss it with my partner", ["decision"]],
  ["Dat moet ik even overleggen", ["decision"]],
  ["We already have someone for that", ["covered"]],
  ["Dat doen we zelf, in-house", ["covered"]],
  ["We had a bad experience with an agency", ["experience"]],
  ["Slechte ervaring mee gehad eerlijk gezegd", ["experience"]],
  ["Werkt dat ook voor ons", ["doubt"]],
  ["Is het wel AVG-veilig", ["privacy"]],
  ["What about GDPR", ["privacy"]],
  ["How soon can you start", ["speed"]],
  ["Hoe snel kan het live", ["speed"]],
  ["Wat is de opzegtermijn", ["contract"]],
] as [string, string[]][]) {
  test(`triggers: "${text}" is ${expected.join(", ")}`, () => {
    assert.deepEqual(cats(text), expected);
  });
}

test("triggers match whole words only", () => {
  assert.deepEqual(cats("Het duurt even voordat het klaar is"), []); // "duur" is not in "duurt"
  assert.deepEqual(cats("Wij zijn een kostenbewust bedrijf"), []); // "kost" is not in "kostenbewust"
  assert.deepEqual(cats("Pricey, but fine"), []);
});

test("a question mark is the category question", () => {
  assert.deepEqual(cats("Hoe gaat het met jullie team?"), ["question"]);
  assert.deepEqual(cats("Is it expensive?"), ["price", "question"]);
});

test("smalltalk and empty text give no categories", () => {
  assert.deepEqual(cats("Leuk dat het gelukt is om af te spreken"), []);
  assert.deepEqual(cats("   "), []);
});

test("phrases also match across a line break and with a typographic apostrophe", () => {
  assert.deepEqual(cats("We do it\nourselves"), ["covered"]);
  assert.deepEqual(cats("Not right now, we don’t"), ["timing"]);
});

test("primaryLabel picks the most specific objection, and question last", () => {
  assert.equal(primaryLabel(triggerCategories("Is that expensive?")), "price");
  assert.equal(primaryLabel(triggerCategories("How soon, and what about the contract?")), "contract");
  assert.equal(primaryLabel(triggerCategories("Hoe gaat het?")), "question");
  assert.equal(primaryLabel(triggerCategories("Mooi weer vandaag")), undefined);
});

test("every label has a text in English and Dutch", () => {
  for (const label of LABEL_ORDER) {
    const key = `tipLabel.${label}` as keyof typeof MESSAGES.en;
    assert.ok(MESSAGES.en[key], `en ${key}`);
    assert.ok(MESSAGES.nl[key], `nl ${key}`);
  }
});

// ---------- per call type ----------

const catsFor = (text: string, type: "sales" | "interview" | "meeting") => [...triggerCategories(text, type)].sort();

for (const [text, expected] of [
  ["What are your salary expectations", ["salary"]],
  ["Wat is je salarisverwachting eigenlijk", ["salary"]],
  ["How many hours a week are you looking for", ["hours"]],
  ["Hoeveel uur wil je werken, en hoeveel kantoordagen", ["hours"]],
  ["So why do you want to work here", ["motivation"]],
  ["Waarom deze rol", ["motivation"]],
  ["What would you say is your biggest weakness", ["weakness"]],
  ["Wat is je grootste valkuil", ["weakness"]],
  ["Tell me about your experience with automation", ["background"]],
  ["Wat voor ervaring heb je met n8n", ["background"]],
  ["Can you give me an example of that", ["example"]],
  ["Geef eens een voorbeeld", ["example"]],
  ["Do you have any questions for us", ["ownQuestions"]],
  ["Heb jij nog vragen voor ons", ["ownQuestions"]],
  ["What is your notice period", ["contract"]],
] as [string, string[]][]) {
  test(`interview triggers: "${text}" is ${expected.join(", ")}`, () => {
    assert.deepEqual(catsFor(text, "interview"), expected);
  });
}

for (const [text, expected] of [
  ["So what do we decide on this", ["decide"]],
  ["Dan moeten we nu een besluit nemen", ["decide"]],
  ["What is the deadline for the report", ["deadline"]],
  ["Uiterlijk vrijdag moet het af zijn", ["deadline"]],
  ["Who picks this up", ["owner"]],
  ["Wie pakt dit op", ["owner"]],
  ["Is there budget for that", ["budget"]],
  ["Wat kost dat ons", ["budget"]],
  ["The risk is that the supplier is late", ["risk"]],
  ["Ik zie wel een risico bij de planning", ["risk"]],
  ["Halen we de planning nog wel", []],
] as [string, string[]][]) {
  test(`meeting triggers: "${text}" is ${expected.join(", ")}`, () => {
    assert.deepEqual(catsFor(text, "meeting"), expected);
  });
}

test("each call type only listens for its own categories", () => {
  // Sales objections are no interview or meeting categories, and the other way round.
  assert.deepEqual(catsFor("Dat vind ik te duur", "interview"), []);
  assert.deepEqual(catsFor("Wat is je salarisverwachting", "sales"), []);
  assert.deepEqual(catsFor("Wie pakt dit op", "sales"), []);
  assert.deepEqual(catsFor("Tell me about your experience with that", "interview"), ["background"]);
  assert.deepEqual(catsFor("We had a bad experience", "sales"), ["experience"]);
  // Without a call type it is a sales call.
  assert.deepEqual([...triggerCategories("Wat is je salarisverwachting")], []);
});

test("every call type knows the question mark, and smalltalk stays empty", () => {
  for (const type of ["sales", "interview", "meeting"] as const) {
    assert.deepEqual(catsFor("Hoe gaat het met je?", type), ["question"]);
    assert.deepEqual(catsFor("Leuk dat het gelukt is om af te spreken", type), []);
  }
});

test("primaryLabel prefers the specific interview or meeting category over question", () => {
  assert.equal(primaryLabel(triggerCategories("Wat is je salarisverwachting?", "interview")), "salary");
  assert.equal(primaryLabel(triggerCategories("Do you have any questions for us?", "interview")), "ownQuestions");
  assert.equal(primaryLabel(triggerCategories("Wie pakt dit op en wanneer is de deadline?", "meeting")), "owner");
});

test("every category of every call type is in LABEL_ORDER", () => {
  for (const type of ["sales", "interview", "meeting"] as const) {
    for (const c of categoriesFor(type)) assert.ok(LABEL_ORDER.includes(c), `${type}: ${c}`);
  }
});

// ---------- ordinary sentences are no start signal ----------

for (const [text, type] of [
  ["dat kost tijd", "sales"],
  ["dat kost tijd", "meeting"],
  ["ik heb al gekeken naar jullie site", "sales"],
  ["we hebben al eerder gesproken", "sales"],
  ["daar kom ik later op", "sales"],
  ["dat gaan we volgende week bespreken", "sales"],
  ["we moeten nadenken over de opzet", "sales"],
  ["het werkt het best als je belt", "sales"],
  ["dat is te veel werk voor nu", "sales"],
  ["hoe lang ben je er al", "sales"],
  ["I'm not sure, let me check", "sales"],
  ["we hadden geen tijd om te lunchen", "sales"],
  ["that's why we started", "interview"],
  ["I will pay for the coffee", "interview"],
  ["the package arrived today", "interview"],
  ["office hours are nine to five", "interview"],
  ["we zitten in een kleine schaal", "interview"],
  ["dat verdient een compliment", "interview"],
  ["met wat ervaring kom je er wel", "interview"],
  ["experience shows it works", "interview"],
  ["geen probleem", "meeting"],
  ["due to the rain we start later", "meeting"],
  ["ervoor zorgen dat iedereen het weet", "meeting"],
  ["wie had dat gedacht", "meeting"],
  ["who knows", "meeting"],
  ["no issue at all", "meeting"],
  ["de planning hangt op de muur", "meeting"],
  ["tot volgende week", "meeting"],
  ["het geld is binnen", "meeting"],
] as [string, "sales" | "interview" | "meeting"][]) {
  test(`no trigger in ordinary talk (${type}): "${text}"`, () => {
    assert.deepEqual(catsFor(text, type), []);
  });
}

for (const [text, type, expected] of [
  ["Wat kost het eigenlijk", "sales", ["price"]],
  ["Dat kost te veel", "sales", ["price"]],
  ["We hebben al een bureau", "sales", ["covered"]],
  ["Misschien later dit jaar", "sales", ["timing"]],
  ["Dat moet ik even bespreken", "sales", ["decision"]],
  ["Hoe lang duurt het voordat het werkt", "sales", ["speed"]],
  ["I'm not sure if this fits", "sales", ["doubt"]],
  ["Why do you want this job", "interview", ["motivation"]],
  ["What is your pay range", "interview", ["salary"]],
  ["Hoeveel uren wil je werken", "interview", ["hours"]],
  ["Wie pakt dit op", "meeting", ["owner"]],
  ["Daar maak ik me zorgen over", "meeting", ["risk"]],
  ["The report is due by Friday", "meeting", ["deadline"]],
] as [string, "sales" | "interview" | "meeting", string[]][]) {
  test(`specific phrases still trigger (${type}): "${text}" is ${expected.join(", ")}`, () => {
    assert.deepEqual(catsFor(text, type), expected);
  });
}
