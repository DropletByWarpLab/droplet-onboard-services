/**
 * reset.service — owner-only factory-reset orchestration (WARP-825).
 *
 * A factory reset wipes every data volume + the generated secrets and bounces
 * the whole stack (scripts/factory-reset.sh runs `docker compose down -v`,
 * which kills the orchestrator container itself). The orchestrator therefore
 * MUST NOT run the script in-process — by the time the wipe finishes there is
 * no orchestrator left to report a result, and a web-tier `exec` of a
 * data-destroying host script is exactly the bypass architecture-guard rule 20
 * forbids.
 *
 * Instead the reset is dispatched through the SAME controlled host-executor
 * path the destructive storage-pool ops and the single-box Wi-Fi write use:
 * the orchestrator POSTs to the device-bridge (config.DEVICE_BRIDGE_URL, auth-
 * gated with the shared BRIDGE_AUTH_TOKEN), and the bridge — a host process —
 * shells the repo-tracked host script (scripts/host/droplet-factory-reset.sh,
 * installed to /usr/local/sbin by setup.sh) DETACHED, so the wipe survives the
 * orchestrator going down. The bridge never runs the reset itself; the host
 * script is the real executor.
 *
 * Persistent state is an EXPLICIT ResetJob.status enum (handbook rule 10 /
 * project CLAUDE.md "no guessing"; precedent WARP-218 BrainMemoryItemStatus,
 * BUG-3 PoolStatus) — never inferred from the absence of a column. The audit
 * row is written BEFORE the wipe is dispatched (AC1) so the destructive intent
 * is recorded even if the box is gone a second later. A single in-flight job is
 * enforced (AC3 double-fire guard).
 *
 * Mirrors hostapd-bridge.service.ts for the bridge access pattern (token
 * precedence read per-call, X-Droplet-Auth header, fail-closed on empty token,
 * isBridgeConnectionError degradation) and storage-safety.service.ts for the
 * CommandAuditLog dual-write shape.
 */

import { timingSafeEqual } from "node:crypto";
import pino from "pino";
import type { PrismaClient, ResetJob } from "@prisma/client";
import { config } from "../config.js";
import { isBridgeConnectionError } from "../lib/bridge-errors.js";

const logger = pino({ name: "reset-service" });

const BRIDGE_URL = config.DEVICE_BRIDGE_URL;
const DOMAIN = "system";
const SERVICE = "factory_reset";

/** Structured error codes the route maps to HTTP statuses. */
export type ResetErrorCode =
  | "CONFIRM_MISMATCH"
  | "RESET_ALREADY_IN_PROGRESS"
  | "BRIDGE_AUTH_UNCONFIGURED"
  | "BRIDGE_UNREACHABLE"
  | "BRIDGE_REFUSED";

export class ResetError extends Error {
  readonly code: ResetErrorCode;
  /** Bridge HTTP status when the failure came from a non-ok bridge reply. */
  readonly bridgeStatus?: number;

  constructor(code: ResetErrorCode, message: string, bridgeStatus?: number) {
    super(message);
    this.name = "ResetError";
    this.code = code;
    this.bridgeStatus = bridgeStatus;
  }
}

/**
 * Shared secret the device-bridge requires on its mutating routes. Same env
 * precedence + per-call read as storage.ts / hostapd-bridge.service.ts so a
 * secret injected after boot (and the tests) see the current value.
 */
function bridgeAuthToken(): string {
  return (
    process.env.BRIDGE_AUTH_TOKEN ||
    process.env.SERVICE_TOKEN_DISPLAY ||
    ""
  ).trim();
}

/**
 * SERVER-side friction check (AC1): the value the owner typed must exactly
 * equal the device target name. This runs on the server — the client's
 * type-to-confirm gate is a UX affordance, NOT the authority. Constant-time so
 * the comparison can't be used as a timing oracle for the (non-secret but still
 * never-trust-the-client) target name.
 *
 * Whitespace around the typed value is trimmed (a trailing space from a
 * copy-paste shouldn't block a legitimate owner); an empty typed value is
 * always rejected, even against an empty target, so a blank field never clears
 * the friction step.
 */
export function validateConfirmToken(typed: string, expected: string): boolean {
  const a = (typed ?? "").trim();
  const b = (expected ?? "").trim();
  if (a.length === 0) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch; a length difference is already a
  // definitive non-match, so short-circuit (no secret leaks via length here —
  // the target name is not a secret).
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface RequestFactoryResetInput {
  /** User.id (UUID) of the owner who confirmed. */
  userId?: string;
  /** The device name the owner typed into the type-to-confirm field. */
  typedConfirm: string;
  /** The canonical device/host name the reset targets (read from device identity). */
  targetName: string;
}

/** A ResetJob row plus nothing else — the dashboard polls this shape. */
export type ResetStatus = Pick<
  ResetJob,
  "id" | "status" | "targetName" | "failureReason" | "createdAt" | "updatedAt"
>;

/**
 * Request a factory reset. Owner-gating is the route's job (requireRole). This
 * service:
 *   1. verifies the type-to-confirm friction token server-side (throws
 *      CONFIRM_MISMATCH on a mismatch — nothing is created or dispatched),
 *   2. refuses if a reset is already in flight (RESET_ALREADY_IN_PROGRESS),
 *   3. writes the audit row BEFORE anything destructive,
 *   4. creates the ResetJob (status `requested`),
 *   5. dispatches the wipe to the device-bridge host executor and flips the job
 *      to `dispatched` on success, or `failed` (box untouched) on any dispatch
 *      error — fail-closed with no bridge token.
 */
export async function requestFactoryReset(
  prisma: PrismaClient,
  input: RequestFactoryResetInput,
): Promise<ResetJob> {
  const { userId, typedConfirm, targetName } = input;

  // (1) Server-side friction. Never trust the client's gate alone.
  if (!validateConfirmToken(typedConfirm, targetName)) {
    throw new ResetError(
      "CONFIRM_MISMATCH",
      "The typed confirmation does not match the device name.",
    );
  }

  // (2) Double-fire guard: at most one non-terminal job at a time.
  const inFlight = await prisma.resetJob.count({
    where: { status: { in: ["requested", "dispatched"] } },
  });
  if (inFlight > 0) {
    throw new ResetError(
      "RESET_ALREADY_IN_PROGRESS",
      "A factory reset is already in progress.",
    );
  }

  // (3) Audit BEFORE the wipe. If the box is gone a second later, the intent is
  // still recorded. Mirrors storage-safety's CommandAuditLog shape.
  await writeResetAudit(prisma, { userId, targetName });

  // (4) Persist the job in `requested` before dispatch so a crash mid-dispatch
  // leaves an explicit, queryable row (never an IS-NULL guess).
  const job = await prisma.resetJob.create({
    data: {
      status: "requested",
      requestedBy: userId ?? null,
      targetName,
    },
  });

  // Fail closed: no bridge token → we cannot safely invoke a data-destroying
  // host action. Mark the job failed and surface BRIDGE_AUTH_UNCONFIGURED.
  const token = bridgeAuthToken();
  if (!token) {
    await prisma.resetJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        failureReason:
          "The device-bridge auth token is not configured; reset was not dispatched.",
      },
    });
    throw new ResetError(
      "BRIDGE_AUTH_UNCONFIGURED",
      "Factory reset is unavailable — the device-bridge auth token is not configured.",
    );
  }

  // (5) Dispatch to the host executor. The bridge shells the host script
  // DETACHED; it returns ~immediately (202/200) and the wipe runs on its own.
  try {
    const res = await dispatchToBridge(token, { jobId: job.id, targetName });
    if (!res.ok) {
      const reason = res.error || `device-bridge returned ${res.status}`;
      await prisma.resetJob.update({
        where: { id: job.id },
        data: { status: "failed", failureReason: reason },
      });
      logger.warn({ jobId: job.id, status: res.status }, "factory reset refused by device-bridge");
      throw new ResetError("BRIDGE_REFUSED", reason, res.status);
    }
  } catch (err) {
    if (err instanceof ResetError) throw err;
    // Connection failure (or anything else) → the wipe never started; the box
    // is untouched. Record the failure honestly.
    const reason = isBridgeConnectionError(err)
      ? "The device service isn't reachable right now; reset was not dispatched."
      : `Reset dispatch failed: ${(err as Error).message || "bridge request failed"}`;
    await prisma.resetJob.update({
      where: { id: job.id },
      data: { status: "failed", failureReason: reason },
    });
    logger.warn({ jobId: job.id, err }, "factory reset dispatch failed");
    throw new ResetError("BRIDGE_UNREACHABLE", reason);
  }

  // Dispatch accepted. The orchestrator will be torn down by the wipe shortly;
  // `dispatched` is the terminal-success state (there is no `succeeded` — the db
  // this row lives in is about to be wiped). See schema enum comment.
  const dispatched = await prisma.resetJob.update({
    where: { id: job.id },
    data: { status: "dispatched" },
  });
  logger.warn({ jobId: job.id, targetName }, "factory reset dispatched to host executor");
  return dispatched;
}

interface BridgeResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * POST the reset to the device-bridge's auth-gated /system/factory-reset. The
 * bridge shells scripts/host/droplet-factory-reset.sh detached. Generous but
 * bounded timeout — the bridge answers as soon as it has SPAWNED the script (it
 * does not wait for the multi-minute wipe to finish).
 */
async function dispatchToBridge(
  token: string,
  body: { jobId: string; targetName: string },
): Promise<BridgeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(`${BRIDGE_URL}/system/factory-reset`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Droplet-Auth": token,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const parsed = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: r.ok, status: r.status, error: parsed.error };
  } finally {
    clearTimeout(timer);
  }
}

async function writeResetAudit(
  prisma: PrismaClient,
  entry: { userId?: string; targetName: string },
): Promise<void> {
  try {
    await prisma.commandAuditLog.create({
      data: {
        userId: entry.userId || null,
        entityId: `system.factory_reset`,
        domain: DOMAIN,
        service: SERVICE,
        data: { targetName: entry.targetName },
        // Highest safety tier — same class as the destructive storage ops.
        tier: 3,
        confirmed: true,
        blocked: false,
        reason: "Owner-confirmed factory reset",
      },
    });
  } catch (err) {
    // An audit-write failure must NOT silently let the wipe proceed un-recorded.
    logger.error({ err }, "failed to write factory-reset audit row");
    throw err;
  }
}

/**
 * Latest reset job for the dashboard's progress poll. Returns null when no reset
 * has ever been requested (a fresh box). The dashboard renders `dispatched` as
 * "reset under way — the box is returning to first-run setup".
 */
export async function getResetStatus(
  prisma: PrismaClient,
): Promise<ResetStatus | null> {
  const job = await prisma.resetJob.findFirst({
    orderBy: { createdAt: "desc" },
  });
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    targetName: job.targetName,
    failureReason: job.failureReason,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
