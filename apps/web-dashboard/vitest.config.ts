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
