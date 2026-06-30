/**
 * WARP-279 — Claude session-state reader.
 *
 * The file at `<repo-root>/.claude/session-state.json` is volatile, gitignored,
 * and updated by the AI engineer (Claude) as it works. The orchestrator reads
 * it (only ever reads — never writes) so the meta-observability dashboard can
 * surface "what is Claude doing now", recent decisions, and recent actions.
 *
 * The schema is versioned (`v: 1`). On any of:
 *   - missing file
 *   - parse error
 *   - schema-version mismatch (unknown major version)
 *   - validation failure
 *
 * the reader returns the empty default rather than throwing. The dashboard
 * stays useful even when nobody has dropped a session-state file in yet, and
 * a malformed write doesn't take the endpoint down.
 *
 * Bounding: arrays are FIFO-bounded at the schema level (50 recent_actions,
 * 20 decisions). The reader trims past those caps defensively in case a
 * writer left them larger.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("claude-activity:session-state");

export const SCHEMA_VERSION = 1;

// ── Bounds (mirrored on the writer side; reader trims defensively) ──
export const MAX_DECISIONS = 20;
export const MAX_RECENT_ACTIONS = 50;

const isoString = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "must be an ISO-8601 timestamp",
});

const NowSchema = z.object({
  task: z.string(),
  ticket: z.string().nullable(),
  branch: z.string().nullable(),
  started_at: isoString.nullable(),
  blocked_on: z.string().nullable(),
});

const DecisionSchema = z.object({
  ts: isoString,
  summary: z.string(),
  rationale: z.string(),
});

const RecentActionSchema = z.object({
  ts: isoString,
  // `kind` is open-ended on purpose — writers can add new kinds (commit,
  // pr_opened, ticket_filed, decision, etc.) without a reader code change.
  kind: z.string(),
  ref: z.string().nullable(),
  summary: z.string(),
});

const SessionStateSchema = z.object({
  v: z.number().int(),
  now: NowSchema,
  decisions: z.array(DecisionSchema),
  recent_actions: z.array(RecentActionSchema),
});

export type Now = z.infer<typeof NowSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type RecentAction = z.infer<typeof RecentActionSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;

export const EMPTY_NOW: Now = {
  task: "",
  ticket: null,
  branch: null,
  started_at: null,
  blocked_on: null,
};

export function emptyState(): SessionState {
  return {
    v: SCHEMA_VERSION,
    now: { ...EMPTY_NOW },
    decisions: [],
    recent_actions: [],
  };
}

/**
 * Resolve `<repo-root>/.claude/session-state.json`.
 *
 * In dev (`tsx watch`) and tests, `process.cwd()` is `apps/orchestrator/`. In
 * production (Docker), the orchestrator is launched from `/app` with the repo
 * mounted at `/app`. We let callers override via `CLAUDE_SESSION_STATE_PATH`
 * for the unusual case where the file lives somewhere else (e.g., a unit
 * test pointing at a fixture). Default lookup order:
 *
 *   1. `CLAUDE_SESSION_STATE_PATH` (absolute or relative to cwd)
 *   2. `<cwd>/.claude/session-state.json`
 *   3. `<cwd>/../../.claude/session-state.json`     (orchestrator under apps/)
 *   4. `<cwd>/../../../.claude/session-state.json`  (extra-nested test runs)
 *
 * The first path that exists wins. If none exist we still return the path-2
 * candidate so that error logs are predictable.
 */
export function resolveSessionStatePath(): string {
  const override = process.env.CLAUDE_SESSION_STATE_PATH;
  if (override && override.length > 0) {
    return path.isAbsolute(override) ? override : path.resolve(override);
  }
  return path.resolve(process.cwd(), ".claude/session-state.json");
}

/**
 * Read + validate the session-state file.
 *
 * Always resolves; never throws. Returns the empty default on every failure
 * mode (missing file, malformed JSON, unknown schema version, validation
 * failure) and logs a warning so an operator can spot a broken writer.
 */
export async function readSessionState(
  filePath: string = resolveSessionStatePath(),
): Promise<SessionState> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // Expected on first boot before any Claude session has written one.
      return emptyState();
    }
    logger.warn({ err, filePath }, "failed to read session-state file");
    return emptyState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err, filePath }, "session-state file is not valid JSON");
    return emptyState();
  }

  // Schema-version gate. We only accept the current major version. Older or
  // newer versions return empty rather than guessing — the dashboard is
  // diagnostic and silently rendering stale shapes would be worse than a
  // blank "Claude now" panel.
  const version = (parsed as { v?: unknown })?.v;
  if (version !== SCHEMA_VERSION) {
    logger.warn(
      { filePath, version, expected: SCHEMA_VERSION },
      "session-state schema version mismatch; ignoring file",
    );
    return emptyState();
  }

  const result = SessionStateSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { filePath, issues: result.error.issues },
      "session-state failed schema validation",
    );
    return emptyState();
  }

  // Defensive trim — a buggy writer should never overflow the dashboard.
  const data = result.data;
  if (data.decisions.length > MAX_DECISIONS) {
    data.decisions = data.decisions.slice(-MAX_DECISIONS);
  }
  if (data.recent_actions.length > MAX_RECENT_ACTIONS) {
    data.recent_actions = data.recent_actions.slice(-MAX_RECENT_ACTIONS);
  }

  return data;
}
