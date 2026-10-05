import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDrop, isFatalUpgradeStatus, newUtteranceId, reconnectDelay, rms, upgradeStatus, upsample16kTo24k } from "./ears";

test("upgradeStatus reads the HTTP status from a ws upgrade error", () => {
  assert.equal(upgradeStatus(new Error("Unexpected server response: 401")), 401);
  assert.equal(upgradeStatus("Unexpected server response: 503"), 503);
  assert.equal(upgradeStatus(new Error("connect ECONNREFUSED 127.0.0.1:443")), undefined);
});

test("only 401, 403 and 404 on the upgrade are permanent", () => {
  assert.deepEqual(
    [400, 401, 403, 404, 429, 500, 503, undefined].map(isFatalUpgradeStatus),
    [false, true, true, true, false, false, false, false],
  );
});

test("describeDrop keeps both the close reason and the last error", () => {
  assert.equal(describeDrop(1006, "", "Unexpected server response: 503"), "Unexpected server response: 503");
  assert.equal(describeDrop(1011, "Internal error", "socket hang up"), "Internal error, socket hang up");
  assert.equal(describeDrop(1011, "Internal error", "Internal error"), "Internal error");
  assert.equal(describeDrop(1006, " ", ""), "code 1006");
});

test("reconnectDelay grows from 1 s to a 10 s cap", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(reconnectDelay), [1000, 2000, 4000, 8000, 10_000, 10_000]);
});

function pcm(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

function samplesOf(b: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < b.length; i += 2) out.push(b.readInt16LE(i));
  return out;
}

test("rms of silence is 0", () => {
  assert.equal(rms(Buffer.alloc(3200)), 0);
});

test("rms of an empty buffer is 0", () => {
  assert.equal(rms(Buffer.alloc(0)), 0);
  assert.equal(rms(Buffer.alloc(1)), 0);
});

test("rms of a full-scale square wave is about 1", () => {
  const square = pcm(Array.from({ length: 1600 }, (_, i) => (Math.floor(i / 8) % 2 ? 32767 : -32768)));
  const v = rms(square);
  assert.ok(v > 0.999 && v <= 1, `got ${v}`);
});

test("rms of a half-scale square wave is about 0.5", () => {
  const square = pcm(Array.from({ length: 1600 }, (_, i) => (i % 2 ? 16384 : -16384)));
  assert.ok(Math.abs(rms(square) - 0.5) < 1e-9);
});

test("upsample16kTo24k makes the output 1.5x as long", () => {
  for (const n of [1600, 160, 2, 4]) {
    const out = upsample16kTo24k(pcm(new Array(n).fill(0)));
    assert.equal(out.length, n * 3, `input ${n} samples`);
  }
});

test("upsample16kTo24k of 100 ms at 16 kHz gives 100 ms at 24 kHz", () => {
  const out = upsample16kTo24k(Buffer.alloc(3200));
  assert.equal(out.length / 2, 2400);
});

test("upsample16kTo24k preserves a constant signal", () => {
  for (const c of [0, 1234, -5000, 32767, -32768]) {
    const out = samplesOf(upsample16kTo24k(pcm(new Array(1600).fill(c))));
    assert.equal(out.length, 2400);
    assert.ok(out.every((s) => s === c), `constant ${c} not preserved`);
  }
});

test("upsample16kTo24k keeps the original samples on the shared grid and interpolates between", () => {
  const out = samplesOf(upsample16kTo24k(pcm([0, 300, 600, 900])));
  // Output sample i sits at input position 2i/3.
  assert.deepEqual(out, [0, 200, 400, 600, 800, 900]);
});

test("upsample16kTo24k of an empty buffer is empty", () => {
  assert.equal(upsample16kTo24k(Buffer.alloc(0)).length, 0);
});

test("newUtteranceId is unique and keeps the prefix", () => {
  const a = newUtteranceId("them");
  const b = newUtteranceId("them");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("them-"));
});
