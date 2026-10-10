/**
 * WARP-2416 - which sign-in backs each server's catalog session, and what to do
 * when that sign-in refreshes or stops working.
 *
 * The base (catalog) session of a server may be opened with a Workspace
 * connection or an owner/admin's own sign-in. Its access token is short-lived, so
 * when the row behind it refreshes the session must be re-opened with the new
 * token, and when the row dies (NEEDS_RECONNECT, DISCONNECTED, ERROR) the choice
 * is re-run: API token, then the Workspace connection, then a CURRENT owner or
 * admin, else the server detaches. That re-run is the ordinary attach, so the same
 * gate applies (channel off means nothing re-opens) and a regular member's token
 * is never a candidate. The role is re-checked on every such re-run.
 */
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("mcp-catalog-repick");

/** serverId -> the McpOAuthConnection id backing its base session. One instance per process. */
const backing = new Map<string, string>();

export const setCatalogBacking = (serverId: string, rowId: string | null): void => {
  if (rowId === null) backing.delete(serverId);
  else backing.set(serverId, rowId);
};
export const catalogBackingRow = (serverId: string): string | undefined => backing.get(serverId);

export interface CatalogRepickerDeps {
  backingRow: (serverId: string) => string | undefined;
  /** Detach the server and run the ordinary gated attach again. */
  reattach: (serverId: string) => Promise<void>;
}

/** `changed(serverId, rowId)`: a no-op for a row that does not back the catalog; otherwise one re-attach at a time per server. */
export function createCatalogRepicker(deps: CatalogRepickerDeps): (serverId: string, rowId: string) => Promise<void> {
  const running = new Map<string, Promise<void>>();
  return (serverId, rowId) => {
    if (deps.backingRow(serverId) !== rowId) return Promise.resolve();
    const inflight = running.get(serverId);
    if (inflight) return inflight;
    const p = deps
      .reattach(serverId)
      .catch((err: unknown) => logger.error({ err, serverId }, "mcp_catalog_repick_failed"))
      .finally(() => running.delete(serverId));
    running.set(serverId, p);
    return p;
  };
}
