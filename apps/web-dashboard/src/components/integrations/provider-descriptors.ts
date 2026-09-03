/**
 * WARP-2291 — the explicit map between the orchestrator's provider keys and the
 * dashboard's connector catalog ids, plus the dispatch each tile answers a
 * click with.
 *
 * ## Why this file has to exist
 *
 * The two namespaces share exactly one member. `EAGLESOFT_PROVIDER` is
 * `"eaglesoft"` (`apps/orchestrator/src/services/erp-provider.ts:61`) and the
 * catalog's first id is also `"eaglesoft"`; every other backend key —
 * `eaglesoft-api`, `quickbooks-online`, `dentrix-ascend`, and the whole
 * `<vendor>-export` family — is not byte-equal to any catalog id. While the
 * relationship stayed implicit (the hub looked a row up with
 * `byId.get(meta.id)`) that single accidental collision hid the fact that the
 * join never worked at all: a genuinely connected QuickBooks Online row was
 * fetched every 30 seconds, ignored, and rendered NOT_CONFIGURED forever.
 *
 * The same accident hid the hardcoded `if (e.meta.id === "eaglesoft")`
 * dispatch, because the one vendor that was hardcoded was also the one whose
 * key happened to match. Stating both relationships as data, in one place that
 * a test can read, is the whole point of the module — an implicit identity
 * match here is exactly what would let the defect grow back.
 *
 * ## Lifetime — this file is a scaffold, not a destination
 *
 * DISPOSABLE. **WARP-2217** moves provider definitions into declarative
 * `ProviderDescriptor`s in `packages/shared-types`, consumed by the
 * orchestrator and the dashboard alike, and deletes `lib/connectors.ts`'s
 * hand-maintained list. When it lands, delete this file and read the
 * descriptors from the shared source. Do not grow it into a second permanent
 * catalog — the dashboard is not supposed to end up with its own idea of what
 * a provider is.
 *
 * It deliberately owns no vendor copy, no availability flag and no track
 * choice: *which* vendors are offered and *how* they are described is
 * **WARP-2123**'s, and this module reads `CONNECTORS` for all of it rather
 * than restating any of it.
 */

import { CONNECTORS, MCP_CONNECTORS, providerKeyForConnector } from "@/lib/connectors";
import { providerName } from "@/app/reports/connectors";
import type { ConnectorMeta } from "@/lib/erp-types";

/**
 * What a click on a tile's action does.
 *
 * Every branch is observable: a route push, a wizard, or a stated reason it
 * cannot happen. There is deliberately no fourth kind and, in particular, no
 * "nothing" — a live-looking button whose click returns silently is the
 * failure this type exists to make unrepresentable.
 */
export type ConnectAction =
  | {
      readonly kind: "wizard";
      /**
       * WHICH provider the wizard is being opened for (WARP-2451).
       *
       * The wizard used to need no argument because it could only ever mean
       * one vendor. Carrying the catalog id makes the dispatch total: the
       * wizard resolves its fields from that provider's descriptor, so a tile
       * can no longer open a form belonging to somebody else.
       */
      readonly catalogId: string;
    }
  | { readonly kind: "route"; readonly href: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ProviderDescriptor {
  readonly meta: ConnectorMeta;
  /**
   * Every orchestrator provider key that resolves to this tile, in precedence
   * order. A vendor is reachable by more than one track and the hub must light
   * up whichever one connected it.
   */
  readonly providerKeys: readonly string[];
  /** What the tile's "set this up" action does. */
  readonly connect: ConnectAction;
  /** What the tile's "open" / "fix connection" action does. */
  readonly open: ConnectAction;
  /**
   * Whether this provider's data arrives on a SCHEDULE (WARP-2659).
   *
   * True for every catalog card — a LAN or cloud track exists to pull canonical
   * datasets on a cron. False for an MCP track, which has no connector, no
   * dataset and no sync: its tools are called when the model calls them.
   *
   * It exists because the hub's Connected strip renders
   * `synced {syncedAgo(lastSyncedAt)}`, and `syncedAgo(undefined)` is the
   * string "never". A connected Atlassian would therefore read "Connected ·
   * synced never", which invites the owner to go and fix a sync that is not
   * supposed to exist. Carried as an explicit flag rather than inferred from a
   * null `lastSyncedAt`, which would also be "never" for a cloud connector
   * whose first sync has genuinely not run yet — two opposite facts.
   */
  readonly syncs: boolean;
}

/**
 * Direct-track provider keys per catalog id, transcribed from
 * `apps/orchestrator/src/services/erp-provider.ts:61,63,74`
 * (`EAGLESOFT_PROVIDER`, `EAGLESOFT_API_PROVIDER`, `KNOWN_ERP_PROVIDERS`).
 *
 * The catalog id itself is prepended by {@link providerKeysFor} and the
 * export-drop key is derived there rather than listed here: those keys are
 * `<vendor>-export` and the vendor set is open, because an operator profile
 * can introduce one at runtime (`isKnownErpProvider`). A key that reaches the
 * hub without belonging to any tile still gets rendered — see
 * {@link descriptorForReportedProvider} — so an omission here degrades to a
 * plainer tile, never to a dropped connection.
 */
const DIRECT_PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  eaglesoft: ["eaglesoft-api"],
  dentrix: ["dentrix-ascend"],
  quickbooks: ["quickbooks-online"],
  opendental: [],
};

/** Tiles that have a detail surface today.
 *
 *  WARP-2560 (ADR-044) — Eaglesoft's detail surface is `/practice`, in the
 *  Business group. The hub tile still opens it from here; only the address
 *  changed. The old route redirects, so a stale cached bundle pointing at
 *  `/integrations/eaglesoft` still lands somewhere real. */
const DETAIL_ROUTES: Readonly<Record<string, string>> = {
  eaglesoft: "/practice",
};

/** The descriptor-driven credential configurator — an MCP track's only connect
 *  surface (WARP-2275 / WARP-2659). */
const CREDENTIALS_ROUTE = "/integrations/credentials";

const COMING_SOON_REASON = "Available in a future update.";
const NO_CONNECT_FLOW_REASON =
  "This system can't be set up from the dashboard yet.";
const NO_DETAIL_VIEW_REASON = "There's no detail view for this connection yet.";
const NOT_IN_CATALOG_REASON =
  "Droplet reports this connection, but the dashboard has no setup flow for it yet.";

/** Every backend provider key that should resolve to this catalog tile. */
export function providerKeysFor(catalogId: string): readonly string[] {
  return [
    catalogId,
    ...(DIRECT_PROVIDER_KEYS[catalogId] ?? []),
    `${catalogId}-export`,
  ];
}

function descriptorFor(meta: ConnectorMeta): ProviderDescriptor {
  const route = DETAIL_ROUTES[meta.id];
  // WARP-2451: which tiles open the wizard is DERIVED — a card backed by a
  // provider key the orchestrator can persist has a connect flow, because the
  // wizard now renders that provider's own credential fields. It was a
  // hand-kept list of one, which is the same shape of defect WARP-2291 removed
  // from the dispatch: correct for exactly the vendor that was hardcoded.
  const connect: ConnectAction =
    meta.availability === "coming-soon"
      ? { kind: "unavailable", reason: COMING_SOON_REASON }
      : providerKeyForConnector(meta.id) !== undefined
        ? { kind: "wizard", catalogId: meta.id }
        : { kind: "unavailable", reason: NO_CONNECT_FLOW_REASON };

  return {
    meta,
    providerKeys: providerKeysFor(meta.id),
    connect,
    open: route
      ? { kind: "route", href: route }
      : { kind: "unavailable", reason: NO_DETAIL_VIEW_REASON },
    syncs: true,
  };
}

/**
 * WARP-2659 — an MCP-track tile.
 *
 * Both actions route to the credential configurator, and that is the whole
 * design:
 *
 *  • **Not the ERP wizard.** `ConnectWizard` probes a transport, offers read
 *    scopes and starts a dataset sync. An MCP track has no connector to probe,
 *    no scopes to grant and no dataset to sync, so opening it here would render
 *    a form whose every step is a promise this track cannot keep.
 *  • **`connect` and `open` are the SAME route, deliberately.** WARP-2483's
 *    lesson is that a second "Connect" path alongside a stored credential can
 *    write a second one over a working one. `/integrations/credentials` renders
 *    one form per provider whose secret input says "Saved — replace to change",
 *    so first-run and re-entry are the same act on the same row. Splitting them
 *    would invent the double-store this avoids.
 *
 * `providerKeys` is the descriptor id ALONE — not `providerKeysFor`, which
 * appends `<id>-export`. That key belongs to the export-drop family and no MCP
 * track has one; claiming it would let this tile swallow a reported connection
 * that is not its own.
 */
function mcpDescriptorFor(meta: ConnectorMeta): ProviderDescriptor {
  const toCredentials: ConnectAction = {
    kind: "route",
    href: CREDENTIALS_ROUTE,
  };
  return {
    meta,
    providerKeys: [meta.id],
    connect: toCredentials,
    open: toCredentials,
    syncs: false,
  };
}

/** The catalog, in catalog order, then the MCP tracks — the hub's stable spine. */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  ...CONNECTORS.map(descriptorFor),
  ...MCP_CONNECTORS.map(mcpDescriptorFor),
];

/**
 * A tile for a provider the box reports that the catalog does not list —
 * `<vendor>-export` keys, M365, or anything a future box adds.
 *
 * Deliberately factual and copy-free: it says where the connection came from
 * and what the dashboard can and cannot do with it. Inventing marketing copy
 * for a provider nobody wrote a tile for would be worse than the plain
 * rendering, and naming vendors is WARP-2123's call, not this module's.
 */
export function descriptorForReportedProvider(
  provider: string,
): ProviderDescriptor {
  return {
    meta: {
      id: provider,
      name: providerName(provider),
      category: "Reported by this box",
      description:
        "This connection is configured on the box. It isn't in the dashboard's connector catalog yet.",
      availability: "available",
    },
    providerKeys: [provider],
    connect: { kind: "unavailable", reason: NOT_IN_CATALOG_REASON },
    open: { kind: "unavailable", reason: NO_DETAIL_VIEW_REASON },
    // The box reported this connection, and every provider it can sync is one
    // this module knows about — so an unrecognised key is treated as a synced
    // connector and keeps the sub-line it has always had. Claiming otherwise
    // would hide a real staleness fact for a provider a newer box added.
    syncs: true,
  };
}
