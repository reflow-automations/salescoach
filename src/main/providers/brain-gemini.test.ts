import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { BrainError } from "./brain";
import { createGeminiBrain } from "./brain-gemini";

const enc = new TextEncoder();

function ok(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Vraag door." }] } }] })}\n\n`));
      c.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

const badRequest = (message: string) => new Response(JSON.stringify({ error: { message, status: "INVALID_ARGUMENT" } }), { status: 400 });

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

const ask = (model: string) =>
  createGeminiBrain({ model, apiKey: "AIza-test" })({
    instructions: "Coach",
    input: "THEM: te duur",
    signal: new AbortController().signal,
    onDelta: () => {},
  });

test("a thinkingLevel rejection is remembered across brains", async (t) => {
  const calls = stubFetch(t, (b) =>
    b.generationConfig.thinkingConfig ? badRequest('Invalid JSON payload received. Unknown name "thinkingLevel" at \'generation_config.thinking_config\'.') : ok(),
  );
  assert.equal(await ask("gemini-knob-remembered"), "Vraag door.");
  assert.equal(calls.length, 2);
  assert.equal(await ask("gemini-knob-remembered"), "Vraag door.");
  assert.equal(calls.length, 3, "a fresh Brain for the same model skips the knob");
  assert.equal(calls[2].generationConfig.thinkingConfig, undefined);
});

test("a bad key (also a 400) fails at once and keeps the knob on", async (t) => {
  const calls = stubFetch(t, () => badRequest("API key not valid. Please pass a valid API key."));
  await assert.rejects(ask("gemini-bad-key"), (e: unknown) => e instanceof BrainError && /API key not valid/.test(e.message));
  assert.equal(calls.length, 1);
  await assert.rejects(ask("gemini-bad-key"));
  assert.deepEqual(calls[1].generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
});
