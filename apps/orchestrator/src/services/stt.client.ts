/**
 * WARP-844 — minimal Wyoming-protocol STT client for the dashboard's
 * voice input. Streams raw 16-bit mono PCM to the wyoming-faster-whisper
 * sidecar (the same container voice-io uses) and returns the transcript.
 *
 * The protocol is deliberately re-implemented rather than wrapped: one
 * event = a JSON header line (`{type, data, payload_length}\n`) followed
 * by `payload_length` binary bytes. See services/voice-io/voice/stt.py —
 * the Python twin this mirrors — for the full wire rationale.
 *
 * No `wyoming` npm dependency exists; the framing is ~30 lines.
 */
import * as net from "node:net";

export class SttUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttUnavailableError";
  }
}

/** Parse `tcp://host:port` (the STT_URL convention voice-io established). */
export function parseSttUrl(url: string): { host: string; port: number } {
  const m = /^tcp:\/\/([^:/]+):(\d+)$/.exec(url.trim());
  if (!m) throw new SttUnavailableError(`invalid STT_URL: ${url}`);
  return { host: m[1]!, port: Number(m[2]) };
}

function encodeEvent(
  type: string,
  data: Record<string, unknown> | null,
  payload?: Buffer,
): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      type,
      data,
      payload_length: payload?.length ?? 0,
    }) + "\n",
    "utf-8",
  );
  return payload && payload.length > 0
    ? Buffer.concat([header, payload])
    : header;
}

/** Stream chunk size: 2560 bytes = 80 ms of 16 kHz int16 mono — the same
 *  frame the voice pipeline uses, well within Wyoming's comfort zone. */
const CHUNK_BYTES = 2560;

export interface TranscribeOptions {
  url: string;
  /** Raw little-endian 16-bit mono PCM. */
  pcm: Buffer;
  /** Sample rate of `pcm` (the dashboard captures at 16000). */
  rate: number;
  language?: string;
  /** Total wall-clock budget incl. connect + transcript wait. */
  timeoutMs?: number;
}

/**
 * One-shot transcription: connect → transcribe/audio-start → chunks →
 * audio-stop → await the `transcript` event. Any socket-level failure or
 * timeout surfaces as SttUnavailableError so the route can 503 cleanly.
 */
export function transcribePcm(opts: TranscribeOptions): Promise<string> {
  const { host, port } = parseSttUrl(opts.url);
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise<string>((resolve, reject) => {
    const sock = net.connect({ host, port });
    let settled = false;
    let buffer = Buffer.alloc(0);
    /** When >0 we're draining a binary payload we don't care about. */
    let payloadToSkip = 0;

    const finish = (err: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(text ?? "");
    };

    const timer = setTimeout(
      () => finish(new SttUnavailableError(`stt timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );

    sock.on("error", (err) =>
      finish(new SttUnavailableError(`stt connect/socket error: ${err.message}`)),
    );
    sock.on("close", () => {
      finish(new SttUnavailableError("stt server closed before transcript"));
    });

    sock.on("connect", () => {
      const meta = { rate: opts.rate, width: 2, channels: 1 };
      sock.write(encodeEvent("transcribe", { language: opts.language ?? "en" }));
      sock.write(encodeEvent("audio-start", meta));
      for (let off = 0; off < opts.pcm.length; off += CHUNK_BYTES) {
        const chunk = opts.pcm.subarray(off, off + CHUNK_BYTES);
        sock.write(encodeEvent("audio-chunk", meta, chunk));
      }
      sock.write(encodeEvent("audio-stop", meta));
    });

    /** Wyoming v2: when >0 the event's data dict arrives as a separate
     *  JSON block of this many bytes between the header line and the
     *  payload. The Python twin (services/voice-io/voice/stt.py
     *  `_read_event`) documents that deployed rhasspy images split
     *  between v1 (data inline in the header) and v2 (`data_length`)
     *  framing — whisper ships v1 today, but the compose tag floats, so
     *  both must parse or a routine image pull silently breaks the mic. */
    let dataToRead = 0;
    /** Header whose v2 data block we're waiting for. */
    interface WireHeader {
      type?: string;
      data?: { text?: string } | null;
      data_length?: number;
      payload_length?: number;
    }
    let pendingHeader: WireHeader | null = null;

    /** Header complete (data resolved): act on it, set the payload skip.
     *  Returns true when the promise settled (stop draining). */
    const emitEvent = (header: WireHeader): boolean => {
      payloadToSkip = header.payload_length ?? 0;
      if (header.type === "transcript") {
        finish(null, (header.data?.text ?? "").trim());
        return true;
      }
      return false; // acks / partials are ignored — keep draining
    };

    sock.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      // Drain events (header line → optional v2 data block → optional
      // payload) until the transcript lands.
      for (;;) {
        if (dataToRead > 0) {
          if (buffer.length < dataToRead) return; // need more bytes
          const block = buffer.subarray(0, dataToRead).toString("utf-8");
          buffer = buffer.subarray(dataToRead);
          dataToRead = 0;
          const header = pendingHeader!;
          pendingHeader = null;
          try {
            header.data = JSON.parse(block);
          } catch {
            finish(new SttUnavailableError("malformed stt data block"));
            return;
          }
          if (emitEvent(header)) return;
          continue;
        }
        if (payloadToSkip > 0) {
          const drop = Math.min(payloadToSkip, buffer.length);
          buffer = buffer.subarray(drop);
          payloadToSkip -= drop;
          if (payloadToSkip > 0) return; // need more bytes
        }
        const nl = buffer.indexOf(0x0a);
        if (nl === -1) return; // incomplete header line
        const line = buffer.subarray(0, nl).toString("utf-8");
        buffer = buffer.subarray(nl + 1);
        let header: WireHeader;
        try {
          header = JSON.parse(line);
        } catch {
          finish(new SttUnavailableError("malformed stt event header"));
          return;
        }
        if ((header.data_length ?? 0) > 0) {
          // v2: the data dict follows as its own JSON block.
          dataToRead = header.data_length!;
          pendingHeader = header;
          continue;
        }
        if (emitEvent(header)) return;
      }
    });
  });
}
