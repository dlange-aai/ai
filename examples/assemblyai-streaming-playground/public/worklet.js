// Downsamples the microphone to 16 kHz mono 16-bit PCM and posts 100 ms chunks.
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.outRate = 16000;
    this.chunkOut = 1600; // 100 ms at 16 kHz
    this.pending = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    const merged = new Float32Array(this.pending.length + input.length);
    merged.set(this.pending);
    merged.set(input, this.pending.length);
    this.pending = merged;

    const needed = Math.ceil((this.chunkOut * sampleRate) / this.outRate);
    while (this.pending.length >= needed) {
      const block = this.pending.subarray(0, needed);
      this.pending = this.pending.slice(needed);
      const out = new Int16Array(this.chunkOut);
      const step = block.length / this.chunkOut;
      let peak = 0;
      for (let i = 0; i < this.chunkOut; i++) {
        const pos = i * step;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, block.length - 1);
        const frac = pos - i0;
        const sample = Math.max(
          -1,
          Math.min(1, block[i0] * (1 - frac) + block[i1] * frac),
        );
        peak = Math.max(peak, Math.abs(sample));
        out[i] = sample * 0x7fff;
      }
      this.port.postMessage({ pcm: out.buffer, peak }, [out.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
