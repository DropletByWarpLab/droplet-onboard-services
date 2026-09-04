/**
 * WARP-2367 — the tool-surface snapshot, and the shape the drift gate
 * byte-compares.
 *
 * ## Why a snapshot for THIS server specifically
 *
 * Every other integration on this box has a version to pin a contract to.
 * Atlassian's remote MCP server does not, and not by omission: it self-reports
 * `atlassian-mcp-server 1.0.0` in `serverInfo` while its published
 * `server.json` says `1.1.3`. Two numbers, neither trustworthy, no changelog
 * tied to either — so "did the tool surface change" cannot be answered by
 * reading a version, and it has to be answered by comparing surfaces.
 *
 * ## What this gate does and does NOT catch, stated plainly
 *
 * It catches OUR drift: the classification table and the committed snapshot
 * are regenerated into tmp and byte-compared, in the shape
 * `schemas-tests.yml` established for committed codegen, so editing one
 * without the other goes red. That is the failure this repo has actually had.
 *
 * It CANNOT catch the server's drift, and no CI job can: the appliance has no
 * live Atlassian credential in CI, would not be given one, and a job that
 * dialled a vendor on every push would be an unregistered egress from a runner.
 * The server changing under us is caught at RUNTIME instead, by
 * `RemoteMcpSession`'s `catalog_changed` state — a tool that appears or
 * disappears between two listings blocks dispatch until `acknowledgeCatalog()`,
 * which is the operator re-seeing a surface they classified. The two halves are
 * complementary and neither substitutes for the other.
 *
 * ## Regenerating
 *
 * `UPDATE_ATLASSIAN_SNAPSHOT=1 npm run -w @droplet/orchestrator test -- atlassian-tool-snapshot`
 *
 * Regenerating is not a formality. The snapshot is a security artefact: a diff
 * on it is a privilege change, and it should be read as one in review.
 */
import {
  ATLASSIAN_PRODUCT_AUTH_MODES,
  ATLASSIAN_TOOL_CLASSIFICATIONS,
  ATLASSIAN_V1_READ_TOOLS,
} from "./atlassian-tool-policy.js";

/** Path of the committed artefact, relative to the repo root. */
export const ATLASSIAN_SNAPSHOT_PATH = "docs/security/atlassian-mcp-tool-surface.json";

/**
 * Bumped whenever the snapshot's SHAPE changes (a new column, a renamed key),
 * so a reviewer can tell a format change from a privilege change at a glance.
 */
export const ATLASSIAN_SNAPSHOT_FORMAT = 1;

/**
 * Where the tool names came from, carried IN the artefact.
 *
 * A snapshot whose provenance lives only in a PR description is a snapshot
 * nobody can date. This one says, in the file: recorded from an OAuth-connected
 * Rovo client, which is why Compass rows are present and JSM / Bitbucket rows
 * are absent, and which is why it is a fixture rather than a probe of the
 * API-token surface this integration actually uses.
 */
export const ATLASSIAN_SNAPSHOT_PROVENANCE =
  "Recorded 2026-09-02 from the tool surface advertised by an OAuth-connected " +
  "Atlassian Rovo MCP client. NOT a probe of the API-token path: Warp Lab holds " +
  "no Atlassian credential. Compass tools are present and JSM/Bitbucket tools " +
  "are absent, which corroborates the auth-mode matrix rather than contradicting " +
  "it. A tool absent from this file is DENIED at dispatch " +
  "(REMOTE_TOOL_NOT_CLASSIFIED), so the missing rows cost capability, not safety.";

/**
 * Build the snapshot document.
 *
 * Sorted by name, not by declaration order, so a row moved within the table
 * produces no diff and a row ADDED produces exactly one.
 */
export function buildAtlassianToolSnapshot(): string {
  const doc = {
    format: ATLASSIAN_SNAPSHOT_FORMAT,
    provenance: ATLASSIAN_SNAPSHOT_PROVENANCE,
    toolCount: ATLASSIAN_TOOL_CLASSIFICATIONS.length,
    v1ReadToolCount: ATLASSIAN_V1_READ_TOOLS.size,
    authModes: ATLASSIAN_PRODUCT_AUTH_MODES,
    tools: [...ATLASSIAN_TOOL_CLASSIFICATIONS]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        product: t.product,
        grade: t.grade,
        v1: t.v1,
        ...(t.note ? { note: t.note } : {}),
      })),
  };
  // Two-space JSON with a trailing newline: the repo's committed-codegen shape,
  // and what makes a byte-compare a readable diff rather than one long line.
  return `${JSON.stringify(doc, null, 2)}\n`;
}
