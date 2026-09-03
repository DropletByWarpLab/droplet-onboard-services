/**
 * WARP-2651 — the orchestrator's own view of whether it is attached to the
 * bridge, as an explicit closed union.
 *
 * ## The two asymmetric failures this exists for
 *
 * #1964 put the outbound session in `services/mcp-bridge` (ADR-043 §5) and had
 * the orchestrator open it once, at boot. Two processes, one session, and
 * nothing reconciling them — so either half restarting left the pair wrong in a
 * way neither could see, and its own Gaps list says so:
 *
 *   1. **The orchestrator crashes, the bridge stays up.** The bridge holds an
 *      authenticated vendor connection that nothing is driving, until the
 *      orchestrator's next `open` happens to replace it. If the operator
 *      meanwhile removed the server from the allowlist or disconnected the
 *      account, *nothing ever replaces it* and the connection simply stays open.
 *   2. **The bridge restarts, the orchestrator stays up.** The bridge's session
 *      store is memory-only (correct — a restart must tear sessions down), so
 *      the orchestrator's port now names a session that does not exist. Every
 *      dispatch answers `SESSION_NOT_OPEN` **until the orchestrator restarts**,
 *      because #1964 had no re-open path at all.
 *
 * ## Why a registry and not a boolean, and why not a Prisma column
 *
 * "No guessing state": the attachment is a DECLARED value here, never derived
 * from "is there a session id" or "did the last call fail". The four states are
 * closed, and each is a different thing for an operator to be told:
 *
 *   - `attached`           — this process holds a live session on the bridge.
 *   - `reattaching`        — a re-open is in flight this tick. The honest
 *                            answer to "why did that tool just disappear".
 *   - `detached`           — no session, and `reason` says why. Some reasons
 *                            are the operator's to fix; some are ours.
 *   - `bridge_unreachable` — the BRIDGE hop failed, which is a different
 *                            remedy from the vendor being down (that one is
 *                            the bridge's own `RemoteMcpSessionHealth`).
 *
 * It is **runtime state, deliberately not a Prisma column.** A column would
 * claim the attachment survives a restart, and the whole point is that it does
 * not: the session lives in another process's memory, so a persisted `attached`
 * read back after a crash would be a stale claim that this module exists to
 * stop making. The repo rule is that PERSISTENT status is an explicit column;
 * this status is not persistent, and writing it to a table would be the
 * guess — not reading it from one.
 *
 * ## Rule 19
 *
 * A registration carries a server id, a state, a reason token and counters. It
 * never carries a credential, a vendor host, a tool argument or a server's
 * error text — and neither do the audit rows this module writes.
 */
import { createLogger } from "../lib/logger.js";
import { recordActivity } from "./activity.singleton.js";

const logger = createLogger("remote-mcp-lifecycle");

/** Every state this process's attachment to the bridge can be in. Closed. */
export const REMOTE_MCP_ATTACH_STATES = [
  "attached",
  "reattaching",
  "detached",
  "bridge_unreachable",
] as const;

export type RemoteMcpAttachState = (typeof REMOTE_MCP_ATTACH_STATES)[number];

/**
 * Why the attachment is in the state it is in.
 *
 * A bounded vocabulary, and every value maps to a different thing to do — the
 * same discipline `session-state.ts` applies to the session's own failures. The
 * first four mirror `RemoteAttachSkipReason` because they ARE those refusals
 * observed from the outside; the rest are this reconciler's own findings.
 */
export type RemoteMcpAttachReason =
  /** The operator has not named this server in REMOTE_MCP_SERVER_ALLOWLIST. */
  | "not_allowlisted"
  /** The connection row is missing, not CONNECTED, or has no credential. */
  | "gate_refused"
  /** The row's credential does not carry every field a session needs. */
  | "credential_incomplete"
  /** The bridge refused or did not answer the open. */
  | "bridge_unavailable"
  /** The bridge no longer holds the session this process opened. */
  | "session_lost"
  /**
   * The vendor's tool surface is not the one we vetted (ADR-043 §1's fourth
   * failure state). Terminal until a human re-vets and acknowledges — the
   * reconciler must NOT re-open past this, because a fresh session's first
   * listing has nothing to compare against and would absorb the drift.
   */
  | "catalog_changed"
  /** `GET /health` on the bridge did not answer. */
  | "health_unreachable";

/**
 * What the operator should do. A stable token, not prose — `routes/contacts.ts`
 * settled that convention (*"`remediation` is a stable token, not prose"*), and
 * the dashboard renders its own copy from it.
 */
export type RemoteMcpRemediation =
  /** Nothing to do. */
  | "none"
  /** It clears on its own; the next tick retries. */
  | "wait"
  /** Add the server to REMOTE_MCP_SERVER_ALLOWLIST. */
  | "enable_server"
  /** Reconnect the account on the credentials page. */
  | "reconnect_account"
  /** The credential is stored but incomplete — finish it. */
  | "complete_credential"
  /** Re-vet the changed tool surface and acknowledge it. */
  | "review_catalog"
  /** The mcp-bridge container is not answering. */
  | "check_bridge";

/** Reason → remediation. Total over the union with no `default`, so a reason
 *  added later fails `tsc` here rather than silently taking a fallthrough. */
const REMEDIATION_BY_REASON: Readonly<
  Record<RemoteMcpAttachReason, RemoteMcpRemediation>
> = {
  not_allowlisted: "enable_server",
  gate_refused: "reconnect_account",
  credential_incomplete: "complete_credential",
  bridge_unavailable: "check_bridge",
  session_lost: "wait",
  catalog_changed: "review_catalog",
  health_unreachable: "check_bridge",
};

/** One server's registration. Immutable snapshots; the registry replaces. */
export interface RemoteMcpAttachRegistration {
  readonly serverId: string;
  readonly state: RemoteMcpAttachState;
  readonly reason: RemoteMcpAttachReason | null;
  /** Epoch ms of the last transition INTO this state. */
  readonly since: number;
  /** Consecutive failed bridge hops. Drives the backoff, reset on success. */
  readonly consecutiveBridgeFailures: number;
  /** Epoch ms before which the reconciler must not dial. `0` = due now. */
  readonly nextAttemptAt: number;
  /**
   * The tool names the BRIDGE last advertised for this server — the drift
   * baseline handed back on a re-open.
   *
   * The bridge's names, not the multiplexer's vetted subset: a tool the
   * multiplexer drops (an illegal wire name, a collision) is still a tool the
   * vendor advertises, and baselining on the subset would make it read as
   * `added` drift on every single re-open, pinning the session in
   * `catalog_changed` forever.
   */
  readonly vettedTools: readonly string[];
}

/** The read-time shape a surface renders. `reason` + `remediation`, the
 *  #1950 split: what happened, and what to do about it. */
export interface RemoteMcpAttachView {
  readonly serverId: string;
  readonly state: RemoteMcpAttachState;
  readonly reason: RemoteMcpAttachReason | null;
  readonly remediation: RemoteMcpRemediation;
  readonly since: string;
}

/** What a `record` call did, so a caller audits TRANSITIONS and not ticks. */
export interface RemoteMcpAttachTransition {
  readonly changed: boolean;
  readonly from: RemoteMcpAttachState | null;
  readonly to: RemoteMcpAttachState;
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/**
 * Bounded exponential backoff for the bridge hop.
 *
 * Bounded in both directions: it never retries faster than the tick and never
 * slower than ten minutes. An unbounded backoff on a container that comes back
 * would leave the box detached for hours after the outage ended, which is the
 * failure mode of a retry policy nobody capped.
 */
export function remoteMcpBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
}

/**
 * Whether THIS process owns the bridge session for a registration.
 *
 * Ownership is what the orphan sweep keys on, and it is deliberately wider than
 * `state === "attached"`. A `catalog_changed` registration is `detached` —
 * nothing is advertised and nothing is callable — but the bridge session behind
 * it must stay open, because closing it would destroy the drift record and the
 * `acknowledge-catalog` call that resolves it. Sweeping that session away would
 * turn "a human must re-vet this surface" into "the surface silently came back
 * as new", which is exactly what ADR-043 §1 forbids.
 */
export function ownsBridgeSession(reg: RemoteMcpAttachRegistration): boolean {
  return (
    reg.state === "attached" ||
    reg.state === "reattaching" ||
    reg.reason === "catalog_changed"
  );
}

export interface RemoteMcpRecordInput {
  serverId: string;
  state: RemoteMcpAttachState;
  reason?: RemoteMcpAttachReason | null;
  /** Replaces the drift baseline. Omitted leaves the stored one alone. */
  vettedTools?: readonly string[];
  /** `true` bumps the failure counter and arms the backoff; `false` clears
   *  both. Omitted leaves them untouched. */
  bridgeHop?: "failed" | "succeeded";
}

/**
 * The registrations, keyed by server id.
 *
 * A class rather than a module-level Map so every test drives its own instance
 * and no test can see another's state. The process-wide singleton below is the
 * one production wiring.
 */
export class RemoteMcpLifecycleRegistry {
  readonly #byServer = new Map<string, RemoteMcpAttachRegistration>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  get(serverId: string): RemoteMcpAttachRegistration | undefined {
    return this.#byServer.get(serverId);
  }

  /** Every registration, sorted by server id. The reconciler's work list. */
  list(): RemoteMcpAttachRegistration[] {
    return [...this.#byServer.keys()].sort().map((id) => this.#byServer.get(id)!);
  }

  /** Drop a server entirely — the "the operator removed it from the allowlist"
   *  path. Nothing is left behind to reconcile. */
  unregister(serverId: string): boolean {
    return this.#byServer.delete(serverId);
  }

  /**
   * Write the state.
   *
   * `since` only moves on an actual change, so "how long has this been
   * reattaching" is a real answer rather than "since the last tick".
   */
  record(input: RemoteMcpRecordInput): RemoteMcpAttachTransition {
    const prev = this.#byServer.get(input.serverId);
    const now = this.#now();
    const reason = input.reason === undefined ? null : input.reason;
    const changed = prev === undefined || prev.state !== input.state || prev.reason !== reason;

    const failures = (() => {
      if (input.bridgeHop === "failed") return (prev?.consecutiveBridgeFailures ?? 0) + 1;
      if (input.bridgeHop === "succeeded") return 0;
      return prev?.consecutiveBridgeFailures ?? 0;
    })();

    this.#byServer.set(input.serverId, {
      serverId: input.serverId,
      state: input.state,
      reason,
      since: changed ? now : prev.since,
      consecutiveBridgeFailures: failures,
      nextAttemptAt:
        input.bridgeHop === "failed"
          ? now + remoteMcpBackoffMs(failures)
          : input.bridgeHop === "succeeded"
            ? 0
            : (prev?.nextAttemptAt ?? 0),
      vettedTools: input.vettedTools ?? prev?.vettedTools ?? [],
    });

    return { changed, from: prev?.state ?? null, to: input.state };
  }

  /** The read-time view, or `null` for a server nobody registered — which is
   *  the shipping default and is NOT an error state. */
  view(serverId: string): RemoteMcpAttachView | null {
    const reg = this.#byServer.get(serverId);
    if (!reg) return null;
    return {
      serverId: reg.serverId,
      state: reg.state,
      reason: reg.reason,
      remediation: reg.reason === null ? "none" : REMEDIATION_BY_REASON[reg.reason],
      since: new Date(reg.since).toISOString(),
    };
  }
}

/** The process-wide registry. One per orchestrator process, because the
 *  attachment it describes is one per orchestrator process. */
export const remoteMcpLifecycle = new RemoteMcpLifecycleRegistry();

/** What a lifecycle audit row records. Two events, kept distinct because they
 *  answer different questions in an audit trail. */
export type RemoteMcpLifecycleEvent = "transition" | "orphan_session_closed";

/**
 * One signed activity row per lifecycle event.
 *
 * Same `kind: "network"` / `sub: "remote_mcp"` envelope as
 * `auditRemoteMcp`, so an operator reading the channel sees the attach story
 * and the call story interleaved in one place. Fire-and-forget: a reconciler
 * tick never waits on the append lock.
 *
 * Rule 19: server id, states and a reason token. No credential, no host, no
 * vendor text — the reason vocabulary is closed and written here.
 */
export function auditRemoteMcpLifecycle(input: {
  serverId: string;
  event: RemoteMcpLifecycleEvent;
  from?: RemoteMcpAttachState | null;
  to?: RemoteMcpAttachState;
  reason?: RemoteMcpAttachReason | null;
}): void {
  logger.info(
    { serverId: input.serverId, event: input.event, from: input.from, to: input.to, reason: input.reason },
    "remote_mcp_lifecycle",
  );
  void recordActivity({
    kind: "network",
    severity: input.to === "attached" || input.event === "orphan_session_closed" ? "info" : "warn",
    sourceIcon: "globe",
    what: `Remote MCP: ${input.serverId}`,
    sub: "remote_mcp",
    refs: {
      channel: "remote_mcp",
      serverId: input.serverId,
      op: "lifecycle",
      event: input.event,
      ...(input.from !== undefined && input.from !== null ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
    actor: { type: "ai", id: null },
  });
}
