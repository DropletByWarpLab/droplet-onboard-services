/**
 * WARP-1749 (ADR-036 Phase 2) — `npm run model-id-migrate`.
 *
 * The explicit operator step that translates persisted model ids between the
 * Ollama and DMR vocabularies. It is NOT part of the runtime flip and NOT part
 * of boot: `migrate deploy` creates the journal tables and stops there
 * (`prisma/migrations/20260805120000_warp_1749_model_id_migration_journal/`).
 * A box where nobody runs this command behaves exactly as it does today.
 *
 * MODES
 * -----
 *   (default) --report    Print the plan. Touches NOTHING. Always safe.
 *             --apply     Rewrite Ollama ids → OCI ids, journaling each row.
 *             --rollback  Undo the most recent applied forward batch.
 *
 * Both write modes are idempotent — see `model-id-migration.service.ts`. Run
 * `--apply` twice and the second run finds every row already migrated and
 * writes nothing; run `--rollback` twice and the second finds no applied
 * forward batch.
 *
 * ORDERING (the part that bites)
 * ------------------------------
 * Flip the runtime FIRST, verify DMR actually serves, and migrate SECOND.
 * The full reasoning and both failure modes are in docs/MODEL_ID_MIGRATION.md;
 * the short version is that `--apply` rewrites rows into ids only DMR can
 * resolve, so doing it before you know DMR stands up on this hardware means
 * rolling back rows you should never have written. Running it in the wrong
 * order does not lose data — `resolveActiveChatModel` falls back rather than
 * failing — but it silently replaces the operator's model choice, which is
 * worse than an error because nothing says so.
 *
 * This command NEVER contacts a runtime and never reads the model list. It is
 * pure database work, which is what makes it runnable independently of the
 * flip.
 */
import { PrismaClient } from "@prisma/client";
import { createLogger } from "../lib/logger.js";
import {
  inferenceRuntime,
  type InferenceRuntimeName,
} from "../services/inference-runtime.js";
import {
  applyForwardMigration,
  applyRollback,
  collectStoredModelIds,
  planEnvAdvisories,
  planForwardMigration,
  planRollback,
  type EnvAdvisory,
  type MigrationPlan,
  type RollbackPlan,
} from "../services/model-id-migration.service.js";

export type MigrateMode = "report" | "apply" | "rollback";

export interface ParsedArgs {
  readonly mode: MigrateMode;
  readonly json: boolean;
  readonly note: string | undefined;
  /** Set when argv was invalid; `main` prints usage and exits 2. */
  readonly error: string | undefined;
}

/**
 * Parse argv. Pure, and deliberately strict: an unrecognised flag is an ERROR,
 * not something to ignore. A typo'd `--aply` must never be read as "report" and
 * leave an operator believing they migrated.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let mode: MigrateMode | undefined;
  let json = false;
  let note: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--report":
      case "--apply":
      case "--rollback": {
        const next = arg.slice(2) as MigrateMode;
        if (mode && mode !== next) {
          return { mode: "report", json, note, error: `--${mode} and ${arg} are mutually exclusive` };
        }
        mode = next;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--note": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          return { mode: "report", json, note, error: "--note needs a value" };
        }
        note = value;
        i++;
        break;
      }
      default:
        return { mode: "report", json, note, error: `unrecognised argument: ${arg}` };
    }
  }

  // Default is the mode that cannot do harm.
  return { mode: mode ?? "report", json, note, error: undefined };
}

export interface CliDeps {
  readonly collect: typeof collectStoredModelIds;
  readonly applyForward: typeof applyForwardMigration;
  readonly planBack: typeof planRollback;
  readonly applyBack: typeof applyRollback;
  /**
   * The backend discriminator, injected so the tests don't have to mutate
   * `process.env`. Defaults to the canonical `inferenceRuntime()` — there is
   * deliberately no second copy of the `INFERENCE_RUNTIME` parsing here. One
   * word selects the backend everywhere (ADR-036 §8); a CLI that decided for
   * itself what `dmr` means is exactly how a box ends up half-migrated.
   */
  readonly runtime: () => InferenceRuntimeName;
  /** Read for the `.env` model-var advisories only. Never written. */
  readonly env: NodeJS.ProcessEnv;
}

export interface CliOutcome {
  readonly mode: MigrateMode;
  readonly plan: MigrationPlan | null;
  readonly rollbackPlan: RollbackPlan | null;
  readonly advisories: readonly EnvAdvisory[];
  /** True when the runtime discriminator does not agree with the mode. */
  readonly runtimeMismatch: boolean;
  readonly changed: number;
  readonly batchId: string | null;
  readonly lines: readonly string[];
}

function describeUntouched(
  label: string,
  rows: readonly { site: string; rowKey: string; value: string; reason: string }[],
): string[] {
  if (rows.length === 0) return [];
  const lines = [`${label} (${rows.length}) — left exactly as stored:`];
  // Collapse by value: one chat table can hold thousands of rows naming the
  // same model, and a report the operator cannot read is not a report.
  const byValue = new Map<string, { count: number; reason: string; sample: string }>();
  for (const r of rows) {
    const seen = byValue.get(r.value);
    if (seen) seen.count++;
    else byValue.set(r.value, { count: 1, reason: r.reason, sample: `${r.site}:${r.rowKey}` });
  }
  for (const [value, info] of byValue) {
    lines.push(`  - "${value}" ×${info.count} (e.g. ${info.sample})`);
    lines.push(`      ${info.reason}`);
  }
  return lines;
}

/**
 * The whole decision, with I/O injected. `main()` below is only composition.
 */
export async function runModelIdMigrateCli(args: {
  readonly mode: MigrateMode;
  readonly note: string | undefined;
  readonly prisma: PrismaClient;
  readonly deps: CliDeps;
}): Promise<CliOutcome> {
  const { mode, note, prisma, deps } = args;
  const runtime = deps.runtime();
  const lines: string[] = [];

  if (mode === "rollback") {
    const rollbackPlan = await deps.planBack(prisma);
    // Rolling back to Ollama ids while the box is still running DMR is the
    // mirror-image mistake of migrating too early — warn, do not refuse.
    const runtimeMismatch = runtime === "dmr";
    if (!rollbackPlan.forwardBatchId) {
      lines.push("No applied forward batch — nothing to roll back. (No-op.)");
      return {
        mode, plan: null, rollbackPlan, advisories: [], runtimeMismatch,
        changed: 0, batchId: null, lines,
      };
    }
    if (runtimeMismatch) {
      lines.push(
        "WARNING: INFERENCE_RUNTIME=dmr, but this restores Ollama-vocabulary ids.",
        "         Revert INFERENCE_RUNTIME to ollama (and stop the DMR profile) after this.",
        "",
      );
    }
    const result = await deps.applyBack(prisma, rollbackPlan, note);
    lines.push(`Rolled back ${result.restored} value(s) from batch ${rollbackPlan.forwardBatchId}.`);
    if (result.skippedDrifted.length > 0) {
      lines.push(
        `SKIPPED ${result.skippedDrifted.length} row(s) changed since the migration — left as they are now:`,
      );
      for (const e of result.skippedDrifted) {
        lines.push(`  - ${e.site}:${e.rowKey} expected "${e.expectCurrent}"`);
      }
    }
    return {
      mode, plan: null, rollbackPlan, advisories: [], runtimeMismatch,
      changed: result.restored, batchId: result.batchId, lines,
    };
  }

  // report | apply — both start from the same freshly-computed plan.
  const stored = await deps.collect(prisma);
  const plan = planForwardMigration(stored);
  const advisories = planEnvAdvisories(deps.env);
  const runtimeMismatch = runtime !== "dmr";

  lines.push(
    `Inference runtime: ${runtime}`,
    `Scanned ${stored.length} persisted model id(s) across workspace_setting, chat_session, chat_message.`,
    "",
  );

  if (runtimeMismatch) {
    lines.push(
      "WARNING: INFERENCE_RUNTIME is not 'dmr'.",
      "         The OCI ids below only resolve on a box actually running Docker Model Runner.",
      "         Recommended order is flip-then-migrate — see docs/MODEL_ID_MIGRATION.md.",
      "",
    );
  }

  if (plan.changes.length === 0) {
    lines.push("Nothing to rewrite. (Already migrated, or nothing mapped.)");
  } else {
    lines.push(`Would rewrite ${plan.changes.length} value(s):`);
    const byPair = new Map<string, number>();
    for (const c of plan.changes) {
      const key = `${c.before} -> ${c.after}`;
      byPair.set(key, (byPair.get(key) ?? 0) + 1);
    }
    for (const [pair, count] of byPair) lines.push(`  - ${pair}  ×${count}`);
  }
  lines.push("");

  lines.push(...describeUntouched("BLOCKED — no DMR equivalent", plan.blocked));
  lines.push(...describeUntouched("Unknown / customer-pulled", plan.unknown));
  lines.push(...describeUntouched("Already migrated", plan.alreadyMigrated));
  if (plan.skipped > 0) lines.push(`Blank values skipped: ${plan.skipped}`);

  if (advisories.length > 0) {
    lines.push("", "Environment (ADVISORY — this command never edits .env):");
    for (const a of advisories) {
      const c = a.classification;
      const verdict =
        c.kind === "rewrite"
          ? `set to ${c.oci}`
          : c.kind === "already"
            ? "already an OCI id"
            : c.kind === "blocked"
              ? `BLOCKED — ${c.reason}`
              : "not a model this appliance configures — decide manually";
      lines.push(`  - ${a.variable}="${a.current}" → ${verdict}`);
    }
  }

  if (mode === "report") {
    lines.push("", "Report only — nothing was changed. Re-run with --apply to write.");
    return {
      mode, plan, rollbackPlan: null, advisories, runtimeMismatch,
      changed: 0, batchId: null, lines,
    };
  }

  const result = await deps.applyForward(prisma, plan, note);
  lines.push(
    "",
    result.batchId
      ? `Applied ${result.changed} change(s) as batch ${result.batchId}. Undo with --rollback.`
      : "Applied 0 changes — no batch recorded.",
  );
  return {
    mode, plan, rollbackPlan: null, advisories, runtimeMismatch,
    changed: result.changed, batchId: result.batchId, lines,
  };
}

const USAGE = `
Usage: npm run model-id-migrate -- [--report | --apply | --rollback] [--json] [--note "text"]

  --report    (default) print the plan, change nothing
  --apply     rewrite Ollama model ids to DMR OCI ids, journaling each row
  --rollback  undo the most recent applied forward batch
  --json      emit the outcome as JSON instead of text
  --note      free-text note recorded on the batch

Order matters: flip INFERENCE_RUNTIME=dmr and verify DMR serves BEFORE --apply.
See docs/MODEL_ID_MIGRATION.md.
`.trim();

/**
 * Composition root. Unlike `tls-deregister` (which must never fail a
 * factory-reset) this one DOES signal failure: an operator running a data
 * migration has to be able to tell success from a silent no-op.
 *   0 — did what was asked
 *   1 — failed
 *   2 — bad arguments
 */
async function main(): Promise<void> {
  const logger = createLogger("model-id-migrate");
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  const prisma = new PrismaClient();
  try {
    const outcome = await runModelIdMigrateCli({
      mode: parsed.mode,
      note: parsed.note,
      prisma,
      deps: {
        collect: collectStoredModelIds,
        applyForward: applyForwardMigration,
        planBack: planRollback,
        applyBack: applyRollback,
        runtime: inferenceRuntime,
        env: process.env,
      },
    });
    process.stdout.write(
      parsed.json
        ? `${JSON.stringify(outcome, null, 2)}\n`
        : `${outcome.lines.join("\n")}\n`,
    );
  } catch (err) {
    logger.error({ err }, "model-id-migrate failed");
    process.stderr.write(`model-id-migrate failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked as a script, so the test can import the module.
if (process.argv[1]?.includes("model-id-migrate")) {
  void main();
}
