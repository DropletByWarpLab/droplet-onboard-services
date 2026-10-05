/**
 * WARP-3529 — loop protection, as pure rules.
 *
 * What makes an inbound message one the desk must NOT turn into (part of) a
 * ticket, and the two small parsers threading needs (the `[KEY-123]` subject
 * token and the order a reply's Message-IDs are tried in). No I/O: every rule is
 * an assertion over an object here, and support-email.pg.test.ts proves the same
 * rules end to end against Postgres.
 */
import { describe, it, expect } from "vitest";
import {
  EMAIL_HEADERS_SCHEMA,
  classifyInbound,
  cleanTicketSubject,
  looksAutomatedSender,
  referenceCandidates,
  ticketSubjectFor,
  ticketTokens,
  type EmailHeaders,
} from "./email-headers.js";

const headers = (over: Partial<EmailHeaders> = {}): EmailHeaders => ({
  references: [],
  autoSubmitted: null,
  precedence: null,
  xAutoreply: null,
  xAutorespond: null,
  returnPath: null,
  reportType: null,
  ...over,
});

const OWN = new Set(["support@acme.example", "billing@acme.example"]);

const classify = (over: {
  fromAddr?: string;
  headers?: EmailHeaders | null;
  isOwnOutbound?: boolean;
} = {}) =>
  classifyInbound({
    fromAddr: over.fromAddr ?? "dana@customer.com",
    headers: over.headers === undefined ? headers() : over.headers,
    ownAddresses: OWN,
    isOwnOutbound: over.isOwnOutbound ?? false,
  });

describe("classifyInbound", () => {
  it("lets an ordinary message through, and says the headers were checked", () => {
    expect(classify()).toEqual({ kind: "process", headersChecked: true });
  });

  describe("Auto-Submitted (RFC 3834)", () => {
    it.each(["auto-replied", "auto-generated", "auto-notified", "something-new", ""])(
      "ignores %j",
      (autoSubmitted) => {
        expect(classify({ headers: headers({ autoSubmitted }) })).toEqual({
          kind: "ignore",
          reason: "AUTO_SUBMITTED",
        });
      },
    );

    it("does not ignore `no` — the header a person's client may add", () => {
      expect(classify({ headers: headers({ autoSubmitted: "no" }) }).kind).toBe("process");
    });
  });

  describe("Precedence", () => {
    it.each(["bulk", "junk", "list", "auto_reply"])("ignores %s", (precedence) => {
      expect(classify({ headers: headers({ precedence }) })).toEqual({
        kind: "ignore",
        reason: "PRECEDENCE_BULK",
      });
    });

    it("does not ignore first-class or an unknown value", () => {
      expect(classify({ headers: headers({ precedence: "first-class" }) }).kind).toBe("process");
      expect(classify({ headers: headers({ precedence: "urgent" }) }).kind).toBe("process");
    });
  });

  describe("X-Autoreply / X-Autorespond", () => {
    it("ignores the presence of either, whatever it says", () => {
      for (const over of [
        { xAutoreply: "yes" },
        { xAutoreply: "" },
        { xAutorespond: "vacation" },
        { xAutorespond: "" },
      ]) {
        expect(classify({ headers: headers(over) })).toEqual({
          kind: "ignore",
          reason: "AUTO_REPLY_HEADER",
        });
      }
    });
  });

  describe("bounces", () => {
    it("ignores a null reverse path", () => {
      expect(classify({ headers: headers({ returnPath: "" }) })).toEqual({ kind: "ignore", reason: "BOUNCE" });
    });

    it("ignores a delivery-status report, and a report that names no type", () => {
      for (const reportType of ["delivery-status", "disposition-notification", ""]) {
        expect(classify({ headers: headers({ reportType }) })).toEqual({ kind: "ignore", reason: "BOUNCE" });
      }
    });

    it.each([
      "MAILER-DAEMON@mta.example",
      "postmaster@mta.example",
      "bounce+abc123@service.example",
      "bounces@service.example",
    ])("ignores mail from %s", (fromAddr) => {
      expect(classify({ fromAddr })).toEqual({ kind: "ignore", reason: "BOUNCE" });
    });

    it("ignores a return path that is a mailer-daemon", () => {
      expect(classify({ headers: headers({ returnPath: "mailer-daemon@mta.example" }) })).toEqual({
        kind: "ignore",
        reason: "BOUNCE",
      });
    });

    it("does not mistake a person for one", () => {
      for (const fromAddr of ["daemon@x.com", "mailer@x.com", "dana.postmaster@x.com", "bouncer@x.com"]) {
        expect(classify({ fromAddr }).kind, fromAddr).toBe("process");
      }
      expect(classify({ headers: headers({ returnPath: "dana@customer.com" }) }).kind).toBe("process");
    });

    it("is reported as a bounce even when it is also marked auto-replied (as a DSN is)", () => {
      expect(
        classify({
          fromAddr: "MAILER-DAEMON@mta.example",
          headers: headers({ autoSubmitted: "auto-replied", reportType: "delivery-status" }),
        }),
      ).toEqual({ kind: "ignore", reason: "BOUNCE" });
    });
  });

  describe("the box's own mail", () => {
    it("ignores a sender that is a mailbox this box operates, whatever the case", () => {
      expect(classify({ fromAddr: "Support@ACME.example" })).toEqual({ kind: "ignore", reason: "OWN_ADDRESS" });
      expect(classify({ fromAddr: "billing@acme.example" })).toEqual({ kind: "ignore", reason: "OWN_ADDRESS" });
    });

    it("ignores a message the desk itself sent, even from another address", () => {
      expect(classify({ isOwnOutbound: true })).toEqual({ kind: "ignore", reason: "OWN_MESSAGE" });
    });

    it("reports the box's own address before anything else it says", () => {
      expect(
        classify({
          fromAddr: "support@acme.example",
          headers: headers({ autoSubmitted: "auto-replied", precedence: "bulk" }),
          isOwnOutbound: true,
        }),
      ).toEqual({ kind: "ignore", reason: "OWN_ADDRESS" });
    });
  });

  describe("when the headers were never recorded", () => {
    it("still applies the rules that need no headers", () => {
      expect(classify({ headers: null, fromAddr: "support@acme.example" })).toEqual({
        kind: "ignore",
        reason: "OWN_ADDRESS",
      });
      expect(classify({ headers: null, fromAddr: "mailer-daemon@x.com" })).toEqual({
        kind: "ignore",
        reason: "BOUNCE",
      });
    });

    it("processes the rest, but says the headers could not be checked", () => {
      expect(classify({ headers: null })).toEqual({ kind: "process", headersChecked: false });
    });
  });
});

describe("looksAutomatedSender", () => {
  it.each([
    "noreply@x.com",
    "no-reply@x.com",
    "No_Reply@x.com",
    "do-not-reply@x.com",
    "donotreply@x.com",
    "noreply+tag@x.com",
    "mailer-daemon@x.com",
    "postmaster@x.com",
    "bounces@x.com",
  ])("%s is a robot", (a) => expect(looksAutomatedSender(a)).toBe(true));

  it.each(["dana@x.com", "reply@x.com", "noreplyfan@x.com", "info@x.com"])("%s is not", (a) =>
    expect(looksAutomatedSender(a)).toBe(false),
  );
});

describe("referenceCandidates", () => {
  it("tries In-Reply-To first, then References newest to oldest", () => {
    expect(referenceCandidates("c@x", ["a@x", "b@x", "c@x"])).toEqual(["c@x", "b@x", "a@x"]);
  });

  it("works with References alone, or In-Reply-To alone", () => {
    expect(referenceCandidates(null, ["a@x", "b@x"])).toEqual(["b@x", "a@x"]);
    expect(referenceCandidates("p@x", [])).toEqual(["p@x"]);
    expect(referenceCandidates(null, [])).toEqual([]);
  });

  it("strips brackets, drops blanks and repeats, and is bounded", () => {
    expect(referenceCandidates("<p@x>", [" a@x ", "", "<p@x>", "a@x"])).toEqual(["p@x", "a@x"]);
    const many = Array.from({ length: 500 }, (_, i) => `m${i}@x`);
    expect(referenceCandidates(null, many).length).toBeLessThanOrEqual(120);
    // the root survives the bound: a long thread must still find its first message
    expect(referenceCandidates(null, many)).toContain("m0@x");
  });
});

describe("ticketTokens", () => {
  it("reads every [KEY-123] in a subject, upper-cased, in order", () => {
    expect(ticketTokens("Re: [SUP-12] Printer [sup-3]")).toEqual([
      { identifier: "SUP", sequenceId: 12 },
      { identifier: "SUP", sequenceId: 3 },
    ]);
  });

  it("ignores what is not one", () => {
    for (const s of ["SUP-12", "[SUP-12", "[SUP-]", "[SUP-0]", "[-12]", "[SUP-12x]", "[TOOLONGKEY99-1]", "[SUP-99999999999]", ""]) {
      expect(ticketTokens(s), s).toEqual([]);
    }
  });
});

describe("cleanTicketSubject", () => {
  it.each([
    ["Printer jam", "Printer jam"],
    ["Re: Printer jam", "Printer jam"],
    ["RE: Re: [SUP-12] Printer jam", "Printer jam"],
    ["[SUP-12] Re: Printer jam", "Printer jam"],
    ["Printer [SUP-12] jam", "Printer jam"],
    ["AW: Drucker kaputt", "Drucker kaputt"],
    ["Fwd: Invoice 7", "Fwd: Invoice 7"],
    ["   spaced    out   ", "spaced out"],
    ["", "(no subject)"],
    ["Re: [SUP-1]", "(no subject)"],
  ])("%j -> %j", (input, expected) => expect(cleanTicketSubject(input)).toBe(expected));

  it("never exceeds the 500 characters a ticket title allows, and never splits a character", () => {
    const out = cleanTicketSubject("é".repeat(600) + "😀".repeat(10));
    expect([...out].length).toBeLessThanOrEqual(500);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("drops control characters, so a subject cannot carry a header break", () => {
    expect(cleanTicketSubject("Printer\r\nBcc: x@y.com\tjam")).toBe("Printer Bcc: x@y.com jam");
  });
});

describe("ticketSubjectFor", () => {
  it("puts the key in square brackets after Re: for a reply to a customer's mail", () => {
    expect(ticketSubjectFor("SUP-12", "Printer jam", true)).toBe("Re: [SUP-12] Printer jam");
  });

  it("omits Re: when the desk is the one who started the conversation", () => {
    expect(ticketSubjectFor("SUP-12", "Printer jam", false)).toBe("[SUP-12] Printer jam");
  });

  it("does not stack a prefix or a token on a title that already has them", () => {
    expect(ticketSubjectFor("SUP-12", "Re: [SUP-12] Printer jam", true)).toBe("Re: [SUP-12] Printer jam");
  });

  it("round-trips through ticketTokens", () => {
    expect(ticketTokens(ticketSubjectFor("SUP-12", "Printer jam", true))).toEqual([
      { identifier: "SUP", sequenceId: 12 },
    ]);
  });
});

describe("EMAIL_HEADERS_SCHEMA", () => {
  const good = {
    references: ["a@x.com"],
    autoSubmitted: "no",
    precedence: null,
    xAutoreply: null,
    xAutorespond: null,
    returnPath: "dana@customer.com",
    reportType: null,
  };

  it("accepts what the indexer sends", () => {
    expect(EMAIL_HEADERS_SCHEMA.safeParse(good).success).toBe(true);
  });

  it("is strict: an unknown key is refused, not silently stored", () => {
    expect(EMAIL_HEADERS_SCHEMA.safeParse({ ...good, bcc: "x" }).success).toBe(false);
  });

  it("bounds every field", () => {
    expect(EMAIL_HEADERS_SCHEMA.safeParse({ ...good, references: Array(101).fill("a@x") }).success).toBe(false);
    expect(EMAIL_HEADERS_SCHEMA.safeParse({ ...good, references: ["a".repeat(999)] }).success).toBe(false);
    expect(EMAIL_HEADERS_SCHEMA.safeParse({ ...good, autoSubmitted: "x".repeat(65) }).success).toBe(false);
    expect(EMAIL_HEADERS_SCHEMA.safeParse({ ...good, returnPath: "x".repeat(321) }).success).toBe(false);
  });

  it("requires every key, so a half-recorded object is never mistaken for a checked one", () => {
    const { reportType: _drop, ...partial } = good;
    expect(EMAIL_HEADERS_SCHEMA.safeParse(partial).success).toBe(false);
  });
});
