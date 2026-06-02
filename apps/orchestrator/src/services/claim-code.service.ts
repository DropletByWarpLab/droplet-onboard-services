/**
 * Claim-code MINT/SEED service (WARP-632 / ADR-017).
 *
 * ADR-017 makes the ORCHESTRATOR the single owner of the claim-code lifecycle:
 * it mints the code, seeds its hash, decides when to show it, and pushes it to
 * the PyPortal. `oled-display` + firmware are thin renderers. This module is
 * the MINT half; the verify half (`consumeClaimCode`) shipped in PR #373 and
 * is reused here so the seeded hash matches verification exactly.
 *
 * "claimed" == a `ClaimCode` row with state='consumed' exists.
 *
 * WHILE NOT CLAIMED we maintain exactly ONE `available` code:
 *   - random, from an UNAMBIGUOUS alphabet (no 0/O/1/I), format DRPL-XXXX-XXXX;
 *   - PLAINTEXT held in memory only (a module-level memo) — never persisted;
 *   - only the HASH is persisted, via `seedClaimCode()` (PR #373), so a DB
 *     read can't recover a live code;
 *   - on (re)mint we DELETE prior `available` rows so they never pile up.
 *
 * Because the plaintext is not persisted, the code ROTATES on each unclaimed
 * restart (acceptable — "rotation invalidates the previous code"). Within a
 * single process the memo keeps the SAME plaintext across calls so the screen
 * doesn't flicker a new code on every poll tick: we only (re)mint when there
 * is no in-memory plaintext OR no matching `available` row in the DB.
 *
 * `CLAIM_CODE` env, if set, OVERRIDES minting (seed that exact code) — the
 * provisioning escape hatch documented in .env.example.
 *
 * NO SIDE EFFECTS ON IMPORT: the memo starts empty and nothing runs until a
 * caller invokes `ensureClaimCode`.
 */
import { randomInt } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { hashClaimCode, seedClaimCode } from "./setup-claim.service.js";

/**
 * Unambiguous claim-code alphabet: A–Z and 2–9 with the four glyphs that read
 * ambiguously on a small panel removed — 0/O and 1/I. A customer copying the
 * code off the PyPortal lid never has to guess "is that a zero or an oh".
 * Matches the normalization contract in setup-claim.service (codes are upper,
 * alphanumeric); these characters all survive `normalizeClaimCode`.
 */
export const CLAIM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** How many groups of how many chars sit after the `DRPL-` brand prefix. */
const GROUP_LEN = 4;
const GROUP_COUNT = 2;

/**
 * In-memory memo of the last-minted plaintext for THIS process. Null until the
 * first mint (or after a claim). Never written to disk — losing it on restart
 * is what makes the code rotate on an unclaimed reboot (by design).
 */
let currentPlaintext: string | null = null;

/**
 * Generate a fresh claim code: `DRPL-XXXX-XXXX` where each X is drawn from
 * CLAIM_CODE_ALPHABET using a CSPRNG (`crypto.randomInt`, rejection-sampled so
 * there's no modulo bias). The `DRPL-` prefix is a constant brand marker, not
 * part of the entropy.
 */
export function generateClaimCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUP_COUNT; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LEN; i++) {
      group += CLAIM_CODE_ALPHABET[randomInt(CLAIM_CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return `DRPL-${groups.join("-")}`;
}

/**
 * True iff the appliance has been claimed — i.e. a `consumed` ClaimCode row
 * exists. Explicit `state` column, never inferred from `usedAt IS NULL`
 * (CLAUDE.md no-guessing rule; the same discipline the verify path uses).
 */
export async function isClaimed(prisma: PrismaClient): Promise<boolean> {
  const consumed = await prisma.claimCode.count({ where: { state: "consumed" } });
  return consumed > 0;
}

/** The plaintext of the code currently shown on the lid, or null if none. */
export function getCurrentClaimCode(): string | null {
  return currentPlaintext;
}

/**
 * Ensure there is exactly one available claim code to render — minting one if
 * needed — and return its PLAINTEXT (or null if nothing should be shown).
 *
 * Decision order:
 *   1. CLAIMED → return null. Nothing to render; the caller falls through to
 *      the normal carousel. We also clear the in-memory plaintext so a code
 *      can't linger after the box is bound.
 *   2. We already hold a plaintext in memo AND its `available` row still
 *      exists in the DB → return the SAME plaintext. No rotation, no new row.
 *      This is the steady-state poll-tick path.
 *   3. Otherwise (re)mint: pick the code (CLAIM_CODE env override, else
 *      `generateClaimCode`), then in a single `$transaction` DELETE every
 *      prior `available` row and `seedClaimCode()` the new one. Persist only
 *      the hash; keep the plaintext in memo. Return the plaintext.
 *
 * The delete-then-seed runs inside one transaction so a fresh poll can never
 * observe two `available` rows, and the prior code is invalidated atomically
 * with the new one's creation.
 */
export async function ensureClaimCode(prisma: PrismaClient): Promise<string | null> {
  if (await isClaimed(prisma)) {
    currentPlaintext = null;
    return null;
  }

  // Steady state: we still have the plaintext AND its row is still available.
  // Don't rotate — return what's already on the lid.
  if (currentPlaintext) {
    const existing = await prisma.claimCode.findFirst({
      where: { codeHash: hashClaimCode(currentPlaintext), state: "available" },
    });
    if (existing) return currentPlaintext;
  }

  // (Re)mint. CLAIM_CODE env overrides random minting (provisioning hook).
  const envOverride = (process.env.CLAIM_CODE || "").trim();
  const code = envOverride || generateClaimCode();

  await prisma.$transaction(async (tx) => {
    // Delete prior available rows so they never pile up and the previous code
    // is invalidated. Consumed rows are left untouched (audit trail).
    await tx.claimCode.deleteMany({ where: { state: "available" } });
    // Seed ONLY the hash (PR #373 helper) — plaintext never hits the DB.
    await seedClaimCode(tx as PrismaClient, code);
  });

  currentPlaintext = code;
  return code;
}

/**
 * Test-only: clear the in-memory plaintext memo so each test starts from a
 * known state (and so a "process restart" can be simulated). Not used by
 * production code.
 */
export function _resetClaimCodeMemoForTests(): void {
  currentPlaintext = null;
}
