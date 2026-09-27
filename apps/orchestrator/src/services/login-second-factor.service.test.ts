/**
 * WARP-3193 SEC-AUTH-2 — the shared sign-in second-factor check that the
 * password, passkey and SSO paths all run. TOTP / recovery verification are
 * mocked at their module boundary (their own suites cover them).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const acceptTotpCode = vi.fn();
const consumeRecoveryCode = vi.fn();
vi.mock("./totp.service.js", () => ({
  acceptTotpCode: (...a: unknown[]) => acceptTotpCode(...a),
}));
vi.mock("./recovery.service.js", () => ({
  consumeRecoveryCode: (...a: unknown[]) => consumeRecoveryCode(...a),
}));

import { checkLoginSecondFactor } from "./login-second-factor.service.js";

function prismaWith(cred: { confirmedAt: Date | null } | null) {
  return {
    totpCredential: {
      findUnique: vi.fn(async () =>
        cred ? { userId: "u1", secretEnc: "enc", lastAcceptedStep: 0, ...cred } : null,
      ),
    },
    recoveryCode: {},
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe("checkLoginSecondFactor", () => {
  it("no TOTP credential, or only a pending one → not_enrolled (nothing verified)", async () => {
    expect(await checkLoginSecondFactor(prismaWith(null), "u1", { totp: "123456" })).toBe("not_enrolled");
    expect(await checkLoginSecondFactor(prismaWith({ confirmedAt: null }), "u1", {})).toBe("not_enrolled");
    expect(acceptTotpCode).not.toHaveBeenCalled();
  });

  it("confirmed TOTP and no code at all → failed", async () => {
    expect(await checkLoginSecondFactor(prismaWith({ confirmedAt: new Date() }), "u1", {})).toBe("failed");
  });

  it("a TOTP code goes through the single-use accept (trimmed)", async () => {
    acceptTotpCode.mockResolvedValueOnce(true);
    const prisma = prismaWith({ confirmedAt: new Date() });
    expect(await checkLoginSecondFactor(prisma, "u1", { totp: " 123456 " })).toBe("passed");
    expect(acceptTotpCode).toHaveBeenCalledWith(prisma, expect.objectContaining({ userId: "u1" }), "123456");
    acceptTotpCode.mockResolvedValueOnce(false);
    expect(await checkLoginSecondFactor(prisma, "u1", { totp: "123456" })).toBe("failed");
  });

  it("a recovery code goes through the shared consume", async () => {
    const prisma = prismaWith({ confirmedAt: new Date() });
    consumeRecoveryCode.mockResolvedValueOnce({ consumed: true, remaining: 3 });
    expect(await checkLoginSecondFactor(prisma, "u1", { recoveryCode: "aaaa-bbbb" })).toBe("passed");
    consumeRecoveryCode.mockResolvedValueOnce({ consumed: false });
    expect(await checkLoginSecondFactor(prisma, "u1", { recoveryCode: "aaaa-bbbb" })).toBe("failed");
  });

  it("non-string inputs are treated as absent", async () => {
    expect(
      await checkLoginSecondFactor(prismaWith({ confirmedAt: new Date() }), "u1", { totp: 123456, recoveryCode: {} }),
    ).toBe("failed");
    expect(acceptTotpCode).not.toHaveBeenCalled();
  });
});
