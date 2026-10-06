import { describe, expect, it, vi } from "vitest";
import { bindDeskEmailChannel, EMAIL_CHANNEL_ERRORS, listDeskEmailAccounts } from "./email-channel.service.js";

function fixture(authMode = "PASSWORD") {
  const prisma = {
    pmProject: { findFirst: vi.fn().mockResolvedValue({ id: "desk" }) },
    emailAccount: {
      findUnique: vi.fn().mockResolvedValue({ id: "account", authMode }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: { findFirst: vi.fn().mockResolvedValue({ id: "owner" }) },
    pmSupportChannel: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "channel" }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return prisma;
}

const INPUT = { projectId: "desk", emailAccountId: "account", contactOwnerUserId: "owner", autoAckEnabled: true };

describe("service desk mailboxes require outbound capability", () => {
  it("offers only PASSWORD and GOOGLE_OAUTH mailboxes", async () => {
    const prisma = fixture();
    await listDeskEmailAccounts(prisma as never);
    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { authMode: { in: ["PASSWORD", "GOOGLE_OAUTH"] } },
    }));
  });

  it.each([true, false])("rejects a read-only Graph mailbox with auto acknowledgements %s", async (autoAckEnabled) => {
    const prisma = fixture("M365_GRAPH");
    await expect(bindDeskEmailChannel(prisma as never, { ...INPUT, autoAckEnabled }))
      .rejects.toThrow(EMAIL_CHANNEL_ERRORS.ACCOUNT_READ_ONLY);
    expect(prisma.pmSupportChannel.upsert).not.toHaveBeenCalled();
  });

  it.each(["PASSWORD", "GOOGLE_OAUTH"])("keeps %s mailbox binding available", async (authMode) => {
    const prisma = fixture(authMode);
    await expect(bindDeskEmailChannel(prisma as never, INPUT)).resolves.toEqual({ id: "channel" });
    expect(prisma.pmSupportChannel.upsert).toHaveBeenCalledOnce();
  });

  it("allows an existing read-only binding to be removed", async () => {
    const prisma = fixture("M365_GRAPH");
    await expect(bindDeskEmailChannel(prisma as never, { ...INPUT, emailAccountId: null })).resolves.toBeNull();
    expect(prisma.pmSupportChannel.deleteMany).toHaveBeenCalledOnce();
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
  });
});
