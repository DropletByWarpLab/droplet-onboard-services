/**
 * ssh-access.service.ts — WARP-1984, WARP-2887.
 *
 * Allow / don't allow an SSH login to the appliance, for support
 * troubleshooting, and (WARP-2887) which login that is. LAN-ONLY: this
 * toggles the host's `sshd` and manages one owner-chosen account, nothing
 * else. It opens no WAN firewall hole, adds no port-forward, and requests no
 * UPnP mapping. Off-site support access stays the WireGuard overlay's job.
 * (FOUNDATION.md: the Vault is never reachable from the internet side —
 * a control that could widen the WAN edge would contradict the product.)
 *
 * WHY AN INTENT FILE AND NOT A COMMAND. The orchestrator is a container and
 * must not acquire a privileged path to the host. It therefore never runs
 * `systemctl`, and never touches the Docker socket — ADR-030 fences that to
 * the cosign-verified OTA applier precisely so no customer- or LLM-facing
 * surface can reach it. Instead this writes a small INTENT file; a
 * root-owned systemd `.path` unit watches it and runs the privileged half.
 * That is the WARP-843 shape, reused because it was built for exactly this
 * problem (the setup wizard's Wi-Fi save, which also had to cross the
 * sandbox boundary without granting the droplet user anything).
 *
 * THE INVARIANT THAT SHAPES THE FILE FORMAT. ADR-037: a droplet-writable
 * file must NEVER be an `EnvironmentFile` on a root unit, because
 * `EnvironmentFile` loads EVERY key — a compromised container could set an
 * arbitrary variable and have a root service act on it (the LPE that PR #551
 * nearly shipped). So the file is not sourced, not evaluated, and not used as
 * an environment. The host script greps exactly THREE keys out of it, each
 * validated against a strict grammar before anything happens. Everything
 * else in the file is ignored by construction.
 *
 * WHY THE PASSWORD IS HASHED HERE. The intent file sits in a droplet-writable
 * directory the container can read back; a plaintext password written there
 * would be readable by anything that can read the state dir. So the
 * orchestrator computes the `$6$` shadow hash (lib/sha512-crypt.ts) and only
 * that crosses the boundary; the host hands it to `chpasswd -e` verbatim.
 * The plaintext lives for the duration of one request and is never logged.
 *
 * WHY STATE IS READ BACK FROM DISK RATHER THAN REMEMBERED. `readSshAccess`
 * reports what the HOST last did, from a root-written state file — not what
 * we last asked for. If the path unit is masked, the script fails, or sshd
 * refuses to start, echoing our own intent back would show the operator a
 * green toggle over a box they cannot actually reach. An honest "we asked,
 * the host hasn't confirmed" is the more useful failure. The same applies to
 * the login: `login_user` is what the host found on the SYSTEM (an unlocked
 * member of the `droplet-ssh` group), never the name we wrote.
 */
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isValidSshLoginUsername } from "@droplet/shared-types";
import { createLogger } from "../lib/logger.js";
import { SHA512_CRYPT_HASH_RE } from "../lib/sha512-crypt.js";

const logger = createLogger("ssh-access");

/**
 * The shared state directory, bind-mounted from the host. Overridable for
 * tests and for deployment shapes that place it elsewhere — never a
 * host-specific default baked into a branch (architecture-guard rule 12).
 */
const STATE_DIR = process.env.DROPLET_SSH_ACCESS_DIR ?? "/var/lib/droplet-ssh-access";

/**
 * Written by US (droplet-owned). Watched by the root `.path` unit.
 *
 * In its own `intent.d/` subdirectory so that STATE_DIR itself can be
 * bind-mounted READ-ONLY into this container while only this subtree stays
 * writable. Without that split, a root-in-container process could overwrite
 * the root-owned `state` below — ownership gives no protection across a bind
 * mount, which does no UID remapping.
 */
const INTENT_PATH = join(STATE_DIR, "intent.d", "intent");

/** Written by the HOST script (root-owned, read-only to us — we never write it). */
const STATE_PATH = join(STATE_DIR, "state");

/** The access key the host script parses out of the intent file. */
const INTENT_KEY = "DROPLET_SSH_ACCESS";
/** WARP-2887 — the two login keys. One-shot: consumed on the next applier run. */
const LOGIN_USER_KEY = "DROPLET_SSH_LOGIN_USER";
const LOGIN_HASH_KEY = "DROPLET_SSH_LOGIN_HASH";

/**
 * The only two values that mean anything, on either side of the boundary.
 * The host script validates against this same pair; anything else is
 * rejected there rather than acted on.
 */
export type SshAccessValue = "on" | "off";

/**
 * WARP-2887 — the username grammar and password bounds live in
 * `@droplet/shared-types` (`ssh-login.ts`) so the dashboard's live validation,
 * this service and the route cannot drift apart; the host applier mirrors the
 * username grammar as a sed capture group and the guard test pins it.
 * Re-exported here so the route and the tests keep one import site.
 */
export {
  SSH_LOGIN_USERNAME_RE,
  SSH_LOGIN_RESERVED,
  SSH_LOGIN_PASSWORD_MIN,
  SSH_LOGIN_PASSWORD_MAX,
} from "@droplet/shared-types";

export interface SshLoginStatus {
  /** The account the HOST reports as the live login (an unlocked
   *  `droplet-ssh` member), or null when there is none / the host cannot say. */
  username: string | null;
  /**
   * `set`     — the host has a usable login (`username` is it).
   * `none`    — the host confirmed there is no login.
   * `pending` — we wrote a login the host has not applied yet.
   * `refused` — the host rejected the last login we wrote (malformed, or a
   *             name it will not manage). `username` is whatever was live
   *             before, if anything.
   * `unknown` — the host has never reported login state (older applier, or
   *             the units are not installed).
   */
  status: "set" | "none" | "pending" | "refused" | "unknown";
}

export interface SshAccessStatus {
  /** True when the host reports sshd is currently running. */
  enabled: boolean;
  /**
   * `applied`  — the host confirmed this state.
   * `pending`  — we wrote an intent the host has not yet confirmed.
   * `unknown`  — no state file. Either the host units are not installed
   *              (a deployment shape without them) or they have never run.
   *              Reported honestly rather than defaulted to "off", which
   *              would look identical to a box that is genuinely closed.
   */
  status: "applied" | "pending" | "unknown";
  /** When the host last wrote the state file, ISO-8601, when known. */
  changedAt: string | null;
  /** WARP-2887 — the troubleshooting login, as the host reports it. */
  login: SshLoginStatus;
}

interface HostState {
  value: SshAccessValue;
  changedAt: string | null;
  /** Absent on a state file written by a pre-WARP-2887 applier. */
  loginUser?: string | null;
  loginResult?: "applied" | "refused" | "none";
}

/** Parse the host's state file. Any malformation reads as "unknown". */
function parseState(raw: string): HostState | null {
  const value = /^\s*state\s*=\s*(on|off)\s*$/im.exec(raw)?.[1]?.toLowerCase();
  if (value !== "on" && value !== "off") return null;
  const changedAt = /^\s*changed_at\s*=\s*(\S+)\s*$/im.exec(raw)?.[1] ?? null;
  const out: HostState = { value, changedAt };
  // `[ \t]*`, not `\s*`, around an OPTIONAL value: `\s*` would happily eat
  // the newline after an empty `login_user=` and capture the next line.
  const loginLine = /^[ \t]*login_user[ \t]*=[ \t]*(\S*)[ \t]*$/im.exec(raw);
  if (loginLine) out.loginUser = loginLine[1] || null;
  const result = /^[ \t]*login_result[ \t]*=[ \t]*(applied|refused|none)[ \t]*$/im.exec(raw)?.[1];
  if (result === "applied" || result === "refused" || result === "none") out.loginResult = result;
  return out;
}

interface Intent {
  access: SshAccessValue | null;
  loginUser: string | null;
  /**
   * The `$6$` hash beside `loginUser`, or null when absent or not a hash we
   * would have written. Read back so a toggle can re-state a login the host
   * has not consumed yet (see `setSshAccess`); a value that fails the same
   * grammar the host checks reads as absent, never as something to carry.
   */
  loginHash: string | null;
}

/** Read the intent we last wrote, or nulls when we have written none. */
async function readIntent(): Promise<Intent> {
  try {
    const raw = await readFile(INTENT_PATH, "utf8");
    const access = new RegExp(`^\\s*${INTENT_KEY}\\s*=\\s*(on|off)\\s*$`, "im")
      .exec(raw)?.[1]
      ?.toLowerCase();
    const loginUser = new RegExp(`^[ \\t]*${LOGIN_USER_KEY}[ \\t]*=[ \\t]*(\\S+)[ \\t]*$`, "im").exec(raw)?.[1] ?? null;
    const rawHash = new RegExp(`^[ \\t]*${LOGIN_HASH_KEY}[ \\t]*=[ \\t]*(\\S+)[ \\t]*$`, "im").exec(raw)?.[1] ?? null;
    const loginHash = rawHash !== null && SHA512_CRYPT_HASH_RE.test(rawHash) ? rawHash : null;
    return { access: access === "on" || access === "off" ? access : null, loginUser, loginHash };
  } catch {
    return { access: null, loginUser: null, loginHash: null };
  }
}

async function mtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Current SSH access, as the HOST last reported it.
 *
 * Fails to `unknown`, never to `enabled: true`. A box whose state we cannot
 * establish must not render as "SSH is on" — that would send an operator
 * looking for a door that may not exist, and on the security-relevant axis
 * the safe direction is to under-claim access, not over-claim it.
 */
export async function readSshAccess(): Promise<SshAccessStatus> {
  let hostState: HostState | null = null;
  try {
    hostState = parseState(await readFile(STATE_PATH, "utf8"));
  } catch {
    hostState = null;
  }

  const intent = await readIntent();

  if (!hostState) {
    // No confirmation from the host. If we asked for something, say so;
    // otherwise we genuinely do not know.
    return {
      enabled: false,
      status: intent.access === null ? "unknown" : "pending",
      changedAt: null,
      login: { username: null, status: intent.loginUser ? "pending" : "unknown" },
    };
  }

  return {
    enabled: hostState.value === "on",
    // An intent the host has not caught up with yet is the honest "pending" —
    // the toggle should not read as settled while the two disagree.
    status: intent.access !== null && intent.access !== hostState.value ? "pending" : "applied",
    changedAt: hostState.changedAt,
    login: await loginStatus(hostState, intent),
  };
}

/**
 * WARP-2887 — the login half of the readback.
 *
 * The login keys are one-shot, so "pending" cannot be read off a value
 * mismatch the way the toggle's is: a successfully applied login leaves the
 * same name in the intent and in the state. It is read off TIME instead —
 * the intent file was written after the host last wrote state, so the host
 * has not run against it yet. Every other answer comes from the host alone.
 */
async function loginStatus(hostState: HostState, intent: Intent): Promise<SshLoginStatus> {
  const username = hostState.loginUser ?? null;
  // Compute freshness once. `intentNewer` = we wrote a login intent AFTER the
  // host last wrote state, i.e. the host has not applied THIS version of our
  // intent yet. Login keys are one-shot, so this time test — not a value
  // comparison — is the only thing that can say "pending".
  const [intentAt, stateAt] = await Promise.all([mtimeMs(INTENT_PATH), mtimeMs(STATE_PATH)]);
  const intentNewer =
    intent.loginUser !== null && intentAt !== null && stateAt !== null && intentAt > stateAt;

  if (hostState.loginResult === undefined && hostState.loginUser === undefined) {
    // A pre-WARP-2887 applier wrote this state file: it reports no login lines
    // and never will. If our login intent is newer than that state it simply
    // has not run our version yet → pending; once it rewrites state (it does
    // so on every run) the intent is no longer newer → `unknown`, the honest
    // "this box's host script is too old to set a login" — NOT a permanent
    // "pending" (the WARP-2887 review's pending-forever finding).
    return { username: null, status: intentNewer ? "pending" : "unknown" };
  }
  if (intentNewer) return { username, status: "pending" };
  if (hostState.loginResult === "refused") return { username, status: "refused" };
  return { username, status: username ? "set" : "none" };
}

async function writeIntent(lines: string[]): Promise<void> {
  const body = [
    "# WARP-1984 / WARP-2887 — written by the orchestrator, read by",
    "# /usr/local/sbin/droplet-ssh-access via the droplet-ssh-access.path unit.",
    "# NOT an EnvironmentFile: the host greps each key below by an anchored",
    "# regex and validates its value before acting (ADR-037).",
    ...lines,
    "",
  ].join("\n");

  await mkdir(dirname(INTENT_PATH), { recursive: true }).catch(() => undefined);
  const tmp = `${INTENT_PATH}.tmp`;
  // 0600, not 0644 (WARP-2887 review): the intent carries DROPLET_SSH_LOGIN_HASH,
  // a $6$ shadow hash of the owner's password — the OS keeps the equivalent
  // /etc/shadow line at 0640 root:shadow, not world-readable. Both writer
  // (orchestrator, uid 0) and reader (the root .path applier) are root, so
  // nothing legitimate needs group/other read; a 0644 file let any local
  // account on the box lift the hash and brute-force it offline.
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, INTENT_PATH);
}

/**
 * Ask the host to allow or disallow SSH.
 *
 * Written atomically (temp file + rename). The `.path` unit fires on
 * `PathModified`, which a rename satisfies — and the rename means the watcher
 * can never observe a half-written file and parse a truncated value.
 *
 * Returns the status AFTER the write, which will normally be `pending`: the
 * host is a separate asynchronous actor and this function deliberately does
 * not wait for it or claim its result.
 *
 * Re-states a login the host has NOT applied yet, and drops one the host has
 * already answered. The file is rewritten whole, so a toggle that carried only
 * the access key would erase login keys the root path unit had not consumed
 * yet — owner sets a login, flips the toggle a moment later, and the login is
 * silently never created. Once the host has answered (applied or refused) the
 * keys are dropped: the host reads the live login back off the system, and
 * re-stating a refused one would retry it on every toggle. "Not applied yet"
 * is the readback's own rule (`login.status === "pending"`), not a second one.
 */
export async function setSshAccess(enabled: boolean): Promise<SshAccessStatus> {
  const value: SshAccessValue = enabled ? "on" : "off";
  const current = await readSshAccess();
  const intent = await readIntent();
  const pendingLogin =
    current.login.status === "pending" && intent.loginUser !== null && intent.loginHash !== null
      ? { username: intent.loginUser, hash: intent.loginHash }
      : null;
  // ORDER MATTERS — login keys first, access key last; see setSshLogin.
  await writeIntent(
    pendingLogin
      ? [`${LOGIN_USER_KEY}=${pendingLogin.username}`, `${LOGIN_HASH_KEY}=${pendingLogin.hash}`, `${INTENT_KEY}=${value}`]
      : [`${INTENT_KEY}=${value}`],
  );
  logger.info(
    { value, carriedLogin: pendingLogin !== null },
    "ssh access intent written; awaiting host confirmation",
  );
  return readSshAccess();
}

/**
 * WARP-2887 — ask the host to create/update the troubleshooting login.
 *
 * Takes the HASH, not the password: the route hashes before it mints the
 * Tier-3 token, so neither the pending-confirmation record nor the audit row
 * nor this file ever sees plaintext. The access key is re-stated at its
 * current value (our intent if we have one, else what the host reports, else
 * off) so that the rewrite cannot flip the door by omission.
 *
 * Validation here is defensive — the route already refused bad input with a
 * 400 — because this is the last line before the host boundary, and the
 * host's own refusal is silent from the caller's point of view.
 */
export async function setSshLogin(input: { username: string; passwordHash: string }): Promise<SshAccessStatus> {
  const username = input.username;
  if (!isValidSshLoginUsername(username)) {
    throw new Error(`ssh login: refusing username ${JSON.stringify(username)}`);
  }
  if (!SHA512_CRYPT_HASH_RE.test(input.passwordHash)) {
    throw new Error("ssh login: password hash is not a $6$ shadow hash");
  }
  const current = await readSshAccess();
  const intent = await readIntent();
  const access: SshAccessValue = intent.access ?? (current.status === "unknown" ? "off" : current.enabled ? "on" : "off");
  // ORDER MATTERS. The host parses the file in one bounded pass that STOPS at
  // the access key (so a never-ending file cannot hang a root process). The
  // login keys must therefore come first; below the access key they would
  // never be read. tests/droplet-ssh-access.test.sh pins the host side.
  await writeIntent([
    `${LOGIN_USER_KEY}=${username}`,
    `${LOGIN_HASH_KEY}=${input.passwordHash}`,
    `${INTENT_KEY}=${access}`,
  ]);
  logger.info({ username }, "ssh login intent written; awaiting host confirmation");
  return readSshAccess();
}
