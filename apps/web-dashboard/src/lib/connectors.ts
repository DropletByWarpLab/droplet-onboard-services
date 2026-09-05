/**
 * The connector catalog for the Integrations hub (WARP-1101), DERIVED from the
 * shared provider descriptors (WARP-2217).
 *
 * This file used to hand-maintain its own list of providers — the fourth of the
 * four independent sites a new vendor had to edit, and the only one in a
 * different app from the other three. Its idea of a provider was structurally
 * unrelated to the orchestrator's: it had display copy and no credential
 * fields, while `erp-provider.ts` had credential validation and no display
 * copy, so the two could not even be compared, let alone kept in agreement.
 *
 * Both now read `@droplet/shared-types`. Adding a vendor adds a card here for
 * free, and — more to the point — the credential fields this hub's forms
 * collect are the SAME objects the orchestrator validates against.
 *
 * Two vocabularies meet here, and the difference is deliberate:
 *  • a DESCRIPTOR id is a track (`eaglesoft`, `eaglesoft-api`,
 *    `quickbooks-online`), which is what a connection row persists;
 *  • a CATALOG id is a vendor card (`eaglesoft`, `quickbooks`), which is what a
 *    practice owner recognises and what the hub keys live status on.
 * Several tracks can sit behind one card, so the mapping is many-to-one and is
 * declared on the descriptor rather than guessed here.
 *
 * Live connection *status* is still merged in from the backend
 * (GET /api/integrations) by useIntegrations — this file remains descriptive
 * metadata only.
 */

import {
  catalogDescriptors,
  descriptorForCatalogId,
  providerDescriptors,
  setupGuideHrefFor,
  type CredentialFieldDef,
  type ProviderDescriptor,
} from "@droplet/shared-types";
import type { ConnectorId, ConnectorMeta } from "./erp-types";

/**
 * The hub card a descriptor contributes, or `undefined` for one that puts no
 * tile on the hub.
 *
 * EXHAUSTIVE over `ProviderTrack`, and the `never` assignment is the point
 * (WARP-2659): a fifth track cannot compile until its author says where its
 * card comes from — or that it has none. There is no `Record<ConnectorId, …>`
 * in this app to make `tsc` enforce that for us (the catalog is a derived
 * array, not a keyed map), so the totality has to be stated here instead.
 * Removing the `mcp` arm is a compile error, not a hub that silently loses a
 * tile.
 */
export function hubCardFor(descriptor: ProviderDescriptor): ConnectorMeta | undefined {
  switch (descriptor.track) {
    case "lan":
    case "cloud":
    case "catalog":
      // The historical home: a vendor-level `catalog` block. The `ConnectorId`
      // cast is the one place the two vocabularies are asserted to line up. It
      // is not taken on trust — `connectors.test.ts` pins the derived ids
      // against the literals the union allows, so a descriptor introducing a
      // card id outside it goes red rather than rendering a card the rest of
      // the hub cannot address.
      return descriptor.catalog
        ? {
            id: descriptor.catalog.id as ConnectorId,
            name: descriptor.catalog.name,
            category: descriptor.catalog.category,
            description: descriptor.catalog.description,
            availability: descriptor.catalog.availability,
            // WARP-2342. Spread rather than assigned, so a card with no guide
            // carries no KEY at all — `{ setupGuideHref: undefined }` would
            // make "no guide declared" and "declared as nothing" the same
            // object, and the pinned-catalog test could not tell them apart
            // either.
            ...(descriptor.catalog.setupGuideHref !== undefined
              ? { setupGuideHref: descriptor.catalog.setupGuideHref }
              : {}),
          }
        : undefined;
    /**
     * WARP-2659 — an MCP track's card is derived from the TRACK, with no
     * `catalog` block and no new `ConnectorId` literal.
     *
     * That is the whole reason to do it this way rather than widen the union:
     * the next hosted MCP server ships a descriptor and gets a working tile,
     * where the catalog-block route would need a hand-added literal in
     * `erp-types.ts` plus a row in this app's pinned-catalog test. The id is
     * the DESCRIPTOR id, which is also the `IntegrationConnection.provider`
     * key, so the hub's status join needs no mapping entry either.
     *
     * `availability` is `available` unconditionally, and that is a statement
     * rather than a default: the track's connect surface is the credential
     * configurator, which exists for every descriptor the registry offers. A
     * `coming-soon` MCP card would be a descriptor nobody can configure, and
     * the registry has no way to express one.
     */
    case "mcp":
      return {
        id: descriptor.id,
        name: descriptor.displayName,
        category: descriptor.category,
        description: descriptor.description,
        availability: "available",
        // REQUIRED on this arm by the descriptor type, so unlike a catalog
        // card there is no "no guide declared" case to preserve.
        setupGuideHref: descriptor.setupGuideHref,
      };
    default: {
      const unreachable: never = descriptor;
      return unreachable;
    }
  }
}

/**
 * The hub's catalog-block cards, in hub order.
 *
 * Kept as its own export, and NOT merged with {@link MCP_CONNECTORS}: these are
 * exactly the cards whose ids live in the closed `ConnectorId` union, and the
 * pinned-catalog test reads this array to keep that union closed. Folding the
 * MCP cards in would make the test's id list grow with every MCP provider,
 * which is the hand-maintained literal WARP-2659 exists to avoid.
 */
export const CONNECTORS: ConnectorMeta[] = catalogDescriptors().flatMap((descriptor) => {
  const card = hubCardFor(descriptor);
  return card ? [card] : [];
});

/**
 * The hub's MCP-track cards (WARP-2659), in registry declaration order.
 *
 * They render AFTER the catalog cards. Ordering is by declaration rather than
 * by a `catalog.order` because there is no catalog block to carry one, and
 * interleaving them with the practice/SaaS cards would need exactly the kind of
 * per-provider number this shape avoids. Appending is deterministic, which is
 * what the hub actually needs — a response arriving must not reshuffle the grid
 * under the owner's cursor.
 */
export const MCP_CONNECTORS: ConnectorMeta[] = providerDescriptors().flatMap((descriptor) => {
  if (descriptor.track !== "mcp") return [];
  const card = hubCardFor(descriptor);
  return card ? [card] : [];
});

export function connectorMeta(id: string): ConnectorMeta | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

/**
 * The credential fields a connector's setup form must collect.
 *
 * Returned straight off the shared descriptor rather than copied, so the form
 * and the orchestrator's validator cannot disagree about what a provider needs
 * — which is the entire reason the descriptor exists. Fields carry their own
 * `secret` flag; render those masked and never echo a submitted value back.
 *
 * An unknown card id returns an empty list rather than throwing: a catalog id
 * with no descriptor is a card that cannot be configured, which is what a
 * `coming-soon` placeholder is.
 */
export function connectorCredentialFields(id: string): readonly CredentialFieldDef[] {
  return descriptorForCatalogId(id)?.credentialFields ?? [];
}

/** The provider key the orchestrator persists for a hub card, or undefined for
 *  a placeholder with no shipped track. */
export function providerKeyForConnector(id: string): string | undefined {
  const descriptor = descriptorForCatalogId(id);
  return descriptor && descriptor.track !== "catalog" ? descriptor.id : undefined;
}

/**
 * The setup guide for a hub card, or undefined when the provider declares none.
 *
 * One read path for both surfaces that render it — the tile and the wizard's
 * credential step — so the two cannot end up linking different places
 * (WARP-2342).
 */
export function connectorSetupGuideHref(id: string): string | undefined {
  return setupGuideHrefFor(descriptorForCatalogId(id));
}
