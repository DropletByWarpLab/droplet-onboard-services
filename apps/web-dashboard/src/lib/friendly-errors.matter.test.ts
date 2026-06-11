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
