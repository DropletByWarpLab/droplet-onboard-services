/** Stateless local OOXML processing. No user identity or storage credentials
 * cross this boundary; the caller owns the source read and new-file write. */
import { config } from "../config.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";

export const OFFICE_BYTES = 10 * 1024 * 1024;
export const OFFICE_INSPECTION_BYTES = 512 * 1024;
export type OfficeFormat = "docx" | "xlsx" | "pptx";
export type OfficeChanges = { cells?: { sheet: string; cell: string; value: string | number | boolean | null }[]; text?: { id: string; text: string }[] };
export interface OfficeInspection {
  format: OfficeFormat;
  sheets?: { name: string; cellCount: number; cells: { sheet: string; cell: string; value: unknown; formula?: string; formulaKind?: string; valueTruncated?: boolean }[] }[];
  paragraphs?: { id: string; text: string; textTruncated?: boolean }[];
  totalItems: number;
  returnedItems: number;
  truncated: boolean;
  warnings: string[];
}
export interface OfficeFileClient {
  inspect(bytes: Buffer, format: OfficeFormat, signal?: AbortSignal): Promise<OfficeInspection>;
  revise(bytes: Buffer, format: OfficeFormat, changes: OfficeChanges, signal?: AbortSignal): Promise<Buffer>;
}
export class OfficeFileError extends Error {
  constructor(readonly code: "INVALID_FILE" | "TOO_LARGE" | "UNAVAILABLE" | "TIMEOUT", message: string) { super(message); }
}

/** Bound streams independently of Content-Length, including aborts midway. */
export async function readOfficeBytes(body: ReadableStream<Uint8Array> | null, cap: number, signal?: AbortSignal): Promise<Buffer> {
  if (!body) throw new OfficeFileError("INVALID_FILE", "Office file contains no bytes.");
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new OfficeFileError("TIMEOUT", "Office processing was cancelled.");
    while (true) {
      // An unresponsive peer/custom stream need not settle read/cancel when
      // aborted. The caller's deadline must still settle this request.
      const pending = reader.read();
      let removeAbort = () => {};
      const interrupted = signal ? new Promise<never>((_resolve, reject) => {
        const stop = () => reject(new OfficeFileError("TIMEOUT", "Office processing was cancelled."));
        signal.addEventListener("abort", stop, { once: true });
        removeAbort = () => signal.removeEventListener("abort", stop);
        if (signal.aborted) stop();
      }) : undefined;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await (interrupted ? Promise.race([pending, interrupted]) : pending); }
      finally { removeAbort(); }
      const { value, done } = chunk;
      if (signal?.aborted) throw new OfficeFileError("TIMEOUT", "Office processing was cancelled.");
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new OfficeFileError("TOO_LARGE", "Office processing exceeded its byte limit.");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener("abort", abort);
    // Cancellation cleanup is best-effort and cannot extend the request
    // budget. Releasing a reader with a pending read can throw; observe the
    // late read rejection and still let the caller finish immediately.
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* pending peer read */ }
  }
}

const MIME: Record<OfficeFormat, string> = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
export const OFFICE_MIME = MIME;

function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new OfficeFileError("TIMEOUT", "Office processing was cancelled."));
    if (signal.aborted) { abort(); void work.catch(() => {}); return; }
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function inspectionResult(value: unknown, format: OfficeFormat): OfficeInspection {
  const bad = () => { throw new OfficeFileError("UNAVAILABLE", "Office processor returned an invalid inspection."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  const v = value as OfficeInspection;
  if (v.format !== format || !Number.isInteger(v.totalItems) || v.totalItems < 0 || !Number.isInteger(v.returnedItems) || v.returnedItems < 0 || v.returnedItems > 200 || v.returnedItems > v.totalItems || typeof v.truncated !== "boolean" || !Array.isArray(v.warnings) || v.warnings.some((w) => typeof w !== "string" || w.length > 1000)) return bad();
  if (format === "xlsx") {
    if (!Array.isArray(v.sheets) || v.sheets.length > 1000) return bad();
    let count = 0;
    for (const sheet of v.sheets) {
      if (!sheet || typeof sheet.name !== "string" || sheet.name.length > 31 || !Number.isInteger(sheet.cellCount) || sheet.cellCount < 0 || !Array.isArray(sheet.cells)) return bad();
      for (const cell of sheet.cells) {
        if (!cell || cell.sheet !== sheet.name || typeof cell.cell !== "string" || !/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(cell.cell) || cell.value !== null && !["string", "number", "boolean"].includes(typeof cell.value) || typeof cell.value === "string" && cell.value.length > 4000 || typeof cell.value === "number" && !Number.isFinite(cell.value) || cell.formula !== undefined && (typeof cell.formula !== "string" || cell.formula.length > 4000)) return bad();
        count++;
      }
    }
    if (count !== v.returnedItems) return bad();
  } else if (!Array.isArray(v.paragraphs) || v.paragraphs.length !== v.returnedItems || v.paragraphs.some((p) => !p || typeof p.id !== "string" || p.id.length > 200 || typeof p.text !== "string" || p.text.length > 4000)) return bad();
  return v;
}

export function createOfficeFileClient(options: { fetchImpl?: typeof fetch; baseUrl?: string; serviceToken?: string; timeoutMs?: number } = {}): OfficeFileClient {
  async function call(action: "inspect" | "revise", bytes: Buffer, format: OfficeFormat, changes: OfficeChanges, signal?: AbortSignal): Promise<OfficeInspection | Buffer> {
    if (!bytes.length || bytes.length > OFFICE_BYTES) throw new OfficeFileError("TOO_LARGE", "Office input must be 1 byte–10 MiB.");
    const token = options.serviceToken ?? config.DOC_RENDER_SERVICE_TOKEN;
    if (!token) throw new OfficeFileError("UNAVAILABLE", "Local Office processing is not configured.");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) controller.abort();
    try {
      const response = await withDeadline((options.fetchImpl ?? internalFetch)(`${internalBaseUrl(options.baseUrl ?? config.DOC_RENDER_URL).replace(/\/+$/, "")}/office`, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, format, content_base64: bytes.toString("base64"), ...(action === "revise" ? { changes } : {}) }), signal: controller.signal }), controller.signal);
      if (!response.ok) {
        // Only expose deliberate bounded validation errors, never HTML or a
        // remote traceback. User paths and credentials were never sent.
        if (response.status === 400 || response.status === 422) {
          const raw = await readOfficeBytes(response.body, 4096, controller.signal);
          let detail: unknown; try { detail = JSON.parse(raw.toString("utf8")).detail; } catch { /* no peer dump */ }
          throw new OfficeFileError("INVALID_FILE", typeof detail === "string" && detail.length <= 1000 ? detail : "Office input or revision is unsupported.");
        }
        void response.body?.cancel().catch(() => {});
        throw new OfficeFileError("UNAVAILABLE", "Local Office processing is unavailable.");
      }
      if (action === "inspect") {
        const raw = await readOfficeBytes(response.body, OFFICE_INSPECTION_BYTES, controller.signal);
        return inspectionResult(JSON.parse(raw.toString("utf8")), format);
      }
      if (response.headers.get("content-type")?.split(";")[0] !== MIME[format]) {
        void response.body?.cancel().catch(() => {});
        throw new OfficeFileError("UNAVAILABLE", "Office processor returned an unexpected file format.");
      }
      const output = await readOfficeBytes(response.body, OFFICE_BYTES, controller.signal);
      if (output.length < 22 || output.toString("ascii", 0, 4) !== "PK\x03\x04") throw new OfficeFileError("UNAVAILABLE", "Office processor returned an invalid file.");
      return output;
    } catch (error) {
      if (controller.signal.aborted) throw new OfficeFileError("TIMEOUT", "Office processing exceeded its deadline or was cancelled.");
      if (error instanceof OfficeFileError) throw error;
      throw new OfficeFileError("UNAVAILABLE", "Local Office processing could not be reached or returned an invalid result.");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  return { inspect: (bytes, format, signal) => call("inspect", bytes, format, {}, signal) as Promise<OfficeInspection>, revise: (bytes, format, changes, signal) => call("revise", bytes, format, changes, signal) as Promise<Buffer> };
}
