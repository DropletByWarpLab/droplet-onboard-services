import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import appConfig from "../../apps/orchestrator/vitest.config.js";

const fromRoot = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

// Opt-in: the ordinary orchestrator suite does not need the Windows checkout.
export default defineConfig({
  ...appConfig,
  root: fromRoot(""),
  test: {
    ...appConfig.test,
    include: ["tests/native-windows/orchestrator.smoke.test.ts"],
    globalSetup: [fromRoot("apps/orchestrator/src/__tests__/env-preflight.globalSetup.ts")],
    setupFiles: (appConfig.test?.setupFiles as string[]).map((path) => fromRoot(`apps/orchestrator/${path}`)),
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
