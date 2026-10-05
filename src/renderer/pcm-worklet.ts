// AudioWorklet: float samples (AudioContext runs at 16 kHz) -> PCM16 chunks of 100 ms.
import { Pcm16Chunker } from "./pcm-chunker";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

class PcmChunker extends AudioWorkletProcessor {
  private chunker = new Pcm16Chunker((chunk) => this.port.postMessage(chunk, [chunk]));

  process(inputs: Float32Array[][]): boolean {
    // All channels of the first input, not just the left one.
    const channels = inputs[0];
    if (channels?.length) this.chunker.push(channels);
    return true;
  }
}

if (sampleRate !== 16000) console.warn(`pcm-worklet: expected 16 kHz, got ${sampleRate}`);
registerProcessor("pcm-chunker", PcmChunker);
