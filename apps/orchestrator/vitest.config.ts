import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // WARP-1872 — one warning per RUN when the Node major doesn't match
    // engines.node. In setupFiles this printed once per test file and
    // buried everything; globalSetup runs once, in the main process.
    globalSetup: ["src/__tests__/env-preflight.globalSetup.ts"],
    setupFiles: [
      // WARP-1872 — FIRST on purpose: turns a missing cosign binary into a
      // named failure instead of 14 fake trust-chain breaks. Must precede
      // setup.ts so the cause aborts the file before anything else runs.
      "src/__tests__/env-preflight.setup.ts",
      "src/__tests__/setup.ts",
      // WARP-1690 — makes supertest bind the loopback address it dials.
      "src/__tests__/supertest-loopback.setup.ts",
    ],
    testTimeout: 10000,
    // WARP-1584 — child processes, not worker threads.
    //
    // A DIAGNOSABILITY setting, explicitly NOT a crash fix. When a tinypool
    // worker died mid-file (rbac.test.ts, reproducible on Node 24), the
    // default `threads` pool exited 127 having printed NOTHING: no error,
    // no test counts, no way to tell which tests never ran. The same death
    // under `forks` prints "Worker exited unexpectedly" and
    // "Tests 316 passed (496)" — it names the failure AND its blast radius.
    // Both are red builds; only one can be debugged from CI logs.
    //
    // Costs nothing: measured on Node 20 (the CI version) over three runs
    // each of the 496-test rbac file, forks 5.97/6.07/6.05s vs threads
    // 6.21/5.68/6.06s.
    //
    // Pinned by src/__tests__/rbac-census.guard.test.ts. If worker deaths
    // show up in CI, the next escalation is `fileParallelism: false` — left
    // off deliberately: it serialises every file in the app, and the crash
    // does not reproduce on Node 20 at all (10/10 clean), so there is no
    // evidence it is needed.
    pool: "forks",
  },
});
