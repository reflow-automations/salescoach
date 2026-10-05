import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Coach, NO_TIP_MESSAGE, wordDiff } from "./coach";
import type { Brain, BrainRequest } from "../main/providers/brain";
import type { CallType, TipEvent, TranscriptEvent } from "../shared/types";

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

function setup(nextBrain: () => Brain, opts: { autoTips?: boolean; callType?: () => CallType } = {}) {
  const events: TipEvent[] = [];
  const warnings: string[] = [];
  const clock = { t: 1_000_000 };
  const coach = new Coach({
    brain: nextBrain,
    instructions: () => "INSTRUCTIONS",
    autoTips: () => opts.autoTips ?? true,
    callType: opts.callType,
    emit: (e) => events.push(e),
    warn: (m) => warnings.push(m),
    now: () => clock.t,
  });
  return { coach, events, clock, warnings };
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
  assert.deepEqual(events[0], { kind: "start", id: "tip-1", trigger: "hotkey", label: "price" });
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

test("brain throwing on an auto tip warns in the status line and leaves the tip area alone", async () => {
  const b = fakeBrain([], { error: new Error("OpenAI 429: rate limit") });
  const { coach, events, warnings } = setup(() => b, { autoTips: false });
  await coach.requestTip("auto");
  assert.deepEqual(events, [{ kind: "skip", id: "tip-1" }]);
  assert.deepEqual(warnings, ["Automatic tip failed: OpenAI 429: rate limit"]);
});

test("an auto tip that fails mid-stream keeps what it showed and ends with done", async () => {
  const b = fakeBrain(["Vraag wat "], { error: new Error("stream stopte") });
  const { coach, events, warnings } = setup(() => b, { autoTips: false });
  await coach.requestTip("auto");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["start", "delta", "done"],
  );
  assert.equal(warnings.length, 1);
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

test("callTranscript() keeps the whole call (30 min) while the brain only sees the last 4 minutes", async () => {
  const b = fakeBrain(["Ok."]);
  const { coach, clock } = setup(() => b, { autoTips: false });
  const start = clock.t;
  coach.onTranscript(said("me", "Goedemorgen Peter.", "m1"));
  for (let i = 0; i < 60; i++) {
    clock.t += 15_000;
    coach.onTranscript(said(i % 2 ? "me" : "them", `zin ${i}`, `s${i}`));
  }
  const call = coach.callTranscript();
  assert.equal(call.lines[0].text, "Goedemorgen Peter.", "the start of a 15 minute call is still there");
  assert.equal(call.lines.length, 61);
  assert.equal(call.durationMs, clock.t - start);
  assert.ok(!coach.lines().some((l) => l.text === "Goedemorgen Peter."), "the brain window stays 4 minutes");
  await coach.requestTip("hotkey");
  assert.ok(!b.requests[0].input.includes("Goedemorgen"), b.requests[0].input);
  assert.ok(coach.lines().length <= 40);
  // After 31 minutes the oldest part drops out of memory too.
  clock.t = start + 31 * 60_000;
  coach.onTranscript(said("me", "Tot ziens.", "m-end"));
  assert.ok(!coach.callTranscript().lines.some((l) => l.text === "Goedemorgen Peter."));
});

test("callTranscript() survives a stop (cancel) and is cleared by reset()", () => {
  const { coach, clock } = setup(() => fakeBrain([]), { autoTips: false });
  coach.onTranscript(said("me", "Hallo.", "m1"));
  clock.t += 150_000;
  coach.onTranscript(said("them", "Dag.", "t1"));
  coach.cancel();
  assert.equal(coach.callTranscript().durationMs, 150_000);
  assert.equal(coach.callTranscript().lines.length, 2);
  coach.reset();
  assert.deepEqual(coach.callTranscript(), { lines: [], durationMs: 0 });
});

test("reset() clears the transcript", () => {
  const { coach } = setup(() => fakeBrain([]), { autoTips: false });
  coach.onTranscript(said("me", "Hallo.", "m1"));
  coach.reset();
  assert.deepEqual(coach.lines(), []);
});

// ---------- tips while THEM is still talking (drafts), with mocked setTimeout ----------

function draftSetup(t: TestContext, brains: FakeBrain[] = [], opts: { whileSpeaking?: boolean; autoTips?: boolean; callType?: () => CallType } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = [...brains];
  const used: FakeBrain[] = [];
  const events: TipEvent[] = [];
  const warnings: string[] = [];
  const clock = { t: 1_000_000 };
  const coach = new Coach({
    brain: () => {
      const b = queue.shift() ?? fakeBrain(["PASS"]);
      used.push(b);
      return b;
    },
    instructions: () => "INSTRUCTIONS",
    autoTips: () => opts.autoTips ?? true,
    tipsWhileSpeaking: () => opts.whileSpeaking ?? true,
    callType: opts.callType,
    emit: (e) => events.push(e),
    warn: (m) => warnings.push(m),
    now: () => clock.t,
  });
  const advance = (ms: number) => {
    clock.t += ms;
    t.mock.timers.tick(ms);
  };
  const inputs = () => used.flatMap((b) => b.requests.map((r) => r.input));
  const autoInputs = () => inputs().filter((i) => i.startsWith("AUTO request."));
  return { coach, events, clock, advance, inputs, autoInputs, used, warnings };
}

const interim = (text: string, id = "t1") => said("them", text, id, false);
const finalLine = (text: string, id = "t1") => said("them", text, id, true);
const starts = (events: TipEvent[]) => events.filter((e): e is Extract<TipEvent, { kind: "start" }> => e.kind === "start");

test("draft: 6+ interim words that stop growing for 350 ms start a request", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t);
  coach.onTranscript(interim("Ja dat klinkt allemaal wel goed"));
  advance(300);
  coach.onTranscript(interim("Ja dat klinkt allemaal wel goed maar")); // still growing: the wait starts again
  advance(349);
  assert.equal(autoInputs().length, 0);
  advance(1);
  assert.equal(autoInputs().length, 1);
  assert.ok(autoInputs()[0].includes("THEM: Ja dat klinkt allemaal wel goed maar (still speaking)"), autoInputs()[0]);
  await flush();
});

test("draft: the same interim text again does not restart the 350 ms wait", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t);
  coach.onTranscript(interim("Ja dat klinkt allemaal wel goed"));
  advance(200);
  coach.onTranscript(interim("Ja dat klinkt allemaal wel goed"));
  advance(150);
  assert.equal(autoInputs().length, 1);
  await flush();
});

test("draft: interim text under 6 words without a trigger or question starts nothing", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t);
  coach.onTranscript(interim("Ja dat klinkt wel"));
  advance(5000);
  assert.equal(autoInputs().length, 0);
  await flush();
});

for (const text of ["Dat is best duur", "Send me some info", "Werkt dat bij jullie?"]) {
  test(`draft: "${text}" (trigger word or question mark) starts a request at once`, async (t) => {
    const { coach, advance, autoInputs } = draftSetup(t);
    coach.onTranscript(interim(text));
    advance(0);
    assert.equal(autoInputs().length, 1);
    await flush();
  });
}

test("draft: a trigger only starts the request; a PASS answer shows nothing", async (t) => {
  const { coach, advance, events, autoInputs } = draftSetup(t, [fakeBrain(["PASS"])]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush();
  assert.equal(autoInputs().length, 1);
  assert.deepEqual(events, [{ kind: "skip", id: "tip-1" }]);
});

test("draft: only the brain's words are shown, never the trigger words; the label is a category key", async (t) => {
  const { coach, advance, events } = draftSetup(t, [fakeBrain(["Vraag waarmee ", "hij het vergelijkt."])]);
  coach.onTranscript(interim("Dat vind ik best duur eerlijk gezegd"));
  advance(0);
  await flush();
  assert.deepEqual(events[0], { kind: "start", id: "tip-1", trigger: "auto", draft: true, label: "price" });
  assert.equal(textOf(events, "tip-1"), "Vraag waarmee hij het vergelijkt.");
  assert.ok(!JSON.stringify(events).includes("duur"), JSON.stringify(events));
  assert.deepEqual(events.at(-1), { kind: "done", id: "tip-1" });
});

test("draft: 6+ new words abort the running draft and start a new one that replaces its tip", async (t) => {
  const gate = deferred();
  const first = fakeBrain(["Vraag waarmee ", "hij vergelijkt."], { gate: gate.promise, abortAware: true });
  const second = fakeBrain(["Vraag wat het hem nu kost."]);
  const { coach, advance, events, autoInputs } = draftSetup(t, [first, second]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush(); // tip-1 shows "Vraag waarmee" and waits
  advance(500);
  coach.onTranscript(interim("Dat vind ik best duur voor zo'n kleine website eerlijk gezegd"));
  advance(999); // at most one request per 1.5 s
  assert.equal(autoInputs().length, 1);
  assert.ok(!first.requests[0].signal.aborted);
  advance(1);
  assert.equal(autoInputs().length, 2);
  assert.ok(first.requests[0].signal.aborted, "the older draft is aborted");
  assert.ok(autoInputs()[1].includes("kleine website eerlijk gezegd (still speaking)"));
  await flush();
  gate.resolve();
  await flush();
  assert.deepEqual(
    events.map((e) => [e.kind, e.id]),
    [
      ["start", "tip-1"],
      ["delta", "tip-1"],
      ["done", "tip-1"],
      ["start", "tip-2"],
      ["delta", "tip-2"],
      ["done", "tip-2"],
    ],
  );
  assert.deepEqual(starts(events)[1], { kind: "start", id: "tip-2", trigger: "auto", draft: true, label: "price", replaces: "tip-1" });
  assert.equal(textOf(events, "tip-2"), "Vraag wat het hem nu kost.");
});

test("draft: a new trigger category also refines, fewer than 6 new words without one does not", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush();
  advance(2000);
  coach.onTranscript(interim("Dat vind ik best duur en ook")); // 2 new words, nothing new
  advance(2000);
  assert.equal(autoInputs().length, 1);
  coach.onTranscript(interim("Dat vind ik best duur en ook de opzegtermijn")); // contract
  advance(0);
  assert.equal(autoInputs().length, 2);
  await flush();
});

test("draft: at most one new request per 1.5 s", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t);
  coach.onTranscript(interim("Dat is best duur"));
  advance(0);
  await flush();
  advance(200);
  coach.onTranscript(interim("Dat is best duur want we hebben er weinig ruimte voor"));
  advance(1299);
  assert.equal(autoInputs().length, 1);
  advance(1); // 1.5 s after the first
  assert.equal(autoInputs().length, 2);
  await flush();
  advance(100);
  coach.onTranscript(interim("Dat is best duur want we hebben er weinig ruimte voor in de begroting van dit jaar"));
  advance(1399);
  assert.equal(autoInputs().length, 2);
  advance(1); // 1.5 s after the second
  assert.equal(autoInputs().length, 3);
  await flush();
});

test("draft: a final line that differs by fewer than 4 words keeps the tip and makes it final", async (t) => {
  const { coach, advance, events, autoInputs } = draftSetup(t, [fakeBrain(["Vraag waarmee hij het vergelijkt."])]);
  coach.onTranscript(interim("Dat vind ik best duur voor wat het is"));
  advance(0);
  await flush();
  assert.equal(events.at(-1)?.kind, "done");
  advance(800);
  coach.onTranscript(finalLine("Dat vind ik best duur voor wat het is, eigenlijk."));
  assert.deepEqual(events.at(-1), { kind: "final", id: "tip-1" });
  advance(10_000);
  assert.equal(autoInputs().length, 1, "no refresh and no classic auto request");
  await flush();
});

test("draft: the final line arrives while the draft still streams; the tip becomes final when it ends", async (t) => {
  const gate = deferred();
  const { coach, advance, events, autoInputs } = draftSetup(t, [fakeBrain(["Noem ", "de kleine pilot."], { gate: gate.promise })]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush();
  coach.onTranscript(finalLine("Dat vind ik best duur."));
  assert.ok(!events.some((e) => e.kind === "final"), "not before the tip is complete");
  gate.resolve();
  await flush();
  assert.deepEqual(events.slice(-2), [
    { kind: "done", id: "tip-1" },
    { kind: "final", id: "tip-1" },
  ]);
  advance(10_000);
  assert.equal(autoInputs().length, 1);
});

test("draft: a final line that differs by 4+ words is refreshed once, after the 1.5 s limit", async (t) => {
  const { coach, advance, events, autoInputs } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."]), fakeBrain(["Vraag wat kwaliteit hem waard is."])]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush();
  advance(400);
  coach.onTranscript(finalLine("Dat vind ik best duur, maar de kwaliteit is heel goed hoor."));
  advance(1099);
  assert.equal(autoInputs().length, 1);
  advance(1);
  assert.equal(autoInputs().length, 2);
  const refresh = autoInputs()[1];
  assert.ok(refresh.includes("THEM: Dat vind ik best duur, maar de kwaliteit is heel goed hoor."), refresh);
  assert.ok(!refresh.includes("(still speaking)"));
  await flush();
  assert.deepEqual(starts(events)[1], { kind: "start", id: "tip-2", trigger: "auto", label: "price", replaces: "tip-1" });
  assert.ok(!events.some((e) => e.kind === "final"), "the replaced tip needs no final");
  advance(10_000);
  coach.onTranscript(finalLine("Dat vind ik best duur, maar de kwaliteit is heel goed hoor, echt.")); // a corrected final
  advance(10_000);
  assert.equal(autoInputs().length, 2, "refreshed only once");
  await flush();
});

test("draft: a refresh that answers PASS withdraws the draft tip and never makes it final", async (t) => {
  const { coach, advance, events, autoInputs } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."]), fakeBrain(["PASS"])]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush();
  coach.onTranscript(finalLine("Dat vind ik best duur, maar goed, we gaan het gewoon proberen."));
  advance(1500);
  await flush();
  assert.deepEqual(events.slice(-2), [
    { kind: "skip", id: "tip-2" },
    { kind: "retract", id: "tip-1" },
  ]);
  coach.onTranscript(interim("Goed, volgende punt dan", "t2"));
  coach.cancel();
  advance(10_000);
  await flush();
  assert.ok(!events.some((e) => e.kind === "final"), JSON.stringify(events));
  assert.equal(autoInputs().length, 2, "the PASS on the final text asks nothing more");
});

test("draft: a new utterance makes the previous draft tip final", async (t) => {
  const { coach, advance, events } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."])]);
  coach.onTranscript(interim("Dat vind ik best duur", "t1"));
  advance(0);
  await flush();
  coach.onTranscript(interim("En verder", "t2"));
  assert.deepEqual(events.at(-1), { kind: "final", id: "tip-1" });
  await flush();
});

test("draft: cancel() makes a shown draft tip final", async (t) => {
  const { coach, advance, events } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."])]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush();
  coach.cancel();
  assert.deepEqual(events.at(-1), { kind: "final", id: "tip-1" });
});

// ---------- drafts and the postponed auto logic ----------

test("draft: a new draft waits for the 5 s cooldown of a shown tip and then uses the newest words", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t, [fakeBrain(["Stel een open vraag."])]);
  await coach.requestTip("hotkey"); // a tip is on screen from now on
  advance(1000);
  coach.onTranscript(interim("Dat is best duur"));
  advance(2000);
  coach.onTranscript(interim("Dat is best duur voor ons kleine bedrijfje hoor"));
  advance(1999); // 4.999 s after the tip
  assert.equal(autoInputs().length, 0);
  advance(1);
  assert.equal(autoInputs().length, 1);
  assert.ok(autoInputs()[0].includes("THEM: Dat is best duur voor ons kleine bedrijfje hoor (still speaking)"));
  await flush();
});

test("draft: a refinement may replace its own tip within the 5 s cooldown", async (t) => {
  const { coach, advance, autoInputs, events } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."]), fakeBrain(["Vraag naar zijn budget."])]);
  coach.onTranscript(interim("Dat is best duur"));
  advance(0);
  await flush(); // tip-1 is on screen
  advance(1600);
  coach.onTranscript(interim("Dat is best duur en we hebben er eigenlijk geen budget voor"));
  advance(0);
  assert.equal(autoInputs().length, 2, "no 5 s cooldown and no 3 s limit for its own refinement");
  await flush();
  assert.equal(starts(events)[1].replaces, "tip-1");
});

test("draft: the first draft of a new utterance does wait for the cooldown of the previous tip", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."])]);
  coach.onTranscript(interim("Dat is best duur", "t1"));
  advance(0);
  await flush();
  coach.onTranscript(finalLine("Dat is best duur.", "t1"));
  advance(1000);
  coach.onTranscript(interim("En hoe zit het met het contract", "t2"));
  advance(3999);
  assert.equal(autoInputs().length, 1);
  advance(1); // 5 s after tip-1
  assert.equal(autoInputs().length, 2);
  await flush();
});

test("draft: never cuts off a streaming hotkey tip; it follows after the cooldown", async (t) => {
  const gate = deferred();
  const slow = fakeBrain(["Vraag door ", "naar het budget."], { gate: gate.promise, abortAware: true });
  const { coach, advance, autoInputs } = draftSetup(t, [slow]);
  const p = coach.requestTip("hotkey");
  await flush();
  coach.onTranscript(interim("Dat vind ik eigenlijk te duur"));
  advance(9000);
  assert.equal(autoInputs().length, 0);
  assert.ok(!slow.requests[0].signal.aborted);
  gate.resolve();
  await p;
  advance(4999);
  assert.equal(autoInputs().length, 0);
  advance(1);
  assert.equal(autoInputs().length, 1);
  await flush();
});

test("draft: covers an auto tip that was still waiting for an earlier final line", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t);
  coach.onTranscript(finalLine("Ik weet het niet goed", "t1")); // classic path, waits 600 ms
  advance(200);
  coach.onTranscript(interim("Het lijkt me best duur", "t2"));
  advance(0);
  assert.equal(autoInputs().length, 1);
  assert.ok(autoInputs()[0].includes("THEM: Ik weet het niet goed Het lijkt me best duur (still speaking)"), autoInputs()[0]);
  advance(5000);
  assert.equal(autoInputs().length, 1, "one request for both");
  await flush();
});

test("draft: a short final line without a draft still takes the classic 600 ms path", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t);
  coach.onTranscript(interim("Klinkt"));
  coach.onTranscript(finalLine("Klinkt wel interessant zeg."));
  advance(599);
  assert.equal(autoInputs().length, 0);
  advance(1);
  assert.equal(autoInputs().length, 1);
  assert.ok(!autoInputs()[0].includes("(still speaking)"));
  await flush();
});

test("draft: a postponed first draft whose line becomes final goes the classic way, once", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t, [fakeBrain(["Stel een open vraag."])]);
  await coach.requestTip("hotkey");
  advance(500);
  coach.onTranscript(interim("Dat is best duur"));
  advance(500);
  coach.onTranscript(finalLine("Dat is best duur."));
  advance(3999); // 4.999 s after the tip
  assert.equal(autoInputs().length, 0);
  advance(1);
  assert.equal(autoInputs().length, 1);
  advance(10_000);
  assert.equal(autoInputs().length, 1);
  await flush();
});

// ---------- tipsWhileSpeaking off: the old behaviour ----------

test("tipsWhileSpeaking off: interim text never starts a request, the final line does after 600 ms", async (t) => {
  const { coach, advance, autoInputs, events } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."])], { whileSpeaking: false });
  coach.onTranscript(interim("Dat vind ik best duur voor zo'n kleine website?"));
  advance(5000);
  assert.equal(autoInputs().length, 0);
  coach.onTranscript(finalLine("Dat vind ik best duur voor zo'n kleine website."));
  advance(599);
  assert.equal(autoInputs().length, 0);
  advance(1);
  assert.equal(autoInputs().length, 1);
  await flush();
  assert.deepEqual(starts(events)[0], { kind: "start", id: "tip-1", trigger: "auto", label: "price" });
  assert.ok(!events.some((e) => e.kind === "final"));
});

test("auto tips off: no draft either", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t, [], { autoTips: false });
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(5000);
  assert.equal(autoInputs().length, 0);
});

test("a hotkey while THEM is still talking does not mark their line as still speaking (only drafts do)", async (t) => {
  const { coach, inputs } = draftSetup(t, [fakeBrain(["Laat hem uitpraten."])], { whileSpeaking: false });
  coach.onTranscript(interim("Ik twijfel nog een beetje over"));
  await coach.requestTip("hotkey");
  assert.ok(inputs()[0].includes("THEM: Ik twijfel nog een beetje over"), inputs()[0]);
  assert.ok(!inputs()[0].includes("(still speaking)"), inputs()[0]);
});

test("wordDiff counts the words two versions differ by", () => {
  assert.equal(wordDiff("Dat vind ik best duur", "Dat vind ik best duur."), 0);
  assert.equal(wordDiff("Dat vind ik best duur", "Dat vind ik best duur eigenlijk wel"), 2);
  assert.equal(wordDiff("Dat vind ik best duur", "Dat vind ik best goedkoop"), 1);
  assert.equal(wordDiff("", "een twee drie vier"), 4);
});

// ---------- kind of call ----------

test("the label follows the kind of call, read again for every tip", async () => {
  let type: CallType = "sales";
  const { coach, events } = setup(() => fakeBrain(["Vraag eerst naar hun range."]), { autoTips: false, callType: () => type });
  coach.onTranscript(said("them", "Wat is je salarisverwachting?", "t1"));
  await coach.requestTip("hotkey");
  assert.deepEqual(starts(events)[0], { kind: "start", id: "tip-1", trigger: "hotkey", label: "question" });
  type = "interview"; // switched in the overlay during the call
  await coach.requestTip("hotkey");
  assert.deepEqual(starts(events)[1], { kind: "start", id: "tip-2", trigger: "hotkey", label: "salary" });
});

test("draft: an interview trigger word starts the request at once, without a question mark", async (t) => {
  const { coach, advance, autoInputs, events } = draftSetup(t, [fakeBrain(["Kern eerst, dan een voorbeeld."])], { callType: () => "interview" });
  coach.onTranscript(interim("En waarom wil je eigenlijk bij"));
  advance(0);
  await flush();
  assert.equal(autoInputs().length, 1);
  assert.deepEqual(starts(events)[0], { kind: "start", id: "tip-1", trigger: "auto", draft: true, label: "motivation" });
});

test("draft: the same words are no trigger in a sales call", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t, [], { callType: () => "sales" });
  coach.onTranscript(interim("En waarom wil je")); // 4 words, no sales trigger, no question mark
  advance(1000);
  await flush();
  assert.equal(autoInputs().length, 0);
});

// ---------- regressions from the v0.2 review ----------

test("review 1A: a postponed draft whose final line is short still gets its tip", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t, [fakeBrain(["Stel een open vraag."])]);
  await coach.requestTip("hotkey"); // a tip is on screen: 5 s cooldown
  advance(500);
  coach.onTranscript(finalLine("Maar dat vind ik veel geld", "t1")); // classic path, postponed
  advance(500);
  coach.onTranscript(interim("Echt veel te duur", "t2")); // a draft is wanted and takes over the waiting tip
  advance(500);
  coach.onTranscript(finalLine("Te duur.", "t2")); // shorter than 3 words
  advance(3499); // 4.999 s after the hotkey tip
  assert.equal(autoInputs().length, 0);
  advance(1);
  assert.equal(autoInputs().length, 1, "the tip is postponed, not lost");
  assert.ok(autoInputs()[0].includes("Te duur."), autoInputs()[0]);
  await flush();
});

test("review 1B: a refresh that was still waiting is not lost when THEM starts a new short line", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."])]);
  coach.onTranscript(interim("Ik denk dat het te duur"));
  advance(0);
  await flush(); // the draft tip is on screen
  assert.equal(autoInputs().length, 1);
  advance(400);
  coach.onTranscript(finalLine("Ik denk dat het te duur is voor ons kleine bedrijf eerlijk gezegd")); // refresh wanted, throttled
  advance(600);
  coach.onTranscript(interim("Dus ja", "t2")); // a new utterance within 1.5 s
  advance(200);
  coach.onTranscript(finalLine("Dus ja.", "t2")); // too short for the classic path
  advance(10_000);
  assert.equal(autoInputs().length, 2, "the waiting refresh becomes a normal auto tip");
  assert.ok(!autoInputs()[1].includes("(still speaking)"));
  assert.ok(autoInputs()[1].includes("Dus ja."), autoInputs()[1]);
  await flush();
});

test("review 2: a PASS on unfinished words is asked again on the final line, not kept", async (t) => {
  const { coach, advance, autoInputs, events } = draftSetup(t, [fakeBrain(["PASS"]), fakeBrain(["Noem de prijs per maand en vraag naar het budget."])]);
  coach.onTranscript(interim("Wat kost dat bij jullie"));
  advance(0);
  await flush();
  assert.equal(autoInputs().length, 1);
  assert.deepEqual(events, [{ kind: "skip", id: "tip-1" }]);
  advance(300);
  coach.onTranscript(finalLine("Wat kost dat bij jullie per maand?")); // 2 words more
  advance(1200); // 1.5 s after the draft
  assert.equal(autoInputs().length, 2);
  assert.ok(autoInputs()[1].includes("THEM: Wat kost dat bij jullie per maand?"), autoInputs()[1]);
  assert.ok(!autoInputs()[1].includes("(still speaking)"));
  await flush();
  assert.deepEqual(starts(events)[0], { kind: "start", id: "tip-2", trigger: "auto", label: "price" });
  advance(10_000);
  assert.equal(autoInputs().length, 2, "only one refresh");
});

test("review 2: a PASS that arrives after the final line also asks once more", async (t) => {
  const gate = deferred();
  const { coach, advance, autoInputs } = draftSetup(t, [fakeBrain(["", "PASS"], { gate: gate.promise }), fakeBrain(["Vraag naar het budget."])]);
  coach.onTranscript(interim("Wat kost dat bij jullie"));
  advance(0);
  await flush();
  coach.onTranscript(finalLine("Wat kost dat bij jullie per maand?")); // nearly the same words, the request still runs
  advance(1000);
  assert.equal(autoInputs().length, 1);
  gate.resolve();
  await flush();
  advance(500); // 1.5 s after the draft
  assert.equal(autoInputs().length, 2);
  assert.ok(!autoInputs()[1].includes("(still speaking)"));
  await flush();
});

for (const text of ["Wat kost", "Wat kost het?", "Werkt dat?"]) {
  test(`review 2/4: "${text}" (under 4 words) does not start a draft yet`, async (t) => {
    const { coach, advance, autoInputs } = draftSetup(t);
    coach.onTranscript(interim(text));
    advance(2000);
    assert.equal(autoInputs().length, 0);
    await flush();
  });
}

test("review 3: auto and draft requests stay under 10 per rolling minute; a hotkey is always allowed", async (t) => {
  const { coach, b, advance } = autoSetup(t);
  for (let i = 0; i < 10; i++) {
    coach.onTranscript(said("them", `Dit is gewoon zin nummer ${i} van het gesprek.`, `t${i}`));
    advance(3000);
    await flush();
  }
  assert.equal(b.requests.length, 10); // the first went out 600 ms after the first line
  coach.onTranscript(said("them", "En dan nog een laatste vraag over de opzegtermijn.", "t10"));
  advance(30_599); // 60.599 s after the first line: 59.999 s after the first request
  assert.equal(b.requests.length, 10);
  await coach.requestTip("hotkey");
  assert.equal(b.requests.length, 11, "the hotkey does not wait for the limit");
  assert.ok(b.requests[10].input.startsWith("HOTKEY request."));
  advance(5000); // the hotkey answer is shown: its 5 s cooldown passes too
  assert.equal(b.requests.length, 12);
  assert.ok(b.requests[11].input.startsWith("AUTO request."));
  await flush();
});

test("review 3: an aborted draft counts for the limit too", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t, Array.from({ length: 12 }, () => fakeBrain(["Vraag door."], { abortAware: true })));
  let words = "Dat vind ik best duur";
  coach.onTranscript(interim(words));
  advance(0);
  for (let i = 0; i < 12; i++) {
    advance(1500);
    words += " en nog veel meer woorden erbij";
    coach.onTranscript(interim(words));
    advance(0);
    await flush();
  }
  assert.equal(autoInputs().length, 10, "at most 10 in the first minute");
  await flush();
});

test("review 5: a refinement does not abort its own request before it shows anything", async (t) => {
  const gate = deferred();
  const first = fakeBrain(["", "Vraag waarmee hij vergelijkt."], { gate: gate.promise, abortAware: true });
  const { coach, advance, autoInputs, events } = draftSetup(t, [first, fakeBrain(["Vraag naar het budget."])]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush(); // the first request runs; its first word has not come yet
  advance(500);
  coach.onTranscript(interim("Dat vind ik best duur voor zo'n kleine website eerlijk gezegd"));
  advance(1000); // 1.5 s: the refinement would be allowed, but its own request is still loading
  assert.equal(autoInputs().length, 1);
  assert.ok(!first.requests[0].signal.aborted);
  advance(500);
  gate.resolve(); // the slow answer arrives after 2 s
  await flush();
  assert.equal(textOf(events, "tip-1"), "Vraag waarmee hij vergelijkt.");
  advance(0);
  assert.equal(autoInputs().length, 2, "the refinement follows once the first one ended");
  assert.ok(!first.requests[0].signal.aborted);
  await flush();
  assert.equal(starts(events)[1].replaces, "tip-1");
});

test("review 5: a request that shows nothing for 3 s is cut off by its refinement", async (t) => {
  const gate = deferred();
  const first = fakeBrain(["", "Te laat."], { gate: gate.promise, abortAware: true });
  const { coach, advance, autoInputs } = draftSetup(t, [first]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush();
  advance(500);
  coach.onTranscript(interim("Dat vind ik best duur voor zo'n kleine website eerlijk gezegd"));
  advance(2499);
  assert.equal(autoInputs().length, 1);
  advance(1); // 3 s after the first request
  assert.equal(autoInputs().length, 2);
  assert.ok(first.requests[0].signal.aborted);
  gate.resolve();
  await flush();
});

test("review 6: a refinement that answers PASS while THEM still talks withdraws the draft tip", async (t) => {
  const { coach, advance, events } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."]), fakeBrain(["PASS"])]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush();
  advance(1500);
  coach.onTranscript(interim("Dat vind ik best duur, maar nee hoor dat maakt eigenlijk niks uit"));
  advance(0);
  await flush();
  assert.deepEqual(events.slice(-2), [
    { kind: "skip", id: "tip-2" },
    { kind: "retract", id: "tip-1" },
  ]);
  coach.onTranscript(interim("Volgende punt", "t2")); // THEM moves on: the withdrawn tip is not made final
  coach.cancel();
  assert.ok(!events.some((e) => e.kind === "final"), JSON.stringify(events));
});

test("review 7: a refinement that fails emits no start, so the draft tip on screen stays", async (t) => {
  const { coach, advance, events, warnings } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."]), fakeBrain([], { error: new Error("Gemini 429") })]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush();
  advance(1500);
  coach.onTranscript(interim("Dat vind ik best duur voor zo'n kleine website eerlijk gezegd"));
  advance(0);
  await flush();
  assert.deepEqual(events.slice(-1), [{ kind: "skip", id: "tip-2" }]);
  assert.equal(starts(events).length, 1);
  assert.ok(!events.some((e) => e.kind === "error"));
  assert.deepEqual(warnings, ["Automatic tip failed: Gemini 429"]);
});

test("review 10: an empty final on a line that had a request asks nothing and makes its tip final", async (t) => {
  const { coach, advance, events, autoInputs } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."])]);
  coach.onTranscript(interim("Dat vind ik best duur"));
  advance(0);
  await flush();
  coach.onTranscript(finalLine(""));
  advance(10_000);
  assert.equal(autoInputs().length, 1);
  assert.deepEqual(events.at(-1), { kind: "final", id: "tip-1" });
  await flush();
});

test("review 10: a late corrected final after the draft was dropped asks nothing again", async (t) => {
  const gate = deferred();
  const { coach, advance, autoInputs, used } = draftSetup(t, [fakeBrain(["Vraag waarmee hij vergelijkt."]), fakeBrain(["", "Vraag naar het contract."], { gate: gate.promise, abortAware: true })]);
  coach.onTranscript(interim("Dat vind ik best duur", "t1"));
  advance(0);
  await flush();
  coach.onTranscript(finalLine("Dat vind ik best duur.", "t1"));
  advance(5000);
  coach.onTranscript(interim("En hoe zit het met het contract", "t2"));
  advance(0);
  assert.equal(autoInputs().length, 2);
  coach.onTranscript(finalLine("Dat vind ik eigenlijk best wel duur zo.", "t1")); // corrected final for t1
  advance(10_000);
  assert.equal(autoInputs().length, 2, "no duplicate request");
  assert.ok(!used[1].requests[0].signal.aborted, "the draft for the next line keeps running");
  gate.resolve();
  await flush();
});

test("review 12: a classic auto request does not mark a merged THEM line as still speaking", async (t) => {
  const { coach, advance, autoInputs } = draftSetup(t, [], { whileSpeaking: false });
  coach.onTranscript(finalLine("Dat vind ik eigenlijk te duur.", "t1"));
  advance(300);
  coach.onTranscript(interim("En verder", "t2"));
  advance(300);
  assert.equal(autoInputs().length, 1);
  assert.ok(autoInputs()[0].includes("THEM: Dat vind ik eigenlijk te duur. En verder"), autoInputs()[0]);
  assert.ok(!autoInputs()[0].includes("(still speaking)"));
  await flush();
});
