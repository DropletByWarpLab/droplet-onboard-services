/**
 * WARP-3375 — the Disconnect copy is derived from the SAME dataset lists the
 * box copies with, for every registered provider.
 */
import { describe, it, expect } from "vitest";
import { providerDescriptors, landedRecords } from "@droplet/shared-types";

import { disconnectCopy } from "../disconnect-copy";

describe("disconnectCopy over every registered provider", () => {
  const all = providerDescriptors();

  it("has providers to check", () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it.each(all.map((d) => [d.id, d] as const))("%s", (_id, d) => {
    const copy = disconnectCopy("Vendor", landedRecords(d));

    expect(copy.intro).toContain("removes the stored credential");
    expect(copy.intro).toContain("the key is not revoked there");
    expect(JSON.stringify(copy).toLowerCase()).not.toContain("untouched");

    const landed = landedRecords(d);
    const copies = landed.crm.length + landed.ledger.length > 0;
    expect(copy.copiesNothing).toBe(!copies);
    // A choice is offered exactly when something was copied, and each option
    // then says what it does — never an empty radio.
    expect(copy.keep === "").toBe(!copies);
    expect(copy.remove === "").toBe(!copies);
    expect(copy.confirmDeleteTitle === "").toBe(!copies);
    // The archive caveat belongs to CRM rows only (a ledger row carries no note).
    expect(copy.remove.includes("archived")).toBe(landed.crm.length > 0);
  });
});
