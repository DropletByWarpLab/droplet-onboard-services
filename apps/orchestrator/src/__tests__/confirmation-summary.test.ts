/**
 * WARP-2469 — the PHI-free argument summary rendered in the chat
 * approval prompt.
 *
 * A user cannot approve what they cannot see, and the chat surface is
 * the one place a confirmation prompt is rendered to a human. But tool
 * arguments routinely carry customer content and, on the ERP/health
 * surfaces, PHI — so the prompt must describe the call without ever
 * reproducing an argument VALUE.
 *
 * Mutation for the whole file: render raw arguments (return `args`
 * verbatim as the summary) → the "no PHI" assertions go red.
 */
import { describe, it, expect } from "vitest";
import {
  summarizeToolArguments,
  CONFIRMATION_SUMMARY_CONTROL_KEYS,
  MAX_SHOWN_LIST_ITEMS,
  MAX_SHOWN_VALUE_CHARS,
} from "../services/confirmation-summary.js";

/** One seeded identity, reused so every assertion names the same leak. */
const SEEDED = {
  email: "camille.moreau@example-clinic.test",
  name: "Camille Moreau",
  mrn: "MRN-88213-XY",
};

describe("summarizeToolArguments — PHI-freedom is a property of the shape", () => {
  it("never reproduces a seeded email, name or record number", () => {
    const summary = summarizeToolArguments("email_send", {
      to: SEEDED.email,
      subject: `Appointment for ${SEEDED.name}`,
      body: `Chart ${SEEDED.mrn} is ready.`,
    });

    const rendered = JSON.stringify(summary);
    expect(rendered).not.toContain(SEEDED.email);
    expect(rendered).not.toContain(SEEDED.name);
    expect(rendered).not.toContain("Moreau");
    expect(rendered).not.toContain(SEEDED.mrn);
  });

  it("still names the tool and every argument key, so the prompt is reviewable", () => {
    const summary = summarizeToolArguments("email_send", {
      to: SEEDED.email,
      subject: "hello",
      body: "hi",
    });
    expect(summary.tool).toBe("email_send");
    expect(summary.fields.map((f) => f.key)).toEqual(["body", "subject", "to"]);
  });

  it("describes each value by kind and size, not by content", () => {
    const summary = summarizeToolArguments("delete_file", {
      path: "/Shared/payroll-2026.xlsx",
      recipients: ["a@x.test", "b@x.test"],
      options: { recurse: true, depth: 2 },
      retries: 3,
      note: null,
    });
    const byKey = Object.fromEntries(summary.fields.map((f) => [f.key, f]));
    expect(byKey.path!.kind).toBe("string");
    expect(byKey.path!.detail).toBe("25 characters");
    expect(byKey.recipients!.kind).toBe("array");
    expect(byKey.recipients!.detail).toBe("2 items");
    expect(byKey.options!.kind).toBe("object");
    expect(byKey.options!.detail).toBe("2 fields");
    expect(byKey.retries!.kind).toBe("number");
    expect(byKey.retries!.detail).toBe("a number");
    expect(byKey.note!.kind).toBe("null");
  });

  it("renders booleans verbatim — two values, no information beyond the key", () => {
    const summary = summarizeToolArguments("t", { dryRun: false, force: true });
    const byKey = Object.fromEntries(summary.fields.map((f) => [f.key, f]));
    expect(byKey.force!.kind).toBe("boolean");
    expect(byKey.force!.value).toBe(true);
    expect(byKey.dryRun!.value).toBe(false);
    // A boolean is the ONLY kind allowed to carry a value.
    expect(
      summarizeToolArguments("t", { s: "secretive" }).fields[0]!.value,
    ).toBeUndefined();
  });

  it("routes values through the audit-scope secret redaction first, so a secret's LENGTH does not leak", () => {
    // `apiKey` is a sensitive KEY name; `redactSecretParams` replaces the
    // value with the fixed placeholder before we ever measure it, so the
    // reported size is the placeholder's, never the secret's.
    const short = summarizeToolArguments("t", { apiKey: "abc" });
    const long = summarizeToolArguments("t", { apiKey: "a".repeat(400) });
    expect(short.fields[0]!.detail).toBe(long.fields[0]!.detail);
    expect(JSON.stringify(long)).not.toContain("aaaa");
  });

  it("omits the `confirmed` control flag — it is protocol, not payload", () => {
    const summary = summarizeToolArguments("t", { path: "/x", confirmed: true });
    expect(summary.fields.map((f) => f.key)).toEqual(["path"]);
    expect(CONFIRMATION_SUMMARY_CONTROL_KEYS).toContain("confirmed");
  });

  it("bounds the field list so a pathological argument object cannot flood the prompt", () => {
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) args[`k${i}`] = i;
    const summary = summarizeToolArguments("t", args);
    expect(summary.fields.length).toBeLessThanOrEqual(24);
    expect(summary.truncatedFields).toBeGreaterThan(0);
  });

  it("handles an empty argument set without inventing fields", () => {
    const summary = summarizeToolArguments("list_devices", {});
    expect(summary.fields).toEqual([]);
    expect(summary.truncatedFields).toBe(0);
  });
});

/**
 * WARP-3569 — the allowlisted, decisive values. Mutation for this block:
 * widen `shown` to every argument (drop the allowlist lookup) → the
 * "stays shape-only" and "never a credential" assertions go red.
 */
describe("summarizeToolArguments — the decisive values (WARP-3569)", () => {
  it("shows who receives a message but not what it says", () => {
    const summary = summarizeToolArguments("team_chat_send_message", {
      recipients: ["camille.moreau@example-clinic.test", "ops"],
      body: "Chart MRN-88213-XY is ready.",
    });
    expect(summary.shown).toEqual([
      { key: "recipients", text: "camille.moreau@example-clinic.test, ops" },
    ]);
    expect(JSON.stringify(summary.shown)).not.toContain("MRN-88213");
    // The shape fields still cover every argument.
    expect(summary.fields.map((f) => f.key)).toEqual(["body", "recipients"]);
  });

  it("shows the path being deleted and the paths being batch-deleted", () => {
    expect(summarizeToolArguments("delete_file", { path: "/Shared/payroll-2026.xlsx" }).shown).toEqual([
      { key: "path", text: "/Shared/payroll-2026.xlsx" },
    ]);
    expect(
      summarizeToolArguments("delete_files", { paths: ["/a.txt", "/b.txt"] }).shown,
    ).toEqual([{ key: "paths", text: "/a.txt, /b.txt" }]);
  });

  it("shows the share target and permission but never the link password", () => {
    const summary = summarizeToolArguments("share_file", {
      path: "/Shared/offer.pdf",
      password: "correct-horse-battery",
      allow_edit: true,
      expires_days: 7,
    });
    expect(summary.shown.map((v) => v.key)).toEqual(["path", "expires_days", "allow_edit"]);
    expect(JSON.stringify(summary)).not.toContain("correct-horse");
  });

  it("shows nothing for a tool with no allowlist entry, however it is spelled", () => {
    for (const tool of ["email_send", "list_files", "constructor", "__proto__", "toString"]) {
      expect(summarizeToolArguments(tool, { path: "/x", to: "a@b.test" }).shown).toEqual([]);
    }
  });

  it("scrubs a secret-shaped value before showing it", () => {
    const summary = summarizeToolArguments("delete_file", {
      path: "see redis://:s3cretPassw0rd@db.local/0",
    });
    expect(JSON.stringify(summary)).not.toContain("s3cretPassw0rd");
  });

  it("strips control and bidirectional characters so a value cannot forge prompt lines", () => {
    const summary = summarizeToolArguments("delete_file", {
      path: "/Shared/a\n\nApproved by admin\u202Egpj.exe\u200B",
    });
    const text = summary.shown[0]!.text;
    expect(text).not.toMatch(/[\u0000-\u001F\u202A-\u202E\u200B]/);
    expect(text).toBe("/Shared/a Approved by admin gpj.exe");
  });

  it("caps a long value and a long list", () => {
    const long = summarizeToolArguments("delete_file", { path: `/${"a".repeat(5000)}` }).shown[0]!.text;
    expect(long.length).toBe(MAX_SHOWN_VALUE_CHARS);
    expect(long.endsWith("…")).toBe(true);

    const many = Array.from({ length: MAX_SHOWN_LIST_ITEMS + 5 }, (_, i) => `u${i}`);
    const list = summarizeToolArguments("delete_files", { paths: many }).shown[0]!.text;
    expect(list).toContain(`u${MAX_SHOWN_LIST_ITEMS - 1}`);
    expect(list).not.toContain(`u${MAX_SHOWN_LIST_ITEMS},`);
    expect(list.endsWith("and 5 more")).toBe(true);
  });

  it("omits an allowlisted key that is absent, empty or an object", () => {
    expect(summarizeToolArguments("delete_file", {}).shown).toEqual([]);
    expect(summarizeToolArguments("delete_file", { path: "  " }).shown).toEqual([]);
    expect(summarizeToolArguments("delete_file", { path: { nested: "/x" } }).shown).toEqual([]);
  });
});
