/**
 * ADR-039 §7 — `finetune-export` CLI.
 *
 * The gate is the thing under test: a run that has not been asked for
 * customer content must not write customer content, and there must be no
 * argv spelling that reaches trajectories by accident.
 */
import { describe, it, expect } from "vitest";
import {
  parseArgs,
  runFinetuneExportCli,
  type ExportDeps,
  type ParsedArgs,
} from "./finetune-export.js";
import {
  buildToolManifest,
  type SourceMessage,
  type ToolManifest,
} from "../services/finetune-dataset.service.js";

const MANIFEST: ToolManifest = {
  fingerprint: "f".repeat(64),
  toolCount: 2,
  tools: [
    {
      name: "list_cameras",
      description: "d",
      inputSchema: { type: "object" },
      requiresWrite: false,
      requiresConfirmation: false,
      domain: "cameras",
    },
    {
      name: "set_wifi_password",
      description: "d",
      inputSchema: { type: "object" },
      requiresWrite: true,
      requiresConfirmation: true,
      domain: "network",
    },
  ],
};

function msg(over: Partial<SourceMessage> & { role: string }): SourceMessage {
  return {
    content: "",
    toolCalls: null,
    turnId: "t1",
    status: "completed",
    feedback: null,
    model: "gpt-oss:20b",
    provider: "ollama",
    ...over,
  };
}

const SESSION: SourceMessage[] = [
  msg({ role: "user", content: "which cameras?" }),
  msg({
    role: "assistant",
    content: "One.",
    toolCalls: [
      { id: "c1", name: "list_cameras", args: {}, ok: true, data: { n: 1 } },
    ],
  }),
];

/** Collect writes instead of touching the filesystem. */
function harness(sessions: readonly (readonly SourceMessage[])[] = [SESSION]) {
  const writes = new Map<string, string>();
  const deps: ExportDeps = {
    manifest: MANIFEST,
    reader: { read: async () => sessions },
    writeOut: async (path, contents) => {
      writes.set(path, contents);
    },
  };
  return { deps, writes };
}

function args(over: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    outDir: "/out",
    includeUserContent: false,
    includeNoToolTurns: false,
    sessionLimit: 500,
    json: false,
    help: false,
    ...over,
  };
}

describe("parseArgs", () => {
  it("defaults to manifest-only", () => {
    const a = parseArgs([]);
    expect(a.error).toBeUndefined();
    expect(a.includeUserContent).toBe(false);
    expect(a.includeNoToolTurns).toBe(false);
  });

  it("reads --out and --session-limit", () => {
    const a = parseArgs(["--out", "/tmp/ds", "--session-limit", "10"]);
    expect(a.outDir).toBe("/tmp/ds");
    expect(a.sessionLimit).toBe(10);
  });

  it("rejects a non-numeric or non-positive session limit", () => {
    expect(parseArgs(["--session-limit", "abc"]).error).toBeTruthy();
    expect(parseArgs(["--session-limit", "0"]).error).toBeTruthy();
    expect(parseArgs(["--session-limit", "-5"]).error).toBeTruthy();
  });

  it("rejects --out with no value", () => {
    expect(parseArgs(["--out"]).error).toBeTruthy();
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(parseArgs(["--include-everything"]).error).toContain("unknown");
  });

  // A silently-ignored flag would let an operator believe negatives were
  // included when nothing read the flag at all.
  it("rejects --include-no-tool-turns without --include-user-content", () => {
    expect(parseArgs(["--include-no-tool-turns"]).error).toBeTruthy();
    expect(
      parseArgs(["--include-no-tool-turns", "--include-user-content"]).error,
    ).toBeUndefined();
  });

  it("takes --help before validating anything else", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});

describe("runFinetuneExportCli", () => {
  it("writes only the manifest by default", async () => {
    const { deps, writes } = harness();
    const outcome = await runFinetuneExportCli(args(), deps);
    expect([...writes.keys()]).toEqual(["/out/tools.json"]);
    expect(outcome.trajectoriesPath).toBeNull();
    expect(outcome.summary).toBeNull();
  });

  // The load-bearing assertion: without the flag, no customer utterance is
  // written anywhere, not even into the manifest.
  it("never emits customer content without --include-user-content", async () => {
    const { deps, writes } = harness();
    await runFinetuneExportCli(args(), deps);
    const all = [...writes.values()].join("\n");
    expect(all).not.toContain("which cameras?");
  });

  it("says why trajectories were skipped", async () => {
    const { deps } = harness();
    const outcome = await runFinetuneExportCli(args(), deps);
    expect(outcome.lines.join("\n")).toContain("--include-user-content");
  });

  it("writes parseable JSONL when asked for user content", async () => {
    const { deps, writes } = harness();
    const outcome = await runFinetuneExportCli(
      args({ includeUserContent: true }),
      deps,
    );
    expect(outcome.trajectoriesPath).toBe("/out/trajectories.jsonl");
    const body = writes.get("/out/trajectories.jsonl") ?? "";
    const lines = body.trimEnd().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).provenance.registryFingerprint).toBe(
      MANIFEST.fingerprint,
    );
    expect(outcome.summary?.kept).toBe(1);
  });

  it("aggregates drop reasons across sessions", async () => {
    const rejected: SourceMessage[] = [
      msg({ role: "user", content: "hi" }),
      msg({ role: "assistant", content: "hello", status: "failed" }),
    ];
    const { deps } = harness([SESSION, rejected]);
    const outcome = await runFinetuneExportCli(
      args({ includeUserContent: true }),
      deps,
    );
    expect(outcome.summary?.kept).toBe(1);
    expect(outcome.summary?.dropped.not_completed).toBe(1);
    expect(outcome.lines.join("\n")).toContain("turn never completed");
  });

  it("warns that personal detail survives redaction", async () => {
    const { deps } = harness();
    const outcome = await runFinetuneExportCli(
      args({ includeUserContent: true }),
      deps,
    );
    expect(outcome.lines.join("\n")).toContain("REVIEW BEFORE THIS LEAVES");
  });

  it("writes an empty trajectories file rather than none when nothing survives", async () => {
    const { deps, writes } = harness([[]]);
    await runFinetuneExportCli(args({ includeUserContent: true }), deps);
    expect(writes.get("/out/trajectories.jsonl")).toBe("");
  });

  it("passes the session limit through to the reader", async () => {
    let seen = -1;
    const deps: ExportDeps = {
      manifest: MANIFEST,
      reader: {
        read: async (limit) => {
          seen = limit;
          return [];
        },
      },
      writeOut: async () => {},
    };
    await runFinetuneExportCli(
      args({ includeUserContent: true, sessionLimit: 7 }),
      deps,
    );
    expect(seen).toBe(7);
  });
});

describe("manifest wiring", () => {
  it("serializes the real registry manifest as valid JSON", async () => {
    const writes = new Map<string, string>();
    await runFinetuneExportCli(args(), {
      manifest: buildToolManifest(),
      reader: { read: async () => [] },
      writeOut: async (p, c) => {
        writes.set(p, c);
      },
    });
    const parsed = JSON.parse(writes.get("/out/tools.json") ?? "{}");
    expect(parsed.tools.length).toBe(parsed.toolCount);
    expect(parsed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
