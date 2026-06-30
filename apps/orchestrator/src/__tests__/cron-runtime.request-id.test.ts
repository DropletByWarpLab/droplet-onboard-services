import { describe, it, expect } from "vitest";
import { createCronRuntime } from "../services/cron-runtime.service.js";
import { getRequestId } from "../lib/request-context.js";

describe("cron-runtime request-id", () => {
  it("runs the handler inside a fresh request-id context", async () => {
    const ids: (string | undefined)[] = [];
    const silent = { warn() {}, error() {}, debug() {} };
    const rt = createCronRuntime(undefined, silent);
    // Drive one tick by registering a 10ms interval then stopping.
    await new Promise<void>((resolve) => {
      rt.scheduleInterval(10, () => {
        ids.push(getRequestId());
        rt.stop();
        resolve();
      });
    });
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    // Outside any tick there is no context.
    expect(getRequestId()).toBeUndefined();
  });

  it("includes requestId on the failure-path log", async () => {
    const calls: any[] = [];

    await new Promise<void>((resolve) => {
      const logger = {
        warn() {},
        error: (obj: any) => {
          calls.push(obj);
          // Resolve from the logger callback itself — deterministic,
          // no setTimeout race with the handler's throw.
          resolve();
        },
        debug() {},
      };
      const runtime = createCronRuntime(undefined, logger);
      runtime.scheduleInterval(10, () => {
        runtime.stop();
        throw new Error("boom");
      });
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
