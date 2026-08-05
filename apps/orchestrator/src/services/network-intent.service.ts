/**
 * WARP-1761 — the fabric's INTENDED state for `wifi.primary` (ADR-035 §1/§7).
 *
 * ADR-035 §1 splits the fabric's truth in two, and this module owns exactly
 * one half:
 *
 *   * **Observed** — "what IS the AP broadcasting" — is read LIVE off the
 *     device on every request (`getApWifi`), and is never cached anywhere.
 *   * **Intended** — "what SHOULD it broadcast" — is this table.
 *
 * The line between them is load-bearing. Nothing in a display path may ever
 * read from here: the moment intent answers "what is my Wi-Fi called", drift
 * stops being visible and starts being hidden, which is the second of the two
 * failures this ticket exists to remove. The only consumer is the converger.
 *
 * The first failure is the lost write. Before this module a Wi-Fi write was a
 * synchronous RPC at one device; an unreachable AP (the lab unit was, for
 * ~20 minutes, during a firmware experiment) meant the call failed and the
 * operator's intent was DISCARDED, with nothing left to retry. Recording it
 * here first means the request's outcome no longer decides whether the
 * household keeps the name it asked for.
 *
 * ── The passphrase, and why it is not here ────────────────────────────────
 *
 * `wifi.primary` intent is `{ ssid }`. The passphrase is deliberately NOT
 * stored, and a key-only save records no intent at all.
 *
 * The repo has one at-rest secret convention (`encryption.service.ts`,
 * aes-256-gcm under `DEVICE_SECRET_KEY`, used by `DeviceClient.ncAppPassword`,
 * `EmailChannel.passwordEnc`, `TotpCredential.secretEnc`) — but it has never
 * been pointed at a Wi-Fi passphrase, and that is a decision, not an
 * oversight: `logNetworkCommand` strips the key through `redactSecretParams`
 * before the audit row is written, the Tier-2 pending-confirmation record
 * that carries it lives in-memory with a 60 s TTL, and `ApDevice` stores only
 * the approval-time `approvedSsid` audit column. The live PSK is read off the
 * AP and held nowhere. Opening a durable Wi-Fi-secret surface is not this
 * ticket's job, and ADR-035 §3 already reserves the right home for one (the
 * per-device escrow rows that replace the singleton
 * `ap_openwrt_password`-style files).
 *
 * The cost is bounded and stated: the converger repairs SSID drift and
 * survives an offline SSID write; passphrase writes keep exactly the behavior
 * they have today (Tier-2 confirm → direct push, no intent, no retry). The
 * benefit is that the converger holds no secret, so it can leak none — it
 * pushes `{ mac, ssid }` and nothing else, ever.
 */
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("network-intent");

/**
 * The one domain key this ticket ships. Dot-namespaced; ADR-035 §7 lists the
 * siblings that follow (VLANs, DHCP ranges, band steering, …).
 */
export const WIFI_PRIMARY_INTENT_KEY = "wifi.primary";

/**
 * The closed shape stored in `NetworkIntent.value` for `wifi.primary`.
 *
 * A `type`, not an `interface`, on purpose: Prisma's `InputJsonValue` requires
 * an implicit index signature, which TypeScript grants to type aliases and
 * withholds from interfaces. Declaring it this way lets the value be written
 * to a Json column with no `as`-cast, so the shape stays type-checked all the
 * way to the database instead of being asserted at the boundary.
 */
export type WifiPrimaryIntentValue = {
  /** The household network name. The ONLY field — never a passphrase. */
  ssid: string;
};

/** What the converger reads back. */
export interface WifiPrimaryIntent {
  ssid: string;
  generation: number;
}

/**
 * Record the operator's intended household network name and BUMP the
 * generation.
 *
 * Three properties this function guarantees, each of which has a test:
 *
 *  1. **Best-effort.** It never throws. This layer is additive — the direct
 *     push and its HTTP contract are the shipped behavior, and a DB hiccup in
 *     the intent write must not turn a request that was going to succeed into
 *     a 500. Failures are logged and swallowed.
 *  2. **Atomic bump.** The generation moves via Prisma's `{ increment: 1 }`,
 *     not a read-then-write, so two concurrent saves cannot both land on the
 *     same number.
 *  3. **No secret.** `opts.key` is accepted so callers can pass their whole
 *     payload without pre-filtering, and is then dropped on the floor. A
 *     key-only save writes nothing rather than inventing an SSID.
 *
 * Deliberately NOT rolled back when the subsequent push fails: a failed push
 * is exactly the case the converger exists for (ADR-035 §7 — "a write bumps
 * the generation and returns; it no longer requires the device to be
 * online"). And rows are never deleted at all (ADR-035 §6).
 */
export async function recordWifiPrimaryIntent(
  prisma: PrismaClient,
  opts: { ssid?: string; key?: string },
  writtenBy?: string,
): Promise<void> {
  const ssid = opts.ssid;
  // Nothing to intend. A passphrase-only save is a real, supported operation
  // — it just changes no fabric-owned fact, because the passphrase is not one
  // (see the module header).
  if (typeof ssid !== "string" || ssid.length === 0) return;

  const value: WifiPrimaryIntentValue = { ssid };

  try {
    await prisma.networkIntent.upsert({
      where: { key: WIFI_PRIMARY_INTENT_KEY },
      create: {
        key: WIFI_PRIMARY_INTENT_KEY,
        value,
        // First write IS generation 1; 0 is the schema default meaning
        // "row exists, nothing written yet".
        generation: 1,
        writtenBy: writtenBy ?? null,
      },
      update: {
        value,
        generation: { increment: 1 },
        // The LAST writer, not an accumulated history — an unauthenticated
        // write records null rather than silently inheriting the previous
        // human's id.
        writtenBy: writtenBy ?? null,
      },
    });
    // `ssid` is a broadcast name, not a secret, so it is safe to log; there
    // is no other field to leak.
    logger.info({ key: WIFI_PRIMARY_INTENT_KEY, ssid }, "network intent recorded");
  } catch (err) {
    logger.warn(
      { err, key: WIFI_PRIMARY_INTENT_KEY },
      "network intent write failed — the direct push is unaffected",
    );
  }
}

/**
 * Read the current `wifi.primary` intent. **Converger-only** — no display
 * path may call this (ADR-035 §1); `GET /network/wifi/ap` keeps dialing the
 * AP.
 *
 * Returns null for "no opinion": no row, an unusable value, or a failed read.
 * Null means the converger stands down, which is the right failure direction
 * — an intent layer that cannot read itself must never start pushing guesses
 * at radios.
 */
export async function readWifiPrimaryIntent(
  prisma: PrismaClient,
): Promise<WifiPrimaryIntent | null> {
  let row: { value: unknown; generation: number } | null;
  try {
    row = await prisma.networkIntent.findUnique({
      where: { key: WIFI_PRIMARY_INTENT_KEY },
      select: { value: true, generation: true },
    });
  } catch (err) {
    logger.warn({ err, key: WIFI_PRIMARY_INTENT_KEY }, "network intent read failed");
    return null;
  }
  if (!row) return null;

  const value = row.value as Partial<WifiPrimaryIntentValue> | null;
  const ssid = value && typeof value.ssid === "string" ? value.ssid : "";
  // An empty name is not something to converge a household onto.
  if (ssid.length === 0) return null;

  return { ssid, generation: row.generation };
}
