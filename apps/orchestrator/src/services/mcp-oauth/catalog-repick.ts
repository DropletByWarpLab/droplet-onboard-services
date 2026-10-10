/**
 * WARP-2416 - which sign-in backs each server's catalog session, and what to do
 * when that sign-in refreshes or stops working.
 *
 * The base (catalog) session of a server may be opened with a Workspace
 * connection or an owner/admin's own sign-in. Its access token is short-lived, so
 * when the row behind it refreshes the session must be re-opened with the new
 * token, and when the row stops working (ended, disconnected, its owner demoted or
 * deactivated) the choice is re-run: API token, then the Workspace connection, then
 * a CURRENT owner or admin, else the server detaches. Both are done IN PLACE
 * (a bridge `open` of the base key replaces the session): the server is never
 * detached to refresh, so no member's session or in-flight call is torn down, the
 * tools stay listed, and a `catalog_changed` server is never touched.
 */
import { createLogger } from "../../lib/logger.js";
import type { RemoteMcpCredentialKind } from "../remote-mcp-gateway.service.js";

const logger = createLogger("mcp-catalog-repick");

/** serverId -> what backs its base session. One instance per process. */
const backing = new Map<string, { rowId: string; kind: RemoteMcpCredentialKind }>();

/** Record the sign-in behind a server's base session. */
export const recordCatalog = (serverId: string, value: { rowId: string; kind: RemoteMcpCredentialKind } | null): void => {
  if (value === null) backing.delete(serverId);
  else backing.set(serverId, value);
};
/** The sign-in row behind the catalog, if any. */
export const catalogBackingRow = (serverId: string): string | undefined => backing.get(serverId)?.rowId;
export const catalogCredentialKind = (serverId: string): RemoteMcpCredentialKind | undefined => backing.get(serverId)?.kind;

const tails = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier job for this server has finished: attach, reconcile re-open and re-pick never overlap. */
export function withServerLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(serverId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  tails.set(serverId, tail);
  void tail.then(() => {
    if (tails.get(serverId) === tail) tails.delete(serverId);
  });
  return run;
}

export type CatalogEvent = "refreshed" | "ended";

export interface CatalogRepickerDeps {
  backingRow: (serverId: string) => string | undefined;
  /** Re-open in place, re-pick, or detach (the caller decides which). One at a time per server. */
  apply: (serverId: string) => Promise<void>;
}

/**
 * `changed(serverId, rowId, event)`: a no-op for a row that does not back the
 * catalog. An event that lands while a re-pick for that server is running is not
 * dropped: it marks the server dirty and the re-pick runs once more afterwards.
 */
export function createCatalogRepicker(
  deps: CatalogRepickerDeps,
): (serverId: string, rowId: string, event?: CatalogEvent) => Promise<void> {
  const running = new Map<string, Promise<void>>();
  const dirty = new Set<string>();

  const loop = async (serverId: string): Promise<void> => {
    do {
      dirty.delete(serverId);
      try {
        await deps.apply(serverId);
      } catch (err) {
        logger.error({ err, serverId }, "mcp_catalog_repick_failed");
      }
    } while (dirty.has(serverId));
  };

  return (serverId, rowId) => {
    if (deps.backingRow(serverId) !== rowId) return Promise.resolve();
    const inflight = running.get(serverId);
    if (inflight) {
      dirty.add(serverId);
      return inflight;
    }
    const p = loop(serverId).finally(() => running.delete(serverId));
    running.set(serverId, p);
    return p;
  };
}
