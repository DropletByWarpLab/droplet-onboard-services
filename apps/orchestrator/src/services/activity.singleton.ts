/**
 * Process-wide activity recorder singleton for WARP-456.
 *
 * Emitter call sites (chat route, MCP dispatch, file-indexer MQTT
 * bridge, Matter writes, auth events, network ops) import
 * `recordActivity()` from here and stay decoupled from the recorder's
 * construction. The signer + Prisma client are wired once at app
 * boot via `initActivityRecorder(prisma)`; before that call,
 * `recordActivity` is a no-op that returns null, so import order in
 * tests doesn't matter.
 *
 * Mirrors the `mcp-client.singleton.ts` shape so the orchestrator's
 * shutdown path can teardown both via the same pattern.
 */
import type { PrismaClient } from "@prisma/client";
import {
  createActivityRecorder,
  recordSafely,
  type ActivityRowRecorder,
  type RecordedActivityRow,
  type RecordParams,
} from "./activity.service.js";
import {
  createHmacSigner,
  loadAuditKeyFromDisk,
  type ActivityRowSigner,
} from "./audit-signing.service.js";

let recorder: ActivityRowRecorder | null = null;
let signer: ActivityRowSigner | null = null;

/**
 * Initialise the singleton at boot. Throws if the signing key can't be
 * loaded — by design, an orchestrator that can't sign the audit chain
 * must fail closed rather than emit unsigned rows.
 *
 * Idempotent: subsequent calls are no-ops so a test that wires the
 * recorder once doesn't have to teardown between cases.
 */
export function initActivityRecorder(prisma: PrismaClient): void {
  if (recorder) return;
  signer = createHmacSigner(loadAuditKeyFromDisk());
  recorder = createActivityRecorder({ prisma, signer });
}

/**
 * Emit a row. Swallows recorder failures with a logged warning — the
 * caller MUST NOT depend on the row landing for its own control flow.
 *
 * Returns the inserted row on success or `null` on failure / before
 * `initActivityRecorder` ran.
 */
export async function recordActivity(
  params: RecordParams,
): Promise<RecordedActivityRow | null> {
  if (!recorder) return null;
  return recordSafely(recorder, params);
}

/**
 * Read the bound signer. Used by `POST /api/activity/export` so the
 * sealed bundle ships the same public bytes the live chain was signed
 * with.
 */
export function getActivitySigner(): ActivityRowSigner | null {
  return signer;
}

/** Exposed only for tests. */
export function _setActivityRecorderForTests(
  newRecorder: ActivityRowRecorder | null,
  newSigner: ActivityRowSigner | null,
): void {
  recorder = newRecorder;
  signer = newSigner;
}
