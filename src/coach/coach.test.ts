import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Coach, NO_TIP_MESSAGE } from "./coach";
import type { Brain, BrainRequest } from "../main/providers/brain";
import type { TipEvent, TranscriptEvent } from "../shared/types";

// ---------- helpers ----------

/** Lets pending promise callbacks run (setImmediate is never mocked here). */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

interface FakeOptions {
  /** Pause on this promise right after emitting chunk number `gateAfter` (default 0). */
  gate?: Promise<void>;
  gateAfter?: number;
  /** Throw this after all chunks are emitted (with no chunks: immediately). */
  error?: Error;
  /** Reject with an AbortError once the signal is aborted, like fetch does. */
  abortAware?: boolean;
}

type FakeBrain = Brain & { requests: BrainRequest[] };

/** A streaming brain that sends the given chunks through onDelta, one per microtask. */
function fakeBrain(chunks: string[], o: FakeOptions = {}): FakeBrain {
  const requests: BrainRequest[] = [];
  const brain: Brain = async (req) => {
    requests.push(req);
    let full = "";
    for (let i = 0; i < chunks.length; i++) {
      await Promise.resolve();
      if (o.abortAware && req.signal.aborted) throw abortError();
      req.onDelta(chunks[i]);
      full += chunks[i];
      if (o.gate && i === (o.gateAfter ?? 0)) await o.gate;
    }
    await Promise.resolve();
    if (o.abortAware && req.signal.aborted) throw abortError();
    if (o.error) throw o.error;
    return full;
  };
  return Object.assign(brain, { requests });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(nextBrain: () => Brain, opts: { autoTips?: boolean } = {}) {
  const events: TipEvent[] = [];
  const clock = { t: 1_000_000 };
  const coach = new Coach({
    brain: nextBrain,
    instructions: () => "INSTRUCTIONS",
    autoTips: () => opts.autoTips ?? true,
    emit: (e) => events.push(e),
    now: () => clock.t,
  });
  return { coach, events, clock };
}

function said(speaker: TranscriptEvent["speaker"], text: string, id: string, final = true): TranscriptEvent {
  return { speaker, text, id, final };
}

function textOf(events: TipEvent[], id: string): string {
  return events
    .filter((e): e is Extract<TipEvent, { kind: "delta" }> => e.kind === "delta" && e.id === id)
    .map((e) => e.text)
    .join("");
}

// ---------- tips ----------

test("hotkey tip emits start, the streamed text and done", async () => {
  const b = fakeBrain(["Vraag ", "wat het ", "nu kost."]);
  const { coach, events } = setup(() => b, { autoTips: false });
  coach.onTranscript(said("them", "Dat vind ik best duur.", "t1"));
  await coach.requestTip("hotkey");
  assert.deepEqual(events[0], { kind: "start", id: "tip-1", trigger: "hotkey" });
  assert.ok(events.slice(1, -1).every((e) => e.kind === "delta"), JSON.stringify(events));
  assert.ok(events.length > 3, "text should stream in more than one delta");
  assert.equal(textOf(events, "tip-1"), "Vraag wat het nu kost.");
  assert.deepEqual(events.at(-1), { kind: "done", id: "tip-1" });
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].instructions, "INSTRUCTIONS");
  assert.ok(b.requests[0].input.startsWith("HOTKEY request."));
  assert.ok(b.requests[0].input.includes("THEM: Dat vind ik best duur."));
});

test("hotkey start is emitted before the brain answers", async () => {
  const gate = deferred();
  const b = fakeBrain(["Even stil blijven."], { gate: gate.promise });
  const { coach, events } = setup(() => b, { autoTips: false });
  const p = coach.requestTip("hotkey");
  assert.deepEqual(events, [{ kind: "start", id: "tip-1", trigger: "hotkey" }]);
  gate.resolve();
  await p;
  assert.equal(events.at(-1)?.kind, "done");
});

for (const [name, chunks] of [
  ["PASS in one chunk", ["PASS"]],
  ["PASS split as PA + SS", ["PA", "SS"]],
  ["PASS split per letter", ["P", "A", "S", "S"]],
  ["PASS with leading newline", ["\n", "PASS"]],
  ["lowercase pass", ["pass"]],
  ["PASS followed by more text", ["PASS", ". Geen tip nodig."]],
] as [string, string[]][]) {
  test(`auto tip answering ${name} emits only skip`, async () => {
    const b = fakeBrain(chunks);
    const { coach, events } = setup(() => b, { autoTips: false });
    await coach.requestTip("auto");
    assert.deepEqual(events, [{ kind: "skip", id: "tip-1" }]);
  });
}

test("auto PASS with an abort-aware brain (rejects after the coach aborts) emits only skip", async () => {
  const b = fakeBrain(["PA", "SS", " en nog meer"], { abortAware: true });
  const { coach, events } = setup(() => b, { autoTips: false });
  await coach.requestTip("auto");
  assert.deepEqual(events, [{ kind: "skip", id: "tip-1" }]);
  assert.ok(b.requests[0].signal.aborted, "coach should abort the stream once PASS is clear");
});

test("auto tip with real text emits start and the full text", async () => {
  const b = fakeBrain(["Vraag", " wat het", " ze nu kost."]);
  const { coach, events } = setup(() => b, { autoTips: false });
  await coach.requestTip("auto");
  assert.deepEqual(events[0], { kind: "start", id: "tip-1", trigger: "auto" });
  assert.equal(textOf(events, "tip-1"), "Vraag wat het ze nu kost.");
  assert.deepEqual(events.at(-1), { kind: "done", id: "tip-1" });
  assert.ok(!events.some((e) => e.kind === "skip"));
  assert.ok(b.requests[0].input.startsWith("AUTO request."));
});

test("auto tip that starts like PASS (P, then rijs...) is held back and then released in full", async () => {
  const b = fakeBrain(["P", "rijs pas ", "na de pijn noemen."]);
  const { coach, events } = setup(() => b, { autoTips: false });
  await coach.requestTip("auto");
  assert.equal(events[0].kind, "start");
  assert.equal(textOf(events, "tip-1"), "Prijs pas na de pijn noemen.");
  assert.equal(events.at(-1)?.kind, "done");
});

test("auto tip from a brain that only returns text (no deltas) is still shown", async () => {
  const brain: Brain = async () => "Vraag naar het budget.";
  const { coach, events } = setup(() => brain, { autoTips: false });
  await coach.requestTip("auto");
  assert.deepEqual(events, [
    { kind: "start", id: "tip-1", trigger: "auto" },
    { kind: "delta", id: "tip-1", text: "Vraag naar het budget." },
    { kind: "done", id: "tip-1" },
  ]);
});

test("auto tip with an empty answer emits only skip", async () => {
  const brain: Brain = async () => "  ";
  const { coach, events } = setup(() => brain, { autoTips: false });
  await coach.requestTip("auto");
  assert.deepEqual(events, [{ kind: "skip", id: "tip-1" }]);
});

test(
  "auto tip that starts with a normal word beginning with 'Pass' is not mistaken for PASS",
  async () => {
    const b = fakeBrain(["Passend voorstel: ", "begin met een kleine pilot."]);
    const { coach, events } = setup(() => b, { autoTips: false });
    await coach.requestTip("auto");
    assert.equal(events[0].kind, "start");
    assert.equal(textOf(events, "tip-1"), "Passend voorstel: begin met een kleine pilot.");
  },
);

test("auto tip split right after 'Pass' (Pass + end ...) is held back and then shown in full", async () => {
  const b = fakeBrain(["Pass", "end voorstel: ", "start klein."]);
  const { coach, events } = setup(() => b, { autoTips: false });
  await coach.requestTip("auto");
  assert.equal(events[0].kind, "start");
  assert.equal(textOf(events, "tip-1"), "Passend voorstel: start klein.");
  assert.ok(!events.some((e) => e.kind === "skip"));
});

for (const abortAware of [false, true]) {
  test(`a newer request supersedes an older one (abortAware=${abortAware})`, async () => {
    const gate = deferred();
    const older = fakeBrain(["Eerste ", "tip die te laat is."], { gate: gate.promise, abortAware });
    const newer = fakeBrain(["Nieuwe tip."]);
    const queue = [older, newer];
    const { coach, events } = setup(() => queue.shift()!, { autoTips: false });

    const p1 = coach.requestTip("hotkey");
    await flush(); // older has streamed "Eerste " and now waits on the gate
    assert.equal(textOf(events, "tip-1"), "Eerste"); // the trailing space waits for the next word

    const cut = events.length;
    const p2 = coach.requestTip("hotkey");
    assert.ok(older.requests[0].signal.aborted, "older request should be aborted");
    await p2;
    gate.resolve();
    await p1;
    await flush();

    // The older tip gets exactly one ending, before the new one starts, and nothing after it.
    const after = events.slice(cut);
    assert.deepEqual(after, [
      { kind: "done", id: "tip-1" },
      { kind: "start", id: "tip-2", trigger: "hotkey" },
      { kind: "delta", id: "tip-2", text: "Nieuwe tip." },
      { kind: "done", id: "tip-2" },
    ]);
  });
}

test("a held-back auto tip that is superseded by a hotkey emits nothing (no skip, no start)", async () => {
  const gate = deferred();
  const auto = fakeBrain(["PA", "SS"], { gate: gate.promise });
  const hotkey = fakeBrain(["Stel een vraag."]);
  const queue = [auto, hotkey];
  const { coach, events } = setup(() => queue.shift()!, { autoTips: false });
  const p1 = coach.requestTip("auto");
  await flush();
  await coach.requestTip("hotkey");
  gate.resolve();
  await p1;
  await flush();
  assert.ok(!events.some((e) => e.id === "tip-1"), JSON.stringify(events));
  assert.equal(textOf(events, "tip-2"), "Stel een vraag.");
});

for (const how of ["cancel", "reset"] as const) {
  test(`${how}() ends a running tip with one done and nothing after it`, async () => {
    const gate = deferred();
    const b = fakeBrain(["Eerste ", "deel."], { gate: gate.promise });
    const { coach, events } = setup(() => b, { autoTips: false });
    const p = coach.requestTip("hotkey");
    await flush();
    coach[how]();
    assert.ok(b.requests[0].signal.aborted);
    gate.resolve();
    await p;
    await flush();
    assert.deepEqual(
      events.map((e) => e.kind),
      ["start", "delta", "done"],
    );
  });
}

test("reset() before the first word still ends the pending hotkey tip (Start pressed while loading)", async () => {
  const b = fakeBrain([], { abortAware: true });
  const { coach, events } = setup(() => b, { autoTips: false });
  const p = coach.requestTip("hotkey");
  coach.reset();
  await p;
  assert.deepEqual(events, [
    { kind: "start", id: "tip-1", trigger: "hotkey" },
    { kind: "done", id: "tip-1" },
  ]);
});

test("cancel() of a held-back auto request emits nothing", async () => {
  const gate = deferred();
  const b = fakeBrain(["PA"], { gate: gate.promise });
  const { coach, events } = setup(() => b, { autoTips: false });
  const p = coach.requestTip("auto");
  await flush();
  coach.cancel();
  gate.resolve();
  await p;
  assert.deepEqual(events, []);
});

test("brain throwing on a hotkey tip emits start and error", async () => {
  const b = fakeBrain([], { error: new Error("Gemini 401: API key not valid") });
  const { coach, events } = setup(() => b, { autoTips: false });
  await coach.requestTip("hotkey");
  assert.deepEqual(events, [
    { kind: "start", id: "tip-1", trigger: "hotkey" },
    { kind: "error", id: "tip-1", message: "Gemini 401: API key not valid" },
  ]);
});

test("brain throwing on an auto tip emits start and error", async () => {
  const b = fakeBrain([], { error: new Error("OpenAI 429: rate limit") });
  const { coach, events } = setup(() => b, { autoTips: false });
  await coach.requestTip("auto");
  assert.deepEqual(events, [
    { kind: "start", id: "tip-1", trigger: "auto" },
    { kind: "error", id: "tip-1", message: "OpenAI 429: rate limit" },
  ]);
});

test("brain throwing mid-stream keeps the deltas and ends with error, not done", async () => {
  const b = fakeBrain(["Vraag wat "], { error: new Error("stream stopte") });
  const { coach, events } = setup(() => b, { autoTips: false });
  await coach.requestTip("hotkey");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["start", "delta", "error"],
  );
});

test("a non-Error throw is turned into a message", async () => {
  const brain: Brain = async () => {
    throw "kapot";
  };
  const { coach, events } = setup(() => brain, { autoTips: false });
  await coach.requestTip("hotkey");
  assert.deepEqual(events.at(-1), { kind: "error", id: "tip-1", message: "kapot" });
});

test("each request gets a new tip id", async () => {
  const { coach, events } = setup(() => fakeBrain(["Ok."]), { autoTips: false });
  await coach.requestTip("hotkey");
  await coach.requestTip("hotkey");
  assert.deepEqual(
    events.filter((e) => e.kind === "start").map((e) => e.id),
    ["tip-1", "tip-2"],
  );
});

// ---------- output contract and PASS ----------

for (const [name, chunks] of [
  ["**PASS**", ["**PASS**"]],
  ["** + PASS + ** in three chunks", ["**", "PASS", "**"]],
  ['"PASS"', ['"PASS"']],
  ["`PASS`", ["`", "PASS`"]],
  ["'PASS'", ["'PASS'"]],
  ["Tip: PASS", ["Tip: ", "PASS"]],
  ["a lone Pass at the end of the stream", ["Pass"]],
  ["PASS with a reason after a space", ["PASS Geen bezwaar of vraag."]],
] as [string, string[]][]) {
  test(`auto tip answering ${name} emits only skip`, async () => {
    const b = fakeBrain(chunks);
    const { coach, events } = setup(() => b, { autoTips: false });
    await coach.requestTip("auto");
    assert.deepEqual(events, [{ kind: "skip", id: "tip-1" }]);
  });
}

for (const [name, chunks, shown] of [
  ["Pass + a word (English)", ["Pass", " the discount, ask for budget first."], "Pass the discount, ask for budget first."],
  ["Passing", ["Passing on price is fine, ask about timing."], "Passing on price is fine, ask about timing."],
  ["Pas op (Dutch)", ["Pas", " op: ", "noem nog geen prijs."], "Pas op: noem nog geen prijs."],
] as [string, string[], string][]) {
  test(`auto tip that starts with ${name} is a real tip`, async () => {
    const b = fakeBrain(chunks);
    const { coach, events } = setup(() => b, { autoTips: false });
    await coach.requestTip("auto");
    assert.equal(events[0].kind, "start");
    assert.equal(textOf(events, "tip-1"), shown);
    assert.deepEqual(events.at(-1), { kind: "done", id: "tip-1" });
  });
}

for (const answer of ["PASS", "**PASS**", ""]) {
  test(`hotkey answered with ${JSON.stringify(answer)} shows a message instead of the text`, async () => {
    const b = fakeBrain(answer ? [answer] : []);
    const { coach, events } = setup(() => b, { autoTips: false });
    await coach.requestTip("hotkey");
    assert.deepEqual(events, [
      { kind: "start", id: "tip-1", trigger: "hotkey" },
      { kind: "error", id: "tip-1", message: NO_TIP_MESSAGE },
    ]);
  });
}

test("labels, markdown, em dashes and extra lines never reach the overlay", async () => {
  const b = fakeBrain([
    "**Vraag:",
    "** Wat kost dit probleem je ",
    "nu per maand \u2014 ",
    "ongeveer?",
    "\n?Wie beslist ",
    "er mee?\nEn nog een derde regel.",
  ]);
  const { coach, events } = setup(() => b, { autoTips: false });
  await coach.requestTip("auto");
  assert.equal(textOf(events, "tip-1"), "Wat kost dit probleem je nu per maand, ongeveer?\n? Wie beslist er mee?");
  assert.deepEqual(events.at(-1), { kind: "done", id: "tip-1" });
});

test("cleaned deltas always add up to the cleaned answer, whatever the chunking", async () => {
  const answer = 'Zeg: "Wat kost het je nu \u2014 per maand?"\n- Vraag: wie beslist er mee?';
  for (let size = 1; size <= 6; size++) {
    const chunks: string[] = [];
    for (let i = 0; i < answer.length; i += size) chunks.push(answer.slice(i, i + size));
    const b = fakeBrain(chunks);
    const { coach, events } = setup(() => b, { autoTips: false });
    await coach.requestTip("hotkey");
    assert.equal(textOf(events, "tip-1"), "Wat kost het je nu, per maand?\n? wie beslist er mee?", `chunk size ${size}`);
  }
});

test("an auto request never cuts off a running hotkey tip", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred();
  const slow = fakeBrain(["Vraag door ", "naar het budget."], { gate: gate.promise, abortAware: true });
  const later = fakeBrain(["Iets anders."]);
  const queue = [slow, later];
  const { coach, events, clock } = setup(() => queue.shift()!);
  const p = coach.requestTip("hotkey");
  await flush();
  // The slow brain is still answering 9 s later when THEM makes a point.
  clock.t += 9000;
  t.mock.timers.tick(9000);
  coach.onTranscript(said("them", "Dat vind ik eigenlijk te duur.", "t1"));
  clock.t += 900;
  t.mock.timers.tick(900);
  assert.equal(later.requests.length, 0, "no auto request while the hotkey tip runs");
  assert.ok(!slow.requests[0].signal.aborted);
  gate.resolve();
  await p;
  assert.equal(textOf(events, "tip-1"), "Vraag door naar het budget.");
  assert.deepEqual(events.at(-1), { kind: "done", id: "tip-1" });
  assert.ok(!events.some((e) => e.id === "tip-2"));
});

test("the auto cooldown counts from the end of a slow tip, and a blocked auto tip waits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred();
  const slow = fakeBrain(["Vraag door."], { gate: gate.promise });
  const auto = fakeBrain(["Noem de pilot."]);
  const queue = [slow, auto];
  const { coach, clock } = setup(() => queue.shift()!);
  const p = coach.requestTip("hotkey");
  await flush();
  clock.t += 10_000;
  gate.resolve();
  await p;
  const advance = (ms: number) => {
    clock.t += ms;
    t.mock.timers.tick(ms);
  };
  advance(3000);
  coach.onTranscript(said("them", "En hoe zit het met de opzegtermijn?", "t1"));
  advance(600); // 3.6 s after the tip finished: still on screen, so the auto tip waits
  assert.equal(auto.requests.length, 0);
  advance(1400); // 5 s after it finished: the waiting tip fires
  assert.equal(auto.requests.length, 1);
  await flush();
});

test("a hotkey that supersedes a running auto tip ends the auto tip first", async () => {
  const gate = deferred();
  const auto = fakeBrain(["Vraag naar ", "het budget."], { gate: gate.promise });
  const hotkey = fakeBrain(["Stel een vraag."]);
  const queue = [auto, hotkey];
  const { coach, events } = setup(() => queue.shift()!, { autoTips: false });
  const p1 = coach.requestTip("auto");
  await flush();
  assert.equal(textOf(events, "tip-1"), "Vraag naar");
  await coach.requestTip("hotkey");
  gate.resolve();
  await p1;
  await flush();
  assert.deepEqual(
    events.filter((e) => e.id === "tip-1").map((e) => e.kind),
    ["start", "delta", "done"],
  );
  assert.equal(textOf(events, "tip-2"), "Stel een vraag.");
});

// ---------- auto trigger (debounce + cooldown), with mocked setTimeout ----------

function autoSetup(t: TestContext, autoTips = true, chunks: string[] = ["PASS"]) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const b = fakeBrain(chunks);
  const h = setup(() => b, { autoTips });
  const advance = (ms: number) => {
    h.clock.t += ms;
    t.mock.timers.tick(ms);
  };
  return { ...h, b, advance };
}

test("auto trigger fires 600 ms after a final THEM line with 3+ words", async (t) => {
  const { coach, b, advance } = autoSetup(t);
  coach.onTranscript(said("them", "Dat vind ik eigenlijk te duur.", "t1"));
  advance(599);
  assert.equal(b.requests.length, 0);
  advance(1);
  assert.equal(b.requests.length, 1);
  assert.ok(b.requests[0].input.startsWith("AUTO request."));
  assert.ok(b.requests[0].input.includes("THEM: Dat vind ik eigenlijk te duur."));
  await flush();
});

test("auto trigger ignores interim text, ME lines and THEM lines under 3 words", async (t) => {
  const { coach, b, advance } = autoSetup(t);
  coach.onTranscript(said("them", "Dat vind ik eigenlijk", "t1", false));
  advance(5000);
  coach.onTranscript(said("me", "Wat bedoel je precies daarmee?", "m1"));
  advance(5000);
  coach.onTranscript(said("them", "Te duur.", "t2"));
  advance(5000);
  assert.equal(b.requests.length, 0);
  await flush();
});

test("auto trigger does nothing when auto tips are off", async (t) => {
  const { coach, b, advance } = autoSetup(t, false);
  coach.onTranscript(said("them", "Dat vind ik eigenlijk te duur.", "t1"));
  advance(5000);
  assert.equal(b.requests.length, 0);
  await flush();
});

test("auto trigger fires when an interim THEM segment becomes final", async (t) => {
  const { coach, b, advance } = autoSetup(t);
  coach.onTranscript(said("them", "Ik moet er", "t1", false));
  advance(2000);
  coach.onTranscript(said("them", "Ik moet er nog even over nadenken.", "t1", true));
  advance(600);
  assert.equal(b.requests.length, 1);
  await flush();
});

test("auto trigger is debounced: a new final THEM line restarts the 600 ms wait", async (t) => {
  const { coach, b, advance } = autoSetup(t);
  coach.onTranscript(said("them", "Nou, dat is een hoop geld.", "t1"));
  advance(400);
  coach.onTranscript(said("them", "Zeker voor een bedrijf als het onze.", "t2"));
  advance(599);
  assert.equal(b.requests.length, 0);
  advance(1);
  assert.equal(b.requests.length, 1);
  assert.ok(b.requests[0].input.includes("THEM: Nou, dat is een hoop geld. Zeker voor een bedrijf als het onze."));
  advance(10_000);
  assert.equal(b.requests.length, 1, "one burst of speech gives one request");
  await flush();
});

test("an objection during the 5 s cooldown is postponed, not dropped", async (t) => {
  const { coach, b, advance } = autoSetup(t, true, ["Vraag wat ze nu betalen."]);
  coach.onTranscript(said("them", "Wat kost dat eigenlijk per maand?", "t1"));
  advance(600);
  assert.equal(b.requests.length, 1);
  await flush();

  advance(2000);
  coach.onTranscript(said("them", "En zit de installatie daarbij in?", "t2"));
  advance(600); // 2.6 s after the tip: it stays on screen
  assert.equal(b.requests.length, 1);
  await flush();
  advance(2400); // 5 s after the tip: the waiting objection gets its tip
  assert.equal(b.requests.length, 2);
  await flush();
});

test("a hotkey tip also starts the auto cooldown", async (t) => {
  const { coach, b, advance } = autoSetup(t);
  await coach.requestTip("hotkey");
  coach.onTranscript(say3("them", "t1"));
  advance(600);
  assert.equal(b.requests.length, 1, "only the hotkey request");
  advance(4400);
  assert.equal(b.requests.length, 2, "the auto tip follows after the cooldown");
  await flush();
});

test("an auto PASS does not start the cooldown; the 3 s request limit only delays", async (t) => {
  const { coach, b, advance, events } = autoSetup(t);
  coach.onTranscript(said("them", "Leuk dat het gelukt is om af te spreken.", "t1"));
  advance(600);
  await flush();
  assert.equal(b.requests.length, 1);
  assert.ok(!events.some((e) => e.kind === "start"), "PASS shows nothing");

  advance(1000);
  coach.onTranscript(said("them", "Maar eerlijk gezegd vind ik het te duur.", "t2"));
  advance(600); // 1.6 s after the last request: waits for the 3 s limit
  assert.equal(b.requests.length, 1);
  await flush();
  advance(1400); // 3 s after the last request
  assert.equal(b.requests.length, 2, "objection shortly after a PASS still gets an auto tip");
  await flush();
});

function say3(speaker: TranscriptEvent["speaker"], id: string): TranscriptEvent {
  return said(speaker, "Dat klinkt wel interessant.", id);
}

// ---------- transcript / lines() ----------

test("lines() merges consecutive segments of one speaker and replaces interim text by id", () => {
  const { coach } = setup(() => fakeBrain([]), { autoTips: false });
  coach.onTranscript(said("me", "Hoi Jan,", "m1"));
  coach.onTranscript(said("me", "hoe gaat het?", "m2"));
  coach.onTranscript(said("them", "Goe", "t1", false));
  coach.onTranscript(said("them", "Goed hoor", "t1", false));
  coach.onTranscript(said("them", "Goed hoor, druk.", "t1", true));
  coach.onTranscript(said("them", "   ", "t2"));
  coach.onTranscript(said("me", "Mooi.", "m3"));
  assert.deepEqual(coach.lines(), [
    { speaker: "me", text: "Hoi Jan, hoe gaat het?" },
    { speaker: "them", text: "Goed hoor, druk." },
    { speaker: "me", text: "Mooi." },
  ]);
});

test("lines() does not change the stored segments", () => {
  const { coach } = setup(() => fakeBrain([]), { autoTips: false });
  coach.onTranscript(said("me", "Een.", "m1"));
  coach.onTranscript(said("me", "Twee.", "m2"));
  coach.lines();
  assert.deepEqual(coach.lines(), [{ speaker: "me", text: "Een. Twee." }]);
});

test("old final segments drop out of the 4 minute window, interim ones stay while they change", () => {
  const { coach, clock } = setup(() => fakeBrain([]), { autoTips: false });
  coach.onTranscript(said("me", "Heel oud.", "m1"));
  coach.onTranscript(said("them", "Nog", "t1", false));
  for (let i = 0; i < 25; i++) {
    clock.t += 10_000;
    coach.onTranscript(said("them", `Nog bezig ${i}`, "t1", false));
  }
  coach.onTranscript(said("me", "Nieuw.", "m2"));
  assert.deepEqual(coach.lines(), [
    { speaker: "them", text: "Nog bezig 24" },
    { speaker: "me", text: "Nieuw." },
  ]);
});

test("an interim segment that never got its final drops out after 30 s without updates", async () => {
  const b = fakeBrain(["Ok."]);
  const { coach, clock } = setup(() => b, { autoTips: false });
  coach.onTranscript(said("them", "Afgebroken zin", "t1", false));
  coach.onTranscript(said("me", "Hallo.", "m1"));
  clock.t += 29_000;
  coach.onTranscript(said("me", "Hoor je me?", "m2"));
  assert.ok(coach.lines().some((l) => l.text === "Afgebroken zin"));
  clock.t += 2_000;
  await coach.requestTip("hotkey");
  assert.ok(!b.requests[0].input.includes("Afgebroken zin"), b.requests[0].input);
  assert.deepEqual(coach.lines(), [{ speaker: "me", text: "Hallo. Hoor je me?" }]);
});

test("at most 40 segments are kept", () => {
  const { coach } = setup(() => fakeBrain([]), { autoTips: false });
  for (let i = 0; i < 45; i++) coach.onTranscript(said(i % 2 ? "them" : "me", `zin ${i}`, `s${i}`));
  const lines = coach.lines();
  assert.equal(lines.length, 40);
  assert.equal(lines[0].text, "zin 5");
  assert.equal(lines.at(-1)?.text, "zin 44");
});

test("reset() clears the transcript", () => {
  const { coach } = setup(() => fakeBrain([]), { autoTips: false });
  coach.onTranscript(said("me", "Hallo.", "m1"));
  coach.reset();
  assert.deepEqual(coach.lines(), []);
});
