/**
 * WARP-1565 residual 2 — pending pre-narrowing owner invites.
 *
 * Rail 7 (`assertRoleAssignable`, WARP-1526) closed the MINT path: the two
 * invite-creating routes refuse `role: "owner"` with 403
 * ROLE_NOT_ASSIGNABLE, because there is exactly one owner by design and
 * ownership transfer is a future dedicated flow.
 *
 * It did nothing about rows already in the table. An invite written before
 * that narrowing is still `role="owner"`, still pending, and the accept path
 * still honours it — deliberately: the WARP-1051 contract is that accept
 * grants the invite's CANONICAL role with no silent remapping, and
 * `auth.directory-invite-accept.test.ts` pins that passthrough explicitly.
 * Changing accept would break a contract on purpose; revoking the rows
 * removes the input instead.
 *
 * Hence a boot sweep rather than a migration. A migration fixes the rows
 * present when it runs, and this box gets reflashed and restored from
 * backup — a restore of a pre-narrowing dump would put a pending owner
 * invite back in front of an accept path that is documented to honour it.
 * Converging on every boot is what makes that unreachable.
 */
import { describe, it, expect, vi } from "vitest";
import { revokePendingOwnerInvites } from "./owner-invite-sweep.service.js";

interface InviteRow {
  id: string;
  role: string;
  // WARP-3193 QUAL-3: the lifecycle is an explicit column.
  status: "pending" | "accepted" | "revoked" | "expired";
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

function createPrismaStub(rows: InviteRow[]) {
  return {
    _rows: rows,
    userInvite: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of rows) {
          if (where.role !== undefined && row.role !== where.role) continue;
          if (where.status?.in !== undefined && !where.status.in.includes(row.status)) continue;
          if (typeof where.status === "string" && row.status !== where.status) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
    },
  };
}

const pending = (id: string, role: string): InviteRow => ({
  id,
  role,
  status: "pending",
  acceptedAt: null,
  revokedAt: null,
});

describe("revokePendingOwnerInvites", () => {
  it("revokes a pending owner invite", async () => {
    const prisma = createPrismaStub([pending("i-1", "owner")]);

    await expect(revokePendingOwnerInvites(prisma as never)).resolves.toBe(1);
    expect(prisma._rows[0].status).toBe("revoked");
    expect(prisma._rows[0].revokedAt).toBeInstanceOf(Date);
  });

  it("revokes an owner invite the daily sweep already marked expired", async () => {
    const prisma = createPrismaStub([{ ...pending("i-old", "owner"), status: "expired" }]);

    await expect(revokePendingOwnerInvites(prisma as never)).resolves.toBe(1);
    expect(prisma._rows[0].status).toBe("revoked");
  });

  it("leaves every assignable-tier invite alone", async () => {
    const prisma = createPrismaStub([
      pending("i-admin", "admin"),
      pending("i-family", "family"),
      pending("i-guest", "guest"),
    ]);

    await expect(revokePendingOwnerInvites(prisma as never)).resolves.toBe(0);
    expect(prisma._rows.every((r) => r.revokedAt === null)).toBe(true);
  });

  it("never touches an owner invite that was already accepted", async () => {
    // The person already holds the role; revoking their invite would not
    // take it away, and rewriting history in the invite audit trail to
    // suggest otherwise would be a lie.
    const accepted: InviteRow = {
      id: "i-done",
      role: "owner",
      status: "accepted",
      acceptedAt: new Date("2026-01-01T00:00:00Z"),
      revokedAt: null,
    };
    const prisma = createPrismaStub([accepted]);

    await expect(revokePendingOwnerInvites(prisma as never)).resolves.toBe(0);
    expect(accepted.status).toBe("accepted");
    expect(accepted.revokedAt).toBeNull();
  });

  it("is idempotent — a second boot revokes nothing and does not re-stamp", async () => {
    const prisma = createPrismaStub([pending("i-1", "owner")]);

    await expect(revokePendingOwnerInvites(prisma as never)).resolves.toBe(1);
    const stampedAt = prisma._rows[0].revokedAt;

    await expect(revokePendingOwnerInvites(prisma as never)).resolves.toBe(0);
    expect(prisma._rows[0].revokedAt).toBe(stampedAt);
  });

  it("selects on the explicit status column, never on absence-derived state", async () => {
    const prisma = createPrismaStub([pending("i-1", "owner")]);
    await revokePendingOwnerInvites(prisma as never);

    expect(prisma.userInvite.updateMany).toHaveBeenCalledWith({
      where: { role: "owner", status: { in: ["pending", "expired"] } },
      data: { status: "revoked", revokedAt: expect.any(Date) },
    });
  });
});
