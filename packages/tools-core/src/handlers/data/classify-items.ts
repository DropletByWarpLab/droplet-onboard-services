/**
 * WARP-3074 — `classify_items` LLM tool: bulk labelling with calibrated
 * probabilities from the Kev decision model (droplet-local-LLM ADR-006;
 * rules in docs/agentic-workflows.md § "Decision model (Kev)").
 *
 * Path: this handler → `POST /api/llm/decide` (orchestrator, mcp principal
 * only) → `DecisionModelClient` → ai-gateway `Decide` gRPC → Kev sidecar.
 * Never port 8009 directly. One `decide` call per item, sequentially: the
 * sidecar serves one batch at a time, so concurrency would only queue.
 *
 * Read-only on purpose: it only labels. Acting on a label is a separate
 * tool call that goes through the normal write-confirmation path.
 *
 * Caps, from latency. The MCP SDK times a tool call out at 60 s. On CPU a
 * one-question Kev call is ~0.65 s p95 and each extra question adds roughly
 * 0.15 s (ADR-006 early measurements), so 25 items x 3 questions is ~25-30 s
 * typical. `DEADLINE_MS` stops starting new items well before the MCP
 * timeout when the box is slower than that; the rest come back `not_run`
 * so the model can call again with them.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const MAX_ITEMS = 25;
const MAX_QUESTIONS = 3;
const MAX_TEXT_CHARS = 4000;
const MAX_INSTRUCTIONS_CHARS = 500;
/** Option count sets the cost of a `choice` row (ADR-006), so keep it small. */
const MAX_OPTIONS = 20;
const PER_ITEM_TIMEOUT_MS = 3000;
const DEADLINE_MS = 40_000;
const QUESTION_NAME = /^[A-Za-z0-9_-]{1,32}$/;

type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; options: Array<{ name: string }> }
  | { type: "score"; instructions: string; levels: string[] };

type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number }
  | { type: "score"; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };

type DecideResult =
  | { status: "ok"; answers: Record<string, Answer>; model?: string }
  | { status: "unavailable" | "invalid"; detail: string };

const inputSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description: `Up to ${MAX_ITEMS}.`,
      items: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
      },
    },
    questions: {
      type: "object",
      description: `Up to ${MAX_QUESTIONS}, keyed by name. type: noul (yes/no), choice (one of options), score (options = levels, lowest first).`,
      additionalProperties: {
        type: "object",
        properties: {
          type: { type: "string" },
          instructions: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["type", "instructions"],
      },
    },
  },
  required: ["items", "questions"],
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_ARGS", message } };
}

function isStr(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

/** Validates the LLM's arguments; returns an error message or the parsed call. */
function parseArgs(
  args: Record<string, unknown>,
): string | { items: Array<{ id: string; text: string }>; questions: Record<string, Question> } {
  const { items, questions } = args;
  if (!Array.isArray(items) || items.length === 0) return "items must be a non-empty array of {id, text}";
  if (items.length > MAX_ITEMS) {
    return `at most ${MAX_ITEMS} items per call (got ${items.length}); call again with the rest`;
  }
  const seen = new Set<string>();
  for (const [i, it] of items.entries()) {
    const { id, text } = (it ?? {}) as Record<string, unknown>;
    if (!isStr(id, 200)) return `items[${i}].id must be a non-empty string of at most 200 characters`;
    if (!isStr(text, MAX_TEXT_CHARS)) return `items[${i}].text must be non-empty text of at most ${MAX_TEXT_CHARS} characters`;
    if (seen.has(id)) return `duplicate item id "${id}"`;
    seen.add(id);
  }

  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    return "questions must be an object keyed by question name";
  }
  const entries = Object.entries(questions as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) return `questions must hold 1 to ${MAX_QUESTIONS} entries`;
  const parsed: Record<string, Question> = {};
  for (const [name, raw] of entries) {
    if (!QUESTION_NAME.test(name)) return `question name "${name}" must be 1-32 letters, digits, _ or -`;
    const { type, instructions, options } = (raw ?? {}) as Record<string, unknown>;
    if (!isStr(instructions, MAX_INSTRUCTIONS_CHARS)) {
      return `questions.${name}.instructions must be non-empty text of at most ${MAX_INSTRUCTIONS_CHARS} characters`;
    }
    if (type === "noul") {
      parsed[name] = { type, instructions };
      continue;
    }
    if (type !== "choice" && type !== "score") return `questions.${name}.type must be noul, choice or score`;
    const min = type === "choice" ? 1 : 2;
    if (
      !Array.isArray(options) ||
      options.length < min ||
      options.length > MAX_OPTIONS ||
      !options.every((o) => isStr(o, 100)) ||
      new Set(options).size !== options.length
    ) {
      return `questions.${name}.options must be ${min}-${MAX_OPTIONS} distinct non-empty strings`;
    }
    parsed[name] =
      type === "choice"
        ? { type, instructions, options: (options as string[]).map((o) => ({ name: o })) }
        : { type, instructions, levels: options as string[] };
  }
  return { items: items as Array<{ id: string; text: string }>, questions: parsed };
}

async function decide(ctx: ToolContext, state: string, questions: Record<string, Question>): Promise<DecideResult> {
  try {
    const res = await ctx.http.orchestrator.post(
      "/api/llm/decide",
      { state, questions, timeoutMs: PER_ITEM_TIMEOUT_MS },
      { signal: ctx.signal },
    );
    if (!res.ok) return { status: res.status === 400 ? "invalid" : "unavailable", detail: `HTTP ${res.status}` };
    return (await res.json()) as DecideResult;
  } catch (e) {
    return { status: "unavailable", detail: e instanceof Error ? e.message : String(e) };
  }
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const cell = (s: string) => s.replace(/[|\r\n]+/g, " ");

/** One table cell: the answer plus the probability of that answer. */
function render(a: Answer | undefined): string {
  if (!a) return "?";
  if (a.type === "noul") return a.noul >= 0.5 ? `yes ${pct(a.noul)}` : `no ${pct(1 - a.noul)}`;
  if (a.type === "choice") return `${cell(a.choice)} ${pct(a.confidence)}`;
  const [top] = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
  return top ? `${cell(a.legend[top[0]] ?? top[0])} ${pct(top[1])}` : "?";
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const parsed = parseArgs(args);
  if (typeof parsed === "string") return invalidArgs(parsed);
  const { items, questions } = parsed;
  const names = Object.keys(questions);

  const started = Date.now();
  const rows: string[] = [];
  let classified = 0;
  let model = "";
  let stopped: { reason: string } | null = null;

  for (const item of items) {
    if (!stopped && (Date.now() - started > DEADLINE_MS || ctx.signal.aborted)) {
      stopped = { reason: "time budget used up" };
    }
    if (stopped) {
      rows.push(`| ${cell(item.id)} | not_run |${" |".repeat(names.length)}`);
      continue;
    }
    const r = await decide(ctx, item.text, questions);
    if (r.status === "ok") {
      classified += 1;
      model ||= r.model ?? "";
      rows.push(`| ${cell(item.id)} | ok | ${names.map((n) => render(r.answers[n])).join(" | ")} |`);
    } else if (r.status === "invalid") {
      rows.push(`| ${cell(item.id)} | invalid: ${cell(r.detail)} |${" |".repeat(names.length)}`);
    } else {
      // Sidecar down or timing out: stop rather than burn the time budget
      // waiting out the same failure once per item.
      stopped = { reason: `classifier unavailable (${r.detail})` };
      rows.push(`| ${cell(item.id)} | unavailable |${" |".repeat(names.length)}`);
    }
  }

  if (classified === 0 && stopped) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "CLASSIFIER_UNAVAILABLE",
        message: `The item classifier is off or unavailable on this box: ${stopped.reason}. Read and label the items yourself instead.`,
      },
    };
  }

  const header = `| id | status | ${names.map(cell).join(" | ")} |`;
  const rule = `|---|---|${"---|".repeat(names.length)}`;
  return {
    ok: true,
    data: {
      type: "classify_items",
      model,
      classified,
      total: items.length,
      // Each cell is the answer and its calibrated probability.
      table: [header, rule, ...rows].join("\n"),
      ...(stopped && {
        note: `Stopped early: ${stopped.reason}. Rows marked not_run or unavailable were not classified; call again with just those items, or label them yourself.`,
      }),
    },
  };
}

const tool: Tool = {
  name: "classify_items",
  description:
    "Bulk-label items (e.g. which department each of 20 emails is for) with the box's calibrated classifier. Returns a table of each answer with its probability. Not for a single judgement.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
