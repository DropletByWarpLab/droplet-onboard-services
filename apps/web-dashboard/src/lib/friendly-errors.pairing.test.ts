/**
 * WARP-1150/1151 — pairing-domain (create-a-pairing-session) copy.
 *
 * Bug: PairDialog's Generate-code step translated failures through the
 * "device" domain, whose fallback is "We couldn't reach that device right
 * now…" — nonsense at code-generation time, when there is no device to
 * reach yet (the observed repro: the on-box module gate 404'd
 * POST /api/devices/pair with {"error":"module_disabled"} and the dialog
 * rendered reach-device copy).
 *
 * Contract pinned here: NO create-session failure — any status, code, or
 * message shape — may ever render reach-device copy through the "pairing"
 * domain. Reach-device copy stays reserved for the post-code handshake
 * surfaces that translate through "device".
 */
import { describe, it, expect, vi } from "vitest";

import { translateError } from "./friendly-errors";

// Silence the operator breadcrumb.
vi.spyOn(console, "error").mockImplementation(() => {});

/** The forbidden step-inappropriate copy (device-domain fallback family). */
const REACH_DEVICE = /reach that device/i;

/** Every failure shape a create-session call can realistically throw. */
const CREATE_SESSION_FAILURES: [label: string, err: unknown][] = [
  // The WARP-1150 on-box repro: module gate 404s with a machine token.
  [
    "module_disabled 404 (module gate)",
    Object.assign(new Error("module_disabled"), {
      status: 404,
      code: "module_disabled",
    }),
  ],
  ["plain 404 (route absent)", Object.assign(new Error("Not found"), { status: 404 })],
  [
    "429 rate limited",
    Object.assign(
      new Error("Too many pairing codes generated. Try again in an hour."),
      { status: 429, code: "Too many pairing codes generated. Try again in an hour." },
    ),
  ],
  ["400 validation", Object.assign(new Error("Invalid pair request"), { status: 400 })],
  ["500 internal", Object.assign(new Error("internal"), { status: 500 })],
  [
    "503 allocation exhausted",
    Object.assign(new Error("Couldn't allocate a pairing code. Try again."), {
      status: 503,
    }),
  ],
  ["502 upstream", Object.assign(new Error("bad gateway"), { status: 502 })],
  ["fetch-level network failure", new TypeError("Failed to fetch")],
  ["timeout", new Error("request timed out")],
  ["no status, no code", new Error("Failed to generate pairing code: 500")],
  ["empty object", {}],
  ["null", null],
  ["undefined", undefined],
  ["string throw", "boom"],
];

describe("translateError pairing domain (WARP-1150/1151)", () => {
  it("NEVER renders the reach-device copy for any create-session failure", () => {
    for (const [label, err] of CREATE_SESSION_FAILURES) {
      const copy = translateError(err, "pairing");
      expect(copy, label).not.toMatch(REACH_DEVICE);
      expect(copy, label).not.toMatch(/powered on and nearby/i);
    }
  });

  it("falls back to retryable create-session copy for unknown failures", () => {
    const copy = translateError(new Error("internal"), "pairing");
    expect(copy).toMatch(/couldn't create a pairing code/i);
    expect(copy).toMatch(/try again/i);
  });

  it("maps the module-gate 404 (the WARP-1150 on-box cause) to pairing-disabled copy", () => {
    const copy = translateError(
      Object.assign(new Error("module_disabled"), {
        status: 404,
        code: "module_disabled",
      }),
      "pairing",
    );
    expect(copy).toMatch(/pairing is turned off/i);
    expect(copy).toMatch(/admin/i);
  });

  it("maps a plain 404 to pairing-unavailable copy, not device copy", () => {
    const copy = translateError(
      Object.assign(new Error("Not found"), { status: 404 }),
      "pairing",
    );
    expect(copy).toMatch(/pairing isn't available/i);
  });

  it("maps the create route's 429 to wait-a-while copy", () => {
    const copy = translateError(
      Object.assign(new Error("Too many pairing codes generated."), { status: 429 }),
      "pairing",
    );
    expect(copy).toMatch(/too many pairing codes/i);
    expect(copy).toMatch(/wait/i);
  });

  it("never echoes err.message verbatim", () => {
    const secret = "SECRET_INTERNAL_DETAIL_DO_NOT_LEAK";
    const copy = translateError(new Error(secret), "pairing");
    expect(copy).not.toContain(secret);
  });

  it("keeps reach-device copy available to the post-code handshake (device domain)", () => {
    // Guard the reservation the other way: the device domain still owns the
    // reach-device fallback for the step that actually talks to a device.
    const copy = translateError(new Error("unknown"), "device");
    expect(copy).toMatch(REACH_DEVICE);
  });
});
