/**
 * WARP-3703 (ADR-043 TC-1.3) — the tool-surface snapshot for a generic vendor
 * table, and the shape the drift gate byte-compares.
 *
 * The same artefact `atlassian-tool-snapshot.ts` renders for Atlassian, minus the
 * two Atlassian-shaped columns (`product` and the auth-mode matrix) a second
 * server has no equivalent of. One file per server, at
 * `docs/security/<serverId>-mcp-tool-surface.json`, so Atlassian's committed
 * artefact already sits where this naming rule says it should.
 *
 * ## What the gate does and does NOT catch
 *
 * It catches OUR drift: the table and the committed snapshot are regenerated and
 * compared, so editing one without the other goes red. It CANNOT catch the
 * vendor's: no CI job holds a vendor credential, and one that dialled a vendor on
 * every push would be an unregistered egress from a runner. The vendor changing
 * under us is caught at RUNTIME instead, by the session's `catalog_changed`
 * state — a tool that appears or disappears between two listings blocks dispatch
 * until a human re-vets it. The two halves are complementary.
 *
 * ## Regenerating
 *
 * `UPDATE_REMOTE_TOOL_SNAPSHOT=<serverId> npm run -w @droplet/orchestrator test -- remote-tool-snapshot`
 *
 * Regenerating is not a formality. The snapshot is a security artefact: a diff on
 * it is a privilege change, and it should be read as one in review.
 */
import { SERVER_ID_PATTERN } from "./mcp-multiplexer.service.js";
import { remoteReadToolsOf, type RemoteToolTableDef } from "./remote-tool-tables.js";

/**
 * Bumped whenever the snapshot's SHAPE changes (a new column, a renamed key), so
 * a reviewer can tell a format change from a privilege change at a glance.
 */
export const REMOTE_TOOL_SNAPSHOT_FORMAT = 1;

/**
 * Path of a server's committed artefact, relative to the repo root.
 *
 * The id is interpolated into a path, so a value that is not a server id is
 * refused rather than trusted to be one.
 */
export function remoteToolSnapshotPath(serverId: string): string {
  if (!SERVER_ID_PATTERN.test(serverId)) {
    throw new Error(
      "not a server id (lowercase letters, digits and hyphens; at most 32) — " +
        "refusing to build a snapshot path from it",
    );
  }
  return `docs/security/${serverId}-mcp-tool-surface.json`;
}

/**
 * Build the snapshot document.
 *
 * Sorted by name, not by declaration order, so a row moved within the table
 * produces no diff and a row ADDED produces exactly one. Code-unit order rather
 * than `localeCompare`: the artefact is committed, and a locale must not be able
 * to reorder it between machines.
 */
export function buildRemoteToolSnapshot(def: RemoteToolTableDef): string {
  const doc = {
    format: REMOTE_TOOL_SNAPSHOT_FORMAT,
    serverId: def.serverId,
    provenance: def.provenance,
    toolCount: def.rows.length,
    v1ReadToolCount: remoteReadToolsOf(def.rows).size,
    tools: [...def.rows]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({
        name: t.name,
        grade: t.grade,
        v1: t.v1,
        ...(t.note ? { note: t.note } : {}),
      })),
  };
  // Two-space JSON with a trailing newline: the repo's committed-codegen shape,
  // and what makes a byte-compare a readable diff rather than one long line.
  return `${JSON.stringify(doc, null, 2)}\n`;
}
