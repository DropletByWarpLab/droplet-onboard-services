/**
 * WARP-2977 P2b-2 (ADR-059 §3.2; P2b spec §6.8) — the Matter door-lock
 * adapter CORE: turns what the smart-home service says about DoorLock
 * endpoints into `lock_state` rows for the Security feed.
 *
 * ── Slice C (the core) + L0 (the wiring), WARP-2977 PR-2. ──
 * The core is built against injected interfaces; L0 supplies them:
 *   · `LockRowDraft`  — a `SecurityEventDraft` (source `matter_lock`, kind
 *     `lock_state`, `observed` live | polled), written through the one
 *     writer by `createPrismaLockStore` below;
 *   · `LockHealth`    — a `SecurityHealthRow` with id `locks`;
 *   · `LockDeviceSource` → `matterLockDeviceSource(...)` below, fed the
 *     existing matter.service exports by index.ts;
 *   · `SecurityLockReader` — what the /security routes read (a fresh lock
 *     list for the Areas page and link checks, the last sweep's locks for a
 *     Close up's `unlockedLocks`, the health row).
 * No Prisma ENUM is imported here (the store passes the draft's string
 * unions straight to the writer). It does NOT import matter.service: index.ts
 * injects the functions, so the route tests that mock matter.service with
 * explicit factories stay green.
 *
 * The rules this file holds (spec §6.8):
 *   · A frame is a lock reading only on the REAL wire path — an OBJECT
 *     `{endpointId, clusterId: 257, attributeId: 0, attributeName: 'lockState'}`.
 *     String paths, other clusters and other attributes are ignored. A lock is
 *     NEVER identified by device type: 0x0101 is also the Dimmable Light.
 *   · The reading comes from the RAW DoorLock.LockState number, never the
 *     sidecar's state string: 1 locked, 2 unlocked, 0 not_fully_locked,
 *     3 unlatched, null unknown.
 *   · Transitions only, one promise chain per `matter:<nodeId>/<endpointId>`.
 *     The first observation of a key reads the previous `{id, reading}` back
 *     from the store; with no stored row it writes a baseline.
 *   · `dedupeKey = matter_lock:<node>/<ep>:after:<prevId|none>:<reading>` is
 *     deterministic, so two bridges (or a retry of a write that did land)
 *     collapse to one row.
 *   · Memory moves ONLY on `recorded` | `duplicate` — never ahead of the
 *     store (the P2a status tracker's flaw). A failed write FORGETS the key's
 *     memory: `failed` can be a connection drop after COMMIT, so the next
 *     frame or sweep reads the history back and sees the row if it landed.
 *   · The sweep (60 s, cron runtime, advisory lockKey) finds changes the live
 *     stream missed, as `polled` rows. Its t0 guard skips a key that heard a
 *     live frame at or after the sweep started: the list may predate it.
 *   · A known lock is gone only after SECURITY_LOCK_GONE_AFTER_LISTS
 *     successful lists in a row lack it; until then it is kept as not
 *     reporting (the sidecar skips a node whose info build throws).
 *   · The subscriber can never throw synchronously — a throw inside the
 *     EventEmitter callback would tear down the SSE bridge for every consumer.
 *   · Health never reads `not_configured` on a smart-home service that has
 *     never answered: "no locks" is only ever what a SUCCESSFUL list said.
 *   · "Could not be saved" is per lock: down while some lock's latest store
 *     round-trip failed and is unsettled, never on an old error alone (locks
 *     sit still for days) and never cleared by ANOTHER lock's save.
 *   · Copy never says monitored, armed, alarm, secure, protected, guard or
 *     space; rows never claim a cause (no "someone unlocked").
 *   · Canary (WARP-2203): no `next…` / `…Cursor` keys in this file.
 */
import type { PrismaClient } from "@prisma/client";
import type { CronRuntime } from "./cron-runtime.service.js";
import type { SecurityEventDraft } from "./security-event-ingest.js";
import { writeSecurityEvent } from "./security-events.service.js";
import type { MatterCommissionedDevice, MatterGrouped } from "../types/smart-home.js";
import { createLogger } from "../lib/logger.js";

// ── constants ────────────────────────────────────────────────────────────

/** Matter DoorLock cluster (0x0101). The cluster id — never the device type, which collides with Dimmable Light. */
export const MATTER_DOOR_LOCK_CLUSTER_ID = 257;
/** DoorLock.LockState. */
export const MATTER_LOCK_STATE_ATTRIBUTE_ID = 0;

export const SECURITY_LOCK_SWEEP_INTERVAL_MS = 60_000;
export const SECURITY_LOCK_SWEEP_LOCK_KEY = "droplet:security-lock-sweep";
/** Consecutive failed sweeps after which the last good list is no longer trusted. */
export const SECURITY_LOCK_SWEEP_FAILURES_DOWN = 3;
/**
 * The cap on the FRESH list a person waits on (/security/sources, a new lock
 * link). The sidecar's own timeout is 30 s; a page load must not hang that
 * long — the answer is then "couldn't check the door locks" (review F3). The
 * sweep keeps the service's own timeout: nobody waits on it.
 */
export const SECURITY_LOCK_LIST_TIMEOUT_MS = 5_000;
/**
 * A known lock is GONE (forgotten, "isn't paired any more", not counted) only
 * after this many consecutive SUCCESSFUL lists lack it — about 3 minutes of
 * sweeps. The sidecar's listDevices skips a node whose device-info build
 * throws (review F5), so one absence is not "unpaired". Until then it is kept
 * as not reporting. A failed list is not an absence.
 */
export const SECURITY_LOCK_GONE_AFTER_LISTS = 3;

const NODE_ID = /^\d{1,20}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const REF = /^matter:(\d{1,20})\/(\d{1,5})$/;
const NAME_MAX = 80;

// ── local types (L0 maps these onto the shared unions) ──────────────────

export type LockReading = "locked" | "unlocked" | "not_fully_locked" | "unlatched" | "unknown";
export const LOCK_READINGS: readonly LockReading[] = ["locked", "unlocked", "not_fully_locked", "unlatched", "unknown"];

/** `live` = startedAt is when it happened; `polled` = when Droplet's 60 s check found it (never timing evidence). */
export type LockObservedVia = "live" | "polled";

/** One reading of one DoorLock endpoint. `ref` is the row's sourceRef and the lock link's sourceRef. */
export interface LockObservation {
  nodeId: string;
  endpointId: number;
  ref: string;
  reading: LockReading;
}

/**
 * One `lock_state` row before the database assigns an id: a
 * `SecurityEventDraft` narrowed to source `matter_lock`, kind `lock_state`
 * (the `extends` makes the compiler hold it to that shape).
 */
export interface LockRowDraft extends SecurityEventDraft {
  source: "matter_lock";
  kind: "lock_state";
  severity: "info" | "notice";
  camera: null;
  sourceRef: string;
  dedupeKey: string;
  labels: [LockReading];
  cameraZones: string[];
  score: null;
  startedAt: Date;
  endedAt: null;
  summary: string;
  observed: LockObservedVia;
}

/** The latest stored row for a key. `id` is `SecurityEvent.id` as a decimal string. */
export interface StoredLockReading {
  id: string;
  reading: LockReading;
}

export type LockWriteOutcome = "recorded" | "duplicate" | "failed";

/**
 * Persistence, injected. `createPrismaLockStore` (below) is the real one:
 *   · `lastReading` — `source matter_lock, sourceRef = ref`, orderBy
 *     `[startedAt desc, id desc]`, `labels[0]` as the reading. THROWS on a
 *     read failure (the tracker then writes nothing and retries).
 *   · `write` — through the one writer, `writeSecurityEvent`, which tells
 *     `duplicate` (the dedupeKey already exists) from `failed`.
 *   · `idByDedupeKey` — the row's id, or null.
 */
export interface LockStore {
  lastReading(ref: string): Promise<StoredLockReading | null>;
  write(draft: LockRowDraft): Promise<LockWriteOutcome>;
  idByDedupeKey(dedupeKey: string): Promise<string | null>;
}

/** The slice of a commissioned device the adapter reads (structurally a `MatterCommissionedDevice`). */
export type LockSourceDevice = Pick<
  MatterCommissionedDevice,
  "nodeId" | "name" | "connectionState" | "endpoints" | "attributes"
> &
  Partial<Pick<MatterCommissionedDevice, "friendlyName" | "roomName">>;

/**
 * The smart-home service, injected (see `matterLockDeviceSource`).
 *   · `list` — EVERY commissioned device, whatever its category. THROWS when
 *     the service cannot answer, so a failure never reads as "no locks".
 *   · `bridgeUp` — `isMatterInitialized()`: the live stream is being heard.
 */
export interface LockDeviceSource {
  list(): Promise<readonly LockSourceDevice[]>;
  bridgeUp(): boolean;
}

/** pino-compatible; the cron runtime's logger shape. */
export interface LockLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const defaultLogger: LockLogger = createLogger("security-lock-adapter");

// ── pure parse ───────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A Matter node id: decimal uint64, canonicalised (no leading zeros) so one lock is one key. */
function canonicalNodeId(v: unknown): string | null {
  if (typeof v !== "string" || !NODE_ID.test(v)) return null;
  const n = BigInt(v);
  return n > UINT64_MAX ? null : n.toString();
}

/** Application endpoints only: 0 is the root node, 65535 the wildcard. */
function endpointIdOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65534 ? v : null;
}

export function lockRef(nodeId: string, endpointId: number): string {
  return `matter:${nodeId}/${endpointId}`;
}

/**
 * A lock link's `sourceRef` → its endpoint, or null. Only the CANONICAL form
 * `lockRef` writes is accepted (no leading zeros, a uint64 node, endpoint
 * 1..65534): a link is joined to lock rows by exact string equality, so a
 * ref in any other spelling could never match a row.
 */
export function parseLockRef(ref: string): { nodeId: string; endpointId: number } | null {
  const m = REF.exec(ref);
  if (!m) return null;
  const nodeId = canonicalNodeId(m[1]);
  const endpointId = endpointIdOf(Number(m[2]));
  if (nodeId === null || endpointId === null) return null;
  return lockRef(nodeId, endpointId) === ref ? { nodeId, endpointId } : null;
}

/** RAW DoorLock.LockState → reading; `undefined` when the value is not one. */
export function lockReadingFromRaw(v: unknown): LockReading | undefined {
  switch (v) {
    case null:
      return "unknown";
    case 0:
      return "not_fully_locked";
    case 1:
      return "locked";
    case 2:
      return "unlocked";
    case 3:
      return "unlatched";
    default:
      return undefined;
  }
}

/**
 * A `state_changed` bridge event (`{nodeId, path, value}`, as the sidecar
 * emits it) → a lock reading, or null for anything that is not exactly a
 * DoorLock.LockState report.
 */
export function parseLockFrame(e: unknown): LockObservation | null {
  if (!isRecord(e)) return null;
  const path = e.path;
  // The wire shape is an OBJECT. A string path ("1/257/0") is not what the
  // sidecar sends, and matching it would make wrong fixtures pass.
  if (!isRecord(path)) return null;
  if (path.clusterId !== MATTER_DOOR_LOCK_CLUSTER_ID) return null;
  if (path.attributeId !== MATTER_LOCK_STATE_ATTRIBUTE_ID) return null;
  const nodeId = canonicalNodeId(e.nodeId);
  const endpointId = endpointIdOf(path.endpointId);
  if (nodeId === null || endpointId === null) return null;
  const reading = lockReadingFromRaw(e.value);
  if (reading === undefined) return null;
  return { nodeId, endpointId, ref: lockRef(nodeId, endpointId), reading };
}

// ── the row ──────────────────────────────────────────────────────────────

export function lockDedupeKey(obs: Pick<LockObservation, "nodeId" | "endpointId" | "reading">, prevId: string | null): string {
  return `matter_lock:${obs.nodeId}/${obs.endpointId}:after:${prevId ?? "none"}:${obs.reading}`;
}

const READING_TEXT: Record<LockReading, string> = {
  locked: "locked",
  unlocked: "unlocked",
  not_fully_locked: "not fully locked",
  unlatched: "unlatched",
  unknown: "state unknown",
};

/** A UTF-16 surrogate without its partner: not encodable as UTF-8, so not storable text. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function cleanName(v: unknown): string {
  if (typeof v !== "string") return "";
  const flat = v
    .replace(LONE_SURROGATE, "\uFFFD")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Cut by code point: a UTF-16 slice can split an emoji and leave a lone
  // surrogate in the summary, and a summary the store cannot take would fail
  // every write for that lock.
  return Array.from(flat).slice(0, NAME_MAX).join("").trim();
}

export function fallbackLockName(nodeId: string): string {
  return `Lock …${nodeId.slice(-4)}`;
}

/** DeviceAlias name (the list's `friendlyName` overlay) ?? the device-list name ?? `Lock …<last4>`. */
export function lockDisplayName(device: { nodeId: string; friendlyName?: string | null; name?: string | null }): string {
  return cleanName(device.friendlyName) || cleanName(device.name) || fallbackLockName(device.nodeId);
}

/** A row snapshots the name it was written under; it states the reading and never a cause. */
export function lockRowDraft(input: {
  obs: LockObservation;
  prevId: string | null;
  name: string;
  via: LockObservedVia;
  at: Date;
}): LockRowDraft {
  const { obs, via } = input;
  return {
    source: "matter_lock",
    kind: "lock_state",
    severity: obs.reading === "not_fully_locked" ? "notice" : "info",
    camera: null,
    sourceRef: obs.ref,
    dedupeKey: lockDedupeKey(obs, input.prevId),
    labels: [obs.reading],
    cameraZones: [],
    score: null,
    startedAt: input.at,
    endedAt: null,
    summary: `${input.name}: ${READING_TEXT[obs.reading]}${via === "polled" ? " (found when Droplet checked)" : ""}`,
    observed: via,
  };
}

// ── the tracker ──────────────────────────────────────────────────────────

/**
 *   · `unchanged`  — the store already says this.
 *   · `recorded`   — a row was written.
 *   · `duplicate`  — the row already existed (another bridge, or a retry of a write that landed).
 *   · `failed`     — not known to be written; memory forgotten, so the next frame or sweep reads the history and retries.
 *   · `superseded` — a polled reading older than a live frame for the same key; dropped.
 */
export type LockObserveOutcome = "unchanged" | "recorded" | "duplicate" | "failed" | "superseded";

export interface LockWriteHealth {
  lastRecordedAt: Date | null;
  lastWriteError: { at: Date; message: string } | null;
  lastLiveFrameAt: Date | null;
  /**
   * Keys whose LATEST store round-trip failed (history read or write) and has
   * not since been settled — by a save, by the store turning out to hold the
   * reading already, or by the node leaving the list. Health keys on this,
   * not on "last error newer than last save": a lock can sit still for days,
   * so a recovered blip that needs no write would otherwise read down until
   * the next change, and one lock's save would hide another lock's failure.
   */
  unsaved: number;
}

export interface LockTracker {
  /**
   * Apply one reading on its key's chain. Never rejects. `sweepStartedAt` is
   * the sweep's t0: a polled reading for a key that heard a live frame at or
   * after it is `superseded`.
   */
  observe(obs: LockObservation, via: LockObservedVia, opts?: { sweepStartedAt?: Date }): Promise<LockObserveOutcome>;
  /** Drop every key whose node is not in `present` (a successful list). No row. Resolves with the number of keys dropped. */
  forgetNodesExcept(present: ReadonlySet<string>): Promise<number>;
  /** The reading the device last gave for `ref` (live, or a polled one no live frame superseded), or null. */
  lastHeard(ref: string): LockReading | null;
  writeHealth(): Readonly<LockWriteHealth>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const noop = (): void => undefined;

export function createLockTracker(deps: {
  store: LockStore;
  now?: () => Date;
  /** The name a row snapshots. Defaults to `Lock …<last4>`. */
  nameOf?: (obs: LockObservation) => string;
  logger?: LockLogger;
}): LockTracker {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const nameOf = deps.nameOf ?? ((obs: LockObservation) => fallbackLockName(obs.nodeId));
  const log = deps.logger ?? defaultLogger;

  /** What the STORE holds per key, as far as this process knows. Absent = read it back first. */
  const persisted = new Map<string, { id: string | null; reading: LockReading | null }>();
  /** Receipt time (ms) of the latest live frame per key — the t0 guard's input. Set at receipt, not on apply. */
  const liveAt = new Map<string, number>();
  /** What the device last said per key — for display (knownLocks), never for transitions. */
  const heard = new Map<string, LockReading>();
  const chains = new Map<string, Promise<void>>();
  /** Keys whose latest store round-trip failed and is not settled yet (see LockWriteHealth.unsaved). */
  const unsaved = new Set<string>();
  const health: Omit<LockWriteHealth, "unsaved"> = { lastRecordedAt: null, lastWriteError: null, lastLiveFrameAt: null };

  function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = chains.get(key) ?? Promise.resolve();
    const run = prior.then(fn);
    const tail = run.then(noop, noop);
    chains.set(key, tail);
    // Keep the map to in-flight keys only.
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  function noteFailure(err: unknown, obs: LockObservation, what: string): void {
    unsaved.add(obs.ref);
    health.lastWriteError = { at: now(), message: errMessage(err) };
    log.warn({ err, ref: obs.ref, reading: obs.reading }, `security lock ${what} failed — will read the history back and retry`);
  }

  async function apply(
    obs: LockObservation,
    via: LockObservedVia,
    receivedAt: Date,
    sweepStartedAt: Date | undefined,
  ): Promise<LockObserveOutcome> {
    if (via === "polled" && sweepStartedAt) {
      // t0 guard: the list was fetched from t0 on, so a live frame heard at or
      // after t0 may be newer than what the list says.
      const live = liveAt.get(obs.ref);
      if (live !== undefined && live >= sweepStartedAt.getTime()) return "superseded";
    }
    heard.set(obs.ref, obs.reading);

    let known = persisted.get(obs.ref);
    if (!known) {
      let stored: StoredLockReading | null;
      try {
        stored = await store.lastReading(obs.ref);
      } catch (err) {
        // No history to compare against: write nothing rather than risk a
        // wrong baseline. The next frame or sweep reads again.
        noteFailure(err, obs, "history read");
        return "failed";
      }
      known = stored ? { id: stored.id, reading: stored.reading } : { id: null, reading: null };
      persisted.set(obs.ref, known);
    }
    if (known.reading === obs.reading) {
      // The store already holds what the device says: nothing is pending.
      unsaved.delete(obs.ref);
      return "unchanged";
    }

    const draft = lockRowDraft({ obs, prevId: known.id, name: nameOf(obs), via, at: receivedAt });
    let outcome: LockWriteOutcome;
    try {
      outcome = await store.write(draft);
    } catch (err) {
      // `failed` may be a lie: the connection can drop AFTER the commit. Forget
      // what the store holds, so the next observation reads the history back
      // and sees the row if it did land (review F2).
      persisted.delete(obs.ref);
      noteFailure(err, obs, "write");
      return "failed";
    }
    if (outcome !== "recorded" && outcome !== "duplicate") {
      persisted.delete(obs.ref);
      noteFailure(new Error("the store did not save the row"), obs, "write");
      return "failed";
    }
    health.lastRecordedAt = now();
    unsaved.delete(obs.ref);

    let id: string | null = null;
    try {
      id = await store.idByDedupeKey(draft.dedupeKey);
    } catch (err) {
      log.warn({ err, ref: obs.ref }, "security lock row id read-back failed — will re-read the history");
    }
    if (id === null) {
      // The row is in, but its id is not known: without it the next row's
      // `after:` would be wrong. Forget, so the next observation reads back.
      persisted.delete(obs.ref);
    } else {
      persisted.set(obs.ref, { id, reading: obs.reading });
    }
    return outcome;
  }

  return {
    observe(obs, via, opts) {
      const receivedAt = now();
      if (via === "live") {
        liveAt.set(obs.ref, receivedAt.getTime());
        health.lastLiveFrameAt = receivedAt;
      }
      return enqueue(obs.ref, () => apply(obs, via, receivedAt, opts?.sweepStartedAt)).catch((err: unknown) => {
        noteFailure(err, obs, "update");
        return "failed" as const;
      });
    },
    forgetNodesExcept(present) {
      const refs = new Set<string>([...persisted.keys(), ...liveAt.keys(), ...heard.keys()]);
      const drops: Promise<void>[] = [];
      for (const ref of refs) {
        const node = REF.exec(ref)?.[1];
        if (node !== undefined && present.has(node)) continue;
        liveAt.delete(ref);
        drops.push(
          enqueue(ref, async () => {
            persisted.delete(ref);
            heard.delete(ref);
            unsaved.delete(ref);
          }),
        );
      }
      return Promise.all(drops).then(() => drops.length);
    },
    lastHeard: (ref) => heard.get(ref) ?? null,
    writeHealth: () => ({ ...health, unsaved: unsaved.size }),
  };
}

// ── the subscriber ───────────────────────────────────────────────────────

/**
 * The `subscribeStateChanges` callback. It can never throw synchronously and
 * never leaves a rejection unhandled: the bridge's EventEmitter would
 * otherwise take the SSE stream down for every consumer (matter.service.ts).
 */
export function lockFrameSubscriber(
  tracker: Pick<LockTracker, "observe">,
  warn: (err: unknown) => void,
): (event: unknown) => void {
  const safeWarn = (err: unknown): void => {
    try {
      warn(err);
    } catch {
      // A logger failure must not reach the bridge either.
    }
  };
  return (event) => {
    try {
      const obs = parseLockFrame(event);
      if (obs) void Promise.resolve(tracker.observe(obs, "live")).catch(safeWarn);
    } catch (err) {
      safeWarn(err);
    }
  };
}

// ── the device source over matter.service ────────────────────────────────

/**
 * Adapts the existing matter.service exports (injected by index.ts — this
 * file never imports matter.service). EVERY group is flattened: a lock is
 * found by its cluster, and the sidecar's category is derived from device
 * types. index.ts passes `getCommissionedDevices` wrapped in `enrichGrouped`
 * so the DeviceAlias name and room ride along as `friendlyName` / `roomName`.
 */
export function matterLockDeviceSource(deps: {
  getCommissionedDevices: () => Promise<MatterGrouped>;
  isMatterInitialized: () => boolean;
}): LockDeviceSource {
  return {
    async list() {
      const grouped: unknown = await deps.getCommissionedDevices();
      if (!isRecord(grouped)) throw new Error("the smart-home service returned no device list");
      const groups = Object.values(grouped);
      if (groups.length === 0 || !groups.every(Array.isArray)) {
        throw new Error("the smart-home service returned an unexpected device list");
      }
      const out: LockSourceDevice[] = [];
      const seen = new Set<string>();
      for (const group of groups as unknown[][]) {
        for (const d of group) {
          if (!isRecord(d) || typeof d.nodeId !== "string" || seen.has(d.nodeId)) continue;
          seen.add(d.nodeId);
          out.push(d as unknown as LockSourceDevice);
        }
      }
      return out;
    },
    bridgeUp() {
      try {
        return deps.isMatterInitialized() === true;
      } catch {
        return false;
      }
    },
  };
}

// ── the adapter: tracker + sweep + health ────────────────────────────────

/** A DoorLock endpoint from the last successful list, with the reading last heard for it. */
export interface KnownLock {
  ref: string;
  nodeId: string;
  endpointId: number;
  name: string;
  room: string | null;
  connected: boolean;
  reading: LockReading | null;
  /** False for a node with several DoorLock endpoints: the list merges their attributes, so only live frames cover it. */
  polled: boolean;
}

/** What one successful device list says about door locks. Pure. */
interface DeviceListReading {
  /** Every well-formed node id in the list (a lock or not): a node absent from it is decommissioned. */
  present: Set<string>;
  /** Every DoorLock endpoint, in list order; `reading` is null here (the caller fills in what was heard). */
  known: KnownLock[];
  /** The reading the list gives for each single-endpoint, connected lock — the sweep's polled observations. */
  polledReadings: LockObservation[];
  /** Nodes with several DoorLock endpoints (the sweep logs each once). */
  multi: Array<{ nodeId: string; endpoints: number[] }>;
}

function readDeviceList(devices: readonly unknown[]): DeviceListReading {
  const out: DeviceListReading = { present: new Set(), known: [], polledReadings: [], multi: [] };
  for (const d of devices) {
    if (!isRecord(d)) continue;
    const nodeId = canonicalNodeId(d.nodeId);
    if (nodeId === null) continue;
    out.present.add(nodeId);
    // A lock is an endpoint that serves the DoorLock CLUSTER — never a device type or category.
    const lockEndpoints = (Array.isArray(d.endpoints) ? d.endpoints : [])
      .filter(
        (ep) => isRecord(ep) && Array.isArray(ep.clusters) && ep.clusters.includes(MATTER_DOOR_LOCK_CLUSTER_ID),
      )
      .map((ep) => endpointIdOf((ep as { endpointId: unknown }).endpointId))
      .filter((id): id is number => id !== null);
    if (lockEndpoints.length === 0) continue;

    const name = lockDisplayName({
      nodeId,
      friendlyName: d.friendlyName as string | null | undefined,
      name: d.name as string | null | undefined,
    });
    const room = cleanName(d.roomName) || null;
    const connected = d.connectionState === "connected";
    const polled = lockEndpoints.length === 1;
    for (const endpointId of lockEndpoints) {
      out.known.push({ ref: lockRef(nodeId, endpointId), nodeId, endpointId, name, room, connected, reading: null, polled });
    }

    if (!polled) {
      // The sidecar merges attributes across endpoints, so the list cannot
      // say which of these locks `lockState` belongs to. Live frames carry
      // the endpoint and still cover them.
      out.multi.push({ nodeId, endpoints: lockEndpoints });
      continue;
    }
    if (!connected) continue;
    const attributes = isRecord(d.attributes) ? d.attributes : {};
    const reading = lockReadingFromRaw(attributes.lockState);
    if (reading === undefined) continue;
    const endpointId = lockEndpoints[0];
    out.polledReadings.push({ nodeId, endpointId, ref: lockRef(nodeId, endpointId), reading });
  }
  return out;
}

/** The readings a Close up / Away answer names as still open. `unknown` is not one: it is not known to be open. */
const STILL_OPEN: ReadonlySet<LockReading> = new Set<LockReading>(["unlocked", "not_fully_locked", "unlatched"]);

/**
 * Route 7's `unlockedLocks`: the names of the locks that are REPORTING (the
 * device is connected) and were last heard unlocked, not fully locked or
 * unlatched. One name per device, sorted. Never phrased — or computed — as
 * "all locked": a lock that is locked, unknown, never heard, or not
 * reporting is simply not named.
 */
export function stillUnlockedLocks(
  known: ReadonlyArray<Pick<KnownLock, "nodeId" | "name" | "connected" | "reading">>,
): string[] {
  const byNode = new Map<string, string>();
  for (const l of known) {
    if (!l.connected || l.reading === null || !STILL_OPEN.has(l.reading)) continue;
    if (!byNode.has(l.nodeId)) byNode.set(l.nodeId, l.name);
  }
  return [...byNode.values()].sort((a, b) => a.localeCompare(b));
}

export type LockSweepResult =
  | {
      status: "ok";
      locks: number;
      observed: number;
      recorded: number;
      failed: number;
      superseded: number;
      dropped: number;
    }
  | { status: "failed"; message: string }
  | { status: "busy" };

export interface LockSweepState {
  lastSweepOkAt: Date | null;
  lastSweepError: { at: Date; message: string } | null;
  consecutiveSweepFailures: number;
  /** Lock endpoints the last SUCCESSFUL list held; null until one succeeds. */
  lastSweepLockCount: number | null;
}

export type LockHealthState = "ok" | "down" | "not_configured";

/** Structurally a `SecurityHealthRow` with id `locks` (L0 widens the shared union). */
export interface LockHealth {
  id: "locks";
  state: LockHealthState;
  detail: string;
  lastSeenAt: string | null;
}

export interface LockHealthInput extends LockSweepState {
  started: boolean;
  sweepScheduled: boolean;
  bridgeUp: boolean;
  knownLocks: ReadonlyArray<Pick<KnownLock, "nodeId" | "name" | "connected">>;
  write: Readonly<LockWriteHealth>;
}

/**
 * The `locks` row of the /security header (shown only to viewers who may
 * read locks — the route's job). Pure. There is no "quiet" rule: locks
 * legitimately sit still for days.
 */
export function lockHealthRow(input: LockHealthInput): LockHealth {
  const seen = [input.lastSweepOkAt, input.write.lastLiveFrameAt]
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const lastSeenAt = seen ? seen.toISOString() : null;
  const row = (state: LockHealthState, detail: string): LockHealth => ({ id: "locks", state, detail, lastSeenAt });

  if (!input.started || !input.sweepScheduled) return row("down", "Not running");
  if (input.lastSweepOkAt === null && input.lastSweepError === null && input.bridgeUp) {
    // Registered, the service is up, the first sweep has not run yet
    // (scheduleInterval has no immediate tick). Still down, never "no locks".
    return row("down", "Hasn't checked the locks yet");
  }
  if (
    !input.bridgeUp ||
    input.lastSweepOkAt === null ||
    input.consecutiveSweepFailures >= SECURITY_LOCK_SWEEP_FAILURES_DOWN
  ) {
    return row("down", "Can't reach the smart-home service");
  }
  if (input.write.unsaved > 0) {
    return row("down", "Lock changes are arriving but could not be saved");
  }
  // Connection is per NODE: a device with two DoorLock endpoints that drops
  // off is one device not reporting, not "X and 1 other lock".
  const silentNodes = new Set<string>();
  const silent = input.knownLocks.filter((l) => {
    if (l.connected || silentNodes.has(l.nodeId)) return false;
    silentNodes.add(l.nodeId);
    return true;
  });
  if (silent.length === 1) return row("down", `${silent[0].name} isn't reporting`);
  if (silent.length > 1) {
    const others = silent.length - 1;
    return row("down", `${silent[0].name} and ${others} other lock${others === 1 ? "" : "s"} aren't reporting`);
  }
  if (input.lastSweepLockCount === 0) return row("not_configured", "No door locks paired");
  const n = input.lastSweepLockCount ?? input.knownLocks.length;
  return row("ok", `Listening to ${n} lock${n === 1 ? "" : "s"}`);
}

export interface SecurityLockAdapterDeps {
  store: LockStore;
  source: LockDeviceSource;
  /** matter.service `subscribeStateChanges`. */
  subscribeStateChanges: (callback: (event: unknown) => void) => () => void;
  now?: () => Date;
  logger?: LockLogger;
}

export interface SecurityLockAdapter {
  readonly tracker: LockTracker;
  /** Subscribe to the live stream. Never throws: a failure leaves health at "Not running". */
  start(): void;
  stop(): void;
  /** One reconcile pass. Never throws. */
  sweep(): Promise<LockSweepResult>;
  /**
   * A FRESH list of every paired DoorLock endpoint (with the reading last
   * heard for each), for the Areas page and route 12's link check. Writes no
   * row and leaves the sweep's state alone. THROWS when the smart-home
   * service cannot answer, or does not within SECURITY_LOCK_LIST_TIMEOUT_MS —
   * never an empty list.
   */
  listLocks(): Promise<KnownLock[]>;
  /** Called by `registerSecurityLockJobs` once the sweep is on the cron runtime. */
  noteSweepScheduled(): void;
  /** DoorLock endpoints from the last successful list, with their last-heard readings. */
  knownLocks(): KnownLock[];
  sweepState(): Readonly<LockSweepState>;
  health(): LockHealth;
}

export function createSecurityLockAdapter(deps: SecurityLockAdapterDeps): SecurityLockAdapter {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? defaultLogger;
  let names = new Map<string, string>();
  let snapshot: KnownLock[] = [];
  /** Consecutive successful lists that lacked a known lock, by ref (review F5). */
  const missedLists = new Map<string, number>();
  const multiLogged = new Set<string>();
  const state: LockSweepState = {
    lastSweepOkAt: null,
    lastSweepError: null,
    consecutiveSweepFailures: 0,
    lastSweepLockCount: null,
  };
  let started = false;
  let sweepScheduled = false;
  let sweeping = false;
  let unsubscribe: (() => void) | null = null;

  const tracker = createLockTracker({
    store: deps.store,
    now,
    logger: log,
    nameOf: (obs) => names.get(obs.ref) ?? fallbackLockName(obs.nodeId),
  });

  async function runSweep(): Promise<LockSweepResult> {
    const t0 = now();
    let devices: readonly LockSourceDevice[];
    try {
      const listed: unknown = await deps.source.list();
      if (!Array.isArray(listed)) throw new Error("the smart-home service returned no device list");
      devices = listed as LockSourceDevice[];
    } catch (err) {
      const message = errMessage(err);
      state.lastSweepError = { at: now(), message };
      state.consecutiveSweepFailures += 1;
      if (state.consecutiveSweepFailures === 1 || state.consecutiveSweepFailures === SECURITY_LOCK_SWEEP_FAILURES_DOWN) {
        log.warn(
          { err, consecutiveFailures: state.consecutiveSweepFailures },
          "security lock sweep could not list devices — nothing written",
        );
      }
      return { status: "failed", message };
    }

    const { present, known, polledReadings, multi } = readDeviceList(devices);
    for (const m of multi) {
      if (multiLogged.has(m.nodeId)) continue;
      multiLogged.add(m.nodeId);
      log.warn(
        { nodeId: m.nodeId, endpoints: m.endpoints },
        "security lock sweep skips a node with several door-lock endpoints — live changes still recorded",
      );
    }

    // A known lock this (successful) list lacks is KEPT, as not reporting,
    // until SECURITY_LOCK_GONE_AFTER_LISTS lists in a row have lacked it:
    // the sidecar skips a node whose info build throws (review F5).
    const listedRefs = new Set(known.map((l) => l.ref));
    const kept: KnownLock[] = [];
    for (const prev of snapshot) {
      if (listedRefs.has(prev.ref)) continue;
      const misses = (missedLists.get(prev.ref) ?? 0) + 1;
      if (misses >= SECURITY_LOCK_GONE_AFTER_LISTS) {
        missedLists.delete(prev.ref);
        continue;
      }
      missedLists.set(prev.ref, misses);
      kept.push({ ...prev, connected: false });
    }
    for (const ref of listedRefs) missedLists.delete(ref);
    const locks = [...known, ...kept];

    // Names first, so this sweep's rows and every later live frame snapshot
    // the current name. A node that is neither listed nor kept is gone:
    // forgotten, with no row.
    names = new Map(locks.map((l) => [l.ref, l.name]));
    const dropped = await tracker.forgetNodesExcept(new Set([...present, ...kept.map((l) => l.nodeId)]));
    const outcomes = await Promise.all(
      polledReadings.map((obs) => tracker.observe(obs, "polled", { sweepStartedAt: t0 })),
    );

    snapshot = locks;
    state.lastSweepOkAt = now();
    if (state.consecutiveSweepFailures > 0) log.info({ after: state.consecutiveSweepFailures }, "security lock sweep recovered");
    state.consecutiveSweepFailures = 0;
    state.lastSweepLockCount = locks.length;
    const count = (o: LockObserveOutcome) => outcomes.filter((x) => x === o).length;
    const result = {
      status: "ok" as const,
      locks: locks.length,
      observed: outcomes.length,
      recorded: count("recorded"),
      failed: count("failed"),
      superseded: count("superseded"),
      dropped,
    };
    if (result.recorded > 0 || result.dropped > 0) log.info(result, "security lock sweep");
    return result;
  }

  const adapter: SecurityLockAdapter = {
    tracker,
    start() {
      if (started) return;
      try {
        unsubscribe = deps.subscribeStateChanges(lockFrameSubscriber(tracker, (err) => log.warn({ err }, "security lock frame dropped")));
        started = true;
      } catch (err) {
        log.error({ err }, "security lock adapter could not subscribe to smart-home changes — /security shows locks as not running");
      }
    },
    stop() {
      try {
        unsubscribe?.();
      } catch (err) {
        log.warn({ err }, "security lock adapter unsubscribe failed");
      }
      unsubscribe = null;
      started = false;
    },
    async sweep() {
      if (sweeping) return { status: "busy" };
      sweeping = true;
      try {
        return await runSweep();
      } catch (err) {
        // Defensive: runSweep handles its own failures; nothing escapes to the cron runtime.
        const message = errMessage(err);
        state.lastSweepError = { at: now(), message };
        state.consecutiveSweepFailures += 1;
        log.error({ err }, "security lock sweep failed");
        return { status: "failed", message };
      } finally {
        sweeping = false;
      }
    },
    noteSweepScheduled() {
      sweepScheduled = true;
    },
    async listLocks() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const giveUp = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the smart-home service did not answer within ${SECURITY_LOCK_LIST_TIMEOUT_MS / 1000} s`)),
          SECURITY_LOCK_LIST_TIMEOUT_MS,
        );
        timer.unref?.();
      });
      let listed: unknown;
      try {
        // A late answer or failure of the losing list is still handled by the race.
        listed = await Promise.race([deps.source.list(), giveUp]);
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(listed)) throw new Error("the smart-home service returned no device list");
      const fresh = readDeviceList(listed).known;
      // A lock the sweep still keeps (not yet gone, review F5) but this list
      // lacks is still paired as far as Droplet knows: listed, as not reporting.
      const freshRefs = new Set(fresh.map((l) => l.ref));
      const kept = snapshot.filter((l) => !freshRefs.has(l.ref)).map((l) => ({ ...l, connected: false }));
      return [...fresh, ...kept].map((l) => ({ ...l, reading: tracker.lastHeard(l.ref) }));
    },
    knownLocks() {
      return snapshot.map((l) => ({ ...l, reading: tracker.lastHeard(l.ref) }));
    },
    sweepState: () => state,
    health() {
      let bridgeUp = false;
      try {
        bridgeUp = deps.source.bridgeUp() === true;
      } catch {
        // A source that cannot say reads as unreachable, never as fine.
      }
      return lockHealthRow({
        ...state,
        started,
        sweepScheduled,
        bridgeUp,
        knownLocks: snapshot,
        write: tracker.writeHealth(),
      });
    },
  };
  return adapter;
}

// ── the store over Prisma ────────────────────────────────────────────────

const READING_SET: ReadonlySet<string> = new Set(LOCK_READINGS);

/**
 * The real `LockStore`: reads a lock's history back from SecurityEvent (on
 * the `(sourceRef, startedAt)` index) and writes through the one writer,
 * `writeSecurityEvent`, whose write health is per source — a lock write can
 * never clear a failing Frigate write.
 */
export function createPrismaLockStore(prisma: Pick<PrismaClient, "securityEvent">): LockStore {
  return {
    async lastReading(ref) {
      const row = await prisma.securityEvent.findFirst({
        where: { source: "matter_lock", sourceRef: ref },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: { id: true, labels: true },
      });
      if (!row) return null;
      const reading = row.labels[0];
      // SecurityEvent_lock_shape makes this unreachable; if it ever is, the
      // tracker must not write a transition from a reading it cannot name.
      if (reading === undefined || !READING_SET.has(reading)) {
        throw new Error(`security lock row ${row.id} holds no reading`);
      }
      return { id: row.id.toString(), reading: reading as LockReading };
    },
    write: (draft) => writeSecurityEvent(prisma, draft),
    async idByDedupeKey(dedupeKey) {
      const row = await prisma.securityEvent.findUnique({ where: { dedupeKey }, select: { id: true } });
      return row ? row.id.toString() : null;
    },
  };
}

// ── wiring (index.ts calls these; the /security routes read the adapter) ─

/** What the /security routes read from the adapter (injectable through the routers' `deps.locks`). */
export type SecurityLockReader = Pick<SecurityLockAdapter, "listLocks" | "knownLocks" | "health">;

let active: SecurityLockAdapter | null = null;

/**
 * Right after the Matter init block in index.ts. Runs whether or not the
 * security or smart_home module is on: capture is independent of display
 * (the DS-015 analogue). Replaces (and stops) any adapter already started.
 *
 *   startSecurityLockAdapter({
 *     store: createPrismaLockStore(prisma),
 *     source: matterLockDeviceSource({
 *       getCommissionedDevices: async () => enrichGrouped(prisma, await getCommissionedDevices()),
 *       isMatterInitialized,
 *     }),
 *     subscribeStateChanges,
 *   });
 */
export function startSecurityLockAdapter(deps: SecurityLockAdapterDeps): SecurityLockAdapter {
  active?.stop();
  const adapter = createSecurityLockAdapter(deps);
  adapter.start();
  active = adapter;
  return adapter;
}

/** Beside `registerSecurityJobs` in index.ts. The sweep is single-flighted on its advisory lock. */
export function registerSecurityLockJobs(
  cronRuntime: Pick<CronRuntime, "scheduleInterval">,
  adapter: SecurityLockAdapter,
): void {
  cronRuntime.scheduleInterval(
    SECURITY_LOCK_SWEEP_INTERVAL_MS,
    async () => {
      // sweep() never throws and logs through the adapter's own logger.
      await adapter.sweep();
    },
    { lockKey: SECURITY_LOCK_SWEEP_LOCK_KEY },
  );
  adapter.noteSweepScheduled();
}

/** The started adapter, for the /security routes (knownLocks, unlockedLocks). */
export function securityLockAdapter(): SecurityLockAdapter | null {
  return active;
}

const NOT_RUNNING: Readonly<LockSweepState> = {
  lastSweepOkAt: null,
  lastSweepError: null,
  consecutiveSweepFailures: 0,
  lastSweepLockCount: null,
};

/**
 * The header row of `reader` (default: the started adapter); "Not running"
 * when there is none. The /security route passes its injected reader.
 */
export function securityLockHealthRow(reader: Pick<SecurityLockReader, "health"> | null = active): LockHealth {
  return reader
    ? reader.health()
    : lockHealthRow({
        ...NOT_RUNNING,
        started: false,
        sweepScheduled: false,
        bridgeUp: false,
        knownLocks: [],
        write: { lastRecordedAt: null, lastWriteError: null, lastLiveFrameAt: null, unsaved: 0 },
      });
}

/** Test seam — module state survives between tests otherwise. */
export function _resetSecurityLockAdapterForTests(): void {
  active?.stop();
  active = null;
}
