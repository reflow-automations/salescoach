import { test } from "node:test";
import assert from "node:assert/strict";
import { BrainError, errorFrom, readSse } from "./brain";

const enc = new TextEncoder();

/** A Response whose body arrives in exactly these chunks (strings or raw bytes). */
function sseResponse(chunks: (string | Uint8Array)[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

async function collect(res: Response, signal = new AbortController().signal): Promise<string[]> {
  const out: string[] = [];
  for await (const d of readSse(res, signal)) out.push(d);
  return out;
}

test("readSse yields each data payload", async () => {
  const res = sseResponse(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']);
  assert.deepEqual(await collect(res), ['{"a":1}', '{"a":2}']);
});

test("readSse joins events that are split across chunk boundaries", async () => {
  const res = sseResponse(["da", 'ta: {"text":"Vra', 'ag"}\n', "\n", "data: tw", "ee\n\nda", "ta: drie\n\n"]);
  assert.deepEqual(await collect(res), ['{"text":"Vraag"}', "twee", "drie"]);
});

test("readSse handles CRLF separators, also when split inside the CRLF pair", async () => {
  const res = sseResponse(["data: een\r\n\r\n", "data: twee\r", "\n\r", "\ndata: drie\r\n", "\r\n"]);
  assert.deepEqual(await collect(res), ["een", "twee", "drie"]);
});

test("readSse joins multi-line data with a newline and ignores other fields", async () => {
  const res = sseResponse([": keep-alive comment\n", "event: message\nid: 7\ndata: regel 1\ndata: regel 2\ndata:zonder spatie\n\n"]);
  assert.deepEqual(await collect(res), ["regel 1\nregel 2\nzonder spatie"]);
});

test("readSse yields the [DONE] payload as a plain string", async () => {
  const res = sseResponse(['data: {"type":"response.output_text.delta","delta":"Hoi"}\n\n', "data: [DONE]\n\n"]);
  const out = await collect(res);
  assert.equal(out.at(-1), "[DONE]");
  assert.equal(out.length, 2);
});

test("readSse skips blocks without data and ignores an unterminated last block", async () => {
  const res = sseResponse(["event: ping\n\n", "data: echt\n\n", "data: half"]);
  assert.deepEqual(await collect(res), ["echt"]);
});

test("readSse decodes UTF-8 characters split across chunks (no mojibake)", async () => {
  const bytes = enc.encode("data: café één\n\n");
  // Split inside the two-byte sequence of the first "é".
  const cut = bytes.indexOf(0xc3) + 1;
  const res = sseResponse([bytes.slice(0, cut), bytes.slice(cut)]);
  assert.deepEqual(await collect(res), ["café één"]);
});

test("readSse stops when the signal is already aborted", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const res = sseResponse(["data: een\n\n"]);
  assert.deepEqual(await collect(res, ctrl.signal), []);
});

test("readSse stops reading after the signal aborts mid-stream", async () => {
  const ctrl = new AbortController();
  const res = sseResponse(["data: een\n\n", "data: twee\n\n", "data: drie\n\n"]);
  const out: string[] = [];
  for await (const d of readSse(res, ctrl.signal)) {
    out.push(d);
    ctrl.abort();
  }
  assert.deepEqual(out, ["een"]);
});

test("readSse on a response without body yields nothing", async () => {
  assert.deepEqual(await collect(new Response(null, { status: 204 })), []);
});

test("errorFrom reads the provider error message and code", async () => {
  const res = new Response(JSON.stringify({ error: { message: "API key not valid", status: "INVALID_ARGUMENT" } }), { status: 400 });
  const err = await errorFrom(res, "Gemini");
  assert.ok(err instanceof BrainError);
  assert.equal(err.message, "Gemini 400: API key not valid");
  assert.equal(err.status, 400);
  assert.equal(err.code, "INVALID_ARGUMENT");
});

test("errorFrom falls back to the status text for a non-JSON body", async () => {
  const res = new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
  const err = await errorFrom(res, "OpenAI");
  assert.equal(err.message, "OpenAI 502: Bad Gateway");
});
