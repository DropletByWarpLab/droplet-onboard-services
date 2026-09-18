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
      login: { username: null, status: "unknown" },
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

// ── WARP-2887 — the login the door uses ──────────────────────────────────────
//
// Two things must hold: what reaches the host is a hash (never plaintext),
// and what the dashboard is told is what the HOST reports (never what we
// wrote). `pending` for the login is read off TIME — the keys are one-shot,
// so a value comparison cannot tell "applied" from "not yet run".
const HASH = "$6$rounds=100000$saltstring$9s1nPRwOKo4FeNBCK5BUtBm4SG17hIi1AdBjtdwEAoIS.4ckJW8FPR8goM6zZZeHEFTq2BK/BQz3f/G/Yjbkg/";

function writeStateWithLogin(value: string, loginUser: string, loginResult: string, changedAt = "2026-09-17T10:00:00Z") {
  writeFileSync(
    join(dir, "state"),
    `state=${value}\nchanged_at=${changedAt}\nunit=ssh.service\nlogin_user=${loginUser}\nlogin_result=${loginResult}\n`,
  );
}

function intentText() {
  return readFileSync(join(dir, "intent.d", "intent"), "utf8");
}

/** The key lines of the intent file, in file order — comments and blanks dropped. */
function intentKeys() {
  return intentText()
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
}

describe("setSshLogin — what crosses the host boundary", () => {
  it("writes the username and the $6$ hash, and re-states the current access value", async () => {
    writeState("on");
    const { setSshLogin } = await load();
    await setSshLogin({ username: "support", passwordHash: HASH });
    const intent = intentText();
    expect(intent).toMatch(/^DROPLET_SSH_ACCESS=on$/m);
    expect(intent).toMatch(/^DROPLET_SSH_LOGIN_USER=support$/m);
    expect(intent).toMatch(new RegExp(`^DROPLET_SSH_LOGIN_HASH=${HASH.replace(/[$./]/g, "\\$&")}$`, "m"));
  });

  it("defaults the access value to off when the host has never reported", async () => {
    // No state file, no prior intent: re-stating `on` by accident would open
    // the door as a side effect of setting a login.
    const { setSshLogin } = await load();
    await setSshLogin({ username: "support", passwordHash: HASH });
    expect(intentText()).toMatch(/^DROPLET_SSH_ACCESS=off$/m);
  });

  it("keeps our own pending access intent when re-stating", async () => {
    writeState("off");
    const { setSshAccess, setSshLogin } = await load();
    await setSshAccess(true);
    await setSshLogin({ username: "support", passwordHash: HASH });
    expect(intentText()).toMatch(/^DROPLET_SSH_ACCESS=on$/m);
  });

  it("a toggle re-states a login the host has not applied yet", async () => {
    // The race: the owner sets a login, then flips the toggle before the root
    // path unit has consumed the intent. The file is rewritten whole, so a
    // toggle that wrote only the access key would erase the login keys and
    // the login would silently never be created — the card settling back to
    // "no login set" with nothing to say why.
    writeStateWithLogin("off", "", "none");
    const { setSshAccess, setSshLogin } = await load();
    await new Promise((r) => setTimeout(r, 20));
    await setSshLogin({ username: "support", passwordHash: HASH });
    const status = await setSshAccess(true);
    // All three keys, login keys FIRST and the toggle's NEW value last: the
    // host parses in one bounded pass that stops at the access key
    // (tests/droplet-ssh-access.test.sh pins that side).
    expect(intentKeys()).toEqual([
      "DROPLET_SSH_LOGIN_USER=support",
      `DROPLET_SSH_LOGIN_HASH=${HASH}`,
      "DROPLET_SSH_ACCESS=on",
    ]);
    expect(status.login.status).toBe("pending");
  });

  it.each([
    ["applied", "support"],
    ["refused", "oldlogin"],
  ])("a toggle drops login keys the host has already answered (%s)", async (loginResult, liveUser) => {
    // Once the host has answered, the live login is read back off the system.
    // Re-stating the keys would retry a refused login on every toggle, and
    // re-apply an applied one for nothing.
    writeStateWithLogin("off", "", "none");
    const { setSshAccess, setSshLogin } = await load();
    await setSshLogin({ username: "support", passwordHash: HASH });
    await new Promise((r) => setTimeout(r, 20));
    writeStateWithLogin("off", liveUser, loginResult, "2026-09-17T10:05:00Z");
    await setSshAccess(false);
    expect(intentKeys()).toEqual(["DROPLET_SSH_ACCESS=off"]);
  });

  it.each([
    ["an uppercase username", "Support", HASH],
    ["a reserved name", "root", HASH],
    ["a name with a metacharacter", "sup;port", HASH],
    ["a non-$6$ hash", "support", "$5$saltstring$notasha512hash"],
    ["a $6$ hash at the weak 5000-round default", "support", "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1"],
    ["a plaintext password where the hash belongs", "support", "correct horse battery"],
  ])("refuses %s without touching the intent file", async (_label, username, passwordHash) => {
    const { setSshLogin } = await load();
    await expect(setSshLogin({ username, passwordHash })).rejects.toThrow(/ssh login/);
    expect(existsSync(join(dir, "intent.d", "intent"))).toBe(false);
  });
});

describe("readSshAccess — login is what the HOST reports", () => {
  it("reports `unknown` from a pre-WARP-2887 state file", async () => {
    writeState("off");
    const { readSshAccess } = await load();
    expect((await readSshAccess()).login).toEqual({ username: null, status: "unknown" });
  });

  it("reports `none` when the host confirmed there is no login", async () => {
    writeStateWithLogin("off", "", "none");
    const { readSshAccess } = await load();
    expect((await readSshAccess()).login).toEqual({ username: null, status: "none" });
  });

  it("reports `set` with the host's username", async () => {
    writeStateWithLogin("off", "support", "applied");
    const { readSshAccess } = await load();
    expect((await readSshAccess()).login).toEqual({ username: "support", status: "set" });
  });

  it("reports `pending` while our intent is newer than the host's state", async () => {
    writeStateWithLogin("off", "", "none");
    const { setSshLogin } = await load();
    // The intent is written after the state file, so its mtime is later.
    const status = await setSshLogin({ username: "support", passwordHash: HASH });
    expect(status.login).toEqual({ username: null, status: "pending" });
  });

  it("settles once the host writes newer state, to whatever the host says", async () => {
    writeStateWithLogin("off", "", "none");
    const { setSshLogin, readSshAccess } = await load();
    await setSshLogin({ username: "support", passwordHash: HASH });
    await new Promise((r) => setTimeout(r, 20));
    writeStateWithLogin("off", "support", "applied", "2026-09-17T10:05:00Z");
    expect((await readSshAccess()).login).toEqual({ username: "support", status: "set" });
  });

  it("reports `refused` and keeps the previous login visible", async () => {
    writeStateWithLogin("off", "", "none");
    const { setSshLogin, readSshAccess } = await load();
    await setSshLogin({ username: "support", passwordHash: HASH });
    await new Promise((r) => setTimeout(r, 20));
    // The host kept the old account and rejected the new keys.
    writeStateWithLogin("off", "oldlogin", "refused", "2026-09-17T10:05:00Z");
    expect((await readSshAccess()).login).toEqual({ username: "oldlogin", status: "refused" });
  });

  // QA carry-path gaps (WARP-2887 sweep handoff): the "no state file" and
  // "pre-WARP-2887 state file" branches had no coverage.
  it("reports `pending` from the no-state-file branch once a login intent is written", async () => {
    // No state file at all (host has never run). A login we just asked for is
    // pending, not unknown — the readback's early no-hostState branch.
    const { setSshLogin, readSshAccess } = await load();
    expect((await readSshAccess()).login).toEqual({ username: null, status: "unknown" });
    await setSshLogin({ username: "support", passwordHash: HASH });
    expect((await readSshAccess()).login).toEqual({ username: null, status: "pending" });
  });

  it("reports `pending` then `unknown` against a pre-WARP-2887 applier's state", async () => {
    // A pre-2887 applier writes `state`/`changed_at` with NO login_* lines. A
    // newer login intent reads as pending; once that old applier rewrites
    // state (newer mtime, still no login lines) the honest answer is
    // `unknown` — "this host is too old to set a login" — never a permanent
    // pending.
    writeState("off"); // pre-2887 shape: no login_user / login_result
    const { setSshLogin, readSshAccess } = await load();
    await new Promise((r) => setTimeout(r, 20));
    await setSshLogin({ username: "support", passwordHash: HASH });
    expect((await readSshAccess()).login).toEqual({ username: null, status: "pending" });
    await new Promise((r) => setTimeout(r, 20));
    writeState("off", "2026-08-13T11:00:00Z"); // old applier ran again, still no login lines
    expect((await readSshAccess()).login).toEqual({ username: null, status: "unknown" });
  });
});
