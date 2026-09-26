/**
 * WARP-2980 (ADR-059 P5 PR-E, spec §6.18) — `security_explain_pattern`: what
 * normal looks like for one area or camera at one time, learned from the last
 * four weeks — on how many observed days something was seen around that
 * hour, how many usually, how long a usual visit lasts, and whether Droplet
 * would flag it (it raises none of these yet while `live` is false).
 *
 * Read-only (P4 §6.12.4): GET A5 only. The numbers are the orchestrator's
 * `explainSecurityPattern`, with the acting person's scope: an area they see
 * through only some of its cameras answers `usual: null`, and one they
 * cannot see at all answers like one that does not exist. See ./common.ts.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { SECURITY_LABEL_ARGS, checkArgs, invalidArgs, securityGet } from "./common.js";

/** A time of day, not a span: the slot is the period's first hour. */
const PATTERN_PERIODS = ["last_night", "today"] as const;

const inputSchema = {
  type: "object",
  properties: {
    area: { type: "string", description: "Area name; or camera" },
    camera: { type: "string", description: "Camera name" },
    label: { type: "string", enum: SECURITY_LABEL_ARGS },
    at: { type: "string", description: "ISO time with offset; default now" },
    period: { type: "string", enum: PATTERN_PERIODS, description: "Or at: its first hour" },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const checked = checkArgs(args, {
    area: { kind: "string", max: 60 },
    camera: { kind: "string", max: 64 },
    label: { kind: "enum", values: SECURITY_LABEL_ARGS },
    at: { kind: "string", max: 40 },
    period: { kind: "enum", values: PATTERN_PERIODS },
  });
  if (!checked.ok) return checked.result;
  const { params } = checked;
  if ((params.area === undefined) === (params.camera === undefined)) return invalidArgs("give one area or one camera");
  if (params.at !== undefined && params.period !== undefined) return invalidArgs("give at or period, not both");
  return securityGet(
    () =>
      ctx.http.orchestrator.get("/api/security/assistant/patterns", {
        params,
        headers: { Accept: "application/json" },
        signal: ctx.signal,
      }),
    "security_pattern",
    ["timezone", "at", "place", "learning", "usual", "why", "wouldFlag", "expected", "moreExpected", "live"],
  );
}

const tool: Tool = {
  name: "security_explain_pattern",
  description:
    "What normal looks like for one area or camera at a given time, learned from the last 4 weeks: on how many days something was seen around that hour, how many usually, and how long a usual visit lasts. Use for 'is it normal for someone to be in the stock room at 2 AM?' or 'why was this flagged?'. Droplet needs about two weeks per camera before it knows. Droplet knows what was seen, not who: never name or guess who anyone was. Only covers what this person may see.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
