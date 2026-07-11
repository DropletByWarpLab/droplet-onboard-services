/**
 * WARP-901 — `regex_test` LLM tool.
 *
 * Misc dev-utility: test a regex against text, or extract matches. Tier-1
 * read; pure computation, no I/O.
 *
 * ReDoS guard (mandatory — a pathological pattern like `^(a+)+$` against
 * "aaaa...!" can backtrack exponentially and hang forever):
 *   1. Pattern length is capped at `MAX_PATTERN_LENGTH`.
 *   2. Input length is capped at `MAX_INPUT_LENGTH`.
 *   3. The actual `exec`/`test` call runs inside a dedicated worker thread
 *      with a hard `EXEC_TIMEOUT_MS` deadline enforced by `worker.terminate()`
 *      — NOT a wall-clock check after the call returns. A wall-clock check
 *      cannot bound anything because a runaway regex never returns control
 *      to the caller; only forcibly killing the worker's isolate does.
 */
import { Worker } from "node:worker_threads";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const MAX_PATTERN_LENGTH = 200;
const MAX_INPUT_LENGTH = 20_000;
const MAX_MATCHES_CAP = 100;
const DEFAULT_MAX_MATCHES = 20;
/** Hard worker-kill deadline. Generous for a dev-utility (not a hot path)
 *  but small enough that a hung caller notices immediately. */
const EXEC_TIMEOUT_MS = 1000;
const ALLOWED_FLAGS = /^[gimsu]*$/;
/** Each call spawns a worker thread that can peg a core for up to
 *  EXEC_TIMEOUT_MS. The HTTP MCP transport lets any authenticated role
 *  fire tools/call in parallel, so cap how many workers run at once —
 *  above the cap we reject immediately (REGEX_BUSY) rather than spawn. */
const MAX_CONCURRENT_WORKERS = 4;
let inFlightWorkers = 0;

const inputSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: `JS regular expression pattern (no leading/trailing slashes). Capped at ${MAX_PATTERN_LENGTH} chars.`,
    },
    flags: {
      type: "string",
      description: "Regex flags, subset of 'g', 'i', 'm', 's', 'u'. Default '' (no flags).",
    },
    input: {
      type: "string",
      description: `Text to test/search against. Capped at ${MAX_INPUT_LENGTH} chars.`,
    },
    mode: {
      type: "string",
      enum: ["test", "extract"],
      description: "'test' (default) returns a boolean match; 'extract' also returns the matched substrings.",
    },
    maxMatches: {
      type: "integer",
      minimum: 1,
      maximum: MAX_MATCHES_CAP,
      description: `Max matches to return in 'extract' mode when the 'g' flag is set (default ${DEFAULT_MAX_MATCHES}).`,
    },
  },
  required: ["pattern", "input"],
  additionalProperties: false,
} as const;

/**
 * Executed inside the worker thread spawned by `runBoundedRegex`. Plain
 * CommonJS source run via `eval: true` — this sidesteps resolving a sibling
 * file path across both the TS source tree (tests) and the compiled `dist/`
 * tree (runtime), since the source is a self-contained string either way.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const { pattern, flags, input, mode, maxMatches } = workerData;
  const re = new RegExp(pattern, flags);
  if (mode === "extract") {
    const matches = [];
    if (flags.includes("g")) {
      // Delegate iteration to String.prototype.matchAll: it is lazy and
      // implements the spec's AdvanceStringIndex, so zero-width matches
      // step forward by a full code point under the \`u\` flag instead of
      // one UTF-16 unit. A hand-rolled \`lastIndex += 1\` loop re-reports
      // index 0 forever over astral input (WARP-901 regression).
      for (const m of input.matchAll(re)) {
        matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
        if (matches.length >= maxMatches) break;
      }
    } else {
      const m = re.exec(input);
      if (m) matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
    }
    parentPort.postMessage({ ok: true, matched: matches.length > 0, matches });
  } else {
    parentPort.postMessage({ ok: true, matched: re.test(input) });
  }
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
}
`;

interface WorkerSuccess {
  ok: true;
  matched: boolean;
  matches?: Array<{ match: string; index: number; groups: Array<string | undefined> }>;
}
interface WorkerFailure {
  ok: false;
  error: string;
}
type WorkerOutcome = { timedOut: true } | { busy: true } | WorkerSuccess | WorkerFailure;

/** Runs the regex in a fresh worker thread and races it against a hard
 *  deadline. On timeout the worker is `terminate()`d — the only way to
 *  genuinely bound a runaway backtracking regex, since it never returns
 *  control on its own. Refuses to spawn (returns `{ busy: true }`) once
 *  `MAX_CONCURRENT_WORKERS` are already in flight. */
function runBoundedRegex(
  pattern: string,
  flags: string,
  input: string,
  mode: string,
  maxMatches: number,
): Promise<WorkerOutcome> {
  if (inFlightWorkers >= MAX_CONCURRENT_WORKERS) {
    return Promise.resolve({ busy: true });
  }
  inFlightWorkers += 1;

  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      // Pin worker startup to a clean argv — no inherited --inspect,
      // --max-old-space-size, loader flags, etc. Deterministic behavior
      // regardless of how the parent process was launched.
      execArgv: [],
      workerData: { pattern, flags, input, mode, maxMatches },
    });

    let settled = false;
    // Single settle path so the in-flight counter is decremented exactly
    // once no matter which of message/error/exit/timeout fires first.
    const finish = (outcome: WorkerOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlightWorkers -= 1;
      void worker.terminate();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ timedOut: true }), EXEC_TIMEOUT_MS);

    worker.once("message", (msg: WorkerSuccess | WorkerFailure) => finish(msg));

    worker.once("error", (err: Error) =>
      finish({ ok: false, error: String(err?.message ?? err) }),
    );

    // A worker that dies without posting (e.g. OOM-killed) would otherwise
    // hang until the timeout and be mislabeled REGEX_TIMEOUT. Surface the
    // real cause. On a normal run the `message` handler settles first, so
    // the post-terminate exit is a no-op here.
    worker.once("exit", (code: number) =>
      finish({ ok: false, error: `worker exited (${code}) before posting a result` }),
    );
  });
}

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  const input = typeof args.input === "string" ? args.input : "";
  const flags = typeof args.flags === "string" ? args.flags : "";
  const mode = args.mode === "extract" ? "extract" : "test";
  const maxMatches =
    typeof args.maxMatches === "number" && Number.isFinite(args.maxMatches)
      ? Math.max(1, Math.min(MAX_MATCHES_CAP, Math.floor(args.maxMatches)))
      : DEFAULT_MAX_MATCHES;

  if (!pattern) {
    return { ok: false, status: "error", error: { code: "INVALID_ARGS", message: "pattern is required" } };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      status: "error",
      error: { code: "PATTERN_TOO_LONG", message: `pattern exceeds ${MAX_PATTERN_LENGTH} chars` },
    };
  }
  if (input.length > MAX_INPUT_LENGTH) {
    return {
      ok: false,
      status: "error",
      error: { code: "INPUT_TOO_LONG", message: `input exceeds ${MAX_INPUT_LENGTH} chars` },
    };
  }
  if (!ALLOWED_FLAGS.test(flags)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_FLAGS", message: "flags must be a subset of 'g', 'i', 'm', 's', 'u'" },
    };
  }
  try {
    // Syntax validation only — constructing a RegExp never executes it
    // against input, so this step alone cannot hang.
    new RegExp(pattern, flags);
  } catch (err) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_PATTERN", message: String((err as Error)?.message ?? err) },
    };
  }

  const result = await runBoundedRegex(pattern, flags, input, mode, maxMatches);

  if ("busy" in result) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "REGEX_BUSY",
        message: `regex evaluation is at capacity (max ${MAX_CONCURRENT_WORKERS} concurrent evaluations) — retry shortly`,
      },
    };
  }
  if ("timedOut" in result) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "REGEX_TIMEOUT",
        message: `pattern did not finish within ${EXEC_TIMEOUT_MS}ms (likely catastrophic backtracking) — refine the pattern`,
      },
    };
  }
  if (!result.ok) {
    return { ok: false, status: "error", error: { code: "REGEX_EXEC_FAILED", message: result.error } };
  }
  if (mode === "extract") {
    return {
      ok: true,
      data: { type: "regex_test", mode, matched: result.matched, matches: result.matches ?? [] },
    };
  }
  return { ok: true, data: { type: "regex_test", mode, matched: result.matched } };
}

const tool: Tool = {
  name: "regex_test",
  description:
    `Test a regular expression against text, or extract matches. Bounded for safety: pattern capped at ${MAX_PATTERN_LENGTH} chars, input capped at ${MAX_INPUT_LENGTH} chars, flags limited to 'g'/'i'/'m'/'s'/'u', and execution runs in a worker thread with a hard ${EXEC_TIMEOUT_MS}ms timeout — a pathological pattern (catastrophic backtracking) is killed and reported as REGEX_TIMEOUT instead of hanging. mode 'test' (default) returns a boolean; mode 'extract' returns the matched substrings (combine the 'g' flag with maxMatches to bound how many).`,
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
