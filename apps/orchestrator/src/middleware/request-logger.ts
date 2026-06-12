import pinoHttp from "pino-http";

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;

export const requestLogger = pinoHttp({
  level: isTest ? "silent" : "info",
  // No transport: "pino-http/lib/transport" is not a resolvable transport
  // target (pino-http ships no lib/ subpath), so pino's fixTarget threw at
  // require time and the orchestrator crashed on every NODE_ENV=development
  // boot. Plain JSON request logs work everywhere; pretty dev logs can be
  // had by piping through `npx pino-pretty`.
});
