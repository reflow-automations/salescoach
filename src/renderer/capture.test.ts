import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { startCapture } from "./capture";

// Minimal stand-ins for the browser media and Web Audio APIs that capture.ts touches.

class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  constructor(readonly kind: "audio" | "video") {
    super();
  }
  /** Like the browser: stop() ends the track but does not fire "ended". */
  stop(): void {
    this.readyState = "ended";
  }
  /** The device went away. */
  lose(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks = (): FakeTrack[] => [...this.tracks];
  getAudioTracks = (): FakeTrack[] => this.tracks.filter((t) => t.kind === "audio");
  getVideoTracks = (): FakeTrack[] => this.tracks.filter((t) => t.kind === "video");
  removeTrack = (t: FakeTrack): void => {
    this.tracks = this.tracks.filter((x) => x !== t);
  };
}

const connectable = () => ({ connect: <T>(next: T): T => next });

let contexts: FakeAudioContext[] = [];
let nodes: { options: unknown; port: { onmessage: ((e: { data: ArrayBuffer }) => void) | null } }[] = [];
let failAddModuleFor = -1;

class FakeAudioContext {
  readonly index = contexts.length;
  closeCalls = 0;
  destination = {};
  audioWorklet = {
    addModule: async (): Promise<void> => {
      if (this.index === failAddModuleFor) throw new Error("worklet laden mislukt");
    },
  };
  constructor() {
    contexts.push(this);
  }
  createMediaStreamSource = () => connectable();
  createGain = () => ({ gain: { value: 1 }, ...connectable() });
  close(): Promise<void> {
    this.closeCalls++;
    return this.closeCalls > 1 ? Promise.reject(new Error("InvalidStateError")) : Promise.resolve();
  }
}

class FakeWorkletNode {
  port = { onmessage: null };
  constructor(_ctx: unknown, _name: string, readonly options: unknown) {
    nodes.push(this);
  }
  connect = <T>(next: T): T => next;
}

let mic: FakeStream;
let system: FakeStream;
let micTrack: FakeTrack;
let loopTrack: FakeTrack;
let reported: [string, string][];

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  contexts = [];
  nodes = [];
  failAddModuleFor = -1;
  micTrack = new FakeTrack("audio");
  loopTrack = new FakeTrack("audio");
  mic = new FakeStream([micTrack]);
  system = new FakeStream([new FakeTrack("video"), loopTrack]);
  reported = [];
  setGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => mic, getDisplayMedia: async () => system },
  });
  setGlobal("AudioContext", FakeAudioContext);
  setGlobal("AudioWorkletNode", FakeWorkletNode);
  setGlobal("coach", { captureEnded: (speaker: string, reason: string) => reported.push([speaker, reason]) });
});

const allStopped = (): boolean => micTrack.readyState === "ended" && loopTrack.readyState === "ended";

test("chunks are tagged per speaker and the worklet gets a mono mixdown", async () => {
  const sent: string[] = [];
  await startCapture((speaker) => sent.push(speaker));
  nodes[0].port.onmessage?.({ data: new ArrayBuffer(2) });
  nodes[1].port.onmessage?.({ data: new ArrayBuffer(2) });
  assert.deepEqual(sent, ["me", "them"]);
  for (const n of nodes) assert.deepEqual(n.options, { channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
});

test("a track that ends stops everything and reports once", async () => {
  const local: [string, string][] = [];
  await startCapture(() => {}, { onEnded: (speaker, reason) => local.push([speaker, reason]), language: "nl" });
  loopTrack.lose();
  assert.ok(allStopped());
  assert.deepEqual(
    contexts.map((c) => c.closeCalls),
    [1, 1],
  );
  assert.equal(reported.length, 1);
  assert.equal(reported[0][0], "them");
  assert.match(reported[0][1], /Pc-geluid weggevallen/);
  assert.deepEqual(local, reported);
  // A headset is mic and output at once: the second end must not report again.
  micTrack.lose();
  assert.equal(reported.length, 1);
  assert.equal(local.length, 1);
});

test("no chunks are forwarded after stop", async () => {
  const sent: string[] = [];
  const capture = await startCapture((speaker) => sent.push(speaker));
  capture.stop();
  nodes[0].port.onmessage?.({ data: new ArrayBuffer(2) });
  assert.deepEqual(sent, []);
});

test("stop() is idempotent and a later device loss after stop is ignored", async () => {
  const capture = await startCapture(() => {});
  capture.stop();
  capture.stop();
  assert.ok(allStopped());
  assert.deepEqual(
    contexts.map((c) => c.closeCalls),
    [1, 1],
  );
  micTrack.lose();
  assert.equal(reported.length, 0);
});

test("works when the preload has no captureEnded yet", async () => {
  setGlobal("coach", {});
  const local: string[] = [];
  await startCapture(() => {}, { onEnded: (speaker) => local.push(speaker) });
  micTrack.lose();
  assert.deepEqual(local, ["me"]);
  assert.ok(allStopped());
});

test("when the second pipe fails, the first stream and AudioContext are released", async () => {
  failAddModuleFor = 1;
  await assert.rejects(startCapture(() => {}), /worklet laden mislukt/);
  assert.ok(allStopped());
  assert.deepEqual(
    contexts.map((c) => c.closeCalls),
    [1, 1],
  );
});

test("a track that already ended during setup fails the start instead of going silent", async () => {
  setGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => mic,
      getDisplayMedia: async () => {
        micTrack.lose(); // before any listener exists
        return system;
      },
    },
  });
  await assert.rejects(startCapture(() => {}), /Microphone dropped out/);
  assert.ok(allStopped());
  assert.deepEqual(
    contexts.map((c) => c.closeCalls),
    [1, 1],
  );
  assert.equal(reported.length, 0);
});
