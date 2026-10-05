/**
 * BUG-3 / ADR-019 — storage safety-tier service.
 *
 * Every destructive pool op is Tier-3-class: data-destroying, owner-only,
 * AI-blocked. This service mirrors network-safety.service.ts but binds the
 * single-use confirm token to {service, resourceId} so a token minted to
 * destroy `md0` can never confirm a destroy of `md1`, nor a format.
 *
 * Contract pinned here:
 *   - evaluateStorageCommand on a destructive op via the AI is BLOCKED.
 *   - via the dashboard it returns a single-use confirm token (202-shaped).
 *   - confirmStorageCommand refuses a missing/expired/mismatched token.
 *   - the token is single-use (a second confirm fails).
 *
 * WARP-3513 adds the recovery-key operations for the bay drives every Prepare
 * encrypts. The one-time reveal (`recovery_key_reveal`) is Tier 2 — the owner
 * confirms, nothing is erased — and "Regenerate recovery key"
 * (`recovery_key_regenerate`) is Tier 3: it replaces the secret, so the key the
 * owner holds stops working. The AI stays hard-blocked from both like from every
 * other storage op, and the response and audit row now carry the
 * classification's tier instead of a hard-coded 3.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// CommandAuditLog writes go through a stubbed Prisma; we don't need a DB.
function prismaStub() {
  return {
    commandAuditLog: { create: vi.fn(async () => ({})) },
  } as unknown as import("@prisma/client").PrismaClient;
}

/** The audit rows a stubbed Prisma saw, in write order. */
interface AuditRow {
  userId: string | null;
  entityId: string;
  domain: string;
  service: string;
  data?: unknown;
  tier: number;
  confirmed: boolean;
  blocked: boolean;
  reason: string | null;
}
function auditRows(prisma: ReturnType<typeof prismaStub>): AuditRow[] {
  const create = prisma.commandAuditLog.create as unknown as {
    mock: { calls: Array<[{ data: AuditRow }]> };
  };
  return create.mock.calls.map((c) => c[0].data);
}

import {
  evaluateStorageCommand,
  confirmStorageCommand,
  cleanupExpiredStorageTokens,
} from "../services/storage-safety.service.js";
import {
  classifyStorageCommand,
  STORAGE_CONFIRMATION_TOKEN_EXPIRY_MS,
  STORAGE_MAX_PENDING_CONFIRMATIONS,
  STORAGE_TIER_2_OPERATIONS,
  STORAGE_TIER_3_OPERATIONS,
} from "../config/storage-safety-rules.js";

describe("storage safety — AI is blocked from destructive ops", () => {
  let prisma: ReturnType<typeof prismaStub>;
  beforeEach(() => {
    prisma = prismaStub();
  });

  it("blocks a destructive op outright when source is the AI", async () => {
    const res = await evaluateStorageCommand(
      prisma,
      "pool_destroy",
      "md0",
      { device: "md0" },
      "ai-user",
      "ai",
    );
    expect("blocked" in res && res.blocked).toBe(true);
    expect(res.tier).toBe(3);
  });

  it("requires confirmation (not auto-allow) for a destructive op via the dashboard", async () => {
    const res = await evaluateStorageCommand(
      prisma,
      "pool_create",
      "md0",
      { device: "md0", level: "raid1" },
      "owner-user",
      "api",
    );
    expect("requiresConfirmation" in res && res.requiresConfirmation).toBe(true);
    expect("confirmationToken" in res && typeof res.confirmationToken).toBe("string");
  });

  it("keeps recordings allocation at Tier 2 and records that tier in the audit row", async () => {
    const result = await evaluateStorageCommand(
      prisma,
      "recordings_set",
      "recordings",
      { mode: "full" },
      "owner-user",
      "api",
    );
    expect("requiresConfirmation" in result && result.requiresConfirmation).toBe(true);
    expect(result.tier).toBe(2);
    expect(prisma.commandAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tier: 2, service: "recordings_set" }) }),
    );
  });

  it("keeps deleting old recordings at Tier 3", async () => {
    const result = await evaluateStorageCommand(
      prisma,
      "recordings_old_footage_delete",
      "recordings",
      {},
      "owner-user",
      "api",
    );
    expect(result.tier).toBe(3);
  });
});

describe("storage safety — confirm token is single-use + bound to {service, resourceId}", () => {
  let prisma: ReturnType<typeof prismaStub>;
  beforeEach(() => {
    prisma = prismaStub();
  });

  async function mintToken(service: string, resourceId: string) {
    const res = await evaluateStorageCommand(
      prisma, service, resourceId, { device: resourceId }, "owner", "api",
    );
    if (!("confirmationToken" in res)) throw new Error("no token minted");
    return res.confirmationToken;
  }

  it("a valid token confirms its exact {service, resourceId}", async () => {
    const token = await mintToken("pool_destroy", "md0");
    const res = await confirmStorageCommand(prisma, token, "owner", {
      service: "pool_destroy",
      resourceId: "md0",
    });
    expect(res.confirmed).toBe(true);
  });

  it("refuses when no token is supplied / token is unknown", async () => {
    const res = await confirmStorageCommand(prisma, "not-a-real-token", "owner", {
      service: "pool_destroy",
      resourceId: "md0",
    });
    expect(res.confirmed).toBe(false);
  });

  it("refuses a token whose resourceId does not match (md0 token cannot destroy md1)", async () => {
    const token = await mintToken("pool_destroy", "md0");
    const res = await confirmStorageCommand(prisma, token, "owner", {
      service: "pool_destroy",
      resourceId: "md1",
    });
    expect(res.confirmed).toBe(false);
    if (!res.confirmed) expect(res.code).toBe("TOKEN_OPERATION_MISMATCH");
  });

  it("refuses a token whose service does not match (a destroy token cannot format)", async () => {
    const token = await mintToken("pool_destroy", "md0");
    const res = await confirmStorageCommand(prisma, token, "owner", {
      service: "pool_format",
      resourceId: "md0",
    });
    expect(res.confirmed).toBe(false);
    if (!res.confirmed) expect(res.code).toBe("TOKEN_OPERATION_MISMATCH");
  });

  it("burns a token presented to an endpoint that is not allowed to execute its service", async () => {
    const token = await mintToken("recordings_set", "recordings");
    const refused = await confirmStorageCommand(prisma, token, "owner", {
      service: "recordings_set",
      resourceId: "recordings",
      allowedServices: new Set(["pool_destroy"]),
    });
    expect(refused).toMatchObject({ confirmed: false, code: "TOKEN_ENDPOINT_MISMATCH" });
    const replay = await confirmStorageCommand(prisma, token, "owner", {
      service: "recordings_set",
      resourceId: "recordings",
      allowedServices: new Set(["recordings_set"]),
    });
    expect(replay).toMatchObject({ confirmed: false, code: "TOKEN_MISSING" });
  });

  it("is single-use — a second confirm of the same token fails", async () => {
    const token = await mintToken("pool_create", "md0");
    const first = await confirmStorageCommand(prisma, token, "owner", {
      service: "pool_create",
      resourceId: "md0",
    });
    expect(first.confirmed).toBe(true);
    const second = await confirmStorageCommand(prisma, token, "owner", {
      service: "pool_create",
      resourceId: "md0",
    });
    expect(second.confirmed).toBe(false);
  });

  it("every destructive storage op classifies as Tier 3 (never auto, never AI)", async () => {
    const ops = [
      "pool_create",
      "pool_destroy",
      "pool_format",
      "pool_set_level",
      "pool_add_spare",
      "pool_remove_disk",
      "recordings_old_footage_delete",
    ];
    for (const op of ops) {
      const viaAi = await evaluateStorageCommand(
        prisma, op, "md0", { device: "md0" }, "ai", "ai",
      );
      expect("blocked" in viaAi && viaAi.blocked, `${op} must block the AI`).toBe(true);
      expect(viaAi.tier, `${op} must be Tier 3`).toBe(3);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WARP-3513 — the recovery-key reveal and recording allocation are Tier-2 actions.
// ─────────────────────────────────────────────────────────────────────────────

const REVEAL = "recovery_key_reveal";
const REGENERATE = "recovery_key_regenerate";
/** A filesystem UUID as the bridge reports it (ext4 inside the LUKS container). */
const FS_UUID = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";

describe("storage safety rules — Tier 2 reveal, Tier 3 regenerate and erase (WARP-3513)", () => {
  it("Tier 2 contains recovery-key reveal and recording allocation", () => {
    expect([...STORAGE_TIER_2_OPERATIONS].sort()).toEqual([REVEAL, "recordings_set"].sort());
  });

  it("uses distinct confirmation text for allocation and recovery-key reveal", () => {
    const allocation = classifyStorageCommand("recordings_set");
    expect(allocation.tier).toBe(2);
    expect(allocation.reason).toMatch(/camera recordings.*owner\/admin/);
    expect(allocation.reason).not.toMatch(/recovery key|permanently erases/);
    expect(classifyStorageCommand(REVEAL).reason).toMatch(/recovery key.*only the owner/);
  });

  it("no operation is in both tiers", () => {
    for (const op of STORAGE_TIER_2_OPERATIONS) {
      expect(STORAGE_TIER_3_OPERATIONS.has(op), `${op} must not be Tier 3 as well`).toBe(false);
    }
  });

  it("classifies the reveal as Tier 2: confirmation required, with a human reason that is not the erase text", () => {
    const c = classifyStorageCommand(REVEAL);
    expect(c.tier).toBe(2);
    expect(c.requiresConfirmation).toBe(true);
    expect(typeof c.reason).toBe("string");
    expect((c.reason ?? "").length).toBeGreaterThan(20);
    // It is NOT the Tier-3 "permanently erases data" sentence, and it is not
    // the unrecognised-operation refusal either.
    expect(c.reason).not.toMatch(/erase/i);
    expect(c.reason).not.toMatch(/unrecogni[sz]ed|refused/i);
  });

  it.each([...STORAGE_TIER_3_OPERATIONS].filter((op) => op !== REGENERATE))(
    "%s stays Tier 3 with the erase reason",
    (op) => {
      const c = classifyStorageCommand(op);
      expect(c.tier).toBe(3);
      expect(c.requiresConfirmation).toBe(true);
      expect(c.reason).toMatch(/permanently erases data/);
    },
  );

  it("classifies the regenerate as Tier 3 with its OWN reason: nothing is erased, but the old key stops working", () => {
    const c = classifyStorageCommand(REGENERATE);
    expect(c.tier).toBe(3);
    expect(c.requiresConfirmation).toBe(true);
    expect(c.reason).toMatch(/recovery key/i);
    expect(c.reason).toMatch(/old one stops working/i);
    expect(c.reason).not.toMatch(/permanently erases data/);
    expect(c.reason).not.toMatch(/unrecogni[sz]ed|refused/i);
  });

  it("the Tier-3 set contains erase operations, old footage deletion and recovery-key regeneration", () => {
    expect([...STORAGE_TIER_3_OPERATIONS].sort()).toEqual(
      [
        "drive_adopt",
        "drive_reclaim",
        "pool_add_spare",
        "pool_create",
        "pool_destroy",
        "pool_format",
        "pool_remove_disk",
        "pool_set_level",
        "recordings_old_footage_delete",
        REGENERATE,
      ].sort(),
    );
  });

  it.each([
    "totally_unknown_op",
    "",
    "recovery_key_reveal ", // trailing space — exact match only
    "RECOVERY_KEY_REVEAL",
    "recovery_key_reveal2",
    "recovery_key_regenerate ",
    "RECOVERY_KEY_REGENERATE",
    "recovery_key_regenerate2",
    "get_recovery_key",
    "recovery_key_delete",
  ])("an unrecognised operation (%j) is still Tier 3 and refused — fail closed", (op) => {
    const c = classifyStorageCommand(op);
    expect(c.tier).toBe(3);
    expect(c.requiresConfirmation).toBe(true);
    expect(c.reason).toMatch(/unrecognised storage operation and is refused/);
  });
});

describe("storage safety — the response and audit row carry the classification's tier (WARP-3513)", () => {
  let prisma: ReturnType<typeof prismaStub>;
  beforeEach(() => {
    prisma = prismaStub();
  });

  it("the reveal via the dashboard answers Tier 2 with a single-use token, and audits Tier 2", async () => {
    const res = await evaluateStorageCommand(prisma, REVEAL, FS_UUID, {}, "owner-1", "api");
    expect("requiresConfirmation" in res && res.requiresConfirmation).toBe(true);
    expect(res.tier).toBe(2);
    expect("confirmationToken" in res && res.confirmationToken).toMatch(/^[0-9a-f]{64}$/);

    const rows = auditRows(prisma);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "owner-1",
      entityId: `storage.${FS_UUID}`,
      domain: "storage",
      service: REVEAL,
      tier: 2,
      confirmed: false,
      blocked: false,
    });
    // No params ride the audit row — and certainly no key.
    expect(rows[0].data).toEqual({});
  });

  it("the AI stays hard-blocked from the reveal: blocked, no token, audited as blocked", async () => {
    const res = await evaluateStorageCommand(prisma, REVEAL, FS_UUID, {}, "ai-user", "ai");
    expect("blocked" in res && res.blocked).toBe(true);
    expect(res.allowed).toBe(false);
    expect("confirmationToken" in res).toBe(false);
    expect(res.tier).toBe(2);
    expect(res.reason).toBeTruthy();

    const rows = auditRows(prisma);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: REVEAL, tier: 2, blocked: true, confirmed: false });
  });

  it("the regenerate via the dashboard answers Tier 3 with a single-use token, and audits Tier 3 with empty params", async () => {
    const res = await evaluateStorageCommand(prisma, REGENERATE, FS_UUID, {}, "owner-1", "api");
    expect("requiresConfirmation" in res && res.requiresConfirmation).toBe(true);
    expect(res.tier).toBe(3);
    expect("confirmationToken" in res && res.confirmationToken).toMatch(/^[0-9a-f]{64}$/);

    const rows = auditRows(prisma);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "owner-1",
      entityId: `storage.${FS_UUID}`,
      domain: "storage",
      service: REGENERATE,
      tier: 3,
      confirmed: false,
      blocked: false,
    });
    expect(rows[0].data).toEqual({});
  });

  it("the AI stays hard-blocked from the regenerate: blocked, no token, audited as blocked at Tier 3", async () => {
    const res = await evaluateStorageCommand(prisma, REGENERATE, FS_UUID, {}, "ai-user", "ai");
    expect("blocked" in res && res.blocked).toBe(true);
    expect("confirmationToken" in res).toBe(false);
    expect(res.tier).toBe(3);
    expect(auditRows(prisma)[0]).toMatchObject({ service: REGENERATE, tier: 3, blocked: true, confirmed: false });
  });

  it("confirming the regenerate audits the confirmation at Tier 3", async () => {
    const res = await evaluateStorageCommand(prisma, REGENERATE, FS_UUID, {}, "owner-1", "api");
    if (!("confirmationToken" in res)) throw new Error("no token minted");
    const confirmed = await confirmStorageCommand(prisma, res.confirmationToken, "owner-1", {
      service: REGENERATE,
      resourceId: FS_UUID,
    });
    expect(confirmed.confirmed).toBe(true);
    expect(auditRows(prisma)[1]).toMatchObject({ service: REGENERATE, tier: 3, confirmed: true, blocked: false });
  });

  it("a reveal token cannot confirm a regenerate of the same drive (and vice versa)", async () => {
    const reveal = await evaluateStorageCommand(prisma, REVEAL, FS_UUID, {}, "owner-1", "api");
    if (!("confirmationToken" in reveal)) throw new Error("no token minted");
    const wrong = await confirmStorageCommand(prisma, reveal.confirmationToken, "owner-1", {
      service: REGENERATE,
      resourceId: FS_UUID,
    });
    expect(wrong.confirmed).toBe(false);
    if (!wrong.confirmed) expect(wrong.code).toBe("TOKEN_OPERATION_MISMATCH");
  });

  it("an erase op still answers Tier 3 and audits Tier 3", async () => {
    const res = await evaluateStorageCommand(prisma, "drive_adopt", "sdb", { device: "sdb" }, "owner-1", "api");
    expect(res.tier).toBe(3);
    expect(auditRows(prisma)[0]).toMatchObject({ service: "drive_adopt", tier: 3, confirmed: false });
  });

  it("an unrecognised op answers (and audits) Tier 3", async () => {
    const viaAi = await evaluateStorageCommand(prisma, "totally_unknown_op", "x", {}, "ai", "ai");
    expect(viaAi.tier).toBe(3);
    expect(auditRows(prisma)[0]).toMatchObject({ service: "totally_unknown_op", tier: 3, blocked: true });
  });

  it("confirming the reveal audits the confirmation at Tier 2", async () => {
    const res = await evaluateStorageCommand(prisma, REVEAL, FS_UUID, {}, "owner-1", "api");
    if (!("confirmationToken" in res)) throw new Error("no token minted");
    const confirmed = await confirmStorageCommand(prisma, res.confirmationToken, "owner-1", {
      service: REVEAL,
      resourceId: FS_UUID,
    });
    expect(confirmed.confirmed).toBe(true);
    const rows = auditRows(prisma);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ service: REVEAL, tier: 2, confirmed: true, blocked: false });
  });

  it("confirming an erase op still audits Tier 3", async () => {
    const res = await evaluateStorageCommand(prisma, "pool_destroy", "md0", {}, "owner-1", "api");
    if (!("confirmationToken" in res)) throw new Error("no token minted");
    await confirmStorageCommand(prisma, res.confirmationToken, "owner-1", {
      service: "pool_destroy",
      resourceId: "md0",
    });
    expect(auditRows(prisma)[1]).toMatchObject({ service: "pool_destroy", tier: 3, confirmed: true });
  });

  it("AI source is hard-blocked for EVERY storage op, Tier 2 and Tier 3 and unknown alike", async () => {
    const ops = [...STORAGE_TIER_3_OPERATIONS, ...STORAGE_TIER_2_OPERATIONS, "totally_unknown_op"];
    for (const op of ops) {
      const res = await evaluateStorageCommand(prisma, op, "x", {}, "ai", "ai");
      expect("blocked" in res && res.blocked, `${op} must block the AI`).toBe(true);
      expect("confirmationToken" in res, `${op} must never mint a token for the AI`).toBe(false);
    }
  });

  it("the too-many-pending refusal also carries the op's own tier", async () => {
    vi.useFakeTimers();
    try {
      // Fill the in-memory pending map to its cap with Tier-3 tokens.
      for (let i = 0; i < STORAGE_MAX_PENDING_CONFIRMATIONS; i++) {
        await evaluateStorageCommand(prisma, "pool_create", `md${i}`, {}, "owner-1", "api");
      }
      const reveal = await evaluateStorageCommand(prisma, REVEAL, FS_UUID, {}, "owner-1", "api");
      expect("blocked" in reveal && reveal.blocked).toBe(true);
      expect(reveal.tier).toBe(2);
      expect(reveal.reason).toMatch(/too many pending/i);

      const erase = await evaluateStorageCommand(prisma, "pool_create", "md999", {}, "owner-1", "api");
      expect("blocked" in erase && erase.blocked).toBe(true);
      expect(erase.tier).toBe(3);
    } finally {
      // Expire + sweep so no later test in this file sees a full map.
      vi.advanceTimersByTime(STORAGE_CONFIRMATION_TOKEN_EXPIRY_MS + 1_000);
      cleanupExpiredStorageTokens();
      vi.useRealTimers();
    }
    const after = await evaluateStorageCommand(prisma, REVEAL, FS_UUID, {}, "owner-1", "api");
    expect("requiresConfirmation" in after && after.requiresConfirmation).toBe(true);
  });
});

describe("confirmStorageCommand — allowedServices endpoint gate (WARP-3513)", () => {
  let prisma: ReturnType<typeof prismaStub>;
  const EXECUTABLE: ReadonlySet<string> = new Set(["pool_create", "drive_adopt"]);
  beforeEach(() => {
    prisma = prismaStub();
  });

  async function mint(service: string, resourceId: string, userId = "owner-1") {
    const res = await evaluateStorageCommand(prisma, service, resourceId, {}, userId, "api");
    if (!("confirmationToken" in res)) throw new Error("no token minted");
    return res.confirmationToken;
  }

  it("refuses a token whose service this endpoint cannot execute, and CONSUMES it", async () => {
    const token = await mint(REVEAL, FS_UUID);
    const res = await confirmStorageCommand(prisma, token, "owner-1", {
      service: REVEAL,
      resourceId: FS_UUID,
      allowedServices: EXECUTABLE,
    });
    expect(res.confirmed).toBe(false);
    if (res.confirmed) return;
    expect(res.code).toBe("TOKEN_ENDPOINT_MISMATCH");
    // Names the service the endpoint cannot execute.
    expect(res.reason).toContain(REVEAL);
    expect(res.reason).toMatch(/cannot be executed at this endpoint/);

    // Single-use: the refused token is gone, it cannot be retried anywhere.
    const retry = await confirmStorageCommand(prisma, token, "owner-1", {
      service: REVEAL,
      resourceId: FS_UUID,
    });
    expect(retry.confirmed).toBe(false);
    if (!retry.confirmed) expect(retry.code).toBe("TOKEN_MISSING");
  });

  it("refuses it even when the caller omits service and resourceId from the echo", async () => {
    const token = await mint(REVEAL, FS_UUID);
    const res = await confirmStorageCommand(prisma, token, "owner-1", { allowedServices: EXECUTABLE });
    expect(res.confirmed).toBe(false);
    if (!res.confirmed) expect(res.code).toBe("TOKEN_ENDPOINT_MISMATCH");
  });

  it("never writes a confirmed=true audit row for a refused endpoint (nothing ran)", async () => {
    const token = await mint(REVEAL, FS_UUID);
    await confirmStorageCommand(prisma, token, "owner-1", { allowedServices: EXECUTABLE });
    expect(auditRows(prisma).some((r) => r.confirmed)).toBe(false);
  });

  it("names the service in the reason, whatever it is", async () => {
    const token = await mint("totally_unknown_op", "x");
    const res = await confirmStorageCommand(prisma, token, "owner-1", { allowedServices: EXECUTABLE });
    expect(res.confirmed).toBe(false);
    if (res.confirmed) return;
    expect(res.code).toBe("TOKEN_ENDPOINT_MISMATCH");
    expect(res.reason).toContain("totally_unknown_op");
  });

  it("lets an allowed service through and consumes it as before", async () => {
    const token = await mint("pool_create", "md0");
    const res = await confirmStorageCommand(prisma, token, "owner-1", {
      service: "pool_create",
      resourceId: "md0",
      allowedServices: EXECUTABLE,
    });
    expect(res.confirmed).toBe(true);
    if (res.confirmed) expect(res.service).toBe("pool_create");
  });

  it("checks the requesting user BEFORE the endpoint: a stranger cannot burn the owner's token", async () => {
    const token = await mint(REVEAL, FS_UUID, "owner-1");
    const stranger = await confirmStorageCommand(prisma, token, "someone-else", {
      allowedServices: EXECUTABLE,
    });
    expect(stranger.confirmed).toBe(false);
    if (!stranger.confirmed) expect(stranger.code).toBe("TOKEN_USER_MISMATCH");

    // The owner's token survived and still confirms for the owner.
    const owner = await confirmStorageCommand(prisma, token, "owner-1", {
      service: REVEAL,
      resourceId: FS_UUID,
    });
    expect(owner.confirmed).toBe(true);
  });

  it("without allowedServices the behaviour is exactly the old one (any known service confirms)", async () => {
    const token = await mint(REVEAL, FS_UUID);
    const res = await confirmStorageCommand(prisma, token, "owner-1", { service: REVEAL, resourceId: FS_UUID });
    expect(res.confirmed).toBe(true);
  });
});
