/**
 * WARP-844 — browser-side PCM capture for chat voice input.
 *
 * The orchestrator's /api/stt expects raw 16-bit little-endian mono PCM
 * (it streams it straight to wyoming-faster-whisper), so we capture via
 * Web Audio instead of MediaRecorder — no webm/opus containers, no
 * ffmpeg anywhere in the chain.
 *
 * The pure sample-math helpers are exported separately for unit tests;
 * PcmRecorder is the thin browser glue around them.
 */

export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Linear-interpolation downsample. Good enough for speech→STT (Whisper
 * is robust to it); avoids shipping a resampler dependency.
 */
export function downsampleBuffer(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate < toRate) {
    throw new Error("downsampleBuffer cannot upsample");
  }
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = input[left]! * (1 - frac) + input[right]! * frac;
  }
  return out;
}

/** Float32 [-1, 1] → 16-bit LE PCM, clamped. */
export function floatTo16BitPcm(samples: Float32Array): ArrayBuffer {
  const out = new ArrayBuffer(samples.length * 2);
  const view = new DataView(out);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Concatenate captured Float32 chunks into one buffer. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** True when this browser can capture microphone audio at all. */
export function canCaptureAudio(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof AudioContext !== "undefined"
  );
}

/**
 * Microphone → Float32 chunks → (on stop) 16 kHz 16-bit mono PCM.
 *
 * ScriptProcessorNode is deprecated but universally supported and ~20
 * lines; an AudioWorklet migration is mechanical if it's ever removed.
 */
export class PcmRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      // Copy — the engine reuses the underlying buffer between callbacks.
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    this.source.connect(this.processor);
    // Required in some engines for onaudioprocess to fire; the processor
    // outputs silence so nothing is audible.
    this.processor.connect(this.ctx.destination);
  }

  /** Stop capturing and return the encoded PCM. Safe to call once. */
  async stop(): Promise<{ pcm: ArrayBuffer; rate: number }> {
    const captureRate = this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);

    const all = concatFloat32(this.chunks);
    this.chunks = [];
    // DASH-003: a Bluetooth handsfree mic can capture below 16 kHz, and
    // downsampleBuffer throws on upsample — which silently lost the whole
    // recording. Send at the capture rate instead (transcribeAudio is told the
    // real rate); only downsample when we're above the target.
    if (captureRate < TARGET_SAMPLE_RATE) {
      return { pcm: floatTo16BitPcm(all), rate: captureRate };
    }
    const at16k = downsampleBuffer(all, captureRate, TARGET_SAMPLE_RATE);
    return { pcm: floatTo16BitPcm(at16k), rate: TARGET_SAMPLE_RATE };
  }
}
