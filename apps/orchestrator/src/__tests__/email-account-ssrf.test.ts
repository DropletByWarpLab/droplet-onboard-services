/**
 * WARP-2734 — an admin-typed mail host is a destination this box will dial.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * `docs/security/allowed-egress.yaml` carries two sibling entries:
 *
 *   - `user-calendar-servers`, whose text says outright *"THE ENFORCEMENT IS
 *     IN CODE (WARP-2022) … `lib/outbound-url-guard.ts` refuses non-http(s)
 *     schemes, credentials in…"*, with `calendar-source-ssrf.test.ts` behind it.
 *   - `user-mail-servers`, `kind: dynamic`, with **no such clause and no code
 *     guard**.
 *
 * Mail had the egress entry and not the enforcement, and until WARP-2734 that
 * was harmless in the way an unlocked door on an empty room is harmless:
 * nothing could create an `EmailAccount`, so no operator-supplied host ever
 * reached a dialler. This ticket opens the room.
 *
 * ── Why resolution, not a pattern ──────────────────────────────────────────
 *
 * 🔴 A hostname allow-list or a "looks private" regex cannot catch
 * `mail.evil.example  A  169.254.169.254`. The name is public, the answer is
 * not, and the connection goes where the answer points.
 * `assertOutboundDestinationAllowed` RESOLVES and rejects a private address,
 * which is the only check that survives DNS the attacker controls.
 *
 * ── Both hosts, not just IMAP ──────────────────────────────────────────────
 *
 * `smtpHost` is dialled by the outbound poller on a schedule. A hostile SMTP
 * host is the same hole with a slower fuse, and a guard that checked only the
 * one the form emphasises would be the more dangerous kind of half-measure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { connectMailbox, PROVISION_ERRORS } from "../services/email/provision.service.js";

const BODY = {
  displayName: "Front desk",
  address: "desk@northgate.example",
  imapHost: "mail.northgate.example",
  imapPort: 993,
  imapTls: true,
  smtpHost: "smtp.northgate.example",
  smtpPort: 465,
  smtpTls: true,
  username: "NORTHGATE-frontdesk",
  password: "hunter2",
};

function prismaMock() {
  const create = vi.fn(async () => ({
    id: "acct-1",
    address: BODY.address,
    displayName: BODY.displayName,
    imapStatus: "idle",
  }));
  return {
    prisma: {
      emailAccount: { findUnique: vi.fn(async () => null), create },
    } as never,
    create,
  };
}

/** Every request to the indexer fails loudly, so any test that reaches the hop
 *  is visibly reaching it rather than quietly passing. */
const fetchMock = vi.fn(async () => {
  throw new Error("the SSRF guard should have refused before this hop");
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  lookupMock.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
});

describe("🔴 a mail host that resolves inside the box is refused", () => {
  const PRIVATE = [
    ["the cloud metadata endpoint", "169.254.169.254"],
    ["loopback", "127.0.0.1"],
    ["the docker bridge", "172.17.0.1"],
    ["the LAN the box sits on", "192.168.9.1"],
    ["a 10/8 host", "10.0.0.5"],
    ["IPv6 loopback", "::1"],
    ["IPv6 link-local", "fe80::1"],
  ] as const;

  it.each(PRIVATE)("refuses a host resolving to %s", async (_label, address) => {
    const { prisma, create } = prismaMock();
    lookupMock.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);

    await expect(connectMailbox(prisma, BODY, "u-1")).rejects.toThrow(
      PROVISION_ERRORS.BLOCKED_HOST,
    );
    // Nothing was dialled and nothing was written.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("🔴 MUTATION: guard only imapHost — the SMTP poller dials it on a timer", async () => {
    const { prisma, create } = prismaMock();
    // A public IMAP host and a private SMTP one. If only the first were
    // checked this would sail through, and the outbound poller would connect
    // to the metadata service every ten seconds.
    lookupMock.mockImplementation(async (host: string) =>
      host === BODY.smtpHost
        ? [{ address: "169.254.169.254", family: 4 }]
        : [{ address: "203.0.113.10", family: 4 }],
    );

    await expect(connectMailbox(prisma, BODY, "u-1")).rejects.toThrow(
      PROVISION_ERRORS.BLOCKED_HOST,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses when ONE of several answers is private", async () => {
    // A name that resolves to both a public and a private address is the
    // rebinding shape. The guard must reject on any private answer, not on
    // the first one it reads.
    const { prisma } = prismaMock();
    lookupMock.mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(connectMailbox(prisma, BODY, "u-1")).rejects.toThrow(
      PROVISION_ERRORS.BLOCKED_HOST,
    );
  });

  it("🔴 fails CLOSED on an unresolvable host", async () => {
    // Not "allow it and let the connection fail": an attacker who controls
    // DNS can make resolution fail on the check and succeed on the dial.
    const { prisma } = prismaMock();
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(connectMailbox(prisma, BODY, "u-1")).rejects.toThrow(
      PROVISION_ERRORS.BLOCKED_HOST,
    );
  });

  it("refuses a literal private address typed straight into the form", async () => {
    const { prisma } = prismaMock();
    await expect(
      connectMailbox(prisma, { ...BODY, imapHost: "127.0.0.1" }, "u-1"),
    ).rejects.toThrow(PROVISION_ERRORS.BLOCKED_HOST);
    // A literal is vetted against the same table without a lookup — asserted
    // so a future refactor cannot make the literal path the unguarded one.
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("a public mail host reaches the indexer", () => {
  it("gets past the guard and is refused only by the hop this test breaks", async () => {
    // The vacuity check for the whole suite: if the guard rejected everything,
    // every test above would pass for the wrong reason.
    const { prisma } = prismaMock();
    await expect(connectMailbox(prisma, BODY, "u-1")).rejects.toThrow(
      PROVISION_ERRORS.INDEXER_UNAVAILABLE,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("🔴 writes userId on the row, not just past the route", async () => {
    // A mutation setting `userId: null` in the create SURVIVED the route
    // suite, because that suite mocks `connectMailbox` and could only see the
    // argument going in. This asserts the column.
    //
    // It matters because `EmailAccount.userId` is `String?`, was written by
    // nothing before this ticket, and is the identity every downstream read
    // scopes by (`assertAccountAccessible`). An account with a null owner is
    // one every user on the box can see.
    const { prisma, create } = prismaMock();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, passwordEnc: "gAAAAA-ciphertext" }),
    } as never);

    await connectMailbox(prisma, BODY, "u-ada");
    expect(create.mock.calls[0][0].data.userId).toBe("u-ada");
    // And the probe decided the status — `idle` is a claim about a connection
    // that worked, not about a row that was written.
    expect(create.mock.calls[0][0].data.imapStatus).toBe("idle");
    // The ciphertext is stored; the plaintext is not anywhere in the write.
    expect(JSON.stringify(create.mock.calls[0][0].data)).not.toContain(BODY.password);
  });

  it("checks the duplicate BEFORE spending an IMAP login", async () => {
    const prisma = {
      emailAccount: {
        findUnique: vi.fn(async () => ({ id: "existing" })),
        create: vi.fn(),
      },
    } as never;
    await expect(connectMailbox(prisma, BODY, "u-1")).rejects.toThrow(
      PROVISION_ERRORS.DUPLICATE_ADDRESS,
    );
    // And the owner is told the real reason rather than watching a perfectly
    // good mailbox fail on a unique constraint.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
