/**
 * ADR-039 §7 — `npm run finetune-export`.
 *
 * Produces the dataset the tool-use LoRA adapter is trained from. Two
 * products, and the gate between them is the whole point:
 *
 *   (default)                 tools.json — the canonical registry rendered as
 *                             training input. Derived from committed source,
 *                             contains NO customer data, safe to hand to the
 *                             training repo unreviewed.
 *
 *   --include-user-content    ALSO trajectories.jsonl — curated real
 *                             conversations. Redacted (never optionally), but
 *                             redaction is not anonymization: names, addresses
 *                             and room labels survive by design because no
 *                             scrubber removes them. ADR-039 §3.
 *
 * This command WRITES FILES AND NOTHING ELSE. It does not train, does not
 * upload, and does not contact a runtime. Getting the files off the box is a
 * deliberate manual operator step — an automated trace pipeline is a
 * phone-home channel wearing a lab coat, which ADR-012 exists to prevent.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createLogger } from "../lib/logger.js";
import {
  buildToolManifest,
  curateMessages,
  renderJsonl,
  type CurationSummary,
  type DropReason,
  type SourceMessage,
  type ToolManifest,
  type TrainingRecord,
} from "../services/finetune-dataset.service.js";

const logger = createLogger("finetune-export");

const DEFAULT_OUT_DIR = "./finetune-dataset";
const DEFAULT_SESSION_LIMIT = 500;

export const USAGE = `Usage: npm run finetune-export -- [options]

Exports the ADR-039 tool-use training dataset. Writes files; trains nothing.

  --out <dir>              Output directory (default: ${DEFAULT_OUT_DIR})
  --include-user-content   ALSO export curated chat trajectories. Customer
                           content. Redacted, NOT anonymized — read ADR-039 §3
                           before running this on a real appliance.
  --include-no-tool-turns  Keep zero-tool turns as "correctly no tool"
                           negatives (only with --include-user-content).
  --session-limit <n>      Most recent sessions to read (default ${DEFAULT_SESSION_LIMIT}).
  --json                   Emit the summary as JSON.
  --help                   Show this message.`;

export interface ParsedArgs {
  readonly outDir: string;
  readonly includeUserContent: boolean;
  readonly includeNoToolTurns: boolean;
  readonly sessionLimit: number;
  readonly json: boolean;
  readonly help: boolean;
  /** Set when argv was invalid; `main` prints usage and exits 2. */
  readonly error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const base: ParsedArgs = {
    outDir: DEFAULT_OUT_DIR,
    includeUserContent: false,
    includeNoToolTurns: false,
    sessionLimit: DEFAULT_SESSION_LIMIT,
    json: false,
    help: false,
  };
  let out = base;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        out = { ...out, help: true };
        break;
      case "--json":
        out = { ...out, json: true };
        break;
      case "--include-user-content":
        out = { ...out, includeUserContent: true };
        break;
      case "--include-no-tool-turns":
        out = { ...out, includeNoToolTurns: true };
        break;
      case "--out": {
        const value = argv[++i];
        if (!value) return { ...out, error: "--out requires a directory" };
        out = { ...out, outDir: value };
        break;
      }
      case "--session-limit": {
        const value = argv[++i];
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          return { ...out, error: `--session-limit must be a positive integer, got ${value ?? "nothing"}` };
        }
        out = { ...out, sessionLimit: n };
        break;
      }
      default:
        return { ...out, error: `unknown argument: ${arg}` };
    }
  }
  // A flag that only means something under another one is a silent no-op
  // otherwise — say so rather than writing a manifest the operator will
  // wrongly read as having honoured it.
  if (out.includeNoToolTurns && !out.includeUserContent) {
    return { ...out, error: "--include-no-tool-turns requires --include-user-content" };
  }
  return out;
}

/** The subset of Prisma this command needs — narrowed so tests can fake it. */
export interface SessionReader {
  read(limit: number): Promise<readonly (readonly SourceMessage[])[]>;
}

export interface ExportDeps {
  readonly reader: SessionReader;
  readonly manifest: ToolManifest;
  readonly writeOut: (path: string, contents: string) => Promise<void>;
}

export interface ExportOutcome {
  readonly manifestPath: string;
  readonly toolCount: number;
  readonly fingerprint: string;
  readonly trajectoriesPath: string | null;
  readonly summary: CurationSummary | null;
  readonly lines: readonly string[];
}

const DROP_LABELS: Record<DropReason, string> = {
  not_completed: "turn never completed",
  negative_feedback: "thumbs-down",
  tool_error: "tool returned an error",
  unknown_tool: "tool no longer in the registry",
  no_tool_calls: "no tool calls",
  incomplete_exchange: "incomplete exchange",
  // WARP-2425 — the connector firewall. Shown in the histogram like every
  // other reason so an operator can SEE how much of their history was excluded
  // for reading a customer's books, rather than wondering where it went.
  connector_records: "read a connected system of record (excluded, WARP-2425)",
};

export async function runFinetuneExportCli(
  args: ParsedArgs,
  deps: ExportDeps,
): Promise<ExportOutcome> {
  const lines: string[] = [];
  const manifestPath = join(args.outDir, "tools.json");
  await deps.writeOut(manifestPath, JSON.stringify(deps.manifest, null, 2) + "\n");
  lines.push(
    `wrote ${manifestPath} — ${deps.manifest.toolCount} tools, fingerprint ${deps.manifest.fingerprint.slice(0, 12)}`,
  );

  if (!args.includeUserContent) {
    lines.push(
      "trajectories: skipped (pass --include-user-content to export customer conversations; ADR-039 §3)",
    );
    return {
      manifestPath,
      toolCount: deps.manifest.toolCount,
      fingerprint: deps.manifest.fingerprint,
      trajectoriesPath: null,
      summary: null,
      lines,
    };
  }

  const knownTools = new Set(deps.manifest.tools.map((t) => t.name));
  const sessions = await deps.reader.read(args.sessionLimit);
  const records: TrainingRecord[] = [];
  const dropped: Record<DropReason, number> = {
    not_completed: 0,
    negative_feedback: 0,
    tool_error: 0,
    unknown_tool: 0,
    no_tool_calls: 0,
    incomplete_exchange: 0,
    connector_records: 0,
  };
  for (const messages of sessions) {
    const run = curateMessages(messages, {
      knownTools,
      includeNoToolTurns: args.includeNoToolTurns,
      registryFingerprint: deps.manifest.fingerprint,
    });
    records.push(...run.records);
    for (const reason of Object.keys(dropped) as DropReason[]) {
      dropped[reason] += run.summary.dropped[reason];
    }
  }

  const trajectoriesPath = join(args.outDir, "trajectories.jsonl");
  await deps.writeOut(trajectoriesPath, renderJsonl(records));

  const summary: CurationSummary = { kept: records.length, dropped };
  lines.push(
    `wrote ${trajectoriesPath} — ${records.length} records from ${sessions.length} sessions`,
  );
  for (const reason of Object.keys(dropped) as DropReason[]) {
    if (dropped[reason] > 0) {
      lines.push(`  dropped ${dropped[reason]} — ${DROP_LABELS[reason]}`);
    }
  }
  lines.push(
    "REVIEW BEFORE THIS LEAVES THE BOX: secrets are redacted, personal detail is NOT (ADR-039 §3).",
  );

  return {
    manifestPath,
    toolCount: deps.manifest.toolCount,
    fingerprint: deps.manifest.fingerprint,
    trajectoriesPath,
    summary,
    lines,
  };
}

/** Prisma-backed reader: most recent sessions, messages in write order. */
export function prismaSessionReader(prisma: PrismaClient): SessionReader {
  return {
    async read(limit) {
      const sessions = await prisma.chatSession.findMany({
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          messages: {
            orderBy: { createdAt: "asc" },
            select: {
              role: true,
              content: true,
              toolCalls: true,
              turnId: true,
              status: true,
              feedback: true,
              model: true,
              provider: true,
            },
          },
        },
      });
      return sessions.map((s) =>
        s.messages.map((m) => ({
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls as SourceMessage["toolCalls"],
          turnId: m.turnId,
          status: String(m.status),
          feedback: m.feedback === null ? null : String(m.feedback),
          model: m.model,
          provider: m.provider,
        })),
      );
    },
  };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  const prisma = new PrismaClient();
  try {
    const outcome = await runFinetuneExportCli(args, {
      reader: prismaSessionReader(prisma),
      manifest: buildToolManifest(),
      writeOut: async (path, contents) => {
        await mkdir(args.outDir, { recursive: true });
        await writeFile(path, contents, "utf8");
      },
    });
    process.stdout.write(
      args.json
        ? `${JSON.stringify(outcome, null, 2)}\n`
        : `${outcome.lines.join("\n")}\n`,
    );
  } catch (err) {
    logger.error({ err }, "finetune-export failed");
    process.stderr.write(`finetune-export failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked as a script, so the test can import the module.
if (process.argv[1]?.includes("finetune-export")) {
  void main();
}
