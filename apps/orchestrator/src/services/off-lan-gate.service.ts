/**
 * off-lan-gate.service.ts — outbound off-LAN egress allowlist reads.
 *
 * The `outbound_email` channel of the WARP-467 `OffLanAllowlistChannel`
 * allowlist decides whether the orchestrator may send mail off the LAN.
 * This read is a SOVEREIGNTY control, so it FAILS CLOSED: a DB error, a
 * missing/unprovisioned row, or a disabled channel all resolve to
 * `false` (no egress). That matches the cross-service posture documented
 * in `services/ai-gateway/middleware/off_lan_gating.py` — "the
 * sovereignty contract is more load-bearing than chat availability." A
 * `false` result surfaces as the 451 refusal in `routes/email.ts`.
 *
 * WARP-467 is merged: the `OffLanAllowlistChannel` model is in the
 * generated Prisma client, so we use the typed `findUnique` read here.
 * The previous `$queryRawUnsafe` + `catch { return true }` shim existed
 * only while the model was absent pre-merge — and it fixed nothing, it
 * defaulted OPEN, which is exactly the wrong way for a sovereignty gate
 * to fail.
 */
import type { PrismaClient } from "@prisma/client";
import pino from "pino";

const logger = pino({ name: "off-lan-gate" });

/** Minimal Prisma surface this gate needs (keeps unit mocking trivial). */
type OffLanGatePrisma = Pick<PrismaClient, "offLanAllowlistChannel">;

/**
 * True only when the `outbound_email` off-LAN channel is explicitly
 * enabled. Fails CLOSED (`false`) on any error or missing row — a
 * transient DB hiccup must never silently open the egress path.
 */
export async function outboundEmailGate(
  prisma: OffLanGatePrisma,
): Promise<boolean> {
  try {
    const row = await prisma.offLanAllowlistChannel.findUnique({
      where: { key: "outbound_email" },
    });
    return row?.enabled === true;
  } catch (err) {
    logger.warn(
      { err },
      "outbound_email off-LAN gate read failed — failing closed (no egress)",
    );
    return false;
  }
}
