/**
 * WARP-3047 — ONE active model drives the whole box.
 *
 * Before this ticket eleven server-side paths chose their model from
 * `process.env.DEFAULT_MODEL ?? process.env.LLM_MODEL` — query rewrites,
 * /llm/complete (translate_text, summarize_file), agent runs, email analysis,
 * the brain pass, retrieval eval, routine summaries and every warm. A switch
 * on the Models page moved the dashboard and nothing else, and on Docker Model
 * Runner (no memory-aware eviction) the env model kept loading NEXT TO the
 * active one until the GPU ran out. Every one of them now asks
 * `resolveActiveModel` (services/active-model.service.ts).
 *
 * The regression is one innocent line — "just default to LLM_MODEL here" — so
 * the rule is a test. Only these files may read the env model, each for a
 * reason that is not "which model answers":
 *
 *   - active-model.service.ts — the resolver's own LLM_MODEL fallback.
 *   - model-readiness.service.ts — the boot PULL loop: provisioning the
 *     seeded models is env-driven by design (it is not a model choice).
 *   - cloud-access.service.ts — provider routing parity with the gateway's
 *     router.py (`_local_model`): local vs cloud, never which model.
 *
 * MUTATIONS THIS CATCHES: any new `process.env.LLM_MODEL` /
 * `process.env.DEFAULT_MODEL` read (dot or bracket form) in a non-test source
 * file outside the list above.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { packagePath } from "./helpers/test-paths";

const SRC = packagePath("src");

const ALLOWED = new Set(
  [
    "services/active-model.service.ts",
    "services/model-readiness.service.ts",
    "services/cloud-access.service.ts",
  ].map((p) => path.join(SRC, p)),
);

const ENV_MODEL_READ =
  /process\.env(?:\.(?:DEFAULT_MODEL|LLM_MODEL)\b|\[\s*["'`](?:DEFAULT_MODEL|LLM_MODEL)["'`]\s*\])/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Reads every source file; generous ceiling for a cold, busy disk.
const SCAN_TIMEOUT_MS = 60_000;

describe("env model reads (WARP-3047)", () => {
  it("scans a real tree (a wrong root must not pass by reading nothing)", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    for (const allowed of ALLOWED) {
      expect(ENV_MODEL_READ.test(readFileSync(allowed, "utf8")), allowed).toBe(true);
    }
  }, SCAN_TIMEOUT_MS);

  it("only the allow-listed files read DEFAULT_MODEL / LLM_MODEL from env", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => ENV_MODEL_READ.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});
