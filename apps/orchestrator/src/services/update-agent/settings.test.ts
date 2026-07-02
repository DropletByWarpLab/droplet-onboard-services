/**
 * WARP-538 — update-agent settings persistence (SystemFlag-backed).
 *
 * Contract: tolerant reads (a corrupt/partial stored row degrades to the
 * defaults, never throws), strict writes (invalid channel / cron /
 * autoApply are refused loudly before anything is stored), and
 * read-your-writes roundtrip through one `update-agent.settings`
 * SystemFlag row.
 */
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  getUpdateAgentSettings,
  saveUpdateAgentSettings,
  DEFAULT_UPDATE_AGENT_SETTINGS,
  UPDATE_AGENT_SETTINGS_KEY,
} from "./settings.js";

function createPrismaStub(initial: Record<string, unknown> = {}) {
  const flags = { ...initial };
  return {
    _flags: flags,
    systemFlag: {
      findUnique: async (args: { where: { key: string } }) =>
        args.where.key in flags
          ? { key: args.where.key, valueJson: flags[args.where.key], createdAt: new Date() }
          : null,
      upsert: async (args: {
        where: { key: string };
        create: { key: string; valueJson: unknown };
        update: { valueJson: unknown };
      }) => {
        flags[args.where.key] =
          args.where.key in flags ? args.update.valueJson : args.create.valueJson;
        return {
          key: args.where.key,
          valueJson: flags[args.where.key],
          createdAt: new Date(),
        };
      },
    },
  };
}

const asPrisma = (stub: ReturnType<typeof createPrismaStub>) =>
  stub as never as PrismaClient;

describe("update-agent settings (WARP-538)", () => {
  it("returns the design defaults when nothing is persisted", async () => {
    const settings = await getUpdateAgentSettings(asPrisma(createPrismaStub()));
    expect(settings).toEqual({
      channel: "stable",
      applyWindowCron: "0 3 * * *",
      autoApply: true,
    });
    expect(settings).toEqual(DEFAULT_UPDATE_AGENT_SETTINGS);
  });

  it("roundtrips a partial save and merges over current values", async () => {
    const stub = createPrismaStub();
    const saved = await saveUpdateAgentSettings(asPrisma(stub), {
      applyWindowCron: "30 4 * * *",
      autoApply: false,
    });
    expect(saved).toEqual({
      channel: "stable",
      applyWindowCron: "30 4 * * *",
      autoApply: false,
    });
    // Read-your-writes through the SystemFlag row.
    expect(await getUpdateAgentSettings(asPrisma(stub))).toEqual(saved);
    expect(stub._flags[UPDATE_AGENT_SETTINGS_KEY]).toEqual(saved);
  });

  it("refuses an invalid cron expression loudly, storing nothing", async () => {
    const stub = createPrismaStub();
    await expect(
      saveUpdateAgentSettings(asPrisma(stub), { applyWindowCron: "not a cron" }),
    ).rejects.toThrow(/cron/i);
    expect(UPDATE_AGENT_SETTINGS_KEY in stub._flags).toBe(false);
  });

  it("refuses an empty channel", async () => {
    await expect(
      saveUpdateAgentSettings(asPrisma(createPrismaStub()), { channel: "  " }),
    ).rejects.toThrow(/channel/i);
  });

  it("degrades a corrupt stored row to defaults instead of throwing", async () => {
    const stub = createPrismaStub({
      [UPDATE_AGENT_SETTINGS_KEY]: {
        channel: 42,
        applyWindowCron: "garbage",
        autoApply: "yes",
        unknownField: true,
      },
    });
    expect(await getUpdateAgentSettings(asPrisma(stub))).toEqual(
      DEFAULT_UPDATE_AGENT_SETTINGS,
    );
  });

  it("keeps valid stored fields while defaulting the invalid ones", async () => {
    const stub = createPrismaStub({
      [UPDATE_AGENT_SETTINGS_KEY]: { autoApply: false, applyWindowCron: 99 },
    });
    expect(await getUpdateAgentSettings(asPrisma(stub))).toEqual({
      ...DEFAULT_UPDATE_AGENT_SETTINGS,
      autoApply: false,
    });
  });
});
