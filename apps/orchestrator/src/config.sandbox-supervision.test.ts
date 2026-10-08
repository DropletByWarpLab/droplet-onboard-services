import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("sandbox supervision config agrees with the existing sandbox flag", () => {
  const original = process.env.SANDBOX_PROCESS_SUPERVISION;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.SANDBOX_PROCESS_SUPERVISION;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SANDBOX_PROCESS_SUPERVISION;
    else process.env.SANDBOX_PROCESS_SUPERVISION = original;
  });

  it("ships disabled when unset", async () => {
    const { config } = await import("./config.js");
    expect(config.SANDBOX_PROCESS_SUPERVISION).toBe(false);
  });

  it.each(["1", "true", "yes", " yes "])("accepts the existing enable alias %j", async (value) => {
    process.env.SANDBOX_PROCESS_SUPERVISION = value;
    const { config } = await import("./config.js");
    expect(config.SANDBOX_PROCESS_SUPERVISION).toBe(true);
  });

  it.each(["0", "false", "no", "off", "", "TRUE", "unexpected"])("keeps %j disabled without rejecting startup", async (value) => {
    process.env.SANDBOX_PROCESS_SUPERVISION = value;
    const { config } = await import("./config.js");
    expect(config.SANDBOX_PROCESS_SUPERVISION).toBe(false);
  });
});
