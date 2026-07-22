/**
 * Agent step-budget knobs (2026-07-21 agent-budgets spec §1) — the pure
 * resolver behind `config.agentMaxIter`. A misconfigured env (DEFAULT > CAP)
 * must clamp with a warning, never crash boot or silently break chat.
 */
import { describe, it, expect, vi } from "vitest";
import { config, resolveAgentIterLimits } from "../config.js";

describe("shipped agent iteration defaults", () => {
  it("resolve to 10/10 — the 2026-07-21 staging step-sweep outcome (findings-2026-07-21-tuning.md)", () => {
    // Env-unset boot (this test env) must yield the measured winner, not the
    // pre-tuning 5. A regression to 5 silently reverts the phase-2 result.
    expect(config.agentMaxIter).toEqual({ defaultIter: 10, capIter: 10 });
  });
});

describe("resolveAgentIterLimits (spec §1)", () => {
  it("passes well-formed values through unchanged", () => {
    const warn = vi.fn();
    expect(resolveAgentIterLimits(5, 10, warn)).toEqual({
      defaultIter: 5,
      capIter: 10,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("allows DEFAULT === CAP without warning", () => {
    const warn = vi.fn();
    expect(resolveAgentIterLimits(10, 10, warn)).toEqual({
      defaultIter: 10,
      capIter: 10,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("clamps DEFAULT down to CAP and warns when DEFAULT > CAP", () => {
    const warn = vi.fn();
    expect(resolveAgentIterLimits(12, 8, warn)).toEqual({
      defaultIter: 8,
      capIter: 8,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("AGENT_MAX_ITER_DEFAULT");
  });
});
