/**
 * WARP-2367 — the tool-surface drift gate.
 *
 * Regenerates the snapshot into a tmp file and byte-compares it with the
 * committed artefact, in the shape `schemas-tests.yml` established for
 * committed codegen. Editing the classification table without regenerating —
 * or hand-editing the JSON without changing the table — turns this red.
 *
 * Regenerate with:
 *   UPDATE_ATLASSIAN_SNAPSHOT=1 npm run -w @droplet/orchestrator test -- atlassian-tool-snapshot
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATLASSIAN_SNAPSHOT_FORMAT,
  ATLASSIAN_SNAPSHOT_PATH,
  buildAtlassianToolSnapshot,
} from "./atlassian-tool-snapshot.js";
import {
  ATLASSIAN_TOOL_CLASSIFICATIONS,
  ATLASSIAN_V1_READ_TOOLS,
} from "./atlassian-tool-policy.js";
import { repoPath } from "../__tests__/helpers/test-paths.js";

// Anchored to this test file, not to `process.cwd()` (WARP-2654).
const committedPath = repoPath(ATLASSIAN_SNAPSHOT_PATH);

describe("the Atlassian tool-surface snapshot", () => {
  it("regenerates into tmp byte-identically to the committed artefact", () => {
    const regenerated = buildAtlassianToolSnapshot();

    // Into tmp first, exactly as the committed-codegen convention does it, so
    // the comparison is of FILES and cannot accidentally compare a string with
    // itself.
    const dir = mkdtempSync(join(tmpdir(), "atlassian-snapshot-"));
    const tmpFile = join(dir, "atlassian-mcp-tool-surface.json");
    writeFileSync(tmpFile, regenerated, "utf8");

    if (process.env.UPDATE_ATLASSIAN_SNAPSHOT === "1") {
      writeFileSync(committedPath, regenerated, "utf8");
    }

    expect(
      existsSync(committedPath),
      `${ATLASSIAN_SNAPSHOT_PATH} is missing — regenerate with ` +
        "UPDATE_ATLASSIAN_SNAPSHOT=1",
    ).toBe(true);

    const committed = readFileSync(committedPath, "utf8");
    const fromTmp = readFileSync(tmpFile, "utf8");
    expect(
      fromTmp,
      `${ATLASSIAN_SNAPSHOT_PATH} is out of date with ` +
        "atlassian-tool-policy.ts. This file is a SECURITY artefact — read the " +
        "diff as a privilege change before regenerating with " +
        "UPDATE_ATLASSIAN_SNAPSHOT=1.",
    ).toBe(committed);
  });

  it("carries its provenance in the file, not only in a PR description", () => {
    const doc = JSON.parse(readFileSync(committedPath, "utf8")) as {
      format: number;
      provenance: string;
      toolCount: number;
      v1ReadToolCount: number;
      tools: { name: string }[];
    };
    expect(doc.format).toBe(ATLASSIAN_SNAPSHOT_FORMAT);
    expect(doc.provenance).toContain("2026-09-02");
    // The honest half: it says what it is NOT.
    expect(doc.provenance).toContain("NOT a probe of the API-token path");
  });

  it("counts agree with the table it was generated from", () => {
    const doc = JSON.parse(readFileSync(committedPath, "utf8")) as {
      toolCount: number;
      v1ReadToolCount: number;
      tools: { name: string }[];
    };
    expect(doc.toolCount).toBe(ATLASSIAN_TOOL_CLASSIFICATIONS.length);
    expect(doc.v1ReadToolCount).toBe(ATLASSIAN_V1_READ_TOOLS.size);
    expect(doc.tools).toHaveLength(ATLASSIAN_TOOL_CLASSIFICATIONS.length);
  });

  it("is sorted by name, so a moved row produces no diff and a NEW row produces one", () => {
    const doc = JSON.parse(readFileSync(committedPath, "utf8")) as {
      tools: { name: string }[];
    };
    const names = doc.tools.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
