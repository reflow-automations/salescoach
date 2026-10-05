import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_PROFILE } from "../shared/types";
import { buildFeedbackInput, buildFeedbackInstructions, cleanText, feedbackToMarkdown, formatScore, nextStepKeys, parseFeedback, smartestModel } from "./feedback";

const EN_FULL = `## SUMMARY
Pete runs a heating company and wants more quote requests from his website.
You asked good questions, but the price came up before the value was clear.
You ended with a free website check on Thursday.
## STRONG_MOMENTS
- QUOTE: "How many quote requests come in through that site?"
  WHY: It made Pete name the problem himself.
- QUOTE: And what is an average job worth to you?
  WHY: Now you can compare the price with one extra job.
## IMPROVEMENTS
- HAPPENED: When Pete said 3,450 felt like a lot, you explained what is included.
  BETTER: "What do you compare that amount with?"
- HAPPENED: You did not ask who else decides.
  BETTER: "Who else looks at this before you decide?"
## NEXT_STEP
Free website check on Thursday at 10:00, you send the invite.
## FILLER_WORDS
um (7), basically (4)
## SCORE
7/10: Strong questions, the price objection needs a calmer answer.`;

test("parses a complete English answer", () => {
  const fb = parseFeedback(EN_FULL);
  assert.equal(fb.raw, undefined);
  assert.deepEqual(fb.sections, ["summary", "strengths", "improvements", "nextStep", "fillers", "score"]);
  assert.equal(fb.summary.length, 3);
  assert.match(fb.summary[0], /^Pete runs/);
  assert.deepEqual(fb.strengths, [
    { quote: "How many quote requests come in through that site?", why: "It made Pete name the problem himself." },
    { quote: "And what is an average job worth to you?", why: "Now you can compare the price with one extra job." },
  ]);
  assert.deepEqual(fb.improvements[0], {
    happened: "When Pete said 3,450 felt like a lot, you explained what is included.",
    better: "What do you compare that amount with?",
  });
  assert.equal(fb.improvements.length, 2);
  assert.equal(fb.nextStep, "Free website check on Thursday at 10:00, you send the invite.");
  assert.deepEqual(fb.fillers, ["um (7)", "basically (4)"]);
  assert.deepEqual(fb.score, { value: 7, reason: "Strong questions, the price objection needs a calmer answer." });
});

test("parses a Dutch answer with Dutch markers, bold labels and NONE sections", () => {
  const fb = parseFeedback(`**SAMENVATTING**
1. Peter heeft een installatiebedrijf en wil meer aanvragen.
2. Je stelde goede vragen.
3. Er is nog niets afgesproken.

### Sterke momenten
- **CITAAT:** „Hoeveel offerteaanvragen komen er via die site binnen?”
  **WAAROM:** Hij noemde zelf het probleem.
- CITAAT: "Wat is een gemiddelde klus voor jullie waard?"
  WAAROM: Zo kun je de prijs vergelijken
  met één extra klus.
## VERBETERPUNTEN
- WAT GEBEURDE: Je verdedigde de prijs meteen.
  BETER: "Waar vergelijk je dat bedrag mee?"
- WAT GEBEURDE: Je vroeg niet wie er nog meebeslist.
  BETER: 'Wie kijkt er nog mee voordat je beslist?'
## VERVOLGSTAP
NONE
## STOPWOORDJES
Geen.
## CIJFER
6,5/10: Goede vragen, maar geen afspraak.`);
  assert.deepEqual(fb.sections, ["summary", "strengths", "improvements", "nextStep", "fillers", "score"]);
  assert.deepEqual(fb.summary, ["Peter heeft een installatiebedrijf en wil meer aanvragen.", "Je stelde goede vragen.", "Er is nog niets afgesproken."]);
  assert.equal(fb.strengths[0].quote, "Hoeveel offerteaanvragen komen er via die site binnen?");
  assert.equal(fb.strengths[1].why, "Zo kun je de prijs vergelijken met één extra klus.", "a continuation line belongs to the field above");
  assert.equal(fb.improvements[1].better, "Wie kijkt er nog mee voordat je beslist?");
  assert.equal(fb.nextStep, null);
  assert.deepEqual(fb.fillers, []);
  assert.deepEqual(fb.score, { value: 6.5, reason: "Goede vragen, maar geen afspraak." });
});

test("missing sections stay empty and are not listed", () => {
  const fb = parseFeedback(`## SUMMARY
Short call.
## IMPROVEMENTS
- HAPPENED: You talked most of the time.
  BETTER: "What matters most to you here?"`);
  assert.deepEqual(fb.sections, ["summary", "improvements"]);
  assert.deepEqual(fb.strengths, []);
  assert.equal(fb.nextStep, null);
  assert.equal(fb.score, null);
  assert.deepEqual(fb.fillers, []);
  assert.equal(fb.improvements.length, 1);
});

test("text before the first marker and after the last section is ignored", () => {
  const fb = parseFeedback(`Sure! Here is your feedback on the call.

## SUMMARY
One. Two. Three.
## NEXT_STEP
Demo next Tuesday.
## FILLER_WORDS
NONE

Let me know if you want more tips!
## SCORE
8/10: Clear and calm.

Good luck with the next call!`);
  assert.deepEqual(fb.summary, ["One. Two. Three."]);
  assert.equal(fb.nextStep, "Demo next Tuesday.");
  assert.deepEqual(fb.fillers, [], "a closing remark is not a filler word");
  assert.deepEqual(fb.score, { value: 8, reason: "Clear and calm." });
});

test("an answer without any marker is kept as raw text", () => {
  const fb = parseFeedback("You did well overall \u2014 but ask more questions.\n\n\n\nGood luck.");
  assert.deepEqual(fb.sections, []);
  assert.equal(fb.raw, "You did well overall, but ask more questions.\n\nGood luck.");
});

test("while streaming, a half-written marker on the last line is not shown as text", () => {
  for (const tail of ["## STRO", "##", "**STRONG_MOM", "STRO", "## SCO"]) {
    const cut = `## SUMMARY\nPete runs a heating company.\n${tail}`;
    const fb = parseFeedback(cut, true);
    assert.deepEqual(fb.summary, ["Pete runs a heating company."], tail);
  }
  const items = parseFeedback(`## STRONG_MOMENTS\n- QUOTE: "How many?"\n  WHY: It worked.\n## IMPR`, true);
  assert.deepEqual(items.strengths, [{ quote: "How many?", why: "It worked." }]);
  // A complete marker on the last line already counts, and ordinary text still streams in.
  assert.deepEqual(parseFeedback("## SUMMARY\nPete runs\n## SCORE", true).sections, ["summary", "score"]);
  assert.deepEqual(parseFeedback("## SUMMARY\nPete runs a", true).summary, ["Pete runs a"]);
  // Without the streaming flag nothing is left out.
  assert.deepEqual(parseFeedback("## SUMMARY\nPete runs a heating company.\nSTRO").summary, ["Pete runs a heating company.", "STRO"]);
});

test("a partial answer while it streams gives the sections so far", () => {
  const cut = EN_FULL.slice(0, EN_FULL.indexOf("  WHY: Now you can"));
  const fb = parseFeedback(cut);
  assert.deepEqual(fb.sections, ["summary", "strengths"]);
  assert.equal(fb.strengths.length, 2);
  assert.equal(fb.strengths[1].why, "");
});

test("items without labels and a score on the marker line still parse", () => {
  const fb = parseFeedback(`## STRONG_MOMENTS
- "Wat kost het je nu om niets te doen?"
- "Zullen we donderdag een scan doen?"
## SCORE: 9/10, sterk afgesloten
## Next step: none`);
  assert.deepEqual(
    fb.strengths.map((s) => s.quote),
    ["Wat kost het je nu om niets te doen?", "Zullen we donderdag een scan doen?"],
  );
  assert.deepEqual(fb.score, { value: 9, reason: "sterk afgesloten" });
  assert.equal(fb.nextStep, null);
});

test("ordinary sentences that start with a section word are not markers", () => {
  const fb = parseFeedback(`## SUMMARY
Score of the call was fine overall.
Summary: you were calm.`);
  assert.deepEqual(fb.sections, ["summary"]);
  assert.equal(fb.summary.length, 2);
});

test("cleanText removes markdown and em and en dashes", () => {
  assert.equal(cleanText("**Goed** gedaan \u2014 echt  waar"), "Goed gedaan, echt waar");
  assert.equal(cleanText("10\u201312 minuten"), "10-12 minuten");
});

test("instructions carry the language, the markers, the rules and a default call type", () => {
  const nl = buildFeedbackInstructions({ profile: EMPTY_PROFILE, callBrief: "", language: "nl" });
  assert.match(nl, /Write the content in Dutch/);
  assert.match(nl, /sales call/);
  for (const marker of ["## SUMMARY", "## STRONG_MOMENTS", "## IMPROVEMENTS", "## NEXT_STEP", "## FILLER_WORDS", "## SCORE"]) assert.ok(nl.includes(marker), marker);
  assert.match(nl, /Only quote words that literally appear/);
  assert.match(nl, /Never invent quotes, numbers/);
  assert.match(nl, /no em dashes or en dashes/);
  assert.doesNotMatch(nl, /[\u2013\u2014]/);
  const interview = buildFeedbackInstructions({ profile: EMPTY_PROFILE, callBrief: "Gesprek met Anna", language: "en", callType: "interview" });
  assert.match(interview, /job interview/);
  assert.match(interview, /Gesprek met Anna/);
});

test("the input holds the whole call as ME and THEM lines", () => {
  const input = buildFeedbackInput(
    [
      { speaker: "me", text: "Hoi Peter." },
      { speaker: "them", text: "Hallo." },
    ],
    14 * 60_000,
  );
  assert.match(input, /about 14 minutes/);
  assert.match(input, /ME: Hoi Peter\.\nTHEM: Hallo\./);
});

test("a very long call is cut from the start", () => {
  const lines = Array.from({ length: 4000 }, (_, i) => ({ speaker: i % 2 ? ("them" as const) : ("me" as const), text: `zin nummer ${i} met wat extra woorden erbij` }));
  const input = buildFeedbackInput(lines, 30 * 60_000);
  assert.ok(input.length < 61_000, String(input.length));
  assert.match(input, /start of the call is left out/);
  assert.match(input, /zin nummer 3999 /);
});

test("markdown for copy and save, in the app language", () => {
  const md = feedbackToMarkdown(parseFeedback(EN_FULL), "nl", { subtitle: "Gesprek van 14 min" });
  assert.match(md, /^# Feedback op je gesprek\n\nGesprek van 14 min\n/);
  assert.match(md, /## Samenvatting/);
  assert.match(md, /Cijfer: 7\/10\. Strong questions/);
  assert.match(md, /- "How many quote requests come in through that site\?"\n {2}It made Pete/);
  assert.match(md, /Oefen deze zin: "What do you compare that amount with\?"/);
  assert.match(md, /## Afgesproken vervolgstap\n\nFree website check/);
  assert.doesNotMatch(md, /[\u2013\u2014]/);
  const none = feedbackToMarkdown(parseFeedback("## NEXT_STEP\nNONE"), "en");
  assert.match(none, /No next step agreed\./);
  assert.equal(formatScore(6.5, "nl"), "6,5");
  assert.equal(formatScore(7, "en"), "7");
});

test("the default ChatGPT feedback model is a larger one", () => {
  assert.equal(smartestModel([{ slug: "gpt-5.5-mini" }, { slug: "gpt-5.5" }]), "gpt-5.5");
  assert.equal(smartestModel([{ slug: "gpt-5.5-mini" }]), "gpt-5.5-mini");
  assert.equal(smartestModel([]), "");
});

test("feedback instructions follow the kind of call", () => {
  const sales = buildFeedbackInstructions({ profile: EMPTY_PROFILE, callBrief: "", language: "en" });
  assert.match(sales, /sales coach/);
  assert.doesNotMatch(sales, /recruiter/);
  const interview = buildFeedbackInstructions({ profile: EMPTY_PROFILE, callBrief: "", language: "nl", callType: "interview" });
  assert.match(interview, /recruiter/);
  assert.match(interview, /THEM is the interviewer/);
  assert.match(interview, /whether hours, salary and ME's own questions came up/);
  assert.match(interview, /next step in the procedure/);
  const meeting = buildFeedbackInstructions({ profile: EMPTY_PROFILE, callBrief: "", language: "en", callType: "meeting" });
  assert.match(meeting, /meeting coach/);
  assert.match(meeting, /decisions and action points that were agreed/);
  for (const s of [sales, interview, meeting]) {
    assert.ok(s.includes("## NEXT_STEP") && s.includes("## SCORE"));
    assert.doesNotMatch(s, /[\u2013\u2014]/);
  }
});

test("a meeting names the next step 'decisions and action points', also in the copied text", () => {
  assert.deepEqual(nextStepKeys("meeting"), { title: "feedback.nextStepMeeting", none: "feedback.noNextStepMeeting" });
  assert.deepEqual(nextStepKeys("interview"), { title: "feedback.nextStep", none: "feedback.noNextStep" });
  const fb = parseFeedback("## SUMMARY\nKort overleg.\n## NEXT_STEP\nNONE");
  assert.match(feedbackToMarkdown(fb, "nl", { callType: "meeting" }), /## Besluiten en actiepunten\n\nGeen besluiten of actiepunten afgesproken\./);
  assert.match(feedbackToMarkdown(fb, "nl"), /## Afgesproken vervolgstap\n\nGeen vervolgstap afgesproken\./);
});
