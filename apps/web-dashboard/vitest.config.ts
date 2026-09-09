import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// WARP-2613 — every path below is anchored to THIS FILE's directory
// (`__dirname` in a vite config is the config file's own location), never to
// `process.cwd()` or to whatever `root` the caller happened to pass.
//
// That matters for `server.fs.allow`. Vitest derives its default from
// `searchForWorkspaceRoot(options.root || process.cwd())` and does not
// normalise `options.root` first, so `vitest run --root apps/web-dashboard`
// (a RELATIVE root, run from the repo root) yields a relative allow entry that
// can never match an absolute file path. Everything the dashboard imports from
// outside its own package is then refused mid-transform:
//
//   Error: Denied ID <repo>/docs/integrations/ADD-A-PROVIDER.md?raw
//
// which takes out `src/lib/integration-guides.test.ts` and
// `src/components/help/__tests__/IntegrationGuideView.test.tsx` — the two
// suites that gate the customer setup guides actually being bundled into the
// dashboard (`integration-guides.ts` inlines them with `?raw`).
//
// Listed by directory, not by widening to a parent: the dashboard package
// itself, the `docs/` tree the guide imports reach into, the workspace
// `packages/` that resolve through symlinks to their real paths, and the
// hoisted `node_modules` vitest loads its own runtime from.
const packageRoot = __dirname;
const repoRoot = path.resolve(packageRoot, "../..");

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/__tests__/setup.ts"],

    // WARP-2696 — this MUST stay above the `asyncUtilTimeout: 5000` that
    // `src/__tests__/setup.ts` configures, and the gap is the whole point.
    //
    // WARP-1421 raised Testing Library's ceiling to 5000 ms so a findBy/waitFor
    // would survive a saturated runner. It did not raise this one, which vitest
    // defaults to 5000 ms — so the async helpers' budget became exactly the
    // test's entire budget, and two things broke at once:
    //
    //   1. A test that legitimately awaits more than once (findBy the prompt,
    //      waitFor the POST, waitFor the second POST — see
    //      `admin-audit.agent-runs-panel.test.tsx`) can spend its whole 5000 ms
    //      on the first two waits and time out on a third that would have
    //      resolved. Nothing is wrong with the component or the assertion; the
    //      budget was already gone. That is the flake, and no amount of
    //      re-running fixes it.
    //   2. A waitFor that genuinely fails can never report WHY. It polls until
    //      5000 ms, but the test dies at the same instant, so the failure
    //      surfaces as a bare "Test timed out in 5000ms" instead of the
    //      assertion's own message. Every wrong-signal race in this suite has
    //      been reading as an opaque timeout, which is exactly why they kept
    //      getting written off as "just needs a re-run".
    //
    // 20 s is not "wait longer until it passes" — the helpers still give up at
    // 5000 ms each and still report their own error, which is what makes a real
    // failure diagnosable. This only stops the suite from running out of test
    // before it runs out of wait. A genuinely hung test still fails, at 20 s.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  server: {
    fs: {
      allow: [
        packageRoot,
        path.join(repoRoot, "docs"),
        path.join(repoRoot, "packages"),
        path.join(repoRoot, "node_modules"),
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(packageRoot, "./src"),
    },
  },
});
