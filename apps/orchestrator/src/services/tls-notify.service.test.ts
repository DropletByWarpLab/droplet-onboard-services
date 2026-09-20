import { beforeEach, describe, expect, it, vi } from "vitest";

type Dispatch = { userId: string; kind: string; title: string; body?: string | null };
const sendNotification = vi.fn(async (_prisma: unknown, _input: Dispatch) => ({
  id: "n1",
  channels: ["toast"],
  delivered: true,
}));
vi.mock("./notifications.service.js", () => ({
  sendNotification: (prisma: unknown, input: Dispatch) => sendNotification(prisma, input),
}));

import {
  TLS_EXPIRING_TITLE,
  TLS_RENEW_FAILED_TITLE,
  createTlsNotifier,
  expiringSoonBody,
  renewFailedBody,
} from "./tls-notify.service.js";

/** Owner + admin + a family member: the family member never hears about
 *  certificates (it is not theirs to fix), and the recipients are USERNAMES —
 *  the vocabulary the notification subsystem actually delivers on. */
function makePrisma(existingLogRows: unknown[] = []) {
  const findFirst = vi.fn(async () => existingLogRows[0] ?? null);
  return {
    prisma: {
      user: {
        findMany: vi.fn(async ({ where }: { where: { role: { in: string[] } } }) =>
          [
            { username: "stefan", role: "owner" },
            { username: "romain", role: "admin" },
            { username: "kid", role: "family" },
          ].filter((u) => where.role.in.includes(u.role)),
        ),
      },
      notificationLog: { findFirst },
    } as never,
    findFirst,
  };
}

const day = 86_400_000;

beforeEach(() => {
  sendNotification.mockClear();
});

describe("tls-notify — who hears it", () => {
  it("renewFailed reaches every owner and admin by username, and nobody else", async () => {
    const { prisma } = makePrisma();
    await createTlsNotifier(prisma).renewFailed({ fqdn: "mybox.droplet-us.com", notAfter: null, daysLeft: 12 });
    const userIds = sendNotification.mock.calls.map((c) => c[1].userId).sort();
    expect(userIds).toEqual(["romain", "stefan"]);
    for (const call of sendNotification.mock.calls) {
      const input = call[1];
      expect(input.kind).toBe("system");
      expect(input.title).toBe(TLS_RENEW_FAILED_TITLE);
      expect(input.body).toContain("12 more days");
      expect(input.body).toContain("internet");
    }
  });
});

describe("tls-notify — the words", () => {
  it("renewFailedBody says what is still working and the one action that helps", () => {
    expect(renewFailedBody(1)).toContain("valid for 1 more day.");
    expect(renewFailedBody(12)).toContain("valid for 12 more days.");
    expect(renewFailedBody(null)).toContain("still serving its current certificate");
    // Past expiry: honest about browsers, honest that the apps keep working.
    const expired = renewFailedBody(0);
    expect(expired).toContain("expired");
    expect(expired).toContain("browsers will warn");
    expect(expired).toContain("apps keep working");
    // The 60-day rule is in every version.
    for (const body of [renewFailedBody(1), renewFailedBody(null), renewFailedBody(0)]) {
      expect(body).toContain("every 60 days");
    }
  });

  it("expiringSoonBody counts down to 'today' and never says a negative number of days", () => {
    expect(expiringSoonBody(6)).toContain("expires in 6 days");
    expect(expiringSoonBody(1)).toContain("expires in 1 day ");
    expect(expiringSoonBody(0)).toContain("expires today");
  });
});

describe("tls-notify — expiringSoon fires once per certificate", () => {
  it("sends when no warning for this certificate exists, and looks only inside this certificate's last week", async () => {
    const { prisma, findFirst } = makePrisma([]);
    const notAfter = new Date(Date.now() + 5 * day).toISOString();
    await createTlsNotifier(prisma).expiringSoon({ fqdn: "mybox.droplet-us.com", notAfter, daysLeft: 5 });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const where = (findFirst.mock.calls[0] as unknown as [{ where: { title: string; createdAt: { gte: Date } } }])[0].where;
    expect(where.title).toBe(TLS_EXPIRING_TITLE);
    // The dedupe window opens 7 days before notAfter — a warning about the
    // PREVIOUS certificate (months ago) can never suppress this one.
    const expectedStart = new Date(new Date(notAfter).getTime() - 7 * day).getTime();
    expect(Math.abs(where.createdAt.gte.getTime() - expectedStart)).toBeLessThan(1000);
  });

  it("stays silent on the next daily tick once this certificate's warning went out", async () => {
    const { prisma } = makePrisma([{ id: "already" }]);
    const notAfter = new Date(Date.now() + 4 * day).toISOString();
    await createTlsNotifier(prisma).expiringSoon({ fqdn: "mybox.droplet-us.com", notAfter, daysLeft: 4 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
