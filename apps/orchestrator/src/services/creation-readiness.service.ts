/** Read-only local prerequisites. These probes never create files or run inference. */
import * as net from "node:net";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";
import { parseTtsUrl } from "./tts.client.js";

export type CreationState = "ready" | "disabled" | "restricted" | "not_configured" | "offline" | "busy" | "unverified" | "unavailable";
export type CreationId = "pdf" | "slides" | "workbook" | "office" | "analysis" | "artifact" | "web_fetch" | "web_search" | "speech" | "image" | "video";
export interface CreationCapability {
  id: CreationId; label: string; state: CreationState; reason: string; detail: string;
  /** Installed model files and a live API are not proof of a successful inference. */
  inferenceVerified?: false;
}
export interface CreationProbeConfig {
  DOC_RENDER_URL: string; DOC_RENDER_SERVICE_TOKEN: string;
  SANDBOX_URL: string; SANDBOX_SERVICE_TOKEN: string;
  WEB_FETCH_URL: string; WEB_FETCH_SERVICE_TOKEN: string;
  MEDIA_GEN_URL: string; MEDIA_GEN_SERVICE_TOKEN: string; TTS_URL: string;
}
export interface ProbeResult { state: "ready" | "not_configured" | "offline"; data?: Record<string, unknown> }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Race promises as well as passing the signal: alternate clients/peers can ignore abort. */
export function boundedCreationRead<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("readiness_deadline"));
    if (signal.aborted) { abort(); void work.catch(() => {}); return; }
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export async function probeCreationService(baseUrl: string, token: string, signal: AbortSignal, fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = internalFetch): Promise<ProbeResult> {
  if (!baseUrl.trim() || !token.trim()) return { state: "not_configured" };
  let response: globalThis.Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await boundedCreationRead(fetchImpl(`${internalBaseUrl(baseUrl).replace(/\/+$/, "")}/capabilities`, {
      headers: { Authorization: `Bearer ${token}` }, signal, redirect: "error",
    }), signal);
    if (!response.ok || !response.body) return { state: "offline" };
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const part = await boundedCreationRead(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) return { state: "offline" };
      chunks.push(part.value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    return record(data) ? { state: "ready", data } : { state: "offline" };
  } catch { return { state: "offline" }; }
  finally {
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Pending uncooperative read. */ } }
    else { void response?.body?.cancel().catch(() => {}); }
  }
}

/** Wyoming describe only. No text, synthesize command, audio, or playback. */
export async function probeCreationSpeech(url: string, signal: AbortSignal): Promise<ProbeResult> {
  let address: { host: string; port: number };
  try { address = parseTtsUrl(url); } catch { return { state: "not_configured" }; }
  if (signal.aborted) return { state: "offline" };
  return new Promise((resolve) => {
    const socket = net.connect(address); let settled = false; let bytes = Buffer.alloc(0); let wireBytes = 0;
    const finish = (result: ProbeResult) => {
      if (settled) return; settled = true; signal.removeEventListener("abort", abort); socket.destroy(); resolve(result);
    };
    const abort = () => finish({ state: "offline" });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    socket.on("connect", () => { if (!settled) socket.write('{"type":"describe","data":{},"payload_length":0}\n'); });
    socket.on("error", abort); socket.on("close", abort);
    socket.on("data", (packet: Buffer) => {
      if (settled) return;
      wireBytes += packet.length;
      if (wireBytes > 32_768) { abort(); return; }
      bytes = Buffer.concat([bytes, packet]);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        const header: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
        if (!record(header) || header.type !== "info" || (header.payload_length ?? 0) !== 0 || !Number.isInteger(header.data_length ?? 0) || Number(header.data_length ?? 0) < 0 || Number(header.data_length ?? 0) > 16_384) { abort(); return; }
        const length = Number(header.data_length ?? 0);
        if (bytes.length < newline + 1 + length) return;
        const data: unknown = length ? JSON.parse(bytes.subarray(newline + 1, newline + 1 + length).toString("utf8")) : header.data;
        if (!record(data) || !Array.isArray(data.tts)) { abort(); return; }
        const installed = data.tts.some((program) => record(program) && Array.isArray(program.voices) && program.voices.some((voice) => record(voice) && voice.installed === true));
        finish({ state: "ready", data: { installed } });
      } catch { abort(); }
    });
  });
}

export function creationCapability(id: CreationId, label: string, state: CreationState, reason: string, detail: string): CreationCapability {
  return { id, label, state, reason, detail, ...((id === "image" || id === "video") ? { inferenceVerified: false as const } : {}) };
}

export function fromCreationProbe(id: CreationId, label: string, probe: ProbeResult, ready: boolean): CreationCapability {
  if (probe.state === "not_configured") return creationCapability(id, label, "not_configured", "service_not_configured", "Ask your administrator to configure the local creation service.");
  if (probe.state !== "ready") return creationCapability(id, label, "offline", "service_unreachable", "The local service did not answer. Retry, or ask your administrator to check it.");
  if (!ready) return creationCapability(id, label, "unavailable", "prerequisite_missing", "A required local prerequisite is missing. Ask your administrator to complete setup.");
  return creationCapability(id, label, "ready", "local_service_ready", "The local service is available. Completed files are saved to your personal drive.");
}
