import { defineConfig } from "vitest/config";

// Vitest 4 dropped `**/dist/**` from its default `exclude` (only node_modules
// and .git remain). This package's `tsc` build emits `dist/__tests__/*.test.js`
// as CommonJS, so once `npm run build` had run, a bare `vitest run` collected
// those compiled copies and failed them all with "Vitest cannot be imported in
// a CommonJS module using require()". Pin collection to the TypeScript sources.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
