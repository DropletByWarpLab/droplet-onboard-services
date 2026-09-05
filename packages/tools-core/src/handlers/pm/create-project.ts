/**
 * `pm_create_project` — create a project in the tracker.
 *
 * Completes the PM tool surface: `pm_create_work_item` could already add
 * tasks, but only ever INSIDE a project that a human had made by hand, so
 * "turn this document into a project plan" dead-ended at the last step.
 * Thin wrapper over `POST /api/pm/projects`, which already exists, enforces
 * WRITE-role, and is covered by `routes/pm/native.test.ts` — no new
 * server-side behaviour is introduced here.
 *
 * Confirmation-gated, matching `pm_create_work_item`: a project is a
 * durable, user-visible container, and the tool that creates one off the
 * back of an extracted document should not be able to litter the tracker
 * without the owner seeing it first.
 *
 * ⚠ WARP-2580 — READ THIS BEFORE BELIEVING THE PARAGRAPH ABOVE. The
 * "dead-ended at the last step" claim is only true for a caller that HAS
 * `pm_create_work_item`. In default CHAT it does not: this is the one
 * `pm_*` tool outside `EXCLUDED_FROM_CHAT_TOOLS` (pinned deliberately by
 * `chat-tool-scope.test.ts` — "the pm rule is NOT dead"), so a chat turn can
 * create the project and then put nothing in it, and cannot list what
 * already exists before creating a duplicate. The wording below no longer
 * PROMISES that next step, which is what this ticket fixes; restoring the
 * capability is ADR-045's `business_create`, not a wider exclusion list.
 * Dashboard and external MCP clients get the whole suite and are unaffected.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, OrchPmError, toPlaneProject } from "./pm-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Project name, e.g. 'Q3 Roof Replacement'.",
    },
    workspace_slug: {
      type: "string",
      // WARP-2580 — this named `pm_list_workspaces`, which is excluded from
      // chat, so the one instruction it gave a chat turn was to call a tool
      // that turn could never reach. Named by slug rather than by tool, which
      // is true for every caller: an MCP client that HAS the listing tool can
      // still use it; a chat turn now knows to omit the field instead.
      description:
        "Workspace slug to create the project in. Omit to use the default workspace.",
    },
    identifier: {
      type: "string",
      description:
        "Optional short prefix for work-item keys, letters and digits only, max 10 chars (e.g. 'ROOF'). Derived from the name when omitted.",
    },
    description: {
      type: "string",
      maxLength: 10000,
      description: "Optional longer description of the project.",
    },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

interface Args {
  name: string;
  workspace_slug?: string;
  identifier?: string;
  description?: string;
}

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { name, workspace_slug, identifier, description } = args as unknown as Args;

  if (typeof name !== "string" || name.trim().length === 0) {
    return err("INVALID_ARGS", "name is required and must be a non-empty string");
  }
  if (name.length > 200) {
    return err("INVALID_ARGS", "name must be at most 200 characters");
  }
  // Mirrors the route's zod schema so a malformed identifier comes back as
  // a usable message the model can correct, rather than an opaque 400.
  if (identifier !== undefined && !/^[A-Za-z0-9]{1,10}$/.test(identifier)) {
    return err(
      "INVALID_ARGS",
      "identifier must be 1-10 characters, letters and digits only",
    );
  }
  if (description !== undefined && description.length > 10000) {
    return err("INVALID_ARGS", "description must be at most 10000 characters");
  }

  try {
    const data = await callOrch<{ project: Parameters<typeof toPlaneProject>[0] }>(
      ctx,
      "post",
      "/api/pm/projects",
      { workspace_slug, name: name.trim(), identifier, description },
    );
    return { ok: true, data: { project: toPlaneProject(data.project) } };
  } catch (e) {
    if (e instanceof OrchPmError) {
      return { ok: false, status: "error", error: { code: "PM_API_ERROR", message: e.message } };
    }
    throw e;
  }
}

const tool: Tool = {
  name: "pm_create_project",
  // WARP-2580 — both sentences that mentioned `pm_create_work_item` are gone.
  // That tool is excluded from chat, so in a chat turn this description
  // promised a next step that did not exist and described a return value in
  // terms of a parameter the model could not spend. The capability it names
  // is unchanged; only the dead cross-reference is.
  description:
    "Create a new project in the user's project tracker. Use it when tasks belong to something that does not exist yet. Requires confirmation. Returns the created project and its id.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
