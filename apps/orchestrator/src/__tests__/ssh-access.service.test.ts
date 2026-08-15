/**
 * WARP-1984 — the container half of the SSH toggle.
 *
 * The load-bearing behaviour here is the READBACK, not the write. Reporting
 * our own intent as state would show a green toggle over a box nobody can
 * actually reach the moment the host units are missing, masked, or failing —
 * and "the dashboard said SSH was on" is precisely the wrong thing to be
 * wrong about during an incident. Every case below pins the honest answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ssh-access-"));
  process.env.DROPLET_SSH_ACCESS_DIR = dir;
  // The module reads the env var at import time, so each case needs a fresh
  // module instance bound to its own temp dir.
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DROPLET_SSH_ACCESS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  return import("../services/ssh-access.service.js");
}

function writeState(value: string, changedAt = "2026-08-13T10:00:00Z") {
  writeFileSync(join(dir, "state"), `state=${value}\nchanged_at=${changedAt}\n`);
}

describe("readSshAccess — reports the HOST's state, not our intent", () => {
  it("says `unknown` when the host has never written state", async () => {
    const { readSshAccess } = await load();
    // A box whose host units were never installed. Distinct from "off": the
    // operator needs to know the toggle is not wired up, not be told a
    // comforting falsehood.
    expect(await readSshAccess()).toEqual({
      enabled: false,
      status: "unknown",
      changedAt: null,
    });
  });

  it("reports enabled once the host confirms `on`", async () => {
    writeState("on");
    const { readSshAccess } = await load();
    const status = await readSshAccess();
    expect(status.enabled).toBe(true);
    expect(status.status).toBe("applied");
    expect(status.changedAt).toBe("2026-08-13T10:00:00Z");
  });

  it("stays `pending` while our intent and the host's state disagree", async () => {
    // The exact shape of a host unit that is masked or erroring: we asked for
    // `on`, the host still says `off`. Showing "applied" here would be the
    // green-toggle-over-a-closed-door failure.
    writeState("off");
    const { setSshAccess, readSshAccess } = await load();
    await setSshAccess(true);
    const status = await readSshAccess();
    expect(status.status).toBe("pending");
    expect(status.enabled).toBe(false);
  });

  it("settles to `applied` once the host catches up", async () => {
    writeState("off");
    const { setSshAccess, readSshAccess } = await load();
    await setSshAccess(true);
    writeState("on", "2026-08-13T10:05:00Z");
    const status = await readSshAccess();
    expect(status.status).toBe("applied");
    expect(status.enabled).toBe(true);
  });

  it("treats a malformed state file as unknown, never as enabled", async () => {
    // Fail-closed on the security-relevant axis: under-claim access, never
    // over-claim it.
    writeFileSync(join(dir, "state"), "state=yes-please\ngarbage\n");
    const { readSshAccess } = await load();
    const status = await readSshAccess();
    expect(status.enabled).toBe(false);
    expect(status.status).toBe("unknown");
  });
});

describe("setSshAccess — writes an intent the host script can parse", () => {
  it("writes exactly the one whitelisted key, in the shape the script greps", async () => {
    const { setSshAccess } = await load();
    await setSshAccess(true);
    const raw = readFileSync(join(dir, "intent.d", "intent"), "utf8");
    expect(raw).toMatch(/^DROPLET_SSH_ACCESS=on$/m);

    await setSshAccess(false);
    expect(readFileSync(join(dir, "intent.d", "intent"), "utf8")).toMatch(
      /^DROPLET_SSH_ACCESS=off$/m,
    );
  });

  it("leaves no temp file behind — the watcher must see one atomic change", async () => {
    // The .path unit fires on PathModified. A lingering `.tmp` would mean the
    // rename never happened and the watcher could read a partial file.
    const { setSshAccess } = await load();
    await setSshAccess(true);
    expect(existsSync(join(dir, "intent.d", "intent.tmp"))).toBe(false);
    expect(existsSync(join(dir, "intent.d", "intent"))).toBe(true);
  });

  it("never writes the state file — that is the host's word, not ours", async () => {
    const { setSshAccess } = await load();
    await setSshAccess(true);
    expect(existsSync(join(dir, "state"))).toBe(false);
  });
});
