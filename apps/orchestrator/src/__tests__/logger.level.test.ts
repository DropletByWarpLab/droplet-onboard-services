/**
 * WARP-2178 — the orchestrator's log level comes from LOG_LEVEL.
 *
 * Before this, pino ran at its own default and nothing read the variable, so
 * every `logger.debug` — including the per-dispatch `agent_tool_result_size`
 * measurement this ticket depends on — was unreachable in production.
 */
import { describe, it, expect } from "vitest";
import { createLogger, levelFromEnv } from "../lib/logger.js";

describe("orchestrator log level (WARP-2178)", () => {
  it("defaults to info when LOG_LEVEL is unset or unknown", () => {
    expect(levelFromEnv({})).toBe("info");
    expect(levelFromEnv({ LOG_LEVEL: "" })).toBe("info");
    expect(levelFromEnv({ LOG_LEVEL: "verbose" })).toBe("info");
  });

  it("honours a known level, case-insensitively", () => {
    expect(levelFromEnv({ LOG_LEVEL: "debug" })).toBe("debug");
    expect(levelFromEnv({ LOG_LEVEL: " WARN " })).toBe("warn");
    expect(levelFromEnv({ LOG_LEVEL: "silent" })).toBe("silent");
  });

  it("createLogger applies it — a debug line is emitted at debug and dropped at info", () => {
    const prior = process.env.LOG_LEVEL;
    try {
      const lines: string[] = [];
      const sink = { write: (s: string) => void lines.push(s) };
      process.env.LOG_LEVEL = "debug";
      createLogger("t", sink).debug({ tool: "read_file" }, "agent_tool_result_size");
      expect(lines.some((l) => l.includes("agent_tool_result_size"))).toBe(true);

      lines.length = 0;
      process.env.LOG_LEVEL = "info";
      createLogger("t", sink).debug({ tool: "read_file" }, "agent_tool_result_size");
      expect(lines).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prior;
    }
  });
});
