/**
 * WARP-851 — device-domain 502 mapping.
 *
 * The orchestrator translates matter.js's discovery failure ("No device
 * discovered using identifier {…}!") into a 502 with curated copy.
 * `translateError` never surfaces `err.message` verbatim (by design),
 * so without a "502" entry in the device domain the curated copy was
 * flattened to the generic device fallback. The status-based dispatch
 * (documented order: code → status → message-infer → fallback) must
 * map a device-domain 502 onto the network-discovery copy.
 */
import { describe, it, expect, vi } from "vitest";

import { translateError } from "./friendly-errors";

// Silence the operator breadcrumb.
vi.spyOn(console, "error").mockImplementation(() => {});

describe("translateError device domain (WARP-851)", () => {
  it("maps a 502 commissioning failure to the network-discovery copy", () => {
    const err = Object.assign(
      new Error(
        "Couldn't find the device on the network. Make sure it's powered on, in pairing mode, and on the same Wi-Fi as the Droplet.",
      ),
      { status: 502 },
    );
    const copy = translateError(err, "device");
    expect(copy).toMatch(/couldn't find the device on the network/i);
    expect(copy).toMatch(/powered on/i);
    expect(copy).toMatch(/pairing mode/i);
  });

  it("never surfaces factory-reset advice for the 502 case", () => {
    const err = Object.assign(new Error("upstream discovery failed"), {
      status: 502,
    });
    expect(translateError(err, "device")).not.toMatch(/factory[- ]reset/i);
  });
});

/**
 * WARP-856 (item 1) — the 504 and 503 siblings of the 502 above.
 *
 * 504: the orchestrator's curated timeout copy ("Put it into pairing mode
 * again…") reached the client with err.status = 504, but with no "504"
 * device entry — and `inferCodeFromMessage` only matching /timeout|timed
 * out/, which that copy doesn't contain — the actionable step flattened to
 * the generic device fallback.
 *
 * 503: "Matter controller not started" is service jargon; the customer gets
 * a calm still-starting line instead.
 */
describe("translateError device domain — 504/503 commissioning copy (WARP-856)", () => {
  it("maps a 504 commissioning timeout to the pairing-mode retry copy", () => {
    const err = Object.assign(
      new Error(
        "Couldn't reach the device in time. Put it into pairing mode again, make sure it's within a few feet of the Droplet, and retry.",
      ),
      { status: 504 },
    );
    const copy = translateError(err, "device");
    expect(copy).toMatch(/pairing mode again/i);
    expect(copy).toMatch(/within a few feet/i);
  });

  it("maps the 503 controller-not-started answer to calm still-starting copy", () => {
    const err = Object.assign(new Error("Matter controller not started"), {
      status: 503,
    });
    const copy = translateError(err, "device");
    expect(copy).toMatch(/starting up/i);
    expect(copy).not.toMatch(/matter controller/i);
  });
});
