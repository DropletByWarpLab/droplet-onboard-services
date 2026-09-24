/**
 * WARP-2896 — `workspace_propose`: the run's LAST act. Writes the
 * extension manifest (ADR-030 shape, `egress: none` — the sandbox pins it
 * whatever the workspace holds), commits, tags `proposal/<version>`, pushes,
 * and the worker ENDS THE RUN on this tool's success (agent-run-worker
 * `proposed`). TIER-2: the interceptor challenges it and the run parks for
 * the person's approval, because a proposal is what the review surface
 * (slice I) acts on and nothing unattended should file one.
 *
 * A second proposal of the same version is refused (409), never
 * overwritten — bump the version.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { bind, fail, isRefusal, relayError } from "./_shared.js";

const inputSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The extension's name as a person will see it.",
    },
    version: {
      type: "string",
      description: "Semantic version, e.g. 0.1.0. A version already proposed is refused; bump it.",
    },
    summary: {
      type: "string",
      description: "What the extension does and what was verified, for the person reviewing it.",
    },
  },
  required: ["name", "version", "summary"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const bound = bind(ctx);
  if (isRefusal(bound)) return bound;
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const version = typeof args.version === "string" ? args.version.trim() : "";
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!name) return fail("INVALID_ARGS", "name is required");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    return fail("INVALID_ARGS", "version must be a semantic version like 0.1.0");
  }
  if (!summary) return fail("INVALID_ARGS", "summary is required");
  const res = await ctx.http.orchestrator.post(
    `/api/workspace/${encodeURIComponent(bound.workspace)}/propose`,
    { name, version, summary, onBehalfOf: ctx.userId },
    { headers: bound.headers },
  );
  if (!res.ok) return relayError(res, "propose from the workspace");
  const data = (await res.json()) as { commit: string; tag: string; manifest: Record<string, unknown> };
  return {
    ok: true,
    data: {
      workspace: bound.workspace,
      commit: data.commit.slice(0, 12),
      tag: data.tag,
      manifest: data.manifest,
      message: `Proposed ${name} ${version} as ${data.tag}. This run is finished; the person reviews it in the Workshop.`,
    },
  };
}

const workspacePropose: Tool = {
  name: "workspace_propose",
  description:
    "Finish this run by proposing the workspace as an extension: writes the manifest, commits, tags proposal/<version> and hands it to the person for review. Needs their confirmation. Nothing runs after it.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default workspacePropose;
