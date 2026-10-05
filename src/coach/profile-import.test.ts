import { test } from "node:test";
import assert from "node:assert/strict";
import { END_MARK, START_MARK, parseProfile, profilePrompt } from "./profile-import";

const BODY = `## WHO_AM_I
Ik ben Rogier, eigenaar van een klein automatiseringsbureau.
## OFFER
- Maatwerk automatiseringen
- AI-telefoonassistent
## PRICING
Vanaf 425 euro per maand.
## IDEAL_CUSTOMER
MKB dienstverleners met 5 tot 50 medewerkers.
## CASES
onbekend
## OBJECTIONS
"Te duur": eerst vragen wat het probleem nu kost.
## RULES
Nooit prijzen van andere klanten noemen.
## TONE
Informeel, tutoyeren, direct.`;

test("parses all sections between the markers and ignores text outside them", () => {
  const pasted = `Natuurlijk! Hier is je profiel:

${START_MARK}
${BODY}
${END_MARK}

## OFFER
Dit staat buiten de markeringen en moet genegeerd worden.
Laat me weten als je iets wilt aanpassen.`;
  const r = parseProfile(pasted);
  assert.equal(r.profile.whoAmI, "Ik ben Rogier, eigenaar van een klein automatiseringsbureau.");
  assert.equal(r.profile.offer, "- Maatwerk automatiseringen\n- AI-telefoonassistent");
  assert.equal(r.profile.pricing, "Vanaf 425 euro per maand.");
  assert.equal(r.profile.idealCustomer, "MKB dienstverleners met 5 tot 50 medewerkers.");
  assert.equal(r.profile.objections, '"Te duur": eerst vragen wat het probleem nu kost.');
  assert.equal(r.profile.rules, "Nooit prijzen van andere klanten noemen.");
  assert.equal(r.profile.tone, "Informeel, tutoyeren, direct.");
  assert.equal(r.profile.cases, "");
  assert.deepEqual(r.missing, ["cases"]);
  assert.equal(r.filled.length, 7);
  assert.ok(!r.profile.offer.includes("buiten de markeringen"));
});

test("text before the start marker is ignored even if it has headings", () => {
  const pasted = `## PRICING
Oude prijs die niet mee mag.

${START_MARK}
## PRICING
Nieuwe prijs.
${END_MARK}`;
  const r = parseProfile(pasted);
  assert.equal(r.profile.pricing, "Nieuwe prijs.");
});

test("parses without markers", () => {
  const r = parseProfile(BODY);
  assert.equal(r.profile.pricing, "Vanaf 425 euro per maand.");
  assert.equal(r.profile.tone, "Informeel, tutoyeren, direct.");
  assert.equal(r.filled.length, 7);
});

test("accepts a heading with a trailing colon (## OFFER:)", () => {
  const r = parseProfile("## OFFER:\nAutomatiseringen.\n## PRICING:\n100 euro.");
  assert.equal(r.profile.offer, "Automatiseringen.");
  assert.equal(r.profile.pricing, "100 euro.");
});

test("accepts bold inside the heading (## **OFFER** and ### **PRICING**:)", () => {
  const r = parseProfile("## **OFFER**\nAutomatiseringen.\n### **PRICING**:\n100 euro.");
  assert.equal(r.profile.offer, "Automatiseringen.");
  assert.equal(r.profile.pricing, "100 euro.");
});

test(
  "accepts bold around the whole heading (**## OFFER**)",
  () => {
    const r = parseProfile("**## OFFER**\nAutomatiseringen.\n**## PRICING**\n100 euro.");
    assert.equal(r.profile.offer, "Automatiseringen.");
    assert.equal(r.profile.pricing, "100 euro.");
  },
);

test(
  "accepts a colon inside bold (## **OFFER:**)",
  () => {
    const r = parseProfile("## **OFFER:**\nAutomatiseringen.");
    assert.equal(r.profile.offer, "Automatiseringen.");
  },
);

test("counts onbekend and unknown (any case, optional dot) as missing", () => {
  const r = parseProfile(`## WHO_AM_I
Rogier.
## OFFER
onbekend
## PRICING
Onbekend.
## IDEAL_CUSTOMER
unknown
## CASES
UNKNOWN.
## OBJECTIONS
n.v.t.
## RULES
-
## TONE
Direct.`);
  assert.deepEqual(r.filled, ["whoAmI", "tone"]);
  assert.deepEqual(r.missing, ["offer", "pricing", "idealCustomer", "cases", "objections", "rules"]);
  assert.equal(r.profile.offer, "");
  assert.equal(r.profile.pricing, "");
});

test(
  "counts a bulleted '- onbekend' as missing",
  () => {
    const r = parseProfile("## PRICING\n- onbekend\n## TONE\nDirect.");
    assert.equal(r.profile.pricing, "");
    assert.ok(r.missing.includes("pricing"));
  },
);

test("handles Windows line endings", () => {
  const pasted = `intro\r\n${START_MARK}\r\n${BODY.replace(/\n/g, "\r\n")}\r\n${END_MARK}\r\nslot`;
  const r = parseProfile(pasted);
  assert.equal(r.profile.offer, "- Maatwerk automatiseringen\n- AI-telefoonassistent");
  assert.equal(r.profile.tone, "Informeel, tutoyeren, direct.");
  for (const k of r.filled) assert.ok(!r.profile[k].includes("\r"), `field ${k} still contains \\r`);
  assert.deepEqual(r.missing, ["cases"]);
});

test("empty or unrelated text gives an empty profile with everything missing", () => {
  const r = parseProfile("Sorry, ik weet niets over je.");
  assert.deepEqual(r.filled, []);
  assert.equal(r.missing.length, 8);
  assert.ok(Object.values(r.profile).every((v) => v === ""));
});

test("returns a fresh profile object (does not mutate EMPTY_PROFILE)", () => {
  const a = parseProfile("## TONE\nDirect.");
  const b = parseProfile("## OFFER\nIets.");
  assert.equal(a.profile.tone, "Direct.");
  assert.equal(b.profile.tone, "");
});

for (const lang of ["nl", "en", "nl-NL", "en-GB"]) {
  test(`profilePrompt(${lang}) contains both markers and all section keys`, () => {
    const p = profilePrompt(lang);
    assert.ok(p.includes(START_MARK));
    assert.ok(p.includes(END_MARK));
    assert.ok(p.indexOf(START_MARK) < p.indexOf(END_MARK));
    for (const key of ["WHO_AM_I", "OFFER", "PRICING", "IDEAL_CUSTOMER", "CASES", "OBJECTIONS", "RULES", "TONE"]) {
      assert.ok(p.includes(`## ${key}`), `missing ## ${key}`);
    }
    assert.ok(!/[\u2013\u2014]/.test(p), "prompt contains an em or en dash");
  });
}

test("profilePrompt picks the language", () => {
  assert.ok(profilePrompt("nl").includes("onbekend"));
  assert.ok(profilePrompt("en").includes("unknown"));
});

for (const lang of ["nl", "en"]) {
  test(`pasting only the prompt (${lang}) imports nothing and says so`, () => {
    const r = parseProfile(profilePrompt(lang));
    assert.deepEqual(r.filled, []);
    assert.equal(r.promptOnly, true);
    assert.ok(Object.values(r.profile).every((v) => v === ""));
  });
}

test("a copied conversation with the prompt and then the answer imports the answer", () => {
  const pasted = `Jij:\n${profilePrompt("nl")}\n\nChatGPT:\nHier is je profiel.\n\n${START_MARK}\n${BODY}\n${END_MARK}\n\nSucces!`;
  const r = parseProfile(pasted);
  assert.equal(r.profile.pricing, "Vanaf 425 euro per maand.");
  assert.equal(r.profile.whoAmI, "Ik ben Rogier, eigenaar van een klein automatiseringsbureau.");
  assert.equal(r.filled.length, 7);
  assert.equal(r.promptOnly, false);
});

test("the prompt in the other language than the answer is still recognised as template", () => {
  const pasted = `${profilePrompt("en")}\n\n${START_MARK}\n## PRICING\nVanaf 425 euro.\n${END_MARK}`;
  const r = parseProfile(pasted);
  assert.deepEqual(r.filled, ["pricing"]);
});

test("markers named in an intro or closing sentence do not hide the real block", () => {
  const pasted = `Ik zet alles tussen ${START_MARK} en ${END_MARK}, zoals gevraagd.\n\n${START_MARK}\n${BODY}\n${END_MARK}\n\nLet op: alles tussen ${START_MARK} en ${END_MARK} kun je plakken.`;
  const r = parseProfile(pasted);
  assert.equal(r.profile.offer, "- Maatwerk automatiseringen\n- AI-telefoonassistent");
  assert.equal(r.filled.length, 7);
});

test("an answer that only says onbekend is not mistaken for the prompt", () => {
  const answer = ["WHO_AM_I", "OFFER", "PRICING"].map((k) => `## ${k}\nonbekend`).join("\n");
  const r = parseProfile(`${profilePrompt("nl")}\n${START_MARK}\n${answer}\n${END_MARK}\n## OFFER\nBuiten de markeringen.`);
  assert.deepEqual(r.filled, []);
  assert.equal(r.promptOnly, false);
});

test("a rendered answer copied without its ## still parses inside the markers", () => {
  const pasted = `${START_MARK}\nWHO_AM_I\nIk ben Rogier.\n**PRICING**\nVanaf 425 euro per maand.\n${END_MARK}`;
  const r = parseProfile(pasted);
  assert.equal(r.profile.whoAmI, "Ik ben Rogier.");
  assert.equal(r.profile.pricing, "Vanaf 425 euro per maand.");
});
