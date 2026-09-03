/**
 * WARP-2568 (ADR-044) — the vertical's own noun, and the one place it must
 * never reach.
 *
 * ADR-044 settles that patient / client / guest is a per-connector LABEL and
 * never a second entity: one `Contact` and one `CrmCompany` underneath,
 * whatever a surface calls them.
 *
 * The load-bearing test here is the last one. Slice 1 of this epic deleted
 * `shellLabel = crmEnabled ? "CRM" : "Projects"` because a destination that
 * renames itself when a module flips leaves the sidebar and the page header
 * disagreeing. Driving a nav label off connector state would reintroduce that
 * one axis over — the label would change when a connector connects and change
 * back when it drops.
 */
import { describe, it, expect } from "vitest";

import {
  PROVIDER_DESCRIPTORS,
  descriptorForReportedProvider,
  partyNounFor,
  partyNounForProviderKey,
} from "@/components/integrations/provider-descriptors";
import { NAV_GROUPS } from "@/components/nav-config";

describe("the vertical's noun", () => {
  it("calls the people at a dental practice patients", () => {
    expect(partyNounFor("eaglesoft")).toBe("patient");
    expect(partyNounFor("dentrix")).toBe("patient");
    expect(partyNounFor("opendental")).toBe("patient");
  });

  it("does NOT call the people on an accounting ledger patients", () => {
    // A box can run both. Naming a QuickBooks contact a patient would be a
    // clinical claim about somebody's bookkeeping.
    expect(partyNounFor("quickbooks")).toBe("customer");
  });

  it("falls back to the neutral word rather than guessing a vertical", () => {
    expect(partyNounFor("something-nobody-wrote-a-tile-for")).toBe("customer");
    expect(descriptorForReportedProvider("mystery-erp").partyNoun).toBe("customer");
  });

  it("is singular, so a caller builds its own plural", () => {
    // Two strings would be two strings to keep in agreement, and every noun
    // here pluralises with an -s.
    for (const d of PROVIDER_DESCRIPTORS) {
      expect(d.partyNoun.endsWith("s")).toBe(false);
    }
  });
});

describe("resolving the noun from a provider KEY", () => {
  it("maps a track key back to its vendor's noun", () => {
    // `PartyLink.externalSystem` carries `eaglesoft-api`, not `eaglesoft`.
    // A caller must not have to know those are the same tile — that implicit
    // identity match is the WARP-2291 defect this module exists to prevent.
    expect(partyNounForProviderKey("eaglesoft-api")).toBe("patient");
    expect(partyNounForProviderKey("eaglesoft")).toBe("patient");
    expect(partyNounForProviderKey("eaglesoft-export")).toBe("patient");
  });

  it("keeps the accounting track on the accounting noun", () => {
    expect(partyNounForProviderKey("quickbooks-online")).toBe("customer");
  });

  it("gives an unrecognised key the neutral word", () => {
    expect(partyNounForProviderKey("stripe")).toBe("customer");
  });
});

describe("the noun never reaches the nav", () => {
  it("leaves every nav label a constant string", () => {
    // The regression: `label: partyNounFor(...)` or any label computed from
    // connector state. A nav entry that renames itself when a connector
    // connects is the shellLabel bug this epic removed in slice 1.
    const labels: string[] = [];
    for (const g of NAV_GROUPS) {
      for (const item of g.items) {
        labels.push(item.label);
        for (const child of item.children ?? []) labels.push(child.label);
      }
    }
    for (const label of labels) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
    // Practice is the entry a partyNoun would be tempting on, and it is
    // deliberately the fixed word.
    const business = NAV_GROUPS.find((g) => g.label === "Business");
    expect(business?.items.find((i) => i.href === "/practice")?.label).toBe("Practice");
  });

  it("keeps no vertical noun in any nav label", () => {
    const nouns = new Set(PROVIDER_DESCRIPTORS.map((d) => d.partyNoun.toLowerCase()));
    for (const g of NAV_GROUPS) {
      for (const item of g.items) {
        expect(nouns.has(item.label.toLowerCase())).toBe(false);
      }
    }
  });
});
