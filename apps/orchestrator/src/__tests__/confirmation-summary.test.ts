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
