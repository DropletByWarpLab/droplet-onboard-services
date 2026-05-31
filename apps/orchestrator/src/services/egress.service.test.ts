import { describe, it, expect } from "vitest";
import { computeDesiredEgress } from "./egress.service.js";

const inGroup = { groups: [{ blockPhoneHome: true }] };
const notInGroup = { groups: [{ blockPhoneHome: false }] };
const noGroups = { groups: [] };

describe("computeDesiredEgress", () => {
  it("yields to a full block regardless of master/group", () => {
    expect(
      computeDesiredEgress({ masterEnabled: true, device: inGroup, fullBlocked: true }),
    ).toBe("full_blocked");
    expect(
      computeDesiredEgress({ masterEnabled: false, device: inGroup, fullBlocked: true }),
    ).toBe("full_blocked");
  });

  it("is open when the master toggle is off", () => {
    expect(
      computeDesiredEgress({ masterEnabled: false, device: inGroup, fullBlocked: false }),
    ).toBe("open");
  });

  it("blocks phone-home when master is on and the device is in a blockPhoneHome group", () => {
    expect(
      computeDesiredEgress({ masterEnabled: true, device: inGroup, fullBlocked: false }),
    ).toBe("phone_home_blocked");
  });

  it("is open when master is on but no group blocks phone-home", () => {
    expect(
      computeDesiredEgress({ masterEnabled: true, device: notInGroup, fullBlocked: false }),
    ).toBe("open");
    expect(
      computeDesiredEgress({ masterEnabled: true, device: noGroups, fullBlocked: false }),
    ).toBe("open");
  });

  it("blocks when the device is in ANY blockPhoneHome group", () => {
    expect(
      computeDesiredEgress({
        masterEnabled: true,
        device: { groups: [{ blockPhoneHome: false }, { blockPhoneHome: true }] },
        fullBlocked: false,
      }),
    ).toBe("phone_home_blocked");
  });
});
