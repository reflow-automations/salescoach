// Float audio frames -> mono PCM16 chunks. No Web Audio globals, so the worklet and the tests share it.

export const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz

export class Pcm16Chunker {
  private buf: Int16Array<ArrayBuffer>;
  private pos = 0;

  constructor(
    private readonly emit: (chunk: ArrayBuffer) => void,
    private readonly size = CHUNK_SAMPLES,
  ) {
    this.buf = new Int16Array(size);
  }

  /**
   * Adds one block of frames. All channels are averaged: the stereo loopback can carry a
   * speaker on one side only, and averaging (not summing) keeps centred audio at its level.
   */
  push(channels: readonly Float32Array[]): void {
    const count = channels.length;
    if (count === 0) return;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < count; c++) sum += channels[c][i];
      const s = Math.max(-1, Math.min(1, sum / count));
      this.buf[this.pos++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.pos === this.size) {
        const full = this.buf.buffer;
        this.buf = new Int16Array(this.size);
        this.pos = 0;
        this.emit(full);
      }
    }
  }
}
