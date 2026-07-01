import { describe, it, expect } from "vitest";
import { createLogger } from "../lib/logger.js";
import { runWithRequestId } from "../lib/request-context.js";

describe("createLogger", () => {
  it("stamps requestId from context, no-request-context otherwise", () => {
    const lines: string[] = [];
    const log = createLogger("test", {
      write: (s: string) => lines.push(s),
    });
    log.info("outside");
    runWithRequestId("rid-42", () => log.info("inside"));
    const outside = JSON.parse(lines[0]);
    const inside = JSON.parse(lines[1]);
    expect(outside.requestId).toBe("no-request-context");
    expect(inside.requestId).toBe("rid-42");
    expect(outside.name).toBe("test");
  });
});
