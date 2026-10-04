/**
 * WARP-3609 — `RAG_EVAL_ENABLED` / `RAGAS_EVAL_USER` config.
 *
 * The retrieval-eval routes are gated on an EXPLICIT positive flag, not on
 * NODE_ENV (the orchestrator container never sets it): absent means off,
 * and "0"/"false" must not read as on (`z.coerce.boolean()` would — the same
 * foot-gun as DROPLET_CLAIM_GATE_ENABLED). Isolated module registry per case,
 * same approach as config.analytics.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const VARS = ["RAG_EVAL_ENABLED", "RAGAS_EVAL_USER"] as const;

describe("WARP-3609 — RAG_EVAL_ENABLED / RAGAS_EVAL_USER config", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it("defaults: route OFF and no eval account (nothing derives it from NODE_ENV)", async () => {
    const { config } = await import("./config.js");
    expect(config.RAG_EVAL_ENABLED).toBe(false);
    expect(config.RAGAS_EVAL_USER).toBe("");
  });

  it('stays OFF for the explicit falsey strings "0" and "false"', async () => {
    for (const v of ["0", "false", ""]) {
      process.env.RAG_EVAL_ENABLED = v;
      vi.resetModules();
      const { config } = await import("./config.js");
      expect(config.RAG_EVAL_ENABLED).toBe(false);
    }
  });

  it('turns ON only for "1"/"true"', async () => {
    for (const v of ["1", "true", "TRUE"]) {
      process.env.RAG_EVAL_ENABLED = v;
      vi.resetModules();
      const { config } = await import("./config.js");
      expect(config.RAG_EVAL_ENABLED).toBe(true);
    }
  });

  it("reads the configured eval account", async () => {
    process.env.RAGAS_EVAL_USER = "eval-fixtures";
    const { config } = await import("./config.js");
    expect(config.RAGAS_EVAL_USER).toBe("eval-fixtures");
  });
});
