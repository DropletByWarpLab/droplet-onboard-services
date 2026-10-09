/** Local Wyoming TTS -> bounded PCM -> a complete, downloadable WAV file.
 * No playback, cloud fallback, model download, or caller-selected server. */
import * as net from "node:net";

export const TTS_TEXT_CHARS = 2_000;
export const TTS_PCM_BYTES = 10 * 1024 * 1024 - 44;
export const TTS_TIMEOUT_MS = 60_000;
const HEADER_BYTES = 16_384;
const PAYLOAD_BYTES = 1024 * 1024;
const MAX_EVENTS = 2_048;
const MAX_DURATION_SECONDS = 180;
let activeSyntheses = 0;

export type TtsErrorCode = "NOT_CONFIGURED" | "UNREACHABLE" | "TIMEOUT" | "CANCELLED" | "BUSY" | "INVALID_VOICE" | "INVALID_TEXT" | "PROTOCOL_ERROR" | "TOO_LARGE" | "SYNTHESIS_FAILED";
export class TtsUnavailableError extends Error {
  constructor(readonly code: TtsErrorCode, message: string) {
    super(message);
    this.name = "TtsUnavailableError";
  }
}
const fail = (code: TtsErrorCode, message: string): never => { throw new TtsUnavailableError(code, message); };

export function parseTtsUrl(value: string): { host: string; port: number } {
  if (!value.trim()) return fail("NOT_CONFIGURED", "Local speech creation is not configured.");
  try {
    const url = new URL(value.trim());
    const port = Number(url.port);
    if (url.protocol !== "tcp:" || !url.hostname || !Number.isInteger(port) || port < 1 || port > 65535 || url.username || url.password || url.pathname || url.search || url.hash) throw new Error();
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
  } catch { return fail("NOT_CONFIGURED", "The local speech server configuration is invalid."); }
}

export interface SynthesizeOptions {
  url: string;
  text: string;
  voice?: string;
  signal?: AbortSignal;
  /** Test/operator seam; production uses the fixed 60 second CPU budget. */
  timeoutMs?: number;
}
export interface SynthesizedWav { wav: Buffer; sampleRate: number; durationSeconds: number; voice?: string }
interface AudioFormat { rate: number; width: number; channels: number }
interface Header { type: string; data?: Record<string, unknown> | null; data_length: number; payload_length: number }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const encode = (type: string, data: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify({ type, data, payload_length: 0 }) + "\n");

function wavFromPcm(pcm: Buffer, format: AudioFormat): Buffer {
  const wav = Buffer.allocUnsafe(44 + pcm.length);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(format.channels, 22);
  wav.writeUInt32LE(format.rate, 24); wav.writeUInt32LE(format.rate * format.width * format.channels, 28);
  wav.writeUInt16LE(format.width * format.channels, 32); wav.writeUInt16LE(format.width * 8, 34);
  wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

/** Supports Wyoming v1 inline data and v2 data_length blocks, even when TCP
 * splits a JSON line, a metadata block, or a PCM frame across packets. */
export async function synthesizeWav(opts: SynthesizeOptions): Promise<SynthesizedWav> {
  const address = parseTtsUrl(opts.url);
  if (typeof opts.text !== "string" || !opts.text.trim() || opts.text.length > TTS_TEXT_CHARS || /\p{Cs}|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(opts.text)) return fail("INVALID_TEXT", "Speech text must contain 1–2,000 characters without control characters.");
  if (opts.voice !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(opts.voice)) return fail("INVALID_VOICE", "Choose an installed local voice name.");
  if (opts.signal?.aborted) return fail("CANCELLED", "Speech creation was cancelled.");
  const timeoutMs = opts.timeoutMs ?? TTS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > TTS_TIMEOUT_MS) return fail("NOT_CONFIGURED", "The local speech timeout configuration is invalid.");
  if (activeSyntheses >= 2) return fail("BUSY", "Local speech creation is busy. Try again when it finishes.");
  activeSyntheses++;
  try {
    return await new Promise<SynthesizedWav>((resolve, reject) => {
      const socket = net.connect(address);
      let settled = false;
      let buffer = Buffer.alloc(0);
      let header: Header | null = null;
      let resolvedData = false;
      let events = 0;
      let wireBytes = 0;
      let pcmBytes = 0;
      const chunks: Buffer[] = [];
      let format: AudioFormat | null = null;
      let phase: "describe" | "start" | "audio" = opts.voice ? "describe" : "start";
      const abort = () => finish(new TtsUnavailableError("CANCELLED", "Speech creation was cancelled."));
      const finish = (error?: TtsUnavailableError, result?: SynthesizedWav) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error); else resolve(result!);
      };
      const timer = setTimeout(() => finish(new TtsUnavailableError("TIMEOUT", "Local speech creation exceeded its 60 second time budget.")), timeoutMs);
      opts.signal?.addEventListener("abort", abort, { once: true });
      if (opts.signal?.aborted) abort();
      socket.on("error", () => finish(new TtsUnavailableError("UNREACHABLE", "The local speech server is unavailable.")));
      socket.on("close", () => finish(new TtsUnavailableError("UNREACHABLE", "The local speech server closed before completing the audio.")));
      const synthesize = () => socket.write(encode("synthesize", { text: opts.text.trim(), ...(opts.voice ? { voice: { name: opts.voice } } : {}) }));
      socket.on("connect", () => { if (opts.voice) socket.write(encode("describe", {})); else synthesize(); });

      const receive = (event: Header, payload: Buffer) => {
        const data = event.data ?? {};
        if (event.type === "error") {
          // Never echo peer-provided text (it can contain internal paths or input).
          const code = data.code;
          if (code === "busy") return fail("BUSY", "Local speech creation is busy. Try again when it finishes.");
          if (code === "invalid-voice") return fail("INVALID_VOICE", "Choose an installed local voice name.");
          if (code === "invalid-text") return fail("INVALID_TEXT", "The local speech server rejected the text.");
          return fail("SYNTHESIS_FAILED", "The local speech server could not create this audio.");
        }
        if (phase === "describe" && event.type === "info" && !payload.length) {
          const programs = Array.isArray(data.tts) ? data.tts : [];
          const installed = programs.some((program) => object(program) && Array.isArray(program.voices) && program.voices.some((voice) => object(voice) && voice.installed === true && voice.name === opts.voice));
          if (!installed) return fail("INVALID_VOICE", "The requested voice is not installed on the local speech server.");
          phase = "start"; synthesize(); return;
        }
        if (phase === "start" && event.type === "audio-start" && !payload.length) {
          if (!Number.isInteger(data.rate) || (data.rate as number) < 8000 || (data.rate as number) > 48000 || data.width !== 2 || data.channels !== 1) return fail("PROTOCOL_ERROR", "The local speech server returned an unsupported PCM format.");
          format = { rate: data.rate as number, width: 2, channels: 1 };
          phase = "audio"; return;
        }
        if (phase === "audio" && event.type === "audio-chunk" && format) {
          for (const key of ["rate", "width", "channels"] as const) if (data[key] !== undefined && data[key] !== format[key]) return fail("PROTOCOL_ERROR", "The local speech server changed PCM format mid-stream.");
          if (!payload.length || payload.length % 2 !== 0) return fail("PROTOCOL_ERROR", "The local speech server returned an incomplete PCM frame.");
          pcmBytes += payload.length;
          if (pcmBytes > TTS_PCM_BYTES || pcmBytes > format.rate * 2 * MAX_DURATION_SECONDS) return fail("TOO_LARGE", "Created speech exceeds the 10 MB or 180 second audio limit.");
          chunks.push(Buffer.from(payload)); return;
        }
        if (phase === "audio" && event.type === "audio-stop" && !payload.length && format && pcmBytes) {
          finish(undefined, { wav: wavFromPcm(Buffer.concat(chunks, pcmBytes), format), sampleRate: format.rate, durationSeconds: pcmBytes / (format.rate * 2), ...(opts.voice ? { voice: opts.voice } : {}) });
          return;
        }
        return fail("PROTOCOL_ERROR", "The local speech server returned an unexpected audio event.");
      };

      socket.on("data", (packet: Buffer) => {
        try {
          wireBytes += packet.length;
          if (wireBytes > TTS_PCM_BYTES + 2 * 1024 * 1024) return fail("TOO_LARGE", "The local speech stream exceeded its byte limit.");
          buffer = Buffer.concat([buffer, packet]);
          for (;;) {
            if (!header) {
              const newline = buffer.indexOf(0x0a);
              if (newline < 0) { if (buffer.length > HEADER_BYTES) return fail("PROTOCOL_ERROR", "The local speech event header is oversized."); return; }
              if (newline > HEADER_BYTES || ++events > MAX_EVENTS) return fail("PROTOCOL_ERROR", "The local speech stream exceeded its event limits.");
              let parsed: unknown;
              try { parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8")); } catch { return fail("PROTOCOL_ERROR", "The local speech event header is malformed."); }
              buffer = buffer.subarray(newline + 1);
              if (!object(parsed) || typeof parsed.type !== "string" || parsed.type.length > 64) return fail("PROTOCOL_ERROR", "The local speech event header is malformed.");
              const dataLength = parsed.data_length ?? 0, payloadLength = parsed.payload_length ?? 0;
              if (!Number.isInteger(dataLength) || (dataLength as number) < 0 || (dataLength as number) > HEADER_BYTES || !Number.isInteger(payloadLength) || (payloadLength as number) < 0 || (payloadLength as number) > PAYLOAD_BYTES) return fail("PROTOCOL_ERROR", "The local speech event lengths are invalid.");
              if (parsed.data !== undefined && parsed.data !== null && !object(parsed.data)) return fail("PROTOCOL_ERROR", "The local speech event metadata is malformed.");
              header = { type: parsed.type, data: parsed.data as Record<string, unknown> | null | undefined, data_length: dataLength as number, payload_length: payloadLength as number };
              resolvedData = header.data_length === 0;
            }
            if (!resolvedData) {
              if (buffer.length < header.data_length) return;
              let data: unknown;
              try { data = JSON.parse(buffer.subarray(0, header.data_length).toString("utf8")); } catch { return fail("PROTOCOL_ERROR", "The local speech data block is malformed."); }
              if (!object(data)) return fail("PROTOCOL_ERROR", "The local speech data block is malformed.");
              header.data = { ...header.data, ...data };
              buffer = buffer.subarray(header.data_length); resolvedData = true;
            }
            if (buffer.length < header.payload_length) return;
            const payload = buffer.subarray(0, header.payload_length);
            buffer = buffer.subarray(header.payload_length);
            const event = header; header = null;
            receive(event, payload);
            if (settled) return;
          }
        } catch (error) {
          finish(error instanceof TtsUnavailableError ? error : new TtsUnavailableError("PROTOCOL_ERROR", "The local speech stream was invalid."));
        }
      });
    });
  } catch (error) {
    if (error instanceof TtsUnavailableError) throw error;
    throw new TtsUnavailableError("UNREACHABLE", "The local speech server is unavailable.");
  } finally { activeSyntheses--; }
}
