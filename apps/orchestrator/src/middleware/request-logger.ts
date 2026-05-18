import pinoHttp from "pino-http";

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;

export const requestLogger = pinoHttp({
  level: isTest ? "silent" : "info",
  // Previous code attempted `transport: { target: "pino-http/lib/transport" }`
  // for pretty-printing in dev, but that module path doesn't exist
  // (pino-pretty is the intended target). Since pino-pretty isn't in
  // the orchestrator's dependency tree, we use pino's default JSON
  // output in dev too — the dashboard's `docker compose logs` is the
  // primary consumer and JSON is fine there. Re-enable pretty-print
  // later by adding pino-pretty to package.json + flipping the target.
});
