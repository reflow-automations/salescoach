import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { MAX_FAILED_ATTEMPTS, reconnectDelay, type EarsOptions, type EarsText, type OpenSocket } from "./ears";
import { STALE_INTERIM_MS, createOpenAIEars, isFatalOpenAIError } from "./ears-openai";

/** Lets setImmediate callbacks run (setImmediate is never mocked here). */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** Stand-in for a ws client; the test plays the server. Close events arrive async, like ws. */
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: any[] = [];
  terminated = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.finish(1000, "");
  }
  terminate(): void {
    this.terminated = true;
    this.finish(1006, "");
  }
  accept(): void {
    this.readyState = 1;
    this.emit("open");
  }
  msg(obj: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(obj)));
  }
  fail(message: string): void {
    this.emit("error", new Error(message));
    this.finish(1006, "");
  }
  serverClose(code: number, reason = ""): void {
    this.finish(code, reason);
  }
  private finish(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setImmediate(() => this.emit("close", code, Buffer.from(reason)));
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const texts: EarsText[] = [];
  const statuses: { message: string; level: string }[] = [];
  const fatals: string[] = [];
  const open: OpenSocket = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s as unknown as WebSocket;
  };
  const opts: EarsOptions = {
    apiKey: "sk-test",
    language: "nl",
    vocabulary: [],
    onText: (t) => texts.push(t),
    onStatus: (message, level) => statuses.push({ message, level }),
    onFatal: (m) => fatals.push(m),
  };
  return { sockets, texts, statuses, fatals, session: createOpenAIEars(opts, "them", open) };
}

const delta = (item: string, d: string) => ({ type: "conversation.item.input_audio_transcription.delta", item_id: item, delta: d });
const completed = (item: string, transcript: string) => ({ type: "conversation.item.input_audio_transcription.completed", item_id: item, transcript });

test("isFatalOpenAIError knows the permanent error codes", () => {
  assert.equal(isFatalOpenAIError({ code: "invalid_api_key" }), true);
  assert.equal(isFatalOpenAIError({ code: "insufficient_quota" }), true);
  assert.equal(isFatalOpenAIError({ code: "model_not_found" }), true);
  assert.equal(isFatalOpenAIError({ type: "permission_error" }), true);
  assert.equal(isFatalOpenAIError({ type: "authentication_error" }), true);
  assert.equal(isFatalOpenAIError({ code: "rate_limit_exceeded" }), false);
  assert.equal(isFatalOpenAIError({ type: "invalid_request_error", code: "input_audio_buffer_commit_empty" }), false);
  assert.equal(isFatalOpenAIError(undefined), false);
});

test("a 401 on the upgrade is fatal: one onFatal, no warning, no reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].fail("Unexpected server response: 401");
  await flush();
  assert.equal(h.fatals.length, 1);
  assert.match(h.fatals[0], /HTTP 401/);
  assert.deepEqual(h.statuses, []);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(h.sockets.length, 1);
  h.session.close();
  assert.equal(h.fatals.length, 1);
});

test("an invalid_api_key error event is fatal and closes the socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].accept();
  h.sockets[0].msg({ type: "error", error: { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key provided." } });
  assert.equal(h.fatals.length, 1);
  assert.match(h.fatals[0], /Incorrect API key provided\. Controleer/);
  assert.ok(h.sockets[0].terminated);
  await flush();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(h.sockets.length, 1);
  assert.ok(!h.statuses.some((s) => s.level === "warn"));
});

test("attempts that never get healthy stop after the cap; open alone does not reset it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    const s = h.sockets[i];
    if (i % 2) {
      // Upgrade accepted, then dropped right away: still a failed attempt.
      s.accept();
      s.serverClose(1011, "");
    } else {
      s.fail("connect ECONNREFUSED 10.0.0.1:443");
    }
    await flush();
    if (i < MAX_FAILED_ATTEMPTS - 1) {
      const last = h.statuses.at(-1)!;
      assert.equal(last.level, "warn");
      if (!(i % 2)) assert.match(last.message, /ECONNREFUSED/, "the warning keeps the cause");
      t.mock.timers.tick(reconnectDelay(i + 1));
      assert.equal(h.sockets.length, i + 2);
    }
  }
  assert.equal(h.fatals.length, 1);
  assert.match(h.fatals[0], new RegExp(`${MAX_FAILED_ATTEMPTS} pogingen`));
  t.mock.timers.tick(60_000);
  assert.equal(h.sockets.length, MAX_FAILED_ATTEMPTS);
});

test("a session that delivered a transcript is healthy: the next drop retries after 1 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  for (let i = 0; i < 3; i++) {
    h.sockets[i].fail("socket hang up");
    await flush();
    t.mock.timers.tick(reconnectDelay(i + 1));
  }
  const s = h.sockets[3];
  s.accept();
  s.msg({ type: "session.updated" });
  s.msg(completed("item_1", "Dat is te duur."));
  s.serverClose(1006);
  await flush();
  assert.match(h.statuses.at(-1)!.message, /over 1 s/);
  t.mock.timers.tick(1000);
  assert.equal(h.sockets.length, 5);
  assert.equal(h.fatals.length, 0);
});

test("interim text is finalized when the socket drops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].accept();
  h.sockets[0].msg(delta("item_1", "Hallo, "));
  h.sockets[0].msg(delta("item_1", "met wie"));
  h.sockets[0].serverClose(1006);
  await flush();
  const last = h.texts.at(-1)!;
  assert.deepEqual(last, { id: h.texts[0].id, text: "Hallo, met wie", final: true });
});

test("interim text without a completed event is promoted; a late completed corrects the same line", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  const s = h.sockets[0];
  s.accept();
  s.msg(delta("item_1", "Wat kost"));
  const id = h.texts[0].id;
  t.mock.timers.tick(STALE_INTERIM_MS);
  assert.deepEqual(h.texts.at(-1), { id, text: "Wat kost", final: true });
  s.msg(delta("item_1", " dat")); // ignored: the line is already final
  assert.equal(h.texts.length, 2);
  s.msg(completed("item_1", "Wat kost dat?"));
  assert.deepEqual(h.texts.at(-1), { id, text: "Wat kost dat?", final: true });
});

test("a completed event with an empty transcript removes the interim line", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].accept();
  h.sockets[0].msg(delta("item_1", "eh"));
  h.sockets[0].msg(completed("item_1", ""));
  assert.deepEqual(h.texts.at(-1), { id: h.texts[0].id, text: "", final: true });
  t.mock.timers.tick(STALE_INTERIM_MS);
  assert.equal(h.texts.length, 2, "no late promotion");
});

test("a failed transcription keeps the words heard so far and warns", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].accept();
  h.sockets[0].msg(delta("item_1", "Wij willen"));
  h.sockets[0].msg({ type: "conversation.item.input_audio_transcription.failed", item_id: "item_1", error: { message: "audio unreadable" } });
  assert.deepEqual(h.texts.at(-1), { id: h.texts[0].id, text: "Wij willen", final: true });
  assert.equal(h.statuses.at(-1)!.level, "warn");
  assert.match(h.statuses.at(-1)!.message, /audio unreadable/);
});

test("a non-fatal error event is shown; an empty-buffer commit error stays silent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].accept();
  h.sockets[0].msg({ type: "error", error: { code: "input_audio_buffer_commit_empty", message: "Error committing input audio buffer: buffer too small." } });
  assert.deepEqual(h.statuses, []);
  h.sockets[0].msg({ type: "error", error: { code: "rate_limit_exceeded", message: "Slow down" } });
  assert.deepEqual(h.statuses, [{ message: "OpenAI: Slow down", level: "error" }]);
  assert.equal(h.fatals.length, 0);
});

test("close() never reconnects and never reports a fatal error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].accept();
  h.session.close();
  t.mock.timers.tick(2000);
  await flush();
  t.mock.timers.tick(60_000);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.fatals.length, 0);
  assert.ok(!h.statuses.some((s) => s.level === "warn"));
});
