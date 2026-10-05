import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { BrainError } from "./brain";
import { createOpenAIBrain } from "./brain-openai";

const enc = new TextEncoder();

function sse(events: unknown[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

const ok = () => sse([{ type: "response.output_text.delta", delta: "Vraag door." }, { type: "response.completed" }]);
const badRequest = (message: string, param?: string) =>
  new Response(JSON.stringify({ error: { message, param, type: "invalid_request_error" } }), { status: 400 });
const knobRejected = () => badRequest("Unsupported parameter: 'reasoning.effort' is not supported with this model.", "reasoning.effort");

/** Replaces fetch for one test and records each request body. */
function stubFetch(t: TestContext, reply: (body: any) => Response): any[] {
  const calls: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return reply(body);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const ask = (model: string, planUsage = false) =>
  createOpenAIBrain({ model, getToken: async () => "sk-test", planUsage })({
    instructions: "Coach",
    input: "THEM: te duur",
    signal: new AbortController().signal,
    onDelta: () => {},
  });

test("a knob rejection is remembered across brains, so the next tip needs one request", async (t) => {
  const calls = stubFetch(t, (b) => (b.reasoning ? knobRejected() : ok()));
  assert.equal(await ask("knobs-remembered"), "Vraag door.");
  assert.equal(calls.length, 2);
  assert.equal(await ask("knobs-remembered"), "Vraag door.");
  assert.equal(calls.length, 3, "a fresh Brain for the same model skips the knobs");
  assert.equal(calls[2].reasoning, undefined);
});

test("a 400 that is not about the knobs fails at once and keeps the knobs on", async (t) => {
  const calls = stubFetch(t, () => badRequest("The requested model 'knobs-other-400' does not exist.", "model"));
  await assert.rejects(ask("knobs-other-400"), (e: unknown) => e instanceof BrainError && e.status === 400 && /does not exist/.test(e.message));
  assert.equal(calls.length, 1, "no pointless second request");
  await assert.rejects(ask("knobs-other-400"));
  assert.deepEqual(calls[1].reasoning, { effort: "none" });
});

test("a knob 400 whose retry also fails is not remembered", async (t) => {
  const calls = stubFetch(t, (b) => (b.reasoning ? knobRejected() : new Response("{}", { status: 500, statusText: "Server Error" })));
  await assert.rejects(ask("knobs-retry-fails"), (e: unknown) => e instanceof BrainError && e.status === 500);
  assert.equal(calls.length, 2);
  await assert.rejects(ask("knobs-retry-fails"));
  assert.deepEqual(calls[2].reasoning, { effort: "none" }, "knobs are tried again");
});

test("ChatGPT-plan requests ask for low reasoning but never send sampling fields", async (t) => {
  const calls = stubFetch(t, () => ok());
  await ask("plan-model", true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].reasoning, { effort: "low" });
  assert.equal(calls[0].max_output_tokens, undefined);
});
