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
      description:
        "Workspace to create the project in. Omit to use the default workspace.",
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
  description:
    "Create a new project in the user's project tracker. Use this before pm_create_work_item when the tasks belong to something that does not exist yet. Requires confirmation. Returns the created project with its id, which pm_create_work_item takes as project_id.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
