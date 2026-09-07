/**
 * WARP-2734 — connecting a mailbox, and the four ways it must refuse.
 *
 * ── Why this suite is weighted towards refusals and absences ───────────────
 *
 * This is the first surface on this box that takes a third-party plaintext
 * password from a form. Everything else the orchestrator holds is a secret it
 * generated (a service token) or one scoped to itself (a session). A mailbox
 * password belongs to somebody else's system, and the owner typed it here
 * because they trusted the appliance with it.
 *
 * So the assertions that matter most are the ones about what does NOT appear:
 * the password in a response body, the password in a log line, a `userId` that
 * is null, and a hostname this box will dial without checking where it points.
 *
 * ── The SSRF one is not theoretical ────────────────────────────────────────
 *
 * `docs/security/allowed-egress.yaml` lists `user-mail-servers` as
 * `kind: dynamic` with NO code guard, while its sibling `user-calendar-servers`
 * says outright "THE ENFORCEMENT IS IN CODE (WARP-2022)". Mail had the entry
 * and not the enforcement. An admin-typed `imapHost` is a hostname a container
 * inside the trust boundary then dials — the classic shape, and the reason
 * `assertOutboundDestinationAllowed` RESOLVES rather than pattern-matches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const connectMailboxMock = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<unknown>>());
const disconnectMailboxMock = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<unknown>>());
vi.mock("../services/email/provision.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/email/provision.service.js")>()),
  connectMailbox: connectMailboxMock,
  disconnectMailbox: disconnectMailboxMock,
}));

const recordActivityMock = vi.hoisted(() =>
  vi.fn(async (_a: Record<string, unknown>) => undefined),
);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createEmailRouter } from "./email.js";
import { PROVISION_ERRORS } from "../services/email/provision.service.js";

const PASSWORD = "hunter2-correct-horse-battery-staple";

/** The outbound-channel gate. Irrelevant to account provisioning — it guards
 *  the SEND path — so it is stubbed permissive and never asserted on. */
const GATE = { isOutboundAllowed: async () => true } as never;

const BODY = {
  displayName: "Front desk",
  address: "desk@northgate.example",
  imapHost: "mail.northgate.example",
  imapPort: 993,
  imapTls: true,
  smtpHost: "smtp.northgate.example",
  smtpPort: 465,
  smtpTls: true,
  // 🔴 DELIBERATELY NOT the address. Many mailboxes use the address as the
  // login, but if the fixture did too, "the username does not leak" would be
  // indistinguishable from "the address is present" — which it correctly is.
  // A test that cannot tell its subject from its control asserts nothing.
  username: "NORTHGATE-frontdesk",
  password: PASSWORD,
};

function app(role: string, prisma: unknown = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "u-owner", role, username: "ada" };
    next();
  });
  a.use("/api", createEmailRouter(prisma as never, GATE));
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  connectMailboxMock.mockResolvedValue({
    id: "acct-1",
    address: BODY.address,
    displayName: BODY.displayName,
    imapStatus: "idle",
  });
  disconnectMailboxMock.mockResolvedValue({ removed: true, address: BODY.address });
});

describe("🔴 the password never comes back out", () => {
  it("is absent from a successful response, in every form", async () => {
    const res = await request(app("owner")).post("/api/email/accounts").send(BODY);
    expect(res.status).toBe(201);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PASSWORD);
    // Nor the ciphertext, nor the username — there is no endpoint anywhere
    // that reveals stored credential material, and this is where that starts.
    expect(body).not.toContain("passwordEnc");
    expect(body).not.toContain(BODY.username);
    expect(res.body.account).toMatchObject({ id: "acct-1", imapStatus: "idle" });
  });

  it("🔴 is absent from a VALIDATION failure", async () => {
    // ⚠ An earlier version of this test justified itself by saying zod's raw
    // `issues` embeds the offending INPUT. It does not — v3 reports a
    // validation NAME for a bad string and KEY names for an unrecognized key.
    // A mutation swapping `flatten()` for `issues` survived, which is how that
    // was found, and the claim is corrected rather than left standing.
    //
    // What this still pins is real and is about THIS code rather than a
    // library's current behaviour: the rejection names the field and carries
    // no credential, in a body the route builds by hand.
    const res = await request(app("owner"))
      .post("/api/email/accounts")
      .send({ ...BODY, address: "not-an-email" });

    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain(BODY.username);
    // The ADR-042 house shape, so a change away from it is a visible contract
    // change and not a silent one.
    expect(res.body.details).toHaveProperty("fieldErrors");
    expect(body).toContain("address");
  });

  it("🔴 is absent from the audit row", async () => {
    await request(app("owner")).post("/api/email/accounts").send(BODY);
    const call = recordActivityMock.mock.calls[0][0] as Record<string, unknown>;
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(BODY.username);
    // The address IS recorded: it is what the owner typed into a field
    // labelled with it, and an audit row nobody can tie to a mailbox is not
    // an audit row.
    expect(serialized).toContain(BODY.address);
  });
});

describe("🔴 userId is always populated", () => {
  it("passes the acting user through, never a null owner", async () => {
    await request(app("owner")).post("/api/email/accounts").send(BODY);
    // `EmailAccount.userId` is `String?` and was written by NOTHING before
    // this route existed. It is the identity every downstream read scopes by
    // (`assertAccountAccessible`), so an account with a null owner is one
    // every user on the box can see.
    expect(connectMailboxMock.mock.calls[0][2]).toBe("u-owner");
  });

  it("refuses a request it cannot attribute", async () => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = { role: "owner" }; // no id
      next();
    });
    a.use("/api", createEmailRouter({} as never, GATE));

    const res = await request(a).post("/api/email/accounts").send(BODY);
    expect(res.status).toBe(403);
    expect(connectMailboxMock).not.toHaveBeenCalled();
  });
});

describe("🔴 who may connect a mailbox", () => {
  it("admits owner and admin", async () => {
    for (const role of ["owner", "admin"]) {
      const res = await request(app(role)).post("/api/email/accounts").send(BODY);
      expect(res.status, role).toBe(201);
    }
  });

  it("MUTATION: admit family — a household member hands the box a credential", async () => {
    // Connecting a mailbox gives this appliance a password to a third-party
    // account and starts an outbound connection on a schedule. That is an
    // administrative act even when the mailbox is somebody's personal one.
    for (const role of ["family", "guest"]) {
      const res = await request(app(role)).post("/api/email/accounts").send(BODY);
      expect(res.status, role).toBe(403);
    }
    expect(connectMailboxMock).not.toHaveBeenCalled();
  });

  it("guards DELETE the same way", async () => {
    expect((await request(app("family")).delete("/api/email/accounts/acct-1")).status).toBe(403);
    expect((await request(app("owner")).delete("/api/email/accounts/acct-1")).status).toBe(204);
  });
});

describe("every refusal is a state the owner can act on", () => {
  const cases: [string, number][] = [
    [PROVISION_ERRORS.DUPLICATE_ADDRESS, 409],
    // 422 rather than 400: the request was well formed. The mailbox refused
    // it, or the destination is one this box will not dial.
    [PROVISION_ERRORS.MAILBOX_REFUSED, 422],
    [PROVISION_ERRORS.BLOCKED_HOST, 422],
    // 503: the box has no `email` compose profile, so there is no indexer to
    // ask. Named, because "connect failed" would send an owner to their
    // mailbox settings for a problem that is on this appliance.
    [PROVISION_ERRORS.INDEXER_UNAVAILABLE, 503],
  ];

  it.each(cases)("%s answers %i", async (code, status) => {
    connectMailboxMock.mockRejectedValue(new Error(code));
    const res = await request(app("owner")).post("/api/email/accounts").send(BODY);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });

  it("does not leak an unexpected error as a provisioning refusal", async () => {
    connectMailboxMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const res = await request(app("owner")).post("/api/email/accounts").send(BODY);
    // Falls through to the error middleware rather than being echoed as a
    // named refusal — a database address is not something to hand a client.
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
  });
});

describe("🔴 the body is an allow-list", () => {
  it("refuses an unknown key rather than ignoring it", async () => {
    const res = await request(app("owner"))
      .post("/api/email/accounts")
      .send({ ...BODY, passwordEnc: "gAAAAA-attacker-supplied-ciphertext" });
    // `.strict()`. A caller must not be able to smuggle a field past the
    // allow-list and have it reach a create — least of all this one.
    expect(res.status).toBe(400);
    expect(connectMailboxMock).not.toHaveBeenCalled();
  });

  it("refuses a port outside the legal range", async () => {
    for (const port of [0, 65536, -1]) {
      const res = await request(app("owner"))
        .post("/api/email/accounts")
        .send({ ...BODY, imapPort: port });
      expect(res.status, String(port)).toBe(400);
    }
  });
});

describe("disconnecting", () => {
  it("404s an account that is not there, rather than reporting a delete", async () => {
    disconnectMailboxMock.mockResolvedValue({ removed: false, address: null });
    const res = await request(app("owner")).delete("/api/email/accounts/nope");
    expect(res.status).toBe(404);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("records the disconnect as a WARNING, because the mail goes with it", async () => {
    await request(app("owner")).delete("/api/email/accounts/acct-1");
    const call = recordActivityMock.mock.calls[0][0] as { severity: string };
    // EmailThread/EmailMessage/EmailDraft all cascade on accountId. Somebody
    // looking for where their mail went deserves to find this row.
    expect(call.severity).toBe("warn");
  });
});
