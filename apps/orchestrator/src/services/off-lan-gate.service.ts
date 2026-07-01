/**
 * off-lan-gate.service.ts — outbound off-LAN egress allowlist reads.
 *
 * The `outbound_email` channel of the WARP-467 `OffLanAllowlistChannel`
 * allowlist decides whether the orchestrator may send mail off the LAN.
 * This read is a SOVEREIGNTY control: a missing/unprovisioned row or a
 * disabled channel resolves to `false` (no egress). A DB error is
 * re-thrown so the caller can surface a 503 (gate temporarily
 * unavailable) rather than a 451 (channel deliberately disabled) — the
 * two failure modes require different operator remediation steps.
 *
 * WARP-467 is merged: the `OffLanAllowlistChannel` model is in the
 * generated Prisma client, so we use the typed `findUnique` read here.
 * The previous `$queryRawUnsafe` + `catch { return true }` shim existed
 * only while the model was absent pre-merge — and it fixed nothing, it
 * defaulted OPEN, which is exactly the wrong way for a sovereignty gate
 * to fail.
 */
import { type PrismaClient, OffLanChannelKey } from "@prisma/client";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("off-lan-gate");

/** Minimal Prisma surface this gate needs (keeps unit mocking trivial). */
type OffLanGatePrisma = Pick<PrismaClient, "offLanAllowlistChannel">;

/**
 * True only when the `outbound_email` off-LAN channel is explicitly
 * enabled. Returns `false` when the row is missing or the channel is
 * disabled. Throws on DB errors so callers can distinguish a transient
 * infrastructure failure (503) from a deliberate channel disable (451).
 */
export async function outboundEmailGate(
  prisma: OffLanGatePrisma,
): Promise<boolean> {
  try {
    const row = await prisma.offLanAllowlistChannel.findUnique({
      where: { key: OffLanChannelKey.outbound_email },
    });
    return row?.enabled === true;
  } catch (err) {
    logger.warn(
      { err },
      "outbound_email off-LAN gate read failed — re-throwing for 503 response",
    );
    throw err;
  }
}
