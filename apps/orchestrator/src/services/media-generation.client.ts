/** Offline media inference. No file credentials or remote URLs reach this peer. */
import { config } from "../config.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";

export const MEDIA_OUTPUT_BYTES = 20 * 1024 * 1024;
export interface MediaSpec {
  kind: "image" | "video"; prompt: string;
  source_base64?: string; mask_base64?: string;
  width: number; height: number; steps: number; seed: number;
  frames?: number; fps?: number;
}
export interface GeneratedMedia { bytes: Buffer; mimeType: "image/png" | "video/mp4"; seed: number; engine: string }
export class MediaGenerationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface MediaGenerationClient {
  capabilities(): Promise<{ image: boolean; video: boolean }>;
  render(spec: MediaSpec, signal: AbortSignal): Promise<GeneratedMedia>;
}
export async function readMediaBytes(body: ReadableStream<Uint8Array> | null, cap: number, signal?: AbortSignal): Promise<Buffer> {
  if (!body) throw new MediaGenerationError(502, "INVALID_OUTPUT", "Local media engine returned no bytes.");
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new MediaGenerationError(408, "TIMEOUT", "Media creation exceeded its deadline.");
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > cap) throw new MediaGenerationError(413, "TOO_LARGE", "Media exceeds the supported size.");
      chunks.push(value);
    }
    if (signal?.aborted) throw new MediaGenerationError(408, "TIMEOUT", "Media creation exceeded its deadline.");
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener("abort", abort);
    // A peer's cancellation callback may itself hang. Release our buffer and
    // reader immediately instead of extending the job beyond its deadline.
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
export function createMediaGenerationClient(options: { baseUrl?: string; token?: string; fetchImpl?: typeof fetch } = {}): MediaGenerationClient {
  function headers() {
    const token = options.token ?? config.MEDIA_GEN_SERVICE_TOKEN;
    if (!token) throw new MediaGenerationError(503, "NOT_CONFIGURED", "Local image/video creation is not configured on this Droplet.");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }
  const url = (suffix: string) => `${internalBaseUrl(options.baseUrl ?? config.MEDIA_GEN_URL).replace(/\/+$/, "")}${suffix}`;
  return {
    async capabilities() {
      const signal = AbortSignal.timeout(5000);
      try {
        const response = await (options.fetchImpl ?? internalFetch)(url("/capabilities"), { headers: headers(), signal, redirect: "error" });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new MediaGenerationError(503, "UNAVAILABLE", "Local media engine is unavailable."); }
        const value: unknown = JSON.parse((await readMediaBytes(response.body, 8192, signal)).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value) || !("image" in value) || !("video" in value) || typeof value.image !== "boolean" || typeof value.video !== "boolean") throw new MediaGenerationError(502, "INVALID_OUTPUT", "Local media engine returned invalid capabilities.");
        return { image: value.image, video: value.video };
      } catch (error) {
        if (error instanceof MediaGenerationError) throw error;
        throw new MediaGenerationError(503, "UNAVAILABLE", "Local media engine is unavailable or returned invalid capabilities.");
      }
    },
    async render(spec, signal) {
      let response: Response;
      try { response = await (options.fetchImpl ?? internalFetch)(url("/render"), { method: "POST", headers: headers(), body: JSON.stringify(spec), signal, redirect: "error" }); }
      catch (error) {
        if (error instanceof MediaGenerationError) throw error;
        throw new MediaGenerationError(signal.aborted ? 408 : 503, signal.aborted ? "TIMEOUT" : "UNAVAILABLE", "Local media generation failed or exceeded its deadline.");
      }
      if (!response.ok) {
        // Do not relay a model/library exception: it can contain the prompt.
        void response.body?.cancel().catch(() => {});
        throw new MediaGenerationError(response.status, response.status === 429 ? "BUSY" : response.status === 400 ? "INVALID_INPUT" : "GENERATION_FAILED", response.status === 400 ? "The local engine does not support these inputs; source-image video requires an installed LTX engine." : "Local media generation failed or exceeded its deadline.");
      }
      const bytes = await readMediaBytes(response.body, MEDIA_OUTPUT_BYTES, signal);
      const mimeType = spec.kind === "image" ? "image/png" : "video/mp4";
      if (response.headers.get("content-type")?.split(";", 1)[0] !== mimeType || (spec.kind === "image" ? !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp")) throw new MediaGenerationError(502, "INVALID_OUTPUT", "Local media engine returned an invalid file.");
      const rawSeed = response.headers.get("x-media-seed");
      const seed = rawSeed && /^\d{1,10}$/.test(rawSeed) ? Number(rawSeed) : NaN;
      const engine = response.headers.get("x-media-engine") ?? "";
      if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647 || seed !== spec.seed || !(spec.kind === "image" ? engine === "sdxl" : engine === "wan" || engine === "ltx")) throw new MediaGenerationError(502, "INVALID_OUTPUT", "Local media engine returned invalid metadata.");
      return { bytes, mimeType, seed, engine };
    },
  };
}
