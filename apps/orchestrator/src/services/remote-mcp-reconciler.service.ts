/**
 * WARP-2651 — reconcile the orchestrator's attachment against the bridge's
 * actual sessions, once per tick, from `cron-runtime.service.ts`.
 *
 * ## The two failures, and why neither self-heals
 *
 * #1964's own Gaps list names both, and its last line names this fix:
 * *"A cron-runtime health read over the port, which #1944's `health()` was
 * written pure for, is the obvious fix and is not in this PR."*
 *
 *   1. **Orchestrator restarts / crashes, bridge stays up.** The bridge holds an
 *      authenticated vendor connection nothing drives. `open` replaces it on the
 *      next boot — *if a boot attach happens at all*. If the operator removed
 *      the server from `REMOTE_MCP_SERVER_ALLOWLIST` or disconnected the
 *      account in the meantime, no `open` ever comes and the connection just
 *      stays open. Handled here by the ORPHAN SWEEP: a session the orchestrator
 *      does not own is closed, with one audit row.
 *   2. **Bridge restarts, orchestrator stays up.** The bridge's session store is
 *      memory-only (correct: ADR-043 §4's kill switch must tear sessions down),
 *      so the orchestrator's port names a session that is gone and every
 *      dispatch answers `SESSION_NOT_OPEN` **until the orchestrator restarts** —
 *      #1964 had no re-open path. Handled here by the RE-OPEN: a registration
 *      that believes it is `attached` while the bridge holds no such session
 *      goes `reattaching` → `attached`.
 *
 * ## No `while (true)`, and no advisory lock either
 *
 * Scheduling is `cronRuntime.scheduleInterval` (repo rule 9), at the 30 s the
 * schedule ticker and the egress reconciler already use.
 *
 * Unlike those two it takes **no `lockKey`**, and that is a decision rather than
 * an omission. An advisory lock exists so only one replica performs a shared
 * side effect — one firewall write, one row update. What this tick converges is
 * **this process's own in-memory attachment**, which every replica has its own
 * copy of. A lock would let one replica win the key and leave every other one
 * permanently detached, believing a session it does not hold is fine, which is
 * the exact bug this file exists to close.
 *
 * ## Rule 19
 *
 * Nothing here reads or holds a credential. The re-open goes through
 * `attachAtlassianRemote`, which opens the ADR-042 seal **at that moment** and
 * drops the plaintext when the call returns — there is deliberately no cached
 * credential between ticks, so a rotated token is picked up on the next re-open
 * and no customer secret lives in a long-lived orchestrator field.
 */
import type { CronRuntime } from "./cron-runtime.service.js";
import { createLogger } from "../lib/logger.js";
import type { McpBridgeHealth } from "./mcp-bridge.client.js";
import {
  auditRemoteMcpLifecycle,
  ownsBridgeSession,
  remoteMcpLifecycle,
  type RemoteMcpLifecycleRegistry,
} from "./remote-mcp-lifecycle.service.js";
import type { RemoteAttachResult } from "./remote-mcp-servers.js";

const logger = createLogger("remote-mcp-reconciler");

/**
 * 30 s — the interval `index.ts` already uses for the schedule ticker and the
 * egress reconciler (`SCHEDULE_TICK_MS`'s default). Reused rather than invented
 * so the box has one convergence cadence, and deliberately NOT a new env var:
 * an interval nobody has asked to tune is a config surface with no reader.
 */
export const REMOTE_MCP_RECONCILE_INTERVAL_MS = 30_000;

/** Why a tick did no work. `null` means it ran. Named rather than inferred from
 *  a zero count, which is the same fact for three different reasons. */
export type RemoteMcpReconcileSkip = "nothing_registered" | "backoff" | null;

export interface RemoteMcpReconcileResult {
  /** Registrations that were due this tick. */
  checked: number;
  /** Server ids whose session was re-opened. */
  reattached: string[];
  /** Server ids the bridge held that this process does not own. */
  orphansClosed: string[];
  /** `true` when `GET /health` itself did not answer. */
  bridgeUnreachable: boolean;
  skipped: RemoteMcpReconcileSkip;
}

export interface RemoteMcpReconcilerDeps {
  /** Defaults to the process-wide registry; injected in tests. */
  lifecycle?: RemoteMcpLifecycleRegistry;
  /** `GET /health` — every session the BRIDGE holds, not just ours. */
  health: () => Promise<McpBridgeHealth>;
  /** `DELETE /sessions/:id`. */
  closeSession: (serverId: string) => Promise<void>;
  /** Drop the multiplexer's port before a re-attach, or `attachRemote` refuses
   *  with `SERVER_ID_IN_USE` and the re-open silently does nothing. */
  detach: (serverId: string) => void;
  /** The FULL attach path: gate → ADR-042 credential re-read → bridge open →
   *  mux attach → catalog vetting. It writes its own terminal lifecycle state,
   *  which is why this tick only has to record `reattaching`. */
  reattach: (
    serverId: string,
    knownTools: readonly string[],
  ) => Promise<RemoteAttachResult>;
  audit?: typeof auditRemoteMcpLifecycle;
  /** Injected so a test can step past a backoff window without sleeping. */
  now?: () => number;
}

/**
 * One reconcile pass. Bounded, idempotent, and safe to run when nothing is
 * configured — in which case it makes ZERO network calls, which is the property
 * asserted rather than the count of tools it did not find.
 */
export async function reconcileRemoteMcpSessions(
  deps: RemoteMcpReconcilerDeps,
): Promise<RemoteMcpReconcileResult> {
  const lifecycle = deps.lifecycle ?? remoteMcpLifecycle;
  const audit = deps.audit ?? auditRemoteMcpLifecycle;
  const empty: RemoteMcpReconcileResult = {
    checked: 0,
    reattached: [],
    orphansClosed: [],
    bridgeUnreachable: false,
    skipped: null,
  };

  const registrations = lifecycle.list();
  if (registrations.length === 0) {
    // The shipping default. `REMOTE_MCP_SERVER_ALLOWLIST` is empty, so no attach
    // ever registered anything, so there is nothing to reconcile and NOTHING IS
    // DIALLED — not even `/health`. A box nobody configured must not talk to a
    // container it is not running.
    return { ...empty, skipped: "nothing_registered" };
  }

  const now = (deps.now ?? Date.now)();
  const due = registrations.filter((r) => r.nextAttemptAt <= now);
  if (due.length === 0) {
    // Every registration is inside its bridge backoff window.
    return { ...empty, skipped: "backoff" };
  }

  let health: McpBridgeHealth;
  try {
    health = await deps.health();
  } catch (err) {
    for (const reg of due) {
      const t = lifecycle.record({
        serverId: reg.serverId,
        state: "bridge_unreachable",
        reason: "health_unreachable",
        bridgeHop: "failed",
      });
      if (t.changed) {
        audit({
          serverId: reg.serverId,
          event: "transition",
          from: t.from,
          to: t.to,
          reason: "health_unreachable",
        });
      }
    }
    logger.warn(
      { code: err instanceof Error ? err.message : String(err), servers: due.length },
      "remote_mcp_bridge_health_unreachable",
    );
    return { ...empty, checked: due.length, bridgeUnreachable: true };
  }

  // The bridge answered, so the HOP is healthy whatever the vendor sessions say.
  // Clear the backoff before anything else: a later refusal for an operator
  // reason (a disconnected account) must not leave the box in a ten-minute
  // bridge backoff it can only exit by waiting.
  for (const reg of due) {
    lifecycle.record({
      serverId: reg.serverId,
      state: reg.state,
      reason: reg.reason,
      bridgeHop: "succeeded",
    });
  }

  const orphansClosed: string[] = [];
  for (const session of health.sessions) {
    const reg = lifecycle.get(session.serverId);
    if (reg && ownsBridgeSession(reg)) continue;
    // Failure (1): an authenticated vendor connection nothing here drives. It is
    // closed rather than adopted — adopting it would mean trusting a session
    // opened with a credential this process never read, under an allowlist that
    // may have changed since.
    try {
      await deps.closeSession(session.serverId);
      orphansClosed.push(session.serverId);
      audit({ serverId: session.serverId, event: "orphan_session_closed" });
    } catch (err) {
      logger.warn(
        {
          serverId: session.serverId,
          code: err instanceof Error ? err.message : String(err),
        },
        "remote_mcp_orphan_close_failed",
      );
    }
  }

  const reattached: string[] = [];
  for (const reg of due) {
    const session = health.sessions.find((s) => s.serverId === reg.serverId);

    // ADR-043 §1's fourth failure state, from either direction: the bridge is
    // holding a session whose surface moved, or this process already knows it
    // did. TERMINAL until a human re-vets and acknowledges — a re-open would
    // hand the bridge a fresh session whose first listing has nothing to
    // compare against, which is silent acknowledgement wearing a retry's
    // clothes.
    if (session?.state === "catalog_changed") {
      const t = lifecycle.record({
        serverId: reg.serverId,
        state: "detached",
        reason: "catalog_changed",
      });
      if (t.changed) {
        audit({
          serverId: reg.serverId,
          event: "transition",
          from: t.from,
          to: t.to,
          reason: "catalog_changed",
        });
      }
      continue;
    }
    if (reg.reason === "catalog_changed") continue;

    // Every other non-`ready` session state — `auth_rejected`, `unreachable`,
    // `protocol_mismatch`, `reconnecting` — is the SESSION's own business and
    // has its own bounded reconnect in `remote-session.ts`. Re-opening on
    // `auth_rejected` in particular would be an unauthenticated request loop
    // against a vendor, which that module's docstring already refuses to do.
    // What this tick owns is the pair being out of step: no session at all, or
    // one the bridge has closed.
    const needsReopen =
      reg.state !== "attached" || session === undefined || session.state === "closed";
    if (!needsReopen) continue;

    const before = lifecycle.record({
      serverId: reg.serverId,
      state: "reattaching",
      reason: reg.state === "attached" ? "session_lost" : reg.reason,
    });
    if (before.changed) {
      audit({
        serverId: reg.serverId,
        event: "transition",
        from: before.from,
        to: before.to,
        reason: reg.state === "attached" ? "session_lost" : reg.reason,
      });
    }

    deps.detach(reg.serverId);
    // `attachAtlassianRemote` records the terminal state and its audit row, so
    // there is exactly one writer per transition and this loop cannot disagree
    // with it about what happened.
    const result = await deps.reattach(reg.serverId, reg.vettedTools);
    if (result.attached) reattached.push(reg.serverId);
  }

  return {
    checked: due.length,
    reattached,
    orphansClosed,
    bridgeUnreachable: false,
    skipped: null,
  };
}

/**
 * Mount the reconciler on the cron runtime.
 *
 * Errors propagate naked to `safeRun`, the same posture the pattern-miner and
 * purge handlers take: swallowing here would zero the per-handler
 * `consecutiveFailures` canary that downstream alerting reads.
 */
export function mountRemoteMcpReconciler(
  cronRuntime: Pick<CronRuntime, "scheduleInterval">,
  deps: RemoteMcpReconcilerDeps,
  intervalMs: number = REMOTE_MCP_RECONCILE_INTERVAL_MS,
): void {
  cronRuntime.scheduleInterval(intervalMs, async () => {
    const result = await reconcileRemoteMcpSessions(deps);
    if (
      result.reattached.length > 0 ||
      result.orphansClosed.length > 0 ||
      result.bridgeUnreachable
    ) {
      logger.info(result, "remote_mcp_reconcile tick complete");
    }
  });
}
