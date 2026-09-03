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
import {
  descriptorForCatalogId,
  providerDescriptor,
  type ProviderDescriptor,
} from "@droplet/shared-types";
import {
  CONNECTORS,
  connectorMeta,
  connectorCredentialFields,
  connectorSetupGuideHref,
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
    setupGuideHref: "/help/integrations/stripe",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "CRM",
    description: "Contacts, companies, deals and tickets from your CRM — read on request.",
    availability: "available",
    setupGuideHref: "/help/integrations/hubspot",
  },
  {
    id: "mailchimp",
    name: "Mailchimp",
    category: "Marketing",
    description:
      "Audiences, campaign performance and attributed orders — read from Mailchimp.",
    availability: "available",
    setupGuideHref: "/help/integrations/mailchimp",
  },
  {
    // WARP-2296 — the fourth SaaS card, at catalog.order 7.
    id: "shopify",
    name: "Shopify",
    category: "Commerce",
    description: "Orders, catalogue and inventory read straight from your store — never a write.",
    availability: "available",
    setupGuideHref: "/help/integrations/shopify",
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

  it("appends the WARP-2214 vendors, in hub order", () => {
    // Mutation: change a `catalog.order` so a SaaS card lands among the
    // practice cards → red.
    expect(CONNECTORS.slice(CATALOG_BEFORE.length)).toEqual(CATALOG_WARP_2214);
  });

  it("keeps every id inside the ConnectorId union the rest of the hub uses", () => {
    // This is what makes the `as ConnectorId` cast in connectors.ts safe. A
    // descriptor introducing an unlisted card id goes red here instead of rendering
    // a card `useIntegrations` cannot key status onto.
    expect(CONNECTORS.map((c) => c.id).sort()).toEqual([
      "dentrix",
      "eaglesoft",
      "hubspot",
      "mailchimp",
      "opendental",
      "quickbooks",
      "shopify",
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

// ---------------------------------------------------------------------------
// WARP-2342 — the setup guide is part of a cloud card's contract
// ---------------------------------------------------------------------------

describe("the setup guide travels with the card", () => {
  /**
   * The pass-through is real, and a card with no guide carries no key —
   * `{ setupGuideHref: undefined }` would make "no guide declared" and
   * "declared as nothing" indistinguishable, including to the pinned-catalog
   * assertion at the top of this file.
   *
   * Mutation: always emit the key → red, because `"setupGuideHref" in meta`
   * then holds for every card.
   */
  it("omits the key entirely for a card that declares no guide", () => {
    for (const card of CONNECTORS) {
      const declared = descriptorForCatalogId(card.id)?.catalog?.setupGuideHref;
      expect(("setupGuideHref" in card), card.id).toBe(declared !== undefined);
      expect(connectorSetupGuideHref(card.id)).toBe(declared);
    }
  });

  it("has no guide for an id that is not a card", () => {
    expect(connectorSetupGuideHref("not-a-card")).toBeUndefined();
  });

  /**
   * The type-level half: a cloud provider offered on the hub CANNOT ship
   * without a guide link. An SMB owner is being told to go and create a
   * credential in a vendor console we do not control (ADR-042 §2), so an
   * unreachable click-path is the connector being unusable.
   *
   * ⚠ Enforced by `tsc`, NOT by vitest — esbuild strips types, so under vitest
   * the body below is an object literal like any other.
   *
   * Mutation: make `setupGuideHref` optional on the cloud arm and the
   * `@ts-expect-error` becomes UNUSED, which is itself a tsc error ("Unused
   * '@ts-expect-error' directive") — so the mutation goes red in both
   * directions.
   */
  it("makes an available cloud card without a guide a TYPE error", () => {
    // @ts-expect-error -- an `available` cloud card must declare setupGuideHref.
    const bad: ProviderDescriptor = {
      id: "fixture-no-guide",
      displayName: "Fixture No Guide",
      category: "Payments",
      track: "cloud",
      credentialFields: [],
      egressHosts: [],
      datasets: [],
      catalog: {
        id: "fixture-no-guide",
        name: "Fixture No Guide",
        category: "Payments",
        description: "Offered, with nowhere to read about it.",
        availability: "available",
        order: 99,
      },
    };
    expect(bad.catalog?.setupGuideHref).toBeUndefined();
  });

  /**
   * …and a `coming-soon` cloud card is deliberately exempt: it has no connect
   * flow, so there is no moment of use to link from, and requiring a href
   * would mean pointing at a guide nobody has written. Both shipped cloud
   * cards are in exactly that state.
   *
   * Mutation: require the href on every cloud card → this stops compiling.
   */
  it("exempts a coming-soon cloud card", () => {
    const ok: ProviderDescriptor = {
      id: "fixture-later",
      displayName: "Fixture Later",
      category: "Payments",
      track: "cloud",
      credentialFields: [],
      egressHosts: [],
      datasets: [],
      catalog: {
        id: "fixture-later",
        name: "Fixture Later",
        category: "Payments",
        description: "Not offered yet.",
        availability: "coming-soon",
        order: 99,
      },
    };
    expect(ok.catalog?.setupGuideHref).toBeUndefined();

    // WARP-2466 corrected the loop that used to sit here. It read
    //
    //   if (d?.track === "cloud") expect(card.availability).toBe("coming-soon")
    //
    // which asserted that EVERY cloud card is coming-soon. That happened to be
    // true when it was written (QuickBooks was the only cloud card), but it is
    // not the property this test is named for, and it goes red the moment any
    // cloud provider actually ships — which is what registering Stripe,
    // HubSpot and Mailchimp does.
    //
    // The real property, both halves:
    //   • an `available` cloud card MUST carry a guide (the union enforces it
    //     at compile time; this is the runtime witness on shipped data);
    //   • a `coming-soon` cloud card need not.
    // Mutation: drop `setupGuideHref` from any of the three → tsc red AND red
    // here.
    for (const card of CONNECTORS) {
      const d = descriptorForCatalogId(card.id);
      if (d?.track !== "cloud") continue;
      if (card.availability === "available") {
        expect(
          d.catalog?.setupGuideHref,
          `${card.id} is an available cloud card with no setup guide`,
        ).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// WARP-2342 — the setup guide is part of a cloud card's contract
// ---------------------------------------------------------------------------

describe("the setup guide travels with the card", () => {
  /**
   * The pass-through is real, and a card with no guide carries no key —
   * `{ setupGuideHref: undefined }` would make "no guide declared" and
   * "declared as nothing" indistinguishable, including to the pinned-catalog
   * assertion at the top of this file.
   *
   * Mutation: always emit the key → red, because `"setupGuideHref" in meta`
   * then holds for every card.
   */
  it("omits the key entirely for a card that declares no guide", () => {
    for (const card of CONNECTORS) {
      const declared = descriptorForCatalogId(card.id)?.catalog?.setupGuideHref;
      expect(("setupGuideHref" in card), card.id).toBe(declared !== undefined);
      expect(connectorSetupGuideHref(card.id)).toBe(declared);
    }
  });

  it("has no guide for an id that is not a card", () => {
    expect(connectorSetupGuideHref("not-a-card")).toBeUndefined();
  });

  /**
   * The type-level half: a cloud provider offered on the hub CANNOT ship
   * without a guide link. An SMB owner is being told to go and create a
   * credential in a vendor console we do not control (ADR-042 §2), so an
   * unreachable click-path is the connector being unusable.
   *
   * ⚠ Enforced by `tsc`, NOT by vitest — esbuild strips types, so under vitest
   * the body below is an object literal like any other.
   *
   * Mutation: make `setupGuideHref` optional on the cloud arm and the
   * `@ts-expect-error` becomes UNUSED, which is itself a tsc error ("Unused
   * '@ts-expect-error' directive") — so the mutation goes red in both
   * directions.
   */
  it("makes an available cloud card without a guide a TYPE error", () => {
    // @ts-expect-error -- an `available` cloud card must declare setupGuideHref.
    const bad: ProviderDescriptor = {
      id: "fixture-no-guide",
      displayName: "Fixture No Guide",
      category: "Payments",
      track: "cloud",
      credentialFields: [],
      egressHosts: [],
      datasets: [],
      catalog: {
        id: "fixture-no-guide",
        name: "Fixture No Guide",
        category: "Payments",
        description: "Offered, with nowhere to read about it.",
        availability: "available",
        order: 99,
      },
    };
    expect(bad.catalog?.setupGuideHref).toBeUndefined();
  });

  /**
   * …and a `coming-soon` cloud card is deliberately exempt: it has no connect
   * flow, so there is no moment of use to link from, and requiring a href
   * would mean pointing at a guide nobody has written.
   *
   * One fixture of each, because the rule has two sides and only stating both
   * pins it. An earlier version of this test ended by asserting every cloud
   * card in the catalog IS `coming-soon` — true while QuickBooks and Dentrix
   * were the only two, but that is a fact about this week's catalog, not the
   * property the test is named for, and it goes red the moment WARP-2466
   * lands three `available` providers. Found while merging this branch into
   * that one.
   *
   * Mutation: require the href on every cloud card → the `later` fixture
   * stops compiling. Drop the requirement entirely → the `@ts-expect-error`
   * above goes unused, which is itself a tsc error.
   */
  it("requires a guide of an available cloud card, and not of a coming-soon one", () => {
    const later: ProviderDescriptor = {
      id: "fixture-later",
      displayName: "Fixture Later",
      category: "Payments",
      track: "cloud",
      credentialFields: [],
      egressHosts: [],
      datasets: [],
      catalog: {
        id: "fixture-later",
        name: "Fixture Later",
        category: "Payments",
        description: "Not offered yet.",
        availability: "coming-soon",
        order: 99,
      },
    };
    expect(later.catalog?.setupGuideHref).toBeUndefined();

    // The positive half: an `available` cloud card compiles ONLY with the
    // href. The `@ts-expect-error` fixture above is the same rule from the
    // other side.
    const offered: ProviderDescriptor = {
      id: "fixture-offered",
      displayName: "Fixture Offered",
      category: "Payments",
      track: "cloud",
      credentialFields: [],
      egressHosts: [],
      datasets: [],
      catalog: {
        id: "fixture-offered",
        name: "Fixture Offered",
        category: "Payments",
        description: "Offered, with a guide.",
        availability: "available",
        setupGuideHref: "/help/integrations/fixture-offered",
        order: 99,
      },
    };
    expect(offered.catalog?.setupGuideHref).toBe("/help/integrations/fixture-offered");

    // And the property over the SHIPPED catalog — every cloud card that is
    // offered carries a guide. Vacuous today (both cloud cards are
    // coming-soon) and load-bearing the moment WARP-2466 lands.
    for (const card of CONNECTORS) {
      const descriptor = descriptorForCatalogId(card.id);
      if (descriptor?.track !== "cloud") continue;
      if (card.availability !== "available") continue;
      expect(card.setupGuideHref, `${card.id} is offered with no setup guide`).toBeTruthy();
    }
  });
});
