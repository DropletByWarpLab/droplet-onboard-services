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
  setupGuideHrefFor,
  type CredentialFieldDef,
} from "@droplet/shared-types";
import type { ConnectorId, ConnectorMeta } from "./erp-types";

/**
 * The hub's cards, in hub order.
 *
 * The `ConnectorId` cast is the one place the two vocabularies are asserted to
 * line up. It is not taken on trust: `connectors.test.ts` pins the derived ids
 * against the four literals `ConnectorId` allows, so a descriptor introducing a
 * card id outside that union goes red rather than rendering a card the rest of
 * the hub cannot address.
 */
export const CONNECTORS: ConnectorMeta[] = catalogDescriptors().flatMap((descriptor) =>
  descriptor.catalog
    ? [
        {
          id: descriptor.catalog.id as ConnectorId,
          name: descriptor.catalog.name,
          category: descriptor.catalog.category,
          description: descriptor.catalog.description,
          availability: descriptor.catalog.availability,
          // WARP-2342. Spread rather than assigned, so a card with no guide
          // carries no KEY at all — `{ setupGuideHref: undefined }` would make
          // "no guide declared" and "declared as nothing" the same object, and
          // the pinned-catalog test could not tell them apart either.
          ...(descriptor.catalog.setupGuideHref !== undefined
            ? { setupGuideHref: descriptor.catalog.setupGuideHref }
            : {}),
        },
      ]
    : [],
);

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
