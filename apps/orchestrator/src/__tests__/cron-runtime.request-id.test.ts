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
});
