import pinoHttp from "pino-http";

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;
const isDev = process.env.NODE_ENV === "development";

export const requestLogger = pinoHttp({
  level: isTest ? "silent" : "info",
  // Only use pretty-print transport in explicit local dev
  ...(isDev ? { transport: { target: "pino-http/lib/transport" } } : {}),
});
