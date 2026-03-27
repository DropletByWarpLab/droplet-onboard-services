import pinoHttp from "pino-http";

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST;
const isProd = process.env.NODE_ENV === "production";

export const requestLogger = pinoHttp({
  level: isTest ? "silent" : isProd ? "info" : "debug",
  // Disable pino pretty-printing in test — it breaks vitest
  ...(isProd || isTest ? {} : { transport: { target: "pino-http/lib/transport" } }),
});
