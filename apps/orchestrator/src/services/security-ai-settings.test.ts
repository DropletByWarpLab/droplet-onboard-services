/**
 * WARP-2979 (ADR-059 P4 §4.2) — the one AI-settings row, created lazily by
 * its first reader: INSERT … ON CONFLICT DO NOTHING and a read, never
 * `upsert({update: {}})` (Prisma 5 runs that as read-then-insert, and two
 * first readers race into a unique violation). The pg lane proves the
 * defaults against the CHECK (security-ai-schema.pg.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { readSecurityAiSettings, SECURITY_AI_SETTINGS_ID } from "./security-ai-settings.js";

function db(existing: { linking: string; summaries: string; version: number } | null) {
  const created = { linking: "link_and_suggest", summaries: "on", version: 0 };
  return {
    securityAiSettings: {
      findUnique: vi.fn().mockResolvedValue(existing),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(created),
      upsert: vi.fn(),
    },
  };
}

describe("readSecurityAiSettings", () => {
  it("reads the row when it exists, and creates nothing", async () => {
    const p = db({ linking: "suggest_only", summaries: "off", version: 7 });
    expect(await readSecurityAiSettings(p as never)).toEqual({ linking: "suggest_only", summaries: "off", version: 7 });
    expect(p.securityAiSettings.findUnique.mock.calls[0][0].where).toEqual({ id: SECURITY_AI_SETTINGS_ID });
    expect(p.securityAiSettings.createMany).not.toHaveBeenCalled();
    expect(p.securityAiSettings.upsert).not.toHaveBeenCalled();
  });

  it("on first sight inserts the singleton with its defaults (skipDuplicates), then reads it — never an upsert", async () => {
    const p = db(null);
    expect(await readSecurityAiSettings(p as never)).toEqual({ linking: "link_and_suggest", summaries: "on", version: 0 });
    expect(p.securityAiSettings.createMany).toHaveBeenCalledWith({ data: [{ id: "singleton" }], skipDuplicates: true });
    expect(p.securityAiSettings.findUniqueOrThrow.mock.calls[0][0].where).toEqual({ id: "singleton" });
    expect(p.securityAiSettings.upsert).not.toHaveBeenCalled();
  });

  it("a database that cannot be read rejects — never read as the defaults or as off", async () => {
    const p = db(null);
    p.securityAiSettings.findUnique.mockRejectedValue(new Error("db down"));
    await expect(readSecurityAiSettings(p as never)).rejects.toThrow("db down");
    expect(p.securityAiSettings.createMany).not.toHaveBeenCalled();
  });
});
