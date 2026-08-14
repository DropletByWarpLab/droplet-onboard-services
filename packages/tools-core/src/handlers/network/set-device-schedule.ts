/**
 * WARP-1443 — `set_device_schedule` LLM tool.
 *
 * Manages a device's internet schedule (parental controls / time-of-day
 * rules) via the orchestrator's `/api/network/schedules` surface:
 *   list  → GET    /api/network/schedules (filtered to the device; plain read)
 *   set   → PATCH  /api/network/schedules/:id when one already targets the
 *           device (the service's update wholesale-replaces the window set
 *           in a delete+create transaction), else POST /api/network/schedules
 *   clear → DELETE /api/network/schedules/:id for every schedule targeting
 *           the device
 *
 * SEMANTICS (verified against schedule.service.ts + lib/schedule-window.ts):
 * a schedule BLOCKS the device's internet DURING each window (start
 * inclusive, end exclusive) and allows it at all other times — so the
 * confirmation echo says "blocked during", never "outside".
 *
 * Wire shape: `ScheduleWindow` is `{ daysOfWeek, startMin, endMin }` where
 * `daysOfWeek` is a 7-bit mask Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32,
 * Sat=64 (prisma schema + DAY_BIT in lib/schedule-window.ts) and start/end
 * are minutes since local midnight. `endMin <= startMin` wraps past
 * midnight and is valid (only zero-length windows are rejected). The tool
 * accepts LLM-friendly day-name arrays + "HH:MM" strings and converts.
 * MACs are canonicalized to uppercase colon-separated form (lib/mac.ts
 * parity — `Schedule.deviceMac` references `NetworkDevice.mac`).
 *
 * Tier 2 for set/clear (write + requires confirmation), enforced BY THE
 * HANDLER — same two-phase contract as `memory_forget` /
 * `set_detection_zones`: the first call returns `confirmation_required`
 * (no HTTP); re-issue with `confirmed: true` only after an explicit user
 * yes. `list` is a read and never asks for confirmation.
 */
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";

const TOOL_NAME = "set_device_schedule";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** Sun=1..Sat=64 — mirror of lib/schedule-window.ts DAY_BIT. */
const DAY_BITS: Record<string, number> = {
  sunday: 1,
  monday: 2,
  tuesday: 4,
  wednesday: 8,
  thursday: 16,
  friday: 32,
  saturday: 64,
};
/** Display/decode order (Monday-first reads naturally in summaries). */
const DAY_ORDER = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const DAY_SHORT: Record<string, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const inputSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["set", "clear", "list"],
      description:
        "'list' reads the device's current schedule (no confirmation). 'set' creates or replaces the device's schedule with the given windows. 'clear' removes it entirely.",
    },
    device_mac: {
      type: "string",
      description: "MAC address of the device (format: AA:BB:CC:DD:EE:FF).",
    },
    windows: {
      type: "array",
      minItems: 1,
      maxItems: 7,
      description:
        "Required for 'set': the COMPLETE replacement set of weekly windows (max 7). The device's internet is BLOCKED during each window and allowed at all other times.",
      items: {
        type: "object",
        properties: {
          days: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              enum: [
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
              ],
            },
            description: "Days of week this window applies to.",
          },
          start: {
            type: "string",
            description: "Window start, 24-hour \"HH:MM\" local time (inclusive).",
          },
          end: {
            type: "string",
            description:
              "Window end, 24-hour \"HH:MM\" local time (exclusive). An end at or before the start wraps past midnight into the next day (e.g. 21:00-07:00).",
          },
        },
        required: ["days", "start", "end"],
        additionalProperties: false,
      },
    },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required describing the action, and the user approves from that prompt.",
    },
  },
  required: ["operation", "device_mac"],
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_ARGS", message } };
}

function invalidSchedule(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_SCHEDULE", message } };
}

/** lib/mac.ts parity: any :-. separators, 12 hex chars → AA:BB:CC:DD:EE:FF. */
function normalizeMac(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const compact = raw.replace(/[:\-.]/g, "").toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(compact)) return null;
  return compact.match(/.{2}/g)!.join(":");
}

/** "HH:MM" → minutes since midnight, or null. */
function parseTime(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = TIME_RE.exec(raw);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minToHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function maskToDays(mask: number): string[] {
  return DAY_ORDER.filter((d) => (mask & DAY_BITS[d]) !== 0);
}

interface ParsedWindow {
  daysOfWeek: number;
  startMin: number;
  endMin: number;
}

/** Validate one LLM-shaped window and convert it to the wire shape.
 *  Returns the parsed window, or an error message string. */
function parseWindow(raw: unknown, idx: number): ParsedWindow | string {
  const label = `window ${idx + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `${label} must be an object with days, start, end`;
  }
  const w = raw as Record<string, unknown>;
  if (!Array.isArray(w.days) || w.days.length === 0) {
    return `${label}: days must be a non-empty array of day names (monday..sunday)`;
  }
  let mask = 0;
  for (const d of w.days) {
    const key = typeof d === "string" ? d.toLowerCase() : "";
    const bit = DAY_BITS[key];
    if (bit === undefined) return `${label}: unknown day name: ${String(d)}`;
    mask |= bit;
  }
  const startMin = parseTime(w.start);
  if (startMin === null) return `${label}: start must be 24-hour "HH:MM"`;
  const endMin = parseTime(w.end);
  if (endMin === null) return `${label}: end must be 24-hour "HH:MM"`;
  // Wrap past midnight (endMin <= startMin) is valid; only a true
  // zero-length window is rejected (service parity).
  if (startMin === endMin) {
    return `${label}: start and end are identical — a window cannot be zero-length`;
  }
  return { daysOfWeek: mask, startMin, endMin };
}

/** Human summary of one wire window for confirmation echoes. */
function describeWindow(w: ParsedWindow): string {
  const days = maskToDays(w.daysOfWeek)
    .map((d) => DAY_SHORT[d])
    .join(", ");
  const wrap = w.endMin <= w.startMin ? " (overnight)" : "";
  return `${days} ${minToHHMM(w.startMin)}-${minToHHMM(w.endMin)}${wrap}`;
}

/** LLM-friendly decode of a wire window (also the list output shape). */
function decodeWindow(w: ParsedWindow): { days: string[]; start: string; end: string } {
  return {
    days: maskToDays(w.daysOfWeek),
    start: minToHHMM(w.startMin),
    end: minToHHMM(w.endMin),
  };
}

/** Map a non-OK /network/schedules response. The route surfaces
 *  DeviceRegistryError as `{ error: { code, message } }`; 404s carry
 *  code SCHEDULE_NOT_FOUND (schedule id) or NOT_FOUND (device). */
async function orchestratorError(res: Response): Promise<ToolResult> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  let serverCode: string | null = null;
  let serverMsg: string | null = null;
  if (body && typeof body.error === "string") {
    serverMsg = body.error;
  } else if (body && body.error && typeof body.error === "object") {
    const e = body.error as { code?: unknown; message?: unknown };
    if (typeof e.code === "string") serverCode = e.code;
    if (typeof e.message === "string") serverMsg = e.message;
  }
  if (res.status === 404) {
    const code = serverCode === "NOT_FOUND" ? "DEVICE_NOT_FOUND" : "SCHEDULE_NOT_FOUND";
    return {
      ok: false,
      status: "error",
      error: { code, message: serverMsg ?? "orchestrator returned 404" },
    };
  }
  if (res.status === 400) {
    return invalidSchedule(serverMsg ?? "orchestrator rejected the schedule");
  }
  return {
    ok: false,
    status: "error",
    error: {
      code: "SCHEDULE_FAILED",
      message: serverMsg ?? `orchestrator returned ${res.status}`,
    },
  };
}

/** Raw schedule row as the orchestrator returns it (windows included). */
interface ScheduleRow {
  id: string;
  name: string;
  enabled: boolean;
  subjectType: string;
  deviceMac: string | null;
  windows: Array<{ daysOfWeek: number; startMin: number; endMin: number }>;
}

/** GET the full schedule list and filter to this device. Returns the
 *  matching rows or a ToolResult error. */
async function findDeviceSchedules(
  ctx: ToolContext,
  mac: string,
): Promise<ScheduleRow[] | ToolResult> {
  const res = await ctx.http.orchestrator.get("/api/network/schedules");
  if (!res.ok) return orchestratorError(res);
  const body = (await res.json().catch(() => null)) as { schedules?: unknown } | null;
  const schedules = Array.isArray(body?.schedules) ? (body.schedules as ScheduleRow[]) : [];
  return schedules.filter(
    (s) =>
      s.subjectType === "device" &&
      typeof s.deviceMac === "string" &&
      s.deviceMac.toUpperCase() === mac,
  );
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const operation = args.operation;
  if (operation !== "set" && operation !== "clear" && operation !== "list") {
    return invalidArgs("operation must be 'set', 'clear', or 'list'");
  }
  const mac = normalizeMac(args.device_mac);
  if (!mac) {
    return invalidArgs("device_mac must be a MAC address like AA:BB:CC:DD:EE:FF");
  }

  // ── list: plain read, no confirmation ──────────────────────────────
  if (operation === "list") {
    const found = await findDeviceSchedules(ctx, mac);
    if (!Array.isArray(found)) return found;
    return {
      ok: true,
      data: {
        type: "set_device_schedule",
        operation: "list",
        device_mac: mac,
        semantics: "internet is blocked during each window and allowed at all other times",
        schedules: found.map((s) => ({
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          windows: s.windows.map(decodeWindow),
        })),
      },
    };
  }

  // ── set: validate windows before asking anyone to approve them ─────
  const wireWindows: ParsedWindow[] = [];
  if (operation === "set") {
    if (!Array.isArray(args.windows) || args.windows.length === 0) {
      return invalidSchedule("set requires at least one window");
    }
    if (args.windows.length > 7) {
      return invalidSchedule("max 7 windows per schedule");
    }
    for (let i = 0; i < args.windows.length; i++) {
      const parsed = parseWindow(args.windows[i], i);
      if (typeof parsed === "string") return invalidSchedule(parsed);
      wireWindows.push(parsed);
    }
  }

  // ── confirmation gate (set/clear) — AFTER validation, BEFORE HTTP ──
  const fingerprint = confirmationFingerprint([TOOL_NAME, mac, operation, wireWindows]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    const message =
      operation === "set"
        ? `I'd like to set an internet schedule for device ${mac}: its internet access will be ` +
          `blocked during ${wireWindows.map(describeWindow).join("; ")} and allowed at all other times. ` +
          "This replaces any existing schedule for the device. " +
          "Ask the user to approve. " +
          "You cannot approve on their behalf."
        : `I'd like to remove the internet schedule for device ${mac} — it will no longer be ` +
          "blocked on a timer (manual blocks and overrides are untouched). " +
          "Ask the user to approve. " +
          "You cannot approve on their behalf.";
    return confirmationRequired(message, {
      type: "set_device_schedule",
      operation,
      device_mac: mac,
      ...(operation === "set" ? { windows: wireWindows.map(decodeWindow) } : {}),
    },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  const existing = await findDeviceSchedules(ctx, mac);
  if (!Array.isArray(existing)) return existing;

  // ── clear ───────────────────────────────────────────────────────────
  if (operation === "clear") {
    if (existing.length === 0) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "SCHEDULE_NOT_FOUND",
          message: `no schedule exists for device ${mac}`,
        },
      };
    }
    for (const s of existing) {
      const res = await ctx.http.orchestrator.delete(
        `/api/network/schedules/${encodeURIComponent(s.id)}`,
      );
      if (!res.ok) return orchestratorError(res);
    }
    return {
      ok: true,
      data: {
        type: "set_device_schedule",
        operation: "clear",
        device_mac: mac,
        cleared: existing.length,
      },
    };
  }

  // ── set: replace the first existing schedule, else create ──────────
  const windows = wireWindows.map((w) => ({
    daysOfWeek: w.daysOfWeek,
    startMin: w.startMin,
    endMin: w.endMin,
  }));
  if (existing.length > 0) {
    // The service's update wholesale-replaces the window set (delete +
    // create in one transaction). `enabled: true` because the user just
    // approved a schedule that must be in force — leaving a previously
    // disabled rule off would silently ignore their approval.
    const target = existing[0];
    const res = await ctx.http.orchestrator.patch(
      `/api/network/schedules/${encodeURIComponent(target.id)}`,
      { enabled: true, windows },
    );
    if (!res.ok) return orchestratorError(res);
    return {
      ok: true,
      data: {
        type: "set_device_schedule",
        operation: "set",
        device_mac: mac,
        scheduleId: target.id,
        replaced: true,
        windows: wireWindows.map(decodeWindow),
      },
    };
  }

  const res = await ctx.http.orchestrator.post("/api/network/schedules", {
    name: `Schedule for ${mac}`,
    enabled: true,
    subjectType: "device",
    deviceMac: mac,
    windows,
  });
  if (!res.ok) return orchestratorError(res);
  const created = (await res.json().catch(() => null)) as { schedule?: { id?: unknown } } | null;
  return {
    ok: true,
    data: {
      type: "set_device_schedule",
      operation: "set",
      device_mac: mac,
      scheduleId: typeof created?.schedule?.id === "string" ? created.schedule.id : null,
      replaced: false,
      windows: wireWindows.map(decodeWindow),
    },
  };
}

const tool: Tool = {
  name: "set_device_schedule",
  description:
    "Manage a device's internet schedule (parental controls). The device's internet is blocked during " +
    "each weekly window and allowed at all other times. operation 'list' reads the current schedule " +
    "(no confirmation); 'set' creates or wholesale-replaces the device's schedule with the given " +
    "windows; 'clear' removes it. Windows take day names (monday..sunday) plus 24-hour HH:MM start/end; " +
    "an end at or before the start wraps past midnight (e.g. 21:00-07:00). For set/clear this is " +
    "two-step: the first call returns confirmation_required summarizing the change — relay it to the " +
    "user, and only after they explicitly approve, approval is handled outside this conversation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
