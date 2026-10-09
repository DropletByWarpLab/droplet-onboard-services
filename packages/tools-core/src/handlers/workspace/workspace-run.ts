/**
 * WARP-2896 — `workspace_run`: run one ALLOW-LISTED command in the
 * workspace, in the sandbox, and return its output. The list is closed —
 * `npm test`, `npm run build`, `pytest`, `ruff`, `tsc`, each with plain
 * arguments — and the orchestrator route refuses anything else BEFORE the
 * sandbox is dialled (the sandbox refuses again). A write without
 * confirmation on the same ground as `workspace_write`: the command runs
 * on one checkout, on a network that reaches nothing.
 *
 * Output is capped and the cap is reported, never silently sliced.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { bind, fail, isRefusal, relayError } from "./_shared.js";

const inputSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "npm test, npm run build, pytest, ruff or tsc with plain arguments; app-check alone probes an app.",
    },
    timeout_seconds: {
      type: "integer",
      minimum: 1,
      description: "Seconds: default 120, max 600.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const bound = bind(ctx);
  if (isRefusal(bound)) return bound;
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return fail("INVALID_ARGS", "command is required");
  const argv = command.split(/\s+/).filter(Boolean);
  const timeoutMs =
    typeof args.timeout_seconds === "number" && Number.isInteger(args.timeout_seconds) && args.timeout_seconds > 0
      ? Math.min(args.timeout_seconds, 600) * 1000
      : undefined;
  const res = await ctx.http.orchestrator.post(
    `/api/workspace/${encodeURIComponent(bound.workspace)}/run`,
    { argv, ...(timeoutMs ? { timeoutMs } : {}), onBehalfOf: ctx.userId },
    { headers: bound.headers },
  );
  if (!res.ok) return relayError(res, "run that command");
  const data = (await res.json()) as {
    argv: string[];
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
    appCheck?: Record<string, unknown>;
  };
  return {
    ok: true,
    data: {
      command: data.argv.join(" "),
      exitCode: data.exitCode,
      passed: data.exitCode === 0,
      timedOut: data.timedOut,
      durationMs: data.durationMs,
      stdout: data.stdout,
      stderr: data.stderr,
      ...(data.appCheck ? { appCheck: data.appCheck } : {}),
      ...(data.truncated ? { truncated: true, note: "Output was longer than what is shown." } : {}),
      message: data.timedOut
        ? `${data.argv.join(" ")} did not finish in time.`
        : data.exitCode === 0
          ? `${data.argv.join(" ")} passed.`
          : `${data.argv.join(" ")} exited ${data.exitCode}.`,
    },
  };
}

const workspaceRun: Tool = {
  name: "workspace_run",
  description:
    "Run an allowed check in the run's workspace; returns exit code and bounded output.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default workspaceRun;
