import { test } from "node:test";
import assert from "node:assert/strict";
import { CHUNK_SAMPLES, Pcm16Chunker } from "./pcm-chunker";

const QUANTUM = 128; // frames per AudioWorklet process() call

function collect(): { chunks: Int16Array[]; chunker: Pcm16Chunker } {
  const chunks: Int16Array[] = [];
  return { chunks, chunker: new Pcm16Chunker((buf) => chunks.push(new Int16Array(buf))) };
}

const filled = (value: number, n = QUANTUM): Float32Array => new Float32Array(n).fill(value);

test("emits one 100 ms chunk per 1600 samples, across render quanta", () => {
  const { chunks, chunker } = collect();
  for (let i = 0; i < 12; i++) chunker.push([filled(0.25)]); // 1536 frames
  assert.equal(chunks.length, 0);
  chunker.push([filled(0.25)]); // 1664 frames
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, CHUNK_SAMPLES);
  assert.equal(chunks[0][0], Math.trunc(0.25 * 0x7fff));
});

test("a speaker on the right channel only still reaches the transcriber", () => {
  const { chunks, chunker } = collect();
  const left = filled(0, CHUNK_SAMPLES);
  const right = filled(0.5, CHUNK_SAMPLES);
  chunker.push([left, right]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0][0], Math.trunc(0.25 * 0x7fff));
});

test("centred stereo keeps the mono level: channels are averaged, not summed", () => {
  const mono = collect();
  const stereo = collect();
  mono.chunker.push([filled(0.6, CHUNK_SAMPLES)]);
  stereo.chunker.push([filled(0.6, CHUNK_SAMPLES), filled(0.6, CHUNK_SAMPLES)]);
  assert.deepEqual(stereo.chunks[0], mono.chunks[0]);
});

test("clamps to the PCM16 range and ignores an empty input", () => {
  const { chunks, chunker } = collect();
  chunker.push([]);
  const samples = new Float32Array(CHUNK_SAMPLES);
  samples[0] = 2;
  samples[1] = -2;
  chunker.push([samples]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0][0], 0x7fff);
  assert.equal(chunks[0][1], -0x8000);
});
