/**
 * WARP-2671 — the plain-English readback of a routine.
 *
 * Promotion is the moment a routine starts running without anybody pressing
 * a button, so the confirm step has to say what it will actually do. That
 * sentence is derived HERE, from the step list and the live tool registry —
 * never from the spec's own `description`.
 *
 * That distinction is the whole point. A routine that misdescribes itself —
 * a miner suggestion, or later a model-authored draft — cannot talk its way
 * past a sentence generated from its own steps and the registry's
 * `requiresWrite` flags. If the readback and the description disagree, the
 * readback is the one that is true.
 *
 * Copy leans on the catalog's `homeDescription` (plain-language, home-user
 * facing, ADR-002) rather than the agent-facing `description`, which carries
 * jargon written for a model.
 */
import type { RoutineSchedule, RoutineStep, ToolCatalogEntry } from "./types";

/** How much damage this routine can do, decided by the registry. */
export type RoutineImpact = "reads" | "writes" | "destructive";

export interface RoutineReadback {
  /** "Every weekday at 8:00" — null when nothing schedules it. */
  cadence: string | null;
  /** One plain-language clause per step, in run order. */
  actions: string[];
  impact: RoutineImpact;
  /** The one-line safety sentence matching `impact`. */
  impactLine: string;
  /** Registry names of the steps that write. Empty for a read-only routine. */
  writeTools: string[];
}

const DAY_LABEL: Record<string, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"];

function parseRuleParams(rrule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const segment of rrule.replace(/^RRULE:/i, "").split(";")) {
    const eq = segment.indexOf("=");
    if (eq > 0) out[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1);
  }
  return out;
}

function clockLabel(params: Record<string, string>): string {
  const h = Number.parseInt(params.BYHOUR ?? "0", 10);
  const m = Number.parseInt(params.BYMINUTE ?? "0", 10);
  const hh = Number.isFinite(h) ? h : 0;
  const mm = Number.isFinite(m) ? m : 0;
  return `${hh}:${String(mm).padStart(2, "0")}`;
}

/**
 * Render one schedule as English.
 *
 * Mirrors the subset the orchestrator's `nextFireFromRrule` actually fires
 * (DAILY / WEEKLY with BYDAY, BYHOUR, BYMINUTE). A rule outside that subset
 * cannot be stored since WARP-2665 validates at write time, but if one is
 * somehow present we say so plainly rather than inventing a cadence — the
 * readback's whole value is that it does not guess.
 */
export function describeSchedule(schedule: RoutineSchedule): string {
  const params = parseRuleParams(schedule.rrule);
  const freq = (params.FREQ ?? "").toUpperCase();
  const at = `at ${clockLabel(params)}`;
  const zone =
    schedule.timezone && schedule.timezone !== "UTC" ? ` ${schedule.timezone}` : " UTC";

  if (freq === "DAILY") return `Every day ${at}${zone}`;

  if (freq === "WEEKLY") {
    const days = (params.BYDAY ?? "").split(",").filter(Boolean);
    if (days.length === 0) return `Every week ${at}${zone}`;
    const isWeekdays =
      days.length === 5 && WEEKDAYS.every((d) => days.includes(d));
    if (isWeekdays) return `Every weekday ${at}${zone}`;
    const labels = days.map((d) => DAY_LABEL[d] ?? d);
    const list =
      labels.length === 1
        ? labels[0]
        : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
    return `Every ${list} ${at}${zone}`;
  }

  return `On a schedule this box cannot read (${schedule.rrule})`;
}

/** `list_recent_files` → "List recent files". Last resort when the registry
 *  has no entry — an unregistered tool would fail the run's pre-flight, so
 *  the reader should still see its name rather than a blank. */
function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Lowercase the first letter so a clause reads inside a sentence. */
function asClause(text: string): string {
  const trimmed = text.trim().replace(/\.$/, "");
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function toolNameOf(step: RoutineStep): string | null {
  const args = step.args as Record<string, unknown> | null;
  if (step.kind !== "call" || !args) return null;
  return typeof args.tool === "string" ? args.tool : null;
}

/**
 * Build the readback.
 *
 * `catalog` is the live registry, keyed by tool name. A step whose tool is
 * missing from it is described by name and treated as READ-ONLY for the
 * impact line — deliberately, because the alternative is worse in both
 * directions: guessing "writes" would cry wolf on every catalog gap, and the
 * actual safety decisions (run-now's 409, the scheduler's refusal) are made
 * server-side from `ToolSpec.writes`, which WARP-2665 derives from the same
 * registry. This readback explains that decision; it does not make it.
 */
export function describeRoutine(args: {
  steps: RoutineStep[];
  catalog: ReadonlyMap<string, ToolCatalogEntry>;
  schedules?: RoutineSchedule[];
  /** The server's own classification, which is what actually gates. */
  writes: boolean;
  reversible: boolean;
}): RoutineReadback {
  const actions: string[] = [];
  const writeTools: string[] = [];

  for (const step of args.steps) {
    if (step.kind === "summarize") {
      actions.push("write you a summary of what it found");
      continue;
    }
    const tool = toolNameOf(step);
    if (!tool) {
      actions.push("run a step this box cannot read");
      continue;
    }
    const entry = args.catalog.get(tool);
    if (entry?.requiresWrite) writeTools.push(tool);
    actions.push(
      entry?.homeDescription
        ? asClause(entry.homeDescription)
        : asClause(humanizeToolName(tool)),
    );
  }

  // Impact follows the SERVER's flags, not the client's recount of the
  // catalog: `writes`/`reversible` are what the orchestrator gates on, and a
  // readback that disagreed with the gate would be worse than none.
  const impact: RoutineImpact = !args.writes
    ? "reads"
    : args.reversible
      ? "writes"
      : "destructive";

  const impactLine =
    impact === "reads"
      ? "Reads only. Changes nothing."
      : impact === "writes"
        ? "Changes things. Each change can be undone."
        : "Changes things that cannot easily be undone — it will never run unattended.";

  const enabled = (args.schedules ?? []).filter((s) => s.enabled);
  const cadence = enabled.length > 0 ? describeSchedule(enabled[0]) : null;

  return { cadence, actions, impact, impactLine, writeTools };
}

/** The readback as one sentence, for the promote confirmation. */
export function readbackSentence(readback: RoutineReadback): string {
  const lead = readback.cadence ?? "When you run it";
  if (readback.actions.length === 0) return `${lead} — it does nothing.`;
  const list =
    readback.actions.length === 1
      ? readback.actions[0]
      : `${readback.actions.slice(0, -1).join(", ")}, then ${
          readback.actions[readback.actions.length - 1]
        }`;
  return `${lead} — ${list}.`;
}
