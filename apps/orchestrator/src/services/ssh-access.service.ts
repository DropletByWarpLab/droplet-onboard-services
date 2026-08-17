/**
 * ssh-access.service.ts — WARP-1984.
 *
 * Allow / don't allow an SSH login to the appliance, for support
 * troubleshooting. LAN-ONLY: this toggles the host's `sshd` and nothing else.
 * It opens no WAN firewall hole, adds no port-forward, and requests no UPnP
 * mapping. Off-site support access stays the WireGuard overlay's job.
 * (FOUNDATION.md: the Vault is never reachable from the internet side —
 * a control that could widen the WAN edge would contradict the product.)
 *
 * WHY AN INTENT FILE AND NOT A COMMAND. The orchestrator is a container and
 * must not acquire a privileged path to the host. It therefore never runs
 * `systemctl`, and never touches the Docker socket — ADR-030 fences that to
 * the cosign-verified OTA applier precisely so no customer- or LLM-facing
 * surface can reach it. Instead this writes a one-key INTENT file; a
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
 * an environment. The host script greps ONE key out of it and validates the
 * value against exactly two literals before doing anything. Everything else
 * in the file is ignored by construction.
 *
 * WHY STATE IS READ BACK FROM DISK RATHER THAN REMEMBERED. `readSshAccess`
 * reports what the HOST last did, from a root-written state file — not what
 * we last asked for. If the path unit is masked, the script fails, or sshd
 * refuses to start, echoing our own intent back would show the operator a
 * green toggle over a box they cannot actually reach. An honest "we asked,
 * the host hasn't confirmed" is the more useful failure.
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../lib/logger.js";

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

/** The ONE key the host script will parse out of the intent file. */
const INTENT_KEY = "DROPLET_SSH_ACCESS";

/**
 * The only two values that mean anything, on either side of the boundary.
 * The host script validates against this same pair; anything else is
 * rejected there rather than acted on.
 */
export type SshAccessValue = "on" | "off";

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
}

/** Parse the host's state file. Any malformation reads as "unknown". */
function parseState(raw: string): { value: SshAccessValue; changedAt: string | null } | null {
  const value = /^\s*state\s*=\s*(on|off)\s*$/im.exec(raw)?.[1]?.toLowerCase();
  if (value !== "on" && value !== "off") return null;
  const changedAt = /^\s*changed_at\s*=\s*(\S+)\s*$/im.exec(raw)?.[1] ?? null;
  return { value, changedAt };
}

/** Read the intent we last wrote, or null when we have written none. */
async function readIntent(): Promise<SshAccessValue | null> {
  try {
    const raw = await readFile(INTENT_PATH, "utf8");
    const value = new RegExp(`^\\s*${INTENT_KEY}\\s*=\\s*(on|off)\\s*$`, "im")
      .exec(raw)?.[1]
      ?.toLowerCase();
    return value === "on" || value === "off" ? value : null;
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
  let hostState: { value: SshAccessValue; changedAt: string | null } | null = null;
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
      status: intent === null ? "unknown" : "pending",
      changedAt: null,
    };
  }

  return {
    enabled: hostState.value === "on",
    // An intent the host has not caught up with yet is the honest "pending" —
    // the toggle should not read as settled while the two disagree.
    status: intent !== null && intent !== hostState.value ? "pending" : "applied",
    changedAt: hostState.changedAt,
  };
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
 */
export async function setSshAccess(enabled: boolean): Promise<SshAccessStatus> {
  const value: SshAccessValue = enabled ? "on" : "off";
  const body = [
    "# WARP-1984 — written by the orchestrator, read by",
    "# /usr/local/sbin/droplet-ssh-access via the droplet-ssh-access.path unit.",
    "# NOT an EnvironmentFile: the host greps the single key below and",
    "# validates it against on|off before acting (ADR-037).",
    `${INTENT_KEY}=${value}`,
    "",
  ].join("\n");

  await mkdir(dirname(INTENT_PATH), { recursive: true }).catch(() => undefined);
  const tmp = `${INTENT_PATH}.tmp`;
  await writeFile(tmp, body, { mode: 0o644 });
  await rename(tmp, INTENT_PATH);

  logger.info({ value }, "ssh access intent written; awaiting host confirmation");
  return readSshAccess();
}
