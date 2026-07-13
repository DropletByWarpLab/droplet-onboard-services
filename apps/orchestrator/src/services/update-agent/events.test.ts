/**
 * WARP-541 — drift guard for the canonical `event: "update.*"` list.
 *
 * events.ts is the design list. This test scans every module that emits
 * update-agent events for `"update.<something>"` string literals and
 * fails when:
 *   - a source emits an event that is NOT in the canonical list
 *     (undocumented event — add it to events.ts), or
 *   - the canonical list documents an event NO source emits
 *     (dead documentation — remove it or wire it).
 * So the list in events.ts provably matches what the code does.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { UPDATE_EVENT_NAMES } from "./events.js";

/** Every module that emits (or names, for the index.ts wrapper) events. */
const EMITTING_SOURCES = [
  "poller.ts",
  "apply.ts",
  "transitions.ts",
  "settings.ts",
  "host-compose-runner.ts",
  "purge-update-backups.ts",
  "purge-self-swap-helpers.ts",
  "../../index.ts",
];

function eventsEmittedBy(relPath: string): string[] {
  const source = readFileSync(path.join(__dirname, relPath), "utf8");
  // Double-quoted "update.<x>" literals only — comments in these files
  // reference event names in backticks, so this matches emission sites
  // (and the two literal assignments in poller.ts's verify branch).
  return [...source.matchAll(/"(update\.[a-z0-9_]+)"/g)].map((m) => m[1]!);
}

describe("canonical update.* event list (WARP-541)", () => {
  const emitted = new Set(EMITTING_SOURCES.flatMap(eventsEmittedBy));
  const canonical = new Set<string>(UPDATE_EVENT_NAMES);

  it("every emitted event is documented in events.ts", () => {
    const undocumented = [...emitted].filter((e) => !canonical.has(e));
    expect(undocumented).toEqual([]);
  });

  it("every documented event is emitted somewhere", () => {
    const dead = [...canonical].filter((e) => !emitted.has(e));
    expect(dead).toEqual([]);
  });
});
