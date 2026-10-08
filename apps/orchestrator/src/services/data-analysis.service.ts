/** Credential-free, bounded call to the appliance's existing sandbox. */
import { config } from "../config.js";
import { SandboxError } from "./sandbox.client.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";

export const ANALYSIS_INPUT_BYTES = 3 * 1024 * 1024;
export const ANALYSIS_RESPONSE_BYTES = 1_048_576;
export interface AnalysisSource { name: string; format: "csv" | "xlsx"; contentBase64: string }
export interface AnalysisArtifact { name: string; mimeType: "text/csv" | "image/svg+xml"; contentBase64: string }
export interface AnalysisResult {
  output: unknown;
  stdout: string;
  stdoutTruncated: boolean;
  sources: unknown[];
  warnings: string[];
  artifacts: AnalysisArtifact[];
}
export interface AnalysisClient {
  analyze(code: string, inputs: Record<string, unknown>, sources: AnalysisSource[], signal?: AbortSignal): Promise<AnalysisResult>;
}

/** Stream caps apply even to a peer that omits/lies about Content-Length. */
export async function readAnalysisBytes(body: ReadableStream<Uint8Array> | null, cap: number, signal?: AbortSignal): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new SandboxError("Data analysis was cancelled.", "TIMEOUT");
    while (true) {
      const reading = reader.read();
      const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const stop = () => reject(new SandboxError("Data analysis was cancelled.", "TIMEOUT"));
        if (signal?.aborted) { stop(); void reading.catch(() => {}); return; }
        signal?.addEventListener("abort", stop, { once: true });
        void reading.then(resolve, reject).finally(() => signal?.removeEventListener("abort", stop));
      });
      if (signal?.aborted) throw new SandboxError("Data analysis was cancelled.", "TIMEOUT");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) throw new SandboxError(`data exceeds ${cap} bytes`, "SANDBOX_ERROR");
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    signal?.removeEventListener("abort", abort);
    // Cancellation is peer-controlled too. Never let its cleanup hold the
    // caller after the byte cap/deadline has already been reached.
    void reader.cancel().catch(() => {}).finally(() => { try { reader.releaseLock(); } catch { /* Pending read cancelled by the peer. */ } });
  }
}

export function createDataAnalysisClient(options: {
  fetchImpl?: typeof fetch; baseUrl?: string; serviceToken?: string; timeoutMs?: number;
} = {}): AnalysisClient {
  return {
    async analyze(code, inputs, sources, signal) {
      const token = options.serviceToken ?? config.SANDBOX_SERVICE_TOKEN;
      if (!token) throw new SandboxError("Data analysis is not configured on this Droplet (sandbox bearer missing).", "NOT_CONFIGURED");
      const timeoutMs = options.timeoutMs ?? config.SANDBOX_TRANSFORM_TIMEOUT_MS;
      const payload = JSON.stringify({ code, inputs, sources, timeoutMs, outputCapBytes: ANALYSIS_RESPONSE_BYTES });
      if (Buffer.byteLength(payload) > 4 * 1024 * 1024) {
        throw new SandboxError("Analysis input exceeds 4 MiB; use fewer sources or a smaller dataset.", "SANDBOX_ERROR");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs + 2000);
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) controller.abort();
      try {
        const response = await (options.fetchImpl ?? internalFetch)(
          `${internalBaseUrl(options.baseUrl ?? config.SANDBOX_URL).replace(/\/+$/, "")}/analysis`,
          { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: payload, signal: controller.signal, redirect: "error" },
        );
        if (response.status === 503) throw new SandboxError("Data analysis sandbox is not configured.", "NOT_CONFIGURED");
        if (!response.ok) throw new SandboxError(`Data analysis sandbox answered ${response.status}.`, "SANDBOX_ERROR");
        const bytes = await readAnalysisBytes(response.body, ANALYSIS_RESPONSE_BYTES, controller.signal);
        const result = JSON.parse(bytes.toString("utf8")) as Partial<AnalysisResult> & { error?: string };
        if (typeof result.error === "string") throw new SandboxError(result.error, "SANDBOX_ERROR");
        if (!("output" in result) || !Array.isArray(result.artifacts) || !Array.isArray(result.sources) || !Array.isArray(result.warnings) || result.warnings.some((v) => typeof v !== "string") || typeof result.stdout !== "string" || typeof result.stdoutTruncated !== "boolean") {
          throw new SandboxError("Data analysis sandbox returned an invalid result.", "SANDBOX_ERROR");
        }
        return result as AnalysisResult;
      } catch (error) {
        if (controller.signal.aborted) throw new SandboxError(`Data analysis exceeded ${timeoutMs} ms.`, "TIMEOUT");
        if (error instanceof SandboxError) throw error;
        throw new SandboxError("Data analysis sandbox could not be reached or returned invalid JSON.", "UNREACHABLE");
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
    },
  };
}
