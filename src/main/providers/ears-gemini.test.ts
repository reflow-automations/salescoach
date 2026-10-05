import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { MAX_FAILED_ATTEMPTS, reconnectDelay, type EarsOptions, type EarsText, type OpenSocket } from "./ears";
import {
  ROLLOVER_MS,
  SESSION_CAP_MS,
  SWITCH_DEADLINE_MS,
  SWITCH_SILENCE_CHUNKS,
  createGeminiEars,
  isFatalGeminiClose,
  rolloverRetryDelay,
} from "./ears-gemini";

/** Lets setImmediate callbacks run (setImmediate is never mocked here). */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** Stand-in for a ws client; the test plays the server. Close events arrive async, like ws. */
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: any[] = [];
  closeCalls = 0;
  terminated = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closeCalls += 1;
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
  /** Upgrade accepted and setupComplete sent. */
  ready(): void {
    this.accept();
    this.msg({ setupComplete: {} });
  }
  fail(message: string): void {
    this.emit("error", new Error(message));
    this.finish(1006, "");
  }
  serverClose(code: number, reason = ""): void {
    this.finish(code, reason);
  }
  audio(): number {
    return this.sent.filter((m) => m.realtimeInput?.audio).length;
  }
  ended(): boolean {
    return this.sent.some((m) => m.realtimeInput?.audioStreamEnd);
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
    apiKey: "AIza-test",
    language: "nl",
    vocabulary: [],
    onText: (t) => texts.push(t),
    onStatus: (message, level) => statuses.push({ message, level }),
    onFatal: (m) => fatals.push(m),
  };
  return { sockets, texts, statuses, fatals, session: createGeminiEars(opts, "them", open) };
}

const loud = () => {
  const b = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) b.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return b;
};
const quiet = () => Buffer.alloc(3200);
const final = (text: string) => ({ serverContent: { inputTranscription: { text } } });
const interim = (text: string) => ({ serverContent: { interimInputTranscription: { text } } });

test("isFatalGeminiClose: bad key, permission or unknown model, or 1007/1008 before setup", () => {
  assert.equal(isFatalGeminiClose(1008, "API key not valid. Please pass a valid API key.", false), true);
  assert.equal(isFatalGeminiClose(1011, "The caller does not have permission", true), true);
  assert.equal(isFatalGeminiClose(1008, "models/x is not found for API version v1beta", false), true);
  assert.equal(isFatalGeminiClose(1007, "", false), true);
  assert.equal(isFatalGeminiClose(1008, "", true), false, "after setup a 1008 may be transient");
  assert.equal(isFatalGeminiClose(1006, "", false), false);
  assert.equal(isFatalGeminiClose(1011, "Internal error encountered.", true), false);
});

test("rolloverRetryDelay backs off but never past the switch safety margin", () => {
  assert.equal(rolloverRetryDelay(1, ROLLOVER_MS), 2000);
  assert.equal(rolloverRetryDelay(2, ROLLOVER_MS), 4000);
  assert.equal(rolloverRetryDelay(9, ROLLOVER_MS), 20_000);
  assert.equal(rolloverRetryDelay(9, SESSION_CAP_MS - 35_000), 5000);
  assert.equal(rolloverRetryDelay(9, SESSION_CAP_MS), 2000);
});

test("rollover: the next session gets no audio until a pause, so every chunk goes to one session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  const [a] = h.sockets;
  a.ready();
  for (let i = 0; i < 3; i++) h.session.send(loud());
  t.mock.timers.tick(ROLLOVER_MS);
  assert.equal(h.sockets.length, 2);
  const b = h.sockets[1];
  b.ready();
  for (let i = 0; i < 5; i++) h.session.send(loud());
  assert.equal(b.audio(), 0, "no audio to the next session before the switch");
  for (let i = 0; i < SWITCH_SILENCE_CHUNKS; i++) h.session.send(quiet());
  assert.equal(a.audio() + b.audio(), 3 + 5 + SWITCH_SILENCE_CHUNKS, "each chunk sent exactly once");
  assert.equal(b.audio(), 1, "the chunk that completed the pause goes to the new session");
  assert.ok(a.ended(), "old session got audioStreamEnd");
  h.session.send(loud());
  assert.equal(b.audio(), 2);
  t.mock.timers.tick(3000);
  assert.equal(a.closeCalls, 1);
});

test("a final transcription from the old session triggers the switch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  const [a] = h.sockets;
  a.ready();
  t.mock.timers.tick(ROLLOVER_MS);
  const b = h.sockets[1];
  b.ready();
  h.session.send(loud());
  a.msg(final("Klopt, dat is het."));
  h.session.send(loud());
  assert.equal(a.audio(), 1);
  assert.equal(b.audio(), 1);
  assert.equal(h.texts.at(-1)!.text, "Klopt, dat is het.");
});

test("without a pause the switch still happens by the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  const [a] = h.sockets;
  a.ready();
  t.mock.timers.tick(ROLLOVER_MS);
  const b = h.sockets[1];
  b.ready();
  h.session.send(loud());
  t.mock.timers.tick(SWITCH_DEADLINE_MS);
  h.session.send(loud());
  assert.equal(a.audio(), 1);
  assert.equal(b.audio(), 1);
});

test("when the live session dies during a rollover, the pending one takes over: no third session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  const [a] = h.sockets;
  a.ready();
  t.mock.timers.tick(ROLLOVER_MS);
  const b = h.sockets[1];
  b.accept(); // still waiting for setupComplete
  a.serverClose(1011, "Internal error");
  await flush();
  h.session.send(loud());
  h.session.send(loud());
  t.mock.timers.tick(30_000);
  assert.equal(h.sockets.length, 2);
  b.msg({ setupComplete: {} });
  assert.equal(b.audio(), 2, "audio queued during the handover is flushed once");
  assert.equal(h.fatals.length, 0);
});

test("a retired session that reports setupComplete again never takes over", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  const [a] = h.sockets;
  a.ready();
  t.mock.timers.tick(ROLLOVER_MS);
  const b = h.sockets[1];
  b.ready();
  t.mock.timers.tick(SWITCH_DEADLINE_MS);
  a.msg({ setupComplete: {} });
  a.msg({ goAway: { timeLeft: "1s" } }); // also ignored: it is not the live session
  h.session.send(loud());
  assert.equal(b.audio(), 1);
  assert.equal(a.audio(), 0);
  assert.equal(h.sockets.length, 2);
});

test("a failed rollover is retried with backoff before the cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].ready();
  t.mock.timers.tick(ROLLOVER_MS);
  h.sockets[1].fail("Unexpected server response: 503");
  await flush();
  t.mock.timers.tick(rolloverRetryDelay(1, ROLLOVER_MS));
  assert.equal(h.sockets.length, 3);
  const c = h.sockets[2];
  c.ready();
  h.session.send(quiet());
  for (let i = 0; i < SWITCH_SILENCE_CHUNKS; i++) h.session.send(quiet());
  assert.ok(c.audio() > 0, "the retried session took over");
  assert.equal(h.fatals.length, 0);
  assert.ok(!h.statuses.some((s) => s.level !== "info"), "a rollover hiccup is not shown to the user");
});

test("goAway from the live session starts a rollover at once and switches as soon as it is ready", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  const [a] = h.sockets;
  a.ready();
  a.msg({ goAway: { timeLeft: "5s" } });
  assert.equal(h.sockets.length, 2);
  h.session.send(loud());
  assert.equal(a.audio(), 1, "keeps feeding the old session until the new one is ready");
  h.sockets[1].ready();
  h.session.send(loud());
  assert.equal(h.sockets[1].audio(), 1);
  assert.ok(a.ended());
});

test("close() during a rollover leaves nothing running", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].ready();
  t.mock.timers.tick(ROLLOVER_MS);
  const b = h.sockets[1];
  b.accept();
  h.session.close();
  assert.ok(b.terminated, "a session that never got ready is cut off at once");
  b.msg({ setupComplete: {} });
  t.mock.timers.tick(3 * ROLLOVER_MS);
  await flush();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.fatals.length, 0);
});

test("a 1008 with an invalid-key reason is fatal: one onFatal, no reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].accept();
  h.sockets[0].serverClose(1008, "API key not valid. Please pass a valid API key.");
  await flush();
  assert.equal(h.fatals.length, 1);
  assert.match(h.fatals[0], /API key not valid/);
  assert.deepEqual(h.statuses, []);
  t.mock.timers.tick(60_000);
  assert.equal(h.sockets.length, 1);
});

test("an HTTP 403 on the upgrade is fatal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.sockets[0].fail("Unexpected server response: 403");
  await flush();
  assert.equal(h.fatals.length, 1);
  assert.match(h.fatals[0], /HTTP 403/);
  t.mock.timers.tick(60_000);
  assert.equal(h.sockets.length, 1);
});

test("attempts that never get ready stop after the cap; warnings keep the last error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    h.sockets[i].fail("getaddrinfo ENOTFOUND generativelanguage.googleapis.com");
    await flush();
    if (i < MAX_FAILED_ATTEMPTS - 1) {
      assert.match(h.statuses.at(-1)!.message, /ENOTFOUND/);
      t.mock.timers.tick(reconnectDelay(i + 1));
    }
  }
  assert.equal(h.fatals.length, 1);
  assert.match(h.fatals[0], /ENOTFOUND/);
  t.mock.timers.tick(60_000);
  assert.equal(h.sockets.length, MAX_FAILED_ATTEMPTS);
});

test("a healthy session that drops reconnects after 1 s and says when it is back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  const [a] = h.sockets;
  a.ready();
  a.msg(interim("Goedemiddag"));
  a.serverClose(1011, "Internal error encountered.");
  await flush();
  assert.deepEqual(h.texts.at(-1), { id: h.texts[0].id, text: "Goedemiddag", final: true }, "the hanging interim is finalized");
  assert.match(h.statuses.at(-1)!.message, /Internal error encountered\..*over 1 s/);
  t.mock.timers.tick(1000);
  assert.equal(h.sockets.length, 2);
  h.sockets[1].ready();
  assert.deepEqual(h.statuses.at(-1), { message: "Luistert weer mee", level: "info" });
});
