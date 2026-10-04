import { describe, expect, it } from "vitest";

import { landedRecords } from "./landed-records";
import { providerDescriptor } from "./provider-registry";

const NOTHING = { crm: [], ledger: [] };
const CRM3 = ["company", "contact", "deal"];

describe("landedRecords", () => {
  it.each([
    ["hubspot", { crm: CRM3, ledger: [] }],
    ["pipedrive", { crm: CRM3, ledger: [] }],
    ["brevo", { crm: CRM3, ledger: [] }],
    // Contacts only — a company or a deal from these is not copied.
    ["klaviyo", { crm: ["contact"], ledger: [] }],
    // Xero lands its contacts AND its invoices and bills.
    ["xero", { crm: ["contact"], ledger: ["invoice", "bill"] }],
    ["quickbooks-online", { crm: [], ledger: ["invoice", "bill"] }],
    // Stripe's charges are not landed; its invoices are.
    ["stripe", { crm: [], ledger: ["invoice"] }],
    // Polled and discarded today, or read through on demand: nothing is copied.
    ["mailchimp", NOTHING],
    ["shopify", NOTHING],
    ["loyverse", NOTHING],
    ["square", NOTHING],
    ["calcom", NOTHING],
    ["github", NOTHING],
    ["gitlab", NOTHING],
    ["todoist", NOTHING],
    // WARP-3697 — charge / refund / payout: read on demand, never polled, never landed.
    ["gocardless", NOTHING],
    // PHI is read-through, whatever the track.
    ["eaglesoft", NOTHING],
    ["dentrix-ascend", NOTHING],
    ["atlassian", NOTHING],
  ])("%s", (id, expected) => {
    // Mutation: add "company" to any provider's datasets and its row here must
    // change with it; drop the track guard and a LAN ledger would read as landed.
    expect(providerDescriptor(id), `${id} must be a registered provider`).toBeDefined();
    expect(landedRecords(providerDescriptor(id))).toEqual(expected);
  });

  it("lands nothing for a provider with no descriptor", () => {
    expect(landedRecords(undefined)).toEqual(NOTHING);
  });
});
