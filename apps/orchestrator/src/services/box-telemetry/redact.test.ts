/**
 * WARP-3504 (ADR-068) — box-side redaction of a log message: emails, IPv4/IPv6,
 * MACs, paths, URLs, host and file names, quoted fragments and long tokens are
 * masked; secrets go through the existing scrub; the cut to 500 comes last.
 */
import { describe, it, expect } from "vitest";
import { redactMessage } from "./redact.js";

describe("redactMessage", () => {
  it.each([
    ["email", "could not mail jane.doe+billing@acme-dental.example today", /jane|acme/, "[email]"],
    ["IPv4", "peer 192.168.20.14 refused the connection", /192\.168/, "[ip]"],
    ["IPv6 with ::", "peer fe80::1ff:fe23:4567:890a refused", /fe80/, "[ip]"],
    ["IPv6 loopback", "listen on ::1 failed", /::1/, "[ip]"],
    ["IPv6 full form", "peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 refused", /2001/, "[ip]"],
    ["MAC with colons", "device aa:bb:cc:dd:ee:ff left", /aa:bb/i, "[mac]"],
    ["MAC with dashes", "device AA-BB-CC-DD-EE-FF left", /AA-BB/, "[mac]"],
    ["POSIX path", "cannot read /srv/files/Finance/Q3 budget.xlsx", /srv|Finance|Q3/, "[path]"],
    ["Windows path", "cannot read C:\\Users\\jane\\Documents\\plan.docx", /Users|jane|plan/, "[path]"],
    ["URL", "GET https://files.acme-dental.example/share/abc123 failed", /acme|abc123/, "[url]"],
    ["host name", "lookup of nas.acme-dental.example failed", /acme|nas\./, "[host]"],
    ["file name", "indexing Patient-List.xlsx failed", /Patient/, "[host]"],
    ["token", "bad credential 9f8e7d6c5b4a39281706f5e4d3c2b1a0 rejected", /9f8e7d6c/, "[token]"],
    ["UUID", "no such user 3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e", /3f2b8c1e/, "[token]"],
  ])("masks a %s", (_name, input, leaked, mask) => {
    const out = redactMessage(input);
    expect(out).not.toMatch(leaked);
    expect(out).toContain(mask);
  });

  it("masks a quoted fragment, the usual way a name lands in a message", () => {
    const out = redactMessage(`could not open "Camille Moreau - lease.pdf" and 'Q3 plan' and \`notes\``);
    expect(out).not.toMatch(/Camille|lease|Q3|notes/);
  });

  it("keeps an ordinary message readable", () => {
    expect(redactMessage("cron handler threw unexpected error")).toBe("cron handler threw unexpected error");
    expect(redactMessage("retrying in 30 seconds (attempt 2 of 5)")).toBe("retrying in 30 seconds (attempt 2 of 5)");
    expect(redactMessage("the user didn't confirm")).toBe("the user didn't confirm");
  });

  it("does not mistake a clock time for an address", () => {
    expect(redactMessage("started at 12:30:45 sharp")).toBe("started at 12:30:45 sharp");
  });

  it("runs the existing secret scrub first", () => {
    const out = redactMessage("upstream said Authorization: Bearer abc.def.ghi and password=hunter2hunter2");
    expect(out).not.toMatch(/abc\.def|hunter2/);
    expect(out).toContain("[REDACTED]");
  });

  it("masks every shape in one message", () => {
    const out = redactMessage(
      "sync for jane@acme.example at 10.0.0.9 / aa:bb:cc:dd:ee:ff wrote /data/x/y.pdf via https://h.example/p?t=1",
    );
    expect(out).not.toMatch(/jane|acme|10\.0\.0\.9|aa:bb|\/data|y\.pdf|h\.example/);
  });

  it("collapses control characters and whitespace", () => {
    expect(redactMessage("line one\n\tline   two\u0000end")).toBe("line one line two end");
  });

  it("cuts to 500 characters AFTER masking, so a mask is never what gets cut", () => {
    const out = redactMessage(`${"word ".repeat(200)} tail jane@acme.example`);
    expect(out.length).toBeLessThanOrEqual(500);
    // 508 characters in, 498 out: cut first, the address would be left as "jane@acm".
    const masked = redactMessage(`${"w".repeat(490)} jane@acme.example`);
    expect(masked).not.toMatch(/jane|acme/);
    expect(masked.endsWith("[email]")).toBe(true);
  });

  it("is idempotent over its own output", () => {
    const once = redactMessage("mail jane@acme.example from 10.0.0.9 for /srv/a/b.pdf at https://x.example/y");
    expect(redactMessage(once)).toBe(once);
  });

  it("is bounded: a hostile 1 MB message is handled and cut", () => {
    const started = Date.now();
    const out = redactMessage("a:".repeat(500_000));
    expect(out.length).toBeLessThanOrEqual(500);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
