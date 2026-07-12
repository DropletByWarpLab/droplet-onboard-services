/**
 * WARP-237 — nightly tamper detection over the signed activity chain.
 *
 * `verifyActivityChain` is the exact walk `GET /api/activity/verify`
 * (WARP-246) ran inline before this extraction — semantics unchanged
 * and still pinned by __tests__/activity-chain.test.ts.
 *
 * `runNightlyChainVerification` is the 03:25 cron body: on a break it
 * appends one err-severity system row (the alarm itself is signed and
 * chained AFTER the break point, which the verifier tolerates — the walk
 * stops at the first break, and the /admin/audit banner keys on the
 * verify result, not on row severity) and toasts every owner/admin via
 * notifications.service. Success is a log line only — no daily feed spam.
 */
import type { PrismaClient } from "@prisma/client";
import {
  hashSignature,
  type ActivityActorTypeName,
  type ActivityKindName,
  type ActivityRowContent,
  type ActivityRowSigner,
  type ActivitySeverityName,
} from "./audit-signing.service.js";
import { getActivitySigner, recordActivity } from "./activity.singleton.js";
import { sendNotification } from "./notifications.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("audit-verify");

export interface ChainVerifyResult {
  ok: boolean;
  rowsChecked: number;
  brokenAtId: string | null;
}

export async function verifyActivityChain(
  prisma: PrismaClient,
  signer: ActivityRowSigner,
): Promise<ChainVerifyResult> {
  const PAGE = 200;
  let cursor: bigint | undefined;
  let prevSignature: string | null = null;
  let rowsChecked = 0;
  let brokenAtId: string | null = null;

  outer: for (;;) {
    const page = await prisma.activityRow.findMany({
      where: cursor === undefined ? {} : { id: { gt: cursor } },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    for (const r of page) {
      rowsChecked += 1;
      const expectedPrevHash =
        prevSignature === null
          ? r.prevSignatureHash
          : hashSignature(prevSignature);
      const content: ActivityRowContent = {
        at: r.at,
        severity: r.severity as ActivitySeverityName,
        sourceIcon: r.sourceIcon,
        what: r.what,
        sub: r.sub,
        kind: r.kind as ActivityKindName,
        refs: r.refs === null ? null : (r.refs as Record<string, unknown>),
        actorType: r.actorType as ActivityActorTypeName | null,
        actorId: r.actorId,
        schemaVersion: r.schemaVersion,
      };
      if (
        r.prevSignatureHash !== expectedPrevHash ||
        !signer.verify(content, expectedPrevHash, r.signature)
      ) {
        brokenAtId = r.id.toString();
        break outer;
      }
      prevSignature = r.signature;
    }

    cursor = page[page.length - 1]!.id;
    if (page.length < PAGE) break;
  }

  return { ok: brokenAtId === null, rowsChecked, brokenAtId };
}

/**
 * WARP-1027: coalesce concurrent chain-verify walks.
 *
 * `verifyActivityChain` is an O(n) HMAC pass over the whole ActivityRow table.
 * `GET /api/activity/verify` auto-runs it on every /admin/audit mount plus
 * manual re-verifies, and the 03:25 cron runs it too — so N admin tabs (or a
 * re-verify racing the nightly run) would stack N full walks, and on a
 * `DROPLET_AUDIT_RETENTION_DAYS<=0` keep-forever box each walk is unbounded.
 *
 * All concurrent callers await one shared in-flight walk; the ref clears when
 * it settles, so worst-case concurrency is 1 and the next call re-walks fresh
 * state. We deliberately do NOT cache the result: verification must reflect
 * live DB state — a cached "ok" could mask a tamper (or a post-purge / new-row
 * change) until a TTL expired. The response's `rowsChecked` already reports the
 * walk size for keep-forever visibility.
 *
 * The shared walk binds the FIRST concurrent caller's `prisma`/`signer`; later
 * joiners' args are ignored. Safe because both production callers use the
 * process-singleton prisma and `getActivitySigner()` — do not pass a per-request
 * client here expecting it to be honoured mid-flight.
 */
let inFlightVerify: Promise<ChainVerifyResult> | null = null;

export function verifyActivityChainCoalesced(
  prisma: PrismaClient,
  signer: ActivityRowSigner,
): Promise<ChainVerifyResult> {
  if (inFlightVerify) return inFlightVerify;
  inFlightVerify = verifyActivityChain(prisma, signer).finally(() => {
    inFlightVerify = null;
  });
  return inFlightVerify;
}

export async function runNightlyChainVerification(
  prisma: PrismaClient,
): Promise<ChainVerifyResult | null> {
  const signer = getActivitySigner();
  if (!signer) {
    logger.warn("nightly chain verification skipped — signer not initialised");
    return null;
  }
  // WARP-1027: coalesce with any in-flight /activity/verify walk so the cron
  // and a concurrent manual re-verify don't double-walk the whole chain.
  const result = await verifyActivityChainCoalesced(prisma, signer);
  if (result.ok) {
    logger.info(
      { rowsChecked: result.rowsChecked },
      "nightly audit-chain verification ok",
    );
    return result;
  }

  logger.error(
    { brokenAtId: result.brokenAtId, rowsChecked: result.rowsChecked },
    "AUDIT CHAIN VERIFICATION FAILED — possible tampering",
  );
  await recordActivity({
    kind: "system",
    severity: "err",
    sourceIcon: "shield-alert",
    what: "Audit chain verification FAILED",
    sub: `chain broken at row ${result.brokenAtId}`,
    refs: { brokenAtId: result.brokenAtId, rowsChecked: result.rowsChecked },
    actor: { type: "system", id: null },
  });
  const admins = await prisma.user.findMany({
    where: { role: { in: ["owner", "admin"] } },
    select: { id: true },
  });
  for (const admin of admins) {
    await sendNotification(prisma, {
      userId: admin.id,
      kind: "system",
      title: "Audit log integrity check failed",
      body: `Nightly verification found the activity log's hash chain broken at row ${result.brokenAtId}. Open /admin/audit for details.`,
    });
  }
  return result;
}
