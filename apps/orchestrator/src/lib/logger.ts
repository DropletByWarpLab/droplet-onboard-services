import pino from "pino";
import { getRequestId } from "./request-context.js";

/**
 * Canonical orchestrator logger factory. The `mixin` runs on every log call
 * and stamps the current request id (from AsyncLocalStorage) onto the line, so
 * deep service-layer logs carry the same `requestId` as request handlers
 * without threading it through call signatures (WARP-108).
 *
 * `dest` is for tests only (a writable sink); production omits it and pino
 * writes JSON to stdout as before.
 */
const LEVELS: ReadonlySet<string> = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

/**
 * WARP-2178 — the level comes from `LOG_LEVEL` (default `info`). Until this
 * line, pino ran at its own default and nothing in the orchestrator read the
 * variable, so every `logger.debug` — including the per-dispatch
 * `agent_tool_result_size` measurement — was unreachable in production. Read
 * per logger creation (module load), so it is a process-start setting: change
 * `.env`, then `up -d --force-recreate orchestrator` (`docker restart` does not
 * re-read `env_file`). An unknown value falls back to `info` rather than
 * throwing at boot.
 */
export function levelFromEnv(env: NodeJS.ProcessEnv = process.env): pino.LevelWithSilent {
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  return raw && LEVELS.has(raw) ? (raw as pino.LevelWithSilent) : "info";
}

export function createLogger(
  name: string,
  dest?: { write: (s: string) => void },
): pino.Logger {
  const opts: pino.LoggerOptions = {
    name,
    level: levelFromEnv(),
    mixin() {
      return { requestId: getRequestId() ?? "no-request-context" };
    },
  };
  return dest ? pino(opts, dest as pino.DestinationStream) : pino(opts);
}
