/**
 * WARP-2977 P2b-2 (ADR-059 §3.2; P2b spec §6.8) — the Matter door-lock
 * adapter CORE: turns what the smart-home service says about DoorLock
 * endpoints into `lock_state` rows for the Security feed.
 *
 * ── Owning slice: C (built in phase 1, ships in PR-2 with L0). ──
 * This file has no Prisma and no Prisma enums on purpose: the shared unions
 * (`SecurityEventSource`, `SecurityEventKind`, `SecurityHealthId`) gain
 * `matter_lock` / `lock_state` / `locks` only in L0. Until then everything is
 * a LOCAL type that L0 maps onto the shared ones:
 *   · `LockRowDraft`  → `SecurityEventDraft` + `observed` (live | polled);
 *   · `LockHealth`    → `SecurityHealthRow` with id `locks`;
 *   · `LockStore`     → L0's Prisma-backed store (over `recordSecurityEvent`);
 *   · `LockDeviceSource` → `matterLockDeviceSource(...)` below, fed the
 *     existing matter.service exports by index.ts.
 * It does NOT import matter.service: index.ts injects the functions, so the
 * route tests that mock matter.service with explicit factories stay green.
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
 *   · Memory moves ONLY on `recorded` | `duplicate`. A failed write keeps the
 *     old reading, so the next frame or sweep retries — the P2a status
 *     tracker's flaw (memory ahead of the store) is not repeated here.
 *   · The sweep (60 s, cron runtime, advisory lockKey) finds changes the live
 *     stream missed, as `polled` rows. Its t0 guard skips a key that heard a
 *     live frame at or after the sweep started: the list may predate it.
 *   · The subscriber can never throw synchronously — a throw inside the
 *     EventEmitter callback would tear down the SSE bridge for every consumer.
 *   · Health never reads `not_configured` on a smart-home service that has
 *     never answered: "no locks" is only ever what a SUCCESSFUL list said.
 *   · Copy never says monitored, armed, alarm, secure, protected, guard or
 *     space; rows never claim a cause (no "someone unlocked").
 *   · Canary (WARP-2203): no `next…` / `…Cursor` keys in this file.
 */
import type { CronRuntime } from "./cron-runtime.service.js";
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
 * One `lock_state` row before the database assigns an id. Field-for-field a
 * `SecurityEventDraft` (source `matter_lock`, kind `lock_state`) plus the
 * PR-2 `observed` column.
 */
export interface LockRowDraft {
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
 * Persistence, injected. L0 implements it over Prisma:
 *   · `lastReading` — `source matter_lock, sourceRef = ref`, orderBy
 *     `[startedAt desc, id desc]`, `labels[0]` as the reading. THROWS on a
 *     read failure (the tracker then writes nothing and retries).
 *   · `write` — through `recordSecurityEvent`. Must tell `duplicate` (the
 *     dedupeKey already exists) from `failed`: recordSecurityEvent's boolean
 *     alone conflates them.
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

function cleanName(v: unknown): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
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
 *   · `failed`     — nothing written; memory kept, so the next frame or sweep retries.
 *   · `superseded` — a polled reading older than a live frame for the same key; dropped.
 */
export type LockObserveOutcome = "unchanged" | "recorded" | "duplicate" | "failed" | "superseded";

export interface LockWriteHealth {
  lastRecordedAt: Date | null;
  lastWriteError: { at: Date; message: string } | null;
  lastLiveFrameAt: Date | null;
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
  const health: LockWriteHealth = { lastRecordedAt: null, lastWriteError: null, lastLiveFrameAt: null };

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
    health.lastWriteError = { at: now(), message: errMessage(err) };
    log.warn({ err, ref: obs.ref, reading: obs.reading }, `security lock ${what} failed — kept the previous reading, will retry`);
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
    if (known.reading === obs.reading) return "unchanged";

    const draft = lockRowDraft({ obs, prevId: known.id, name: nameOf(obs), via, at: receivedAt });
    let outcome: LockWriteOutcome;
    try {
      outcome = await store.write(draft);
    } catch (err) {
      noteFailure(err, obs, "write");
      return "failed";
    }
    if (outcome !== "recorded" && outcome !== "duplicate") {
      noteFailure(new Error("the store did not save the row"), obs, "write");
      return "failed";
    }
    health.lastRecordedAt = now();

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
          }),
        );
      }
      return Promise.all(drops).then(() => drops.length);
    },
    lastHeard: (ref) => heard.get(ref) ?? null,
    writeHealth: () => health,
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
 * types. L0 passes `getCommissionedDevices` wrapped in `enrichGrouped` so the
 * DeviceAlias name and room ride along as `friendlyName` / `roomName`.
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
  knownLocks: ReadonlyArray<Pick<KnownLock, "name" | "connected">>;
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
  const w = input.write;
  if (w.lastWriteError && (!w.lastRecordedAt || w.lastWriteError.at > w.lastRecordedAt)) {
    return row("down", "Lock changes are arriving but could not be saved");
  }
  const silent = input.knownLocks.filter((l) => !l.connected);
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

    const present = new Set<string>();
    const known: KnownLock[] = [];
    const freshNames = new Map<string, string>();
    const toObserve: LockObservation[] = [];

    for (const d of devices) {
      if (!isRecord(d)) continue;
      const nodeId = canonicalNodeId(d.nodeId);
      if (nodeId === null) continue;
      present.add(nodeId);
      // A lock is an endpoint that serves the DoorLock CLUSTER — never a device type or category.
      const lockEndpoints = (Array.isArray(d.endpoints) ? d.endpoints : [])
        .filter(
          (ep) =>
            isRecord(ep) && Array.isArray(ep.clusters) && ep.clusters.includes(MATTER_DOOR_LOCK_CLUSTER_ID),
        )
        .map((ep) => endpointIdOf((ep as { endpointId: unknown }).endpointId))
        .filter((id): id is number => id !== null);
      if (lockEndpoints.length === 0) continue;

      const name = lockDisplayName({ nodeId, friendlyName: d.friendlyName, name: d.name });
      const room = cleanName(d.roomName) || null;
      const connected = d.connectionState === "connected";
      const polled = lockEndpoints.length === 1;
      for (const endpointId of lockEndpoints) {
        const ref = lockRef(nodeId, endpointId);
        freshNames.set(ref, name);
        known.push({ ref, nodeId, endpointId, name, room, connected, reading: null, polled });
      }

      if (!polled) {
        // The sidecar merges attributes across endpoints, so the list cannot
        // say which of these locks `lockState` belongs to. Live frames carry
        // the endpoint and still cover them.
        if (!multiLogged.has(nodeId)) {
          multiLogged.add(nodeId);
          log.warn(
            { nodeId, endpoints: lockEndpoints },
            "security lock sweep skips a node with several door-lock endpoints — live changes still recorded",
          );
        }
        continue;
      }
      if (!connected) continue;
      const attributes = isRecord(d.attributes) ? d.attributes : {};
      const reading = lockReadingFromRaw(attributes.lockState);
      if (reading === undefined) continue;
      const endpointId = lockEndpoints[0];
      toObserve.push({ nodeId, endpointId, ref: lockRef(nodeId, endpointId), reading });
    }

    // Names first, so this sweep's rows and every later live frame snapshot
    // the current name. A node missing from this (successful) list is
    // decommissioned: forgotten, with no row.
    names = freshNames;
    const dropped = await tracker.forgetNodesExcept(present);
    const outcomes = await Promise.all(
      toObserve.map((obs) => tracker.observe(obs, "polled", { sweepStartedAt: t0 })),
    );

    snapshot = known;
    state.lastSweepOkAt = now();
    if (state.consecutiveSweepFailures > 0) log.info({ after: state.consecutiveSweepFailures }, "security lock sweep recovered");
    state.consecutiveSweepFailures = 0;
    state.lastSweepLockCount = known.length;
    const count = (o: LockObserveOutcome) => outcomes.filter((x) => x === o).length;
    return {
      status: "ok",
      locks: known.length,
      observed: outcomes.length,
      recorded: count("recorded"),
      failed: count("failed"),
      superseded: count("superseded"),
      dropped,
    };
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

// ── wiring shapes (L0 calls these from index.ts; nothing calls them yet) ─

let active: SecurityLockAdapter | null = null;

/**
 * Right after the Matter init block in index.ts (L0). Runs whether or not the
 * security or smart_home module is on: capture is independent of display.
 * Replaces (and stops) any adapter already started.
 *
 *   startSecurityLockAdapter({
 *     store: createPrismaLockStore(prisma),               // L0
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

/** Beside `registerSecurityJobs` in index.ts (L0). The sweep is single-flighted on its advisory lock. */
export function registerSecurityLockJobs(
  cronRuntime: Pick<CronRuntime, "scheduleInterval">,
  adapter: SecurityLockAdapter,
): void {
  cronRuntime.scheduleInterval(
    SECURITY_LOCK_SWEEP_INTERVAL_MS,
    async () => {
      const r = await adapter.sweep();
      if (r.status === "ok" && (r.recorded > 0 || r.dropped > 0)) defaultLogger.info(r, "security lock sweep");
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

/** The header row; "Not running" when no adapter was started. */
export function securityLockHealthRow(): LockHealth {
  return active
    ? active.health()
    : lockHealthRow({
        ...NOT_RUNNING,
        started: false,
        sweepScheduled: false,
        bridgeUp: false,
        knownLocks: [],
        write: { lastRecordedAt: null, lastWriteError: null, lastLiveFrameAt: null },
      });
}

/** Test seam — module state survives between tests otherwise. */
export function _resetSecurityLockAdapterForTests(): void {
  active?.stop();
  active = null;
}
