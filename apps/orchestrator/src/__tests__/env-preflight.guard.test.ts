/**
 * WARP-1872 — pins the preflight guard's wiring, mechanism, and claims.
 *
 * The guard's whole value is that it fires on the RIGHT suites with the
 * RIGHT cause. Ways it could rot silently, all cheap to pin:
 *   - a cosign-dependent test file is renamed, the list matches nothing,
 *     and the confusing 14-test failure comes back;
 *   - the setup file stops being registered (or stops being first);
 *   - a vitest upgrade renames the `__vitest_worker__.filepath` internal
 *     the scoping depends on, so the guard protects nothing;
 *   - the messages drift into blaming the wrong cause, which would make
 *     this a second lying gate rather than a fix.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  COSIGN_DEPENDENT_SUITES,
  ORCHESTRATOR_ROOT,
  cosignSpawnFailure,
  cosignUnavailableMessage,
  isCosignDependent,
  majorFromRange,
  nodeMismatchMessage,
  nodePinVerdict,
  nodeWarningIfMismatched,
  requiredNodeRange,
  runningInCi,
  resolveCosignBin,
  toOrchestratorRelative,
} from "./env-preflight.js";

describe("env preflight guard (WARP-1872)", () => {
  it("lists at least one cosign-dependent suite", () => {
    expect(COSIGN_DEPENDENT_SUITES.length).toBeGreaterThan(0);
  });

  it("every listed cosign-dependent suite still exists", () => {
    for (const rel of COSIGN_DEPENDENT_SUITES) {
      expect(
        existsSync(path.join(ORCHESTRATOR_ROOT, rel)),
        `${rel} is listed as cosign-dependent but does not exist — the guard ` +
          `now covers nothing. Update COSIGN_DEPENDENT_SUITES.`,
      ).toBe(true);
    }
  });

  it("matches cosign-dependent files and leaves the rest alone", () => {
    for (const rel of COSIGN_DEPENDENT_SUITES) {
      expect(isCosignDependent(path.join(ORCHESTRATOR_ROOT, rel))).toBe(true);
    }
    // Same directory, but never reaches a cosign spawn — failing these
    // on a missing binary would be a regression, not a fix.
    for (const rel of [
      "src/services/update-agent/manifest.test.ts",
      "src/services/update-agent/apply.test.ts",
      "src/services/update-agent/verify.toctou.test.ts",
    ]) {
      expect(
        isCosignDependent(path.join(ORCHESTRATOR_ROOT, rel)),
        `${rel} passes without cosign today and must not be gated`,
      ).toBe(false);
    }
  });

  it("normalises absolute paths to orchestrator-relative POSIX", () => {
    const abs = path.join(ORCHESTRATOR_ROOT, "src", "services", "x.test.ts");
    expect(toOrchestratorRelative(abs)).toBe("src/services/x.test.ts");
  });

  // The scoping depends on a vitest internal. If an upgrade renames it,
  // fail HERE rather than let the guard quietly stop protecting.
  it("vitest still exposes the test filepath the scoping relies on", () => {
    const w = (globalThis as { __vitest_worker__?: { filepath?: string } })
      .__vitest_worker__;
    expect(
      w?.filepath,
      "__vitest_worker__.filepath is gone — env-preflight.setup.ts can no " +
        "longer tell which suite it is loading for; rework its scoping.",
    ).toEqual(expect.any(String));
    expect(w!.filepath!.length).toBeGreaterThan(0);
  });

  it("is wired into vitest.config.ts, preflight before setup.ts", () => {
    const cfg = readFileSync(
      path.join(ORCHESTRATOR_ROOT, "vitest.config.ts"),
      "utf8",
    );
    const preflight = cfg.indexOf("env-preflight.setup.ts");
    const setup = cfg.indexOf("__tests__/setup.ts");
    expect(preflight, "env-preflight.setup.ts is not in setupFiles").toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(-1);
    expect(
      preflight,
      "preflight must precede setup.ts so it aborts the file first",
    ).toBeLessThan(setup);
    expect(
      cfg.indexOf("env-preflight.globalSetup.ts"),
      "the run-level Node warning is not registered as globalSetup",
    ).toBeGreaterThan(-1);
  });

  it("resolves the cosign binary exactly as verify.ts does", () => {
    const prior = process.env.DROPLET_COSIGN_BIN;
    try {
      delete process.env.DROPLET_COSIGN_BIN;
      expect(resolveCosignBin()).toBe("cosign");
      process.env.DROPLET_COSIGN_BIN = "/custom/cosign";
      expect(resolveCosignBin()).toBe("/custom/cosign");
    } finally {
      if (prior === undefined) delete process.env.DROPLET_COSIGN_BIN;
      else process.env.DROPLET_COSIGN_BIN = prior;
    }
  });

  it("reports a nonexistent binary as a spawn failure", () => {
    expect(
      cosignSpawnFailure(
        path.join(ORCHESTRATOR_ROOT, "definitely-not-a-real-cosign-binary"),
      ),
    ).toBe("ENOENT");
  });

  it("reads engines.node from the root package.json", () => {
    const range = requiredNodeRange();
    expect(range).toBeTruthy();
    expect(majorFromRange(range!)).toBe(20);
  });

  it("warns only on a mismatched Node major", () => {
    expect(nodeWarningIfMismatched("20.11.0")).toBeNull();
    expect(nodeWarningIfMismatched("24.15.0")).toMatch(/Node 20\.x expected/);
  });

  // The failure mode this whole ticket is about: a guard that names the
  // wrong cause is not an improvement, it is a second lying gate.
  it("the cosign message names cosign and clears the signing code", () => {
    const msg = cosignUnavailableMessage("cosign", "ENOENT");
    expect(msg).toMatch(/cosign not found/);
    expect(msg).toMatch(/NOT A TRUST-CHAIN BUG/);
    expect(msg).toMatch(/DROPLET_COSIGN_BIN/);
  });

  it("the Node warning never blames Node for signature failures", () => {
    const msg = nodeMismatchMessage("20.x", "v24.15.0");
    expect(msg).toMatch(/does NOT cause signature-test failures/);
    expect(msg).toMatch(/check cosign, not your Node version/);
  });

  // WARP-2626 — the pin stopped being advisory-only. Four implementers lost
  // time to the same Node-major symptom because nothing named the pin or the
  // class of failure it hides, and nothing failed when a runner drifted off it.
  describe("Node pin enforcement (WARP-2626)", () => {
    it("names the pin, how to switch, and the failure class it hides", () => {
      const msg = nodeMismatchMessage("20.x", "v26.0.0");
      expect(msg, "must name every place the pin is declared").toMatch(/\.nvmrc/);
      expect(msg).toMatch(/engines\.node/);
      expect(msg, "must say how to switch, not just that it is wrong").toMatch(/nvm use/);
      expect(
        msg,
        "must name the dispatcher/fetch class — a bare version warning is what " +
          "everyone already ignored",
      ).toMatch(/UND_ERR_INVALID_ARG/);
      expect(msg).toMatch(/WARP-2626/);
    });

    it("recognises CI, and ignores a falsy CI a developer may have exported", () => {
      expect(runningInCi({ CI: "true" })).toBe(true);
      expect(runningInCi({ CI: "1" })).toBe(true);
      for (const CI of ["", "0", "false"]) expect(runningInCi({ CI })).toBe(false);
      expect(runningInCi({})).toBe(false);
    });

    it("is silent on a matching Node, in CI and out", () => {
      expect(nodePinVerdict("20.11.0", { CI: "true" })).toBeNull();
      expect(nodePinVerdict("20.11.0", {})).toBeNull();
    });

    it("warns locally but FAILS in CI on a mismatched major", () => {
      // Locally: advisory. A contributor with no nvm/fnm must still be able
      // to run the suite — the pin-sensitive behaviour is asserted directly
      // by api-auth.dispatcher.test.ts, not by the runtime version.
      expect(nodePinVerdict("26.0.0", {})).toMatchObject({ fatal: false });
      // In CI: fatal. Runners are pinned by setup-node, so a mismatch means
      // a workflow drifted from .nvmrc/engines.node — the exact drift that
      // ships a Node-major-sensitive defect to the field.
      expect(nodePinVerdict("26.0.0", { CI: "true" })).toMatchObject({ fatal: true });
    });

    it("globalSetup throws on the fatal verdict rather than only logging", () => {
      // The verdict is worthless if the caller prints it either way.
      const src = readFileSync(
        path.join(ORCHESTRATOR_ROOT, "src/__tests__/env-preflight.globalSetup.ts"),
        "utf8",
      );
      expect(src, "globalSetup must consume the verdict, not the raw warning").toMatch(
        /nodePinVerdict/,
      );
      expect(src, "a fatal verdict must abort the run").toMatch(/throw new Error/);
    });
  });
});
