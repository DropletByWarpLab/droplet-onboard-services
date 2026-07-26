/**
 * WARP-1541 — Postgres-image parity between the local pg lane and CI.
 *
 * scripts/test-orchestrator-pg.sh (Docker backend) and the `pg-integration`
 * job in .github/workflows/orchestrator-tests.yml both apply the full
 * Prisma migration set, which includes
 * 20260412000000_add_file_content_index (`CREATE EXTENSION IF NOT EXISTS
 * vector`). Plain postgres:16 does not ship the pgvector extension, so
 * `prisma migrate deploy` fails on it — the image must be
 * pgvector/pgvector:pg16 in BOTH places, and must stay the SAME string so
 * "works locally" keeps meaning "works in CI".
 *
 * Same file-text-regression discipline as access-role.schema.test.ts: no
 * DB needed, runs in the default DB-less vitest lane. The parity assert is
 * self-updating — it extracts the image from the workflow and requires the
 * script to match, so a future CI bump (e.g. pg17) fails here until the
 * script follows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// vitest runs with cwd = apps/orchestrator; both files live at repo root.
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github",
  "workflows",
  "orchestrator-tests.yml",
);
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "test-orchestrator-pg.sh");

/** The service-container image of the pg-integration job. */
function ciPgImage(): string {
  const workflow = readFileSync(WORKFLOW_PATH, "utf-8");
  const jobStart = workflow.search(/^ {2}pg-integration:/m);
  expect(
    jobStart,
    "orchestrator-tests.yml must declare a pg-integration job",
  ).toBeGreaterThanOrEqual(0);
  const image = workflow.slice(jobStart).match(/^\s*image:\s*(\S+)/m);
  expect(image, "pg-integration job must declare a service image").not.toBeNull();
  return image![1]!;
}

/** The image the script's Docker backend boots (last arg of `docker run`). */
function scriptPgImage(): string {
  const script = readFileSync(SCRIPT_PATH, "utf-8");
  const runBlock = script.match(/docker run[\s\S]*?>\/dev\/null/);
  expect(
    runBlock,
    "test-orchestrator-pg.sh must boot its throwaway Postgres via docker run",
  ).not.toBeNull();
  const image = runBlock![0].match(/(\S+)\s+>\/dev\/null/);
  expect(image, "docker run must end with the image argument").not.toBeNull();
  return image![1]!;
}

describe("WARP-1541 pg-lane image parity (script vs CI)", () => {
  it("CI's pg-integration job boots a pgvector image (migration set runs CREATE EXTENSION vector)", () => {
    expect(ciPgImage()).toMatch(/pgvector/);
  });

  it("test-orchestrator-pg.sh boots the exact CI image — no silent divergence", () => {
    expect(scriptPgImage()).toBe(ciPgImage());
  });
});
