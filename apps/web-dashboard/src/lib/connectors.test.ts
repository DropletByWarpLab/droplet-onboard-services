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

describe("the derived catalog is byte-identical to the hand-written one", () => {
  it("renders the same four cards, same copy, same order", () => {
    // Order is part of it: the Claude Design handoff is Eaglesoft · Dentrix ·
    // QuickBooks · Open Dental, and the hub renders CONNECTORS in array order.
    expect(CONNECTORS).toEqual(CATALOG_BEFORE);
  });

  it("keeps every id inside the ConnectorId union the rest of the hub uses", () => {
    // This is what makes the `as ConnectorId` cast in connectors.ts safe. A
    // descriptor introducing a fifth card id goes red here instead of rendering
    // a card `useIntegrations` cannot key status onto.
    expect(CONNECTORS.map((c) => c.id).sort()).toEqual([
      "dentrix",
      "eaglesoft",
      "opendental",
      "quickbooks",
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
    // answered. Serialising the whole catalog is the cheapest way to assert it.
    const serialised = JSON.stringify(
      CONNECTORS.map((c) => connectorCredentialFields(c.id)),
    );
    expect(serialised).not.toMatch(/password|token|secret["']?\s*:\s*["'][^"']/i);
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
    for (const card of CONNECTORS) {
      const d = descriptorForCatalogId(card.id);
      if (d?.track === "cloud") expect(card.availability).toBe("coming-soon");
    }
  });
});
