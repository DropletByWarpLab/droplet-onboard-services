/**
 * WARP-3532 — every `OffLanChannelKey` member is mirrored in each hand-kept
 * list, or this goes red.
 *
 * The enum is closed on purpose (ADR-012: extending the vocabulary is a schema
 * change), but the schema is only the first of several places that name the
 * keys, and four of them are plain string lists nobody generates:
 *
 *   - `OFF_LAN_CHANNEL_DEFAULTS` — the first-boot seed. A key missing here has
 *     no `OffLanAllowlistChannel` row, so its gate reads "no row" and the
 *     owner has no switch to turn it on.
 *   - `routes/settings.ts` — the only list `PATCH /off-lan/:key` accepts, and
 *     the one `GET` reads `requiresOwner` from. A key missing here 404s the
 *     owner's own switch.
 *   - `routes/off-lan-network.ts` — the zod enum the meter's sample batch is
 *     validated against. A key missing here silently drops its bytes.
 *   - `services/routing/egress_meter.py` — the Python meter's `CHANNEL_KEYS`.
 *
 * WARP-3264 added `place_lookup` to all of them by hand, and the same hand-edit
 * is how `ambient_data` went missing from the meter until WARP-2904 (its own
 * comment in egress_meter.py says so).
 * This pins the set instead of trusting the next author to remember it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OFF_LAN_CHANNEL_DEFAULTS } from "../services/workspace-settings.service.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** Members of `enum OffLanChannelKey { ... }`, comments and blank lines dropped. */
function schemaChannelKeys(): string[] {
  const schema = read("apps/orchestrator/prisma/schema.prisma");
  const body = /enum OffLanChannelKey \{([\s\S]*?)\n\}/.exec(schema)?.[1];
  if (!body) throw new Error("enum OffLanChannelKey not found in schema.prisma");
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"));
}

const KEYS = schemaChannelKeys();

describe("OffLanChannelKey mirrors (WARP-3532)", () => {
  it("reads a plausible vocabulary out of schema.prisma", () => {
    // Guards the parser, not the schema: an empty or tiny list would make every
    // assertion below vacuous.
    expect(KEYS.length).toBeGreaterThanOrEqual(9);
    expect(KEYS).toContain("work_integrations");
    expect(KEYS).toContain("remote_mcp"); // WARP-3912
  });

  it("seeds a default row for every key, and only for real keys", () => {
    expect(OFF_LAN_CHANNEL_DEFAULTS.map((d) => d.key).sort()).toEqual([...KEYS].sort());
  });

  it.each([
    "apps/orchestrator/src/routes/settings.ts",
    "apps/orchestrator/src/routes/off-lan-network.ts",
    "apps/orchestrator/src/__tests__/setup.ts",
    "services/routing/egress_meter.py",
  ])("%s names every key", (rel) => {
    const source = read(rel);
    const missing = KEYS.filter((key) => !source.includes(`"${key}"`));
    expect(missing, `${rel} is missing: ${missing.join(", ")}`).toEqual([]);
  });
});
