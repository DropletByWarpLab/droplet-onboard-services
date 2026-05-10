/**
 * WARP-279 — readSessionState unit tests.
 *
 * Covers the four failure modes the dashboard reader is required to handle
 * gracefully (missing file, malformed JSON, schema-version mismatch, schema
 * validation failure) plus the happy path. We use a tmp-dir per test so
 * concurrent runs can't trip over each other and so the on-disk fixture
 * matches the real shape rather than a mocked fs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readSessionState,
  emptyState,
  SCHEMA_VERSION,
} from "../services/claude-activity/session-state.js";

describe("readSessionState", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "warp-279-session-state-"));
    filePath = path.join(dir, "session-state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns parsed state on the happy path", async () => {
    const state = {
      v: SCHEMA_VERSION,
      now: {
        task: "Building dashboard",
        ticket: "WARP-279",
        branch: "WARP-279",
        started_at: "2026-05-10T18:00:00Z",
        blocked_on: null,
      },
      decisions: [
        {
          ts: "2026-05-10T17:50:00Z",
          summary: "Picked B",
          rationale: "LAN-only auth",
        },
      ],
      recent_actions: [
        {
          ts: "2026-05-10T18:00:00Z",
          kind: "ticket_filed",
          ref: "WARP-279",
          summary: "Filed ticket",
        },
      ],
    };
    await writeFile(filePath, JSON.stringify(state), "utf8");

    const got = await readSessionState(filePath);
    expect(got).toEqual(state);
  });

  it("returns the empty default when the file is missing", async () => {
    const got = await readSessionState(path.join(dir, "does-not-exist.json"));
    expect(got).toEqual(emptyState());
  });

  it("returns the empty default on malformed JSON", async () => {
    await writeFile(filePath, "{not json,", "utf8");
    const got = await readSessionState(filePath);
    expect(got).toEqual(emptyState());
  });

  it("returns the empty default on schema-version mismatch", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        v: 999,
        now: {
          task: "x",
          ticket: null,
          branch: null,
          started_at: null,
          blocked_on: null,
        },
        decisions: [],
        recent_actions: [],
      }),
      "utf8",
    );
    const got = await readSessionState(filePath);
    expect(got).toEqual(emptyState());
  });

  it("returns the empty default when validation fails (missing fields)", async () => {
    // Right schema version, but `now` is missing required fields. The reader
    // refuses to guess and falls back to empty rather than render half-data.
    await writeFile(
      filePath,
      JSON.stringify({
        v: SCHEMA_VERSION,
        now: { task: "x" },
        decisions: [],
        recent_actions: [],
      }),
      "utf8",
    );
    const got = await readSessionState(filePath);
    expect(got).toEqual(emptyState());
  });

  it("trims arrays past their bounds", async () => {
    // Writer overshoots the cap (50 recent_actions, 20 decisions) — the
    // reader trims defensively rather than blowing up the dashboard payload.
    const action = {
      ts: "2026-05-10T18:00:00Z",
      kind: "commit",
      ref: "abc1234",
      summary: "x",
    };
    const decision = {
      ts: "2026-05-10T18:00:00Z",
      summary: "x",
      rationale: "y",
    };
    const state = {
      v: SCHEMA_VERSION,
      now: {
        task: "x",
        ticket: null,
        branch: null,
        started_at: null,
        blocked_on: null,
      },
      // 60 recent_actions, 25 decisions — both above the cap.
      recent_actions: Array.from({ length: 60 }, (_, i) => ({
        ...action,
        summary: `action #${i}`,
      })),
      decisions: Array.from({ length: 25 }, (_, i) => ({
        ...decision,
        summary: `decision #${i}`,
      })),
    };
    await writeFile(filePath, JSON.stringify(state), "utf8");
    const got = await readSessionState(filePath);
    expect(got.recent_actions).toHaveLength(50);
    expect(got.decisions).toHaveLength(20);
    // FIFO trim retains the most recent (last) entries.
    expect(got.recent_actions[0]?.summary).toBe("action #10");
    expect(got.decisions[0]?.summary).toBe("decision #5");
  });
});
