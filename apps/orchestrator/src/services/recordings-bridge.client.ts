/**
 * WARP-3514 / ADR-070 — the orchestrator's client for the device-bridge's NVR
 * storage endpoints (`/host/nvr-storage*`) and its `/drives` inventory.
 *
 * The bridge runs on the HOST: it is the only thing that can read the drive
 * topology, set an ext4 project quota or move footage, and the orchestrator
 * (a container, no docker socket — ADR-023) reaches it over `host.docker.internal`
 * with the shared `X-Droplet-Auth` secret, exactly like `routes/storage.ts`.
 *
 * Errors are keyed on the bridge's MACHINE `code`, never on message text
 * (WARP-834): 409 → `busy`, 422 → `host_refused` (with the writer's code, e.g.
 * `os_disk`, `files_not_empty`), a connection failure → `bridge_unavailable`.
 * Responses are narrowed from `unknown`; a malformed body is an error, never a
 * guess — a guessed "ok" here would start a destructive move on the wrong facts.
 */
import { config } from "../config.js";
import { isBridgeConnectionError } from "../lib/bridge-errors.js";
import {
  RecordingsError,
  type NvrApplyMode,
  type NvrHostStatus,
  type NvrMigrationStatus,
} from "./recordings.types.js";

/** The raw `/drives` snapshot; the facts collector normalises each drive. */
export interface BridgeDrivesSnapshotRaw {
  drives: unknown[];
  os_disk?: string;
  disks?: unknown[];
}

export interface RecordingsBridge {
  getNvrStatus(): Promise<NvrHostStatus>;
  applyNvrTarget(req: { fsUuid: string; mode: NvrApplyMode; limitBytes?: number }): Promise<void>;
  resizeNvr(limitBytes: number): Promise<void>;
  startMigration(fsUuid: string): Promise<void>;
  getMigration(): Promise<NvrMigrationStatus>;
  deleteOldFootage(): Promise<void>;
  getDrivesSnapshot(): Promise<BridgeDrivesSnapshotRaw>;
}

// ── time budgets ─────────────────────────────────────────────────────────────
// The apply unit may take ~2 minutes (quota set + read-back + Nextcloud occ), so
// the mutating calls get more than the bridge's own 125 s wait.
const READ_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 130_000;

/** Same precedence as `routes/storage.ts`, read PER CALL so a token injected after boot is seen. */
function bridgeAuthToken(): string {
  return (process.env.BRIDGE_AUTH_TOKEN || process.env.SERVICE_TOKEN_DISPLAY || "").trim();
}

// ── narrowing helpers ────────────────────────────────────────────────────────
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const malformed = (what: string): never => {
  throw new Error(`device-bridge returned a malformed ${what}`);
};
const str = (v: unknown, what: string): string => (typeof v === "string" ? v : malformed(what));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown, what: string): boolean => (typeof v === "boolean" ? v : malformed(what));
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const numOr0 = (v: unknown): number => numOrNull(v) ?? 0;

export function parseNvrHostStatus(body: unknown): NvrHostStatus {
  if (!isObj(body)) return malformed("storage status");
  const kind = body.kind === "volume" || body.kind === "path" ? body.kind : malformed("storage status kind");
  return {
    source: str(body.source, "storage status source"),
    kind,
    fsUuid: strOrNull(body.fsUuid),
    mountPath: strOrNull(body.mountPath),
    physicalDisk: strOrNull(body.physicalDisk),
    backingDevices: Array.isArray(body.backingDevices)
      ? body.backingDevices.filter((d): d is string => typeof d === "string")
      : [],
    isSystemDisk: bool(body.isSystemDisk, "storage status isSystemDisk"),
    encrypted: bool(body.encrypted, "storage status encrypted"),
    mounted: bool(body.mounted, "storage status mounted"),
    rw: bool(body.rw, "storage status rw"),
    projectId: numOrNull(body.projectId),
    limitBytes: numOrNull(body.limitBytes),
    usedBytes: numOrNull(body.usedBytes),
    fsSizeBytes: numOrNull(body.fsSizeBytes),
    fsFreeBytes: numOrNull(body.fsFreeBytes),
  };
}

const JOB_STATES = ["idle", "running", "done", "failed"] as const;

export function parseNvrMigration(body: unknown): NvrMigrationStatus {
  if (!isObj(body)) return malformed("migration status");
  const state = JOB_STATES.find((s) => s === body.state) ?? malformed("migration state");
  const job = body.job === "migrate" || body.job === "delete_old" ? body.job : null;
  let oldSource: NvrMigrationStatus["oldSource"] = null;
  if (isObj(body.oldSource) && typeof body.oldSource.source === "string") {
    oldSource = {
      kind: body.oldSource.kind === "path" ? "path" : "volume",
      source: body.oldSource.source,
      bytes: numOr0(body.oldSource.bytes),
      deleted: body.oldSource.deleted === true,
    };
  }
  return {
    state,
    job,
    phase: strOrNull(body.phase),
    progressPct: Math.min(100, Math.max(0, Math.round(numOr0(body.progressPct)))),
    bytesCopied: numOr0(body.bytesCopied),
    bytesTotal: numOr0(body.bytesTotal),
    startedAt: strOrNull(body.startedAt),
    finishedAt: strOrNull(body.finishedAt),
    error: strOrNull(body.error),
    errorCode: strOrNull(body.errorCode),
    oldSource,
  };
}

interface CallOptions {
  body?: Record<string, unknown>;
  timeoutMs: number;
}

/** One authenticated call. Returns the parsed JSON body of a 2xx; maps every other outcome to a typed error. */
async function call(method: "GET" | "POST", path: string, opts: CallOptions): Promise<unknown> {
  const token = bridgeAuthToken();
  if (!token) {
    // Fail closed: with no bridge secret we cannot safely invoke a host action.
    throw new RecordingsError("bridge_unavailable", "the device-bridge auth token is not configured");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${config.DEVICE_BRIDGE_URL}${path}`, {
      method,
      headers: {
        "X-Droplet-Auth": token,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (isBridgeConnectionError(err) || (err as { name?: string }).name === "AbortError") {
      throw new RecordingsError("bridge_unavailable", "the device-bridge could not be reached");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return body;

  const code = isObj(body) && typeof body.code === "string" ? body.code : undefined;
  const message = isObj(body) && typeof body.error === "string" ? body.error : `the device-bridge returned ${res.status}`;
  if (res.status === 409) throw new RecordingsError("busy", message, code);
  if (res.status === 503) throw new RecordingsError("bridge_unavailable", message, code);
  if (res.status === 422) throw new RecordingsError("host_refused", message, code);
  const err = new Error(`${path}: ${message} (${res.status})`);
  (err as { status?: number }).status = res.status;
  throw err;
}

/** The production client; `call` reads config + env at call time, so one instance serves the process. */
export function createRecordingsBridge(): RecordingsBridge {
  return {
    async getNvrStatus() {
      return parseNvrHostStatus(await call("GET", "/host/nvr-storage", { timeoutMs: READ_TIMEOUT_MS }));
    },
    async applyNvrTarget(req) {
      await call("POST", "/host/nvr-storage", {
        timeoutMs: APPLY_TIMEOUT_MS,
        body: {
          fsUuid: req.fsUuid,
          mode: req.mode,
          ...(req.mode === "reserved" && req.limitBytes !== undefined ? { limitBytes: req.limitBytes } : {}),
        },
      });
    },
    async resizeNvr(limitBytes) {
      await call("POST", "/host/nvr-storage/resize", { timeoutMs: APPLY_TIMEOUT_MS, body: { limitBytes } });
    },
    async startMigration(fsUuid) {
      await call("POST", "/host/nvr-storage/migrate", { timeoutMs: START_TIMEOUT_MS, body: { fsUuid } });
    },
    async getMigration() {
      return parseNvrMigration(await call("GET", "/host/nvr-storage/migrate", { timeoutMs: READ_TIMEOUT_MS }));
    },
    async deleteOldFootage() {
      await call("POST", "/host/nvr-storage/old/delete", { timeoutMs: START_TIMEOUT_MS, body: {} });
    },
    async getDrivesSnapshot() {
      const body = await call("GET", "/drives", { timeoutMs: READ_TIMEOUT_MS });
      if (!isObj(body) || !Array.isArray(body.drives)) return malformed("drives snapshot");
      return {
        drives: body.drives,
        ...(typeof body.os_disk === "string" ? { os_disk: body.os_disk } : {}),
        ...(Array.isArray(body.disks) ? { disks: body.disks } : {}),
      };
    },
  };
}
