/**
 * WARP-237 — device-key-signed daily roots over the activity chain.
 *
 * The per-row HMAC chain (audit-signing.service.ts) is symmetric: whoever
 * holds /data/secrets/audit.key can rewrite history. A daily root binds
 * the day's chain state to the device identity key (TPM-backed,
 * non-extractable — services/device-identity-svc), so an off-box copy of
 * `GET /api/audit/roots` is enough to later detect a full-chain rewrite.
 *
 * Span semantics (id-anchored, same clock-skew posture as WARP-586's
 * purge): the FIRST root covers min(id)..max(id among rows with
 * at < end-of-date UTC); every later root covers
 * prev.lastRowId+1 .. max(id among rows with at < end-of-date). An empty
 * day is still signed (rowCount 0, firstRowId > lastRowId, tail carried
 * forward) so a silently deleted day is detectable. Roots are never
 * purged.
 */
import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { hashSignature } from "./audit-signing.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("audit-daily-root");

export interface DailyRootContent {
  date: string;
  firstRowId: string;
  lastRowId: string;
  prevRootHash: string;
  rowCount: number;
  tailSignatureHash: string;
}

/** Structural subset of DeviceIdentityClient — keeps tests stub-friendly. */
export interface DailyRootSigner {
  signWithDeviceKey(
    payload: Uint8Array,
  ): Promise<{ signature: Uint8Array; algorithm: string }>;
}

/** Canonical form: JSON with keys in lexicographic order, BigInts as
 * decimal strings. Stable across engines; an offline verifier re-derives
 * it from the stored columns alone. */
export function canonicalizeDailyRoot(content: DailyRootContent): string {
  return JSON.stringify({
    date: content.date,
    firstRowId: content.firstRowId,
    lastRowId: content.lastRowId,
    prevRootHash: content.prevRootHash,
    rowCount: content.rowCount,
    tailSignatureHash: content.tailSignatureHash,
  });
}

export function dailyRootHash(content: DailyRootContent): string {
  return createHash("sha256")
    .update(canonicalizeDailyRoot(content), "utf8")
    .digest("base64url");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC "YYYY-MM-DD" for a Date. */
export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function endOfUtcDay(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 24 * 60 * 60 * 1000);
}

export async function signDailyRootForDate(
  prisma: PrismaClient,
  identity: DailyRootSigner,
  date: string,
): Promise<{ created: boolean; date: string }> {
  if (!DATE_RE.test(date)) throw new Error(`invalid root date: ${date}`);

  const existing = await prisma.activityDailyRoot.findUnique({
    where: { date },
  });
  if (existing) return { created: false, date };

  const prevRoot = await prisma.activityDailyRoot.findFirst({
    orderBy: { date: "desc" },
  });

  const dayEnd = endOfUtcDay(date);
  // Last row whose `at` precedes the end of the covered day.
  const tailRow = await prisma.activityRow.findFirst({
    where: { at: { lt: dayEnd } },
    orderBy: { id: "desc" },
  });

  let firstRowId: bigint;
  let lastRowId: bigint;
  let tailSignatureHash: string;

  if (prevRoot) {
    firstRowId = prevRoot.lastRowId + 1n;
    if (tailRow && tailRow.id >= firstRowId) {
      lastRowId = tailRow.id;
      tailSignatureHash = hashSignature(tailRow.signature);
    } else {
      // Attested-empty day: nothing appended since the previous root.
      lastRowId = prevRoot.lastRowId;
      tailSignatureHash = prevRoot.tailSignatureHash;
    }
  } else {
    if (!tailRow) return { created: false, date }; // nothing to attest yet
    const headRow = await prisma.activityRow.findFirst({
      orderBy: { id: "asc" },
    });
    firstRowId = headRow!.id;
    lastRowId = tailRow.id;
    tailSignatureHash = hashSignature(tailRow.signature);
  }

  const rowCount =
    lastRowId >= firstRowId
      ? await prisma.activityRow.count({
          where: { id: { gte: firstRowId, lte: lastRowId } },
        })
      : 0;

  const content: DailyRootContent = {
    date,
    firstRowId: firstRowId.toString(),
    lastRowId: lastRowId.toString(),
    prevRootHash: prevRoot?.rootHash ?? "",
    rowCount,
    tailSignatureHash,
  };
  const canonical = canonicalizeDailyRoot(content);
  const signed = await identity.signWithDeviceKey(
    Buffer.from(canonical, "utf8"),
  );

  await prisma.activityDailyRoot.create({
    data: {
      date,
      firstRowId,
      lastRowId,
      rowCount,
      tailSignatureHash,
      prevRootHash: content.prevRootHash,
      rootHash: dailyRootHash(content),
      signature: Buffer.from(signed.signature).toString("base64"),
      algorithm: signed.algorithm,
    },
  });
  logger.info(
    { date, firstRowId, lastRowId, rowCount },
    "daily audit root signed",
  );
  return { created: true, date };
}

/** Cap on catch-up so a box restored from years-old backup can't wedge
 * the nightly cron; the remainder drains over subsequent nights. */
const MAX_CATCHUP_DAYS = 60;

export async function runDailyRootJob(
  prisma: PrismaClient,
  identity: DailyRootSigner,
  now: Date = new Date(),
): Promise<{ signed: string[]; skipped: number }> {
  const yesterday = utcDateString(
    new Date(now.getTime() - 24 * 60 * 60 * 1000),
  );
  const lastRoot = await prisma.activityDailyRoot.findFirst({
    orderBy: { date: "desc" },
  });

  // Build the date list to sign: (lastRoot.date, yesterday], else just
  // yesterday for a box with no roots yet.
  const dates: string[] = [];
  let cursor: Date;
  if (lastRoot) {
    cursor = new Date(
      Date.parse(`${lastRoot.date}T00:00:00.000Z`) + 24 * 60 * 60 * 1000,
    );
  } else {
    cursor = new Date(Date.parse(`${yesterday}T00:00:00.000Z`));
  }
  while (utcDateString(cursor) <= yesterday && dates.length < MAX_CATCHUP_DAYS) {
    dates.push(utcDateString(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }

  const signed: string[] = [];
  let skipped = 0;
  for (const date of dates) {
    const r = await signDailyRootForDate(prisma, identity, date);
    if (r.created) signed.push(date);
    else skipped += 1;
  }
  return { signed, skipped };
}
