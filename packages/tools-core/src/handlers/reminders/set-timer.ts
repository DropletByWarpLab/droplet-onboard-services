/**
 * WARP-1425 — `set_timer`: quick countdown timer ("pasta in 10 minutes")
 * that fires a dashboard notification when it ends. The due time is
 * computed SERVER-SIDE from the box's clock — the LLM supplies only a
 * relative duration, never an absolute timestamp (models don't have a
 * reliable clock). Implemented as a Reminder row so the existing
 * reminders dispatcher fires it; deliberately there are no dedicated
 * cancel/list timer tools — `complete_reminder` cancels a timer and
 * `list_reminders` shows running ones.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const MAX_LABEL_LENGTH = 200;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60; // 7 days

const inputSchema = {
  type: "object",
  properties: {
    label: {
      type: "string",
      maxLength: 200,
      description: "What the timer is for (e.g. 'pasta'). Defaults to 'Timer'.",
    },
    hours: { type: "integer", minimum: 0, description: "Hours from now." },
    minutes: { type: "integer", minimum: 0, description: "Minutes from now." },
    seconds: { type: "integer", minimum: 0, description: "Seconds from now." },
  },
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

/** Read an optional duration component: absent → 0, invalid → null. */
function parseComponent(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");

  const components: Record<string, number> = {};
  for (const field of ["hours", "minutes", "seconds"] as const) {
    const parsed = parseComponent(args[field]);
    if (parsed === null) {
      return err("INVALID_ARGS", `invalid ${field} — expected a non-negative integer`);
    }
    components[field] = parsed;
  }
  const totalSeconds =
    components.hours * 3600 + components.minutes * 60 + components.seconds;
  if (totalSeconds === 0) {
    return err("INVALID_ARGS", "provide a positive duration (hours, minutes, and/or seconds)");
  }
  if (totalSeconds > MAX_DURATION_SECONDS) {
    return err("DURATION_TOO_LONG", "timer duration exceeds the 7-day maximum — use create_reminder instead");
  }

  if (args.label !== undefined && typeof args.label !== "string") {
    return err("INVALID_ARGS", "invalid label — expected a string");
  }
  const label = typeof args.label === "string" ? args.label.trim() : "";
  if (label.length > MAX_LABEL_LENGTH) {
    return err("INVALID_ARGS", `label too long — maximum ${MAX_LABEL_LENGTH} characters`);
  }
  const title = label || "Timer";

  const dueAt = new Date(Date.now() + totalSeconds * 1000);
  const reminder = (await ctx.prisma.reminder.create({
    data: {
      userId: ctx.userId,
      title,
      body: null,
      dueAt,
      calendarEventId: null,
    },
  })) as unknown as { id: string; dueAt: Date };
  return {
    ok: true,
    data: {
      type: "set_timer",
      id: reminder.id,
      title,
      due_at: reminder.dueAt.toISOString(),
      duration_seconds: totalSeconds,
    },
  };
}

const tool: Tool = {
  name: "set_timer",
  description:
    "Set a countdown timer (e.g. 'pasta in 10 minutes') that fires a dashboard notification when it ends. Pass the duration as hours/minutes/seconds RELATIVE TO NOW — the due time is computed on the Droplet from its own clock, so never convert to an absolute timestamp. To cancel a timer, call complete_reminder with the returned id; running timers appear in list_reminders.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
