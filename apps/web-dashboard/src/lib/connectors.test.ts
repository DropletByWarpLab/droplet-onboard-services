/**
 * WARP-2217 — the hub catalog is DERIVED, not hand-listed.
 *
 * Two things are being proved here, and they pull in opposite directions:
 *
 *  1. The derivation is real — the cards and their credential fields come off
 *    the shared descriptors, so hard-coding either back into `connectors.ts`
 *    goes red.
 *  2. The derivation changed NOTHING the user sees. The four cards, their ids,
 *    copy, categories, availability and order are pinned against the literals
 *    this file shipped before the refactor. This story owns `connectors.ts`;
 *    the hub page and `useIntegrations` are WARP-2291's, and a silent copy or
 *    ordering change here would land in their surface.
 */
import { describe, it, expect } from "vitest";
import { descriptorForCatalogId, providerDescriptor } from "@droplet/shared-types";
import {
  CONNECTORS,
  connectorMeta,
  connectorCredentialFields,
  providerKeyForConnector,
} from "./connectors";

/**
 * The catalog EXACTLY as `connectors.ts` hand-declared it on `origin/stage`
 * before this change — copied out of the pre-change file, not regenerated.
 * A derivation checked against a regenerated expectation proves nothing.
 */
const CATALOG_BEFORE = [
  {
    id: "eaglesoft",
    name: "Eaglesoft",
    category: "Practice management",
    description:
      "Read your schedule, patients, and balances — directly from Eaglesoft, on your network.",
    availability: "available",
  },
  {
    id: "dentrix",
    name: "Dentrix",
    category: "Practice management",
    description: "Schedule, patients, and ledgers from Dentrix — read on your own network.",
    availability: "coming-soon",
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    category: "Accounting",
    description:
      "Production, receivables, and deposits from your books — no export, no upload.",
    availability: "coming-soon",
  },
  {
    id: "opendental",
    name: "Open Dental",
    category: "Practice management",
    description:
      "Read the schedule and patient records straight from your Open Dental database.",
    availability: "coming-soon",
  },
];

/**
 * WARP-2466 — the three WARP-2214 SaaS vendors, appended after the historical
 * four. Kept separate from `CATALOG_BEFORE` for the same reason the
 * orchestrator's descriptor test keeps its `_BEFORE` anchors separate: that
 * list is a record of what shipped before the refactor, and folding new cards
 * into it turns a regression anchor into a running total.
 */
const CATALOG_WARP_2214 = [
  {
    id: "stripe",
    name: "Stripe",
    category: "Payments",
    description:
      "Payments, refunds and payouts read straight from Stripe — never money movement.",
    availability: "available",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "CRM",
    description: "Contacts, companies, deals and tickets from your CRM — read on request.",
    availability: "available",
  },
  {
    id: "mailchimp",
    name: "Mailchimp",
    category: "Marketing",
    description:
      "Audiences, campaign performance and attributed orders — read from Mailchimp.",
    availability: "available",
  },
];

describe("the derived catalog is byte-identical to the hand-written one", () => {
  it("still renders the original four cards first, same copy, same order", () => {
    // Order is part of it: the Claude Design handoff is Eaglesoft · Dentrix ·
    // QuickBooks · Open Dental, and the hub renders CONNECTORS in array order.
    // Asserted as a PREFIX so the pre-change surface stays pinned exactly while
    // new cards can only ever be appended.
    // Mutation: reorder the descriptors or edit a card's copy → red.
    expect(CONNECTORS.slice(0, CATALOG_BEFORE.length)).toEqual(CATALOG_BEFORE);
  });

  it("appends the three WARP-2214 vendors, in hub order", () => {
    // Mutation: change a `catalog.order` so a SaaS card lands among the
    // practice cards → red.
    expect(CONNECTORS.slice(CATALOG_BEFORE.length)).toEqual(CATALOG_WARP_2214);
  });

  it("keeps every id inside the ConnectorId union the rest of the hub uses", () => {
    // This is what makes the `as ConnectorId` cast in connectors.ts safe. A
    // descriptor introducing a fifth card id goes red here instead of rendering
    // a card `useIntegrations` cannot key status onto.
    expect(CONNECTORS.map((c) => c.id).sort()).toEqual([
      "dentrix",
      "eaglesoft",
      "hubspot",
      "mailchimp",
      "opendental",
      "quickbooks",
      "stripe",
    ]);
  });

  it("still answers connectorMeta by id", () => {
    expect(connectorMeta("eaglesoft")?.name).toBe("Eaglesoft");
    expect(connectorMeta("nope")).toBeUndefined();
  });

  it("shows ONE Eaglesoft card even though two tracks serve it", () => {
    // `eaglesoft` (direct SQL) and `eaglesoft-api` (Patterson REST) are two
    // descriptors. Two cards for two transports of one vendor would be a
    // question no practice owner can answer.
    expect(CONNECTORS.filter((c) => c.id === "eaglesoft")).toHaveLength(1);
    expect(providerDescriptor("eaglesoft-api")?.catalog).toBeUndefined();
  });
});

describe("credential fields come from the shared descriptor, not from this file", () => {
  it("returns the descriptor's own field list by IDENTITY", () => {
    // Identity, not deep equality: hard-coding an equivalent array back into
    // connectors.ts would still deep-equal, and would still be the divergence
    // this ticket exists to remove. Mutation: return a literal copy → red.
    const fromDescriptor = descriptorForCatalogId("quickbooks")?.credentialFields;
    expect(connectorCredentialFields("quickbooks")).toBe(fromDescriptor);
  });

  it("gives the QuickBooks form the fields the orchestrator actually validates", () => {
    const fields = connectorCredentialFields("quickbooks");
    expect(fields.map((f) => f.name)).toEqual(["realmId", "baseUrl", "callCeiling"]);

    const realmId = fields.find((f) => f.name === "realmId");
    expect(realmId?.required).toBe(true);
    expect(realmId?.label).toBeTruthy();
    // Mutation: flip `realmId.required` to false in the descriptor and this
    // goes red — the SAME mutation that turns the orchestrator's
    // missing-identifier rejection row red in the equivalence table. One
    // definition, two apps, one mutation.
  });

  it("maps a hub card to the provider key a connection row persists", () => {
    expect(providerKeyForConnector("quickbooks")).toBe("quickbooks-online");
    expect(providerKeyForConnector("dentrix")).toBe("dentrix-ascend");
    expect(providerKeyForConnector("eaglesoft")).toBe("eaglesoft");
  });

  it("has no provider key and no fields for a placeholder card", () => {
    // Open Dental is a card with no shipped track. Absence is explicit
    // (`track: "catalog"`), never inferred from an empty field list.
    expect(providerKeyForConnector("opendental")).toBeUndefined();
    expect(connectorCredentialFields("opendental")).toEqual([]);
    expect(connectorCredentialFields("not-a-card")).toEqual([]);
  });

  it("never exposes a secret VALUE — only the shape of the field", () => {
    // A descriptor describes what to ask for; it must never carry what was
    // answered.
    //
    // WARP-2466 fixed a real bug in this assertion. It was
    // `/password|token|secret["']?\s*:\s*["'][^"']/i`, and JS alternation
    // binds looser than concatenation — so it read as `password` OR `token` OR
    // `secret:"…"`, and fired on the bare word "token" ANYWHERE. That is not
    // what the comment above claims it checks: it made a field NAMED
    // `accessToken`, or a help string containing the word "token",
    // indistinguishable from a leaked value. The group is now explicit.
    const serialised = JSON.stringify(
      CONNECTORS.map((c) => connectorCredentialFields(c.id)),
    );
    // Mutation: add `value: "hunter2"` to any descriptor field → red.
    expect(serialised).not.toMatch(/(password|token|secret)["']?\s*:\s*["'][^"']/i);

    // Stronger than a regex, and the assertion the comment actually wants: a
    // field object may carry ONLY the declared shape keys. A value smuggled
    // under any name at all — not just one the regex thought to look for —
    // fails here.
    // Mutation: add any key to a descriptor's credential field → red.
    const allowed = new Set([
      "name",
      "label",
      "type",
      "required",
      "secret",
      "storage",
      "pattern",
      "help",
    ]);
    for (const c of CONNECTORS) {
      for (const field of connectorCredentialFields(c.id)) {
        const extra = Object.keys(field).filter((k) => !allowed.has(k));
        expect(extra, `${c.id}.${field.name} carries non-shape keys`).toEqual([]);
      }
    }
  });
});
