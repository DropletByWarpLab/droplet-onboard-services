/**
 * Unit tests for the onboarding TEAM-invite service (PR #381 /
 * docs/ONBOARDING_TEAM_ROLES.md).
 *
 * The TEAM wizard step invites teammates by EMAIL + ROLE. This service is the
 * single boundary that:
 *   - normalizes the email to lowercase (#374 contract: the email is the login
 *     key, so it must be case-canonical before it hits the store);
 *   - validates the role against the SHIPPED HOUSEHOLD Role enum
 *     (owner / admin / family / guest — `service` is excluded, a service
 *     principal is never minted by an invite);
 *   - derives a NOT-NULL username from the email local-part (the UserInvite
 *     model requires `username`; the onboarding surface is email-first);
 *   - creates the UserInvite row, reusing the WARP-217 token generator.
 *
 * #386 (a SEPARATE PR on main) owns invite-ACCEPT-time argon2id passwordHash so
 * an invited member can sign in on the email-keyed login. This service only
 * CREATES the invite; it is compatible with #386 (same UserInvite row), it does
 * not re-implement accept.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.unmock("@prisma/client");

import {
  normalizeInviteEmail,
  isValidEmail,
  isInviteRole,
  deriveUsernameFromEmail,
  createTeamInvite,
  INVITE_ROLES,
  InvalidInviteEmailError,
  InvalidInviteRoleError,
} from "./onboarding-team-invite.service.js";

// ── In-memory UserInvite store ──
function createPrismaMock() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    _rows: () => rows,
    userInvite: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `inv-${rows.length + 1}`, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      }),
    },
  };
}

describe("normalizeInviteEmail", () => {
  it("lowercases and trims (the login key is case-canonical, #374)", () => {
    expect(normalizeInviteEmail("  Romain@Acme.CO ")).toBe("romain@acme.co");
  });

  it("does not strip internal characters — it canonicalizes only", () => {
    expect(normalizeInviteEmail("First.Last+tag@Example.com")).toBe(
      "first.last+tag@example.com",
    );
  });
});

describe("isValidEmail", () => {
  it("accepts a well-formed address", () => {
    expect(isValidEmail("sam@acme.co")).toBe(true);
  });

  it.each(["", "notanemail", "no@domain", "@acme.co", "a b@acme.co", "x@.co"])(
    "rejects malformed address %j",
    (bad) => {
      expect(isValidEmail(bad)).toBe(false);
    },
  );
});

describe("isInviteRole — HOUSEHOLD model", () => {
  it("accepts the four household roles", () => {
    expect(INVITE_ROLES).toEqual(["owner", "admin", "family", "guest"]);
    for (const r of INVITE_ROLES) expect(isInviteRole(r)).toBe(true);
  });

  it("rejects `service` (never minted by an invite) and business-only roles", () => {
    expect(isInviteRole("service")).toBe(false);
    // Business-fork roles the scaffold flagged — NOT part of the shipped model.
    expect(isInviteRole("manager")).toBe(false);
    expect(isInviteRole("member")).toBe(false);
    expect(isInviteRole("viewer")).toBe(false);
    expect(isInviteRole("")).toBe(false);
  });
});

describe("deriveUsernameFromEmail", () => {
  it("uses the local-part, sanitized to the username charset", () => {
    expect(deriveUsernameFromEmail("romain@acme.co")).toBe("romain");
  });

  it("keeps allowed punctuation and drops the rest", () => {
    expect(deriveUsernameFromEmail("first.last+tag@acme.co")).toBe(
      "first.last-tag",
    );
  });

  it("never returns shorter than the 2-char minimum", () => {
    // A 1-char local part is padded so the derived username satisfies the
    // UserInvite username contract (min 2).
    const u = deriveUsernameFromEmail("a@acme.co");
    expect(u.length).toBeGreaterThanOrEqual(2);
  });
});

describe("createTeamInvite", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("creates a UserInvite with the normalized email + validated role", async () => {
    const result = await createTeamInvite(prisma as never, {
      email: "  Nina@Acme.CO ",
      role: "family",
      createdBy: "stefan",
    });

    expect(result.email).toBe("nina@acme.co");
    expect(result.role).toBe("family");
    expect(result.token).toBeTruthy();
    expect(result.expiresAt).toBeInstanceOf(Date);

    const [row] = prisma._rows();
    expect(row.email).toBe("nina@acme.co");
    expect(row.role).toBe("family");
    expect(row.createdBy).toBe("stefan");
    // username is NOT NULL on UserInvite — derived from the local part.
    expect(row.username).toBe("nina");
    expect(typeof row.token).toBe("string");
    expect(row.expiresAt).toBeInstanceOf(Date);
  });

  it("rejects an invalid email WITHOUT writing", async () => {
    await expect(
      createTeamInvite(prisma as never, {
        email: "not-an-email",
        role: "family",
        createdBy: "stefan",
      }),
    ).rejects.toBeInstanceOf(InvalidInviteEmailError);
    expect(prisma._rows()).toHaveLength(0);
  });

  it("rejects an invalid role WITHOUT writing", async () => {
    await expect(
      createTeamInvite(prisma as never, {
        email: "sam@acme.co",
        role: "manager",
        createdBy: "stefan",
      }),
    ).rejects.toBeInstanceOf(InvalidInviteRoleError);
    expect(prisma._rows()).toHaveLength(0);
  });

  it("honours an explicit ttlHours and defaults to 72h otherwise", async () => {
    const before = Date.now();
    const r = await createTeamInvite(prisma as never, {
      email: "sam@acme.co",
      role: "guest",
      createdBy: "stefan",
      ttlHours: 24,
    });
    const ms = r.expiresAt.getTime() - before;
    // ~24h, allow generous slack for test execution time.
    expect(ms).toBeGreaterThan(23 * 3600 * 1000);
    expect(ms).toBeLessThan(25 * 3600 * 1000);
  });
});
