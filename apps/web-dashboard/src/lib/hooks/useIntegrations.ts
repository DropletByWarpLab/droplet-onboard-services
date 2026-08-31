"use client";

import useSWR from "swr";
import { fetchIntegrations } from "../api.erp";
import {
  PROVIDER_DESCRIPTORS,
  descriptorForReportedProvider,
  type ConnectAction,
  type ProviderDescriptor,
} from "@/components/integrations/provider-descriptors";
import type { TypedError } from "./apiFetch";
import type {
  ConnectorMeta,
  IntegrationConnection,
  IntegrationStatus,
} from "../erp-types";

/**
 * What the hub knows about one provider's connection, stated explicitly.
 *
 * The union exists because "we haven't heard back yet", "we asked and the
 * request failed" and "the box says this provider is not configured" are three
 * different facts about the world. The previous shape collapsed all three into
 * a fabricated `{ status: "NOT_CONFIGURED" }` row synthesized from a `Map`
 * miss — a persistent status derived from absence, which the no-guessing-state
 * rule forbids, and which rendered a failed fetch as a healthy, empty hub.
 * `M365ConnectionState` (`schema.prisma:4990-5012`) is the in-repo argument for
 * why states like these have to stay distinguishable.
 */
export type ConnectionState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "absent" }
  | { kind: "reported"; connection: IntegrationConnection };

export interface HubEntry {
  meta: ConnectorMeta;
  /** The backend provider keys this tile answers to (WARP-2291). */
  providerKeys: readonly string[];
  state: ConnectionState;
  /** What the tile's "set this up" action does — never nothing. */
  connect: ConnectAction;
  /** What the tile's "open" / "fix connection" action does — never nothing. */
  open: ConnectAction;
}

/** A hub entry the box has actually reported a connection row for. */
export interface ConnectedEntry extends HubEntry {
  state: { kind: "reported"; connection: IntegrationConnection };
}

/**
 * Statuses that count as "connected" for the hub's Connected strip.
 *
 * `NEEDS_RECONNECT` belongs here (WARP-2458) even though nothing is working
 * through it right now: the owner DID set this integration up, and the strip is
 * where they will look for it. Filtering it out would move a broken connection
 * back to the catalog and read as "you never connected this" — which is the
 * NOT_CONFIGURED confusion ADR-042 §6 requires stay impossible. It appears here
 * carrying its own "Paste a new key" pill, which is the whole point.
 */
const LIVE_STATUSES: IntegrationStatus[] = [
  "CONNECTED",
  "DEGRADED",
  "DRIFT_LOCKED",
  "NEEDS_RECONNECT",
];

/**
 * A short, safe description of why the status read failed.
 *
 * Built from the typed `code`/`status` `apiFetch` attaches rather than from the
 * response body, so nothing the server happened to echo can reach the DOM
 * (rule 19 — never surface captured material).
 */
export function fetchErrorMessage(err: unknown): string {
  const typed = err as TypedError | null | undefined;
  const code = typeof typed?.code === "string" ? typed.code : undefined;
  const status = typeof typed?.status === "number" ? typed.status : undefined;
  const detail = code ?? (status ? `HTTP ${status}` : undefined);
  return detail
    ? `Couldn't check connection status (${detail}).`
    : "Couldn't check connection status.";
}

/**
 * Among the rows that belong to one tile, the one the tile should show.
 *
 * A vendor can be connected by more than one track at once — Eaglesoft direct
 * SQL and the official REST API both report rows, and `list()` always returns
 * both keys. A live track wins over a dormant one, because "connected" is the
 * fact the owner needs; ties fall back to the descriptor's own key order.
 */
function pickRow(rows: IntegrationConnection[]): IntegrationConnection | undefined {
  return rows.find((r) => LIVE_STATUSES.includes(r.status)) ?? rows[0];
}

function entryFor(
  descriptor: ProviderDescriptor,
  state: ConnectionState,
): HubEntry {
  return {
    meta: descriptor.meta,
    providerKeys: descriptor.providerKeys,
    state,
    connect: descriptor.connect,
    open: descriptor.open,
  };
}

/**
 * Merge the connector catalog with what the box reported.
 *
 * Three rules, each of which was a shipped defect:
 *
 *  1. The join is on the provider key the backend **emits**, resolved through
 *     the descriptor's `providerKeys`, not on the catalog id. `eaglesoft` was
 *     the only id byte-equal to a backend key, so the broken join looked
 *     healthy for exactly one vendor.
 *  2. `entries` is the **union** of the catalog and the response. A provider
 *     the box reports but the catalog does not list gets a plain tile rather
 *     than vanishing; nothing the API says about a connection may disappear
 *     from the UI without a trace.
 *  3. A tile with no row carries an explicit `absent`/`loading`/`error` state.
 *     No `IntegrationStatus` is ever constructed from a `Map` miss.
 *
 * Ordering is deterministic — catalog order first, then reported-only
 * providers sorted by key — so a response arriving does not reshuffle the grid
 * under the owner's cursor.
 */
export function buildHubEntries(
  rows: IntegrationConnection[] | undefined,
  error: unknown,
): HubEntry[] {
  // No rows at all: we genuinely do not know any provider's status, and the
  // reason we do not know is the state.
  const blanket: ConnectionState | null =
    rows === undefined
      ? error
        ? { kind: "error", message: fetchErrorMessage(error) }
        : { kind: "loading" }
      : null;

  const byKey = new Map<string, IntegrationConnection>();
  for (const row of rows ?? []) byKey.set(row.provider, row);
  const claimed = new Set<string>();

  const catalogEntries = PROVIDER_DESCRIPTORS.map((descriptor) => {
    const matches = descriptor.providerKeys.filter((key) => byKey.has(key));
    // Every matching key is claimed, not just the one shown, so a second track
    // for the same vendor does not also appear as an orphan tile.
    for (const key of matches) claimed.add(key);

    if (blanket) return entryFor(descriptor, blanket);
    const row = pickRow(matches.map((key) => byKey.get(key)!));
    return entryFor(
      descriptor,
      row ? { kind: "reported", connection: row } : { kind: "absent" },
    );
  });

  const reportedOnly = [...byKey.keys()]
    .filter((key) => !claimed.has(key))
    .sort()
    .map((key) =>
      entryFor(descriptorForReportedProvider(key), {
        kind: "reported",
        connection: byKey.get(key)!,
      }),
    );

  return [...catalogEntries, ...reportedOnly];
}

/**
 * The Integrations hub model. Merges the connector catalog with live connection
 * status from GET /api/integrations.
 *
 * A failed read is reported as a failure rather than smoothed into an empty
 * hub: `shouldRetryOnError: false` means one failure stands until the next
 * 30-second tick, so silently rendering "nothing is connected" would be a lie
 * with a 30-second half-life.
 */
export function useIntegrations() {
  const { data, error, isLoading, mutate } = useSWR<IntegrationConnection[]>(
    "/api/integrations",
    fetchIntegrations,
    { refreshInterval: 30_000, shouldRetryOnError: false },
  );

  const entries = buildHubEntries(data, error);

  const connected = entries.filter(
    (e): e is ConnectedEntry =>
      e.state.kind === "reported" &&
      LIVE_STATUSES.includes(e.state.connection.status),
  );

  return {
    entries,
    connected,
    isLoading,
    /** Non-null when the last status read failed — surfaced, never swallowed. */
    error: error ? fetchErrorMessage(error) : null,
    refresh: () => mutate(),
  };
}
