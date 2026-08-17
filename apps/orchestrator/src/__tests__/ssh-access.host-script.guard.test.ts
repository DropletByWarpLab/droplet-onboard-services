/**
 * WARP-1984 — guards on the PRIVILEGED half of the SSH toggle.
 *
 * The orchestrator side is ordinary TypeScript and gets ordinary unit tests
 * (`ssh-access.service.test.ts`). This file guards the part that runs as ROOT
 * on the appliance, where the failure modes are not "wrong output" but
 * "privilege escalation" and "the WAN edge quietly got wider" — neither of
 * which a unit test of the container side can see at all.
 *
 * These assertions read the shipped artefacts as text. That is the point: the
 * shell script and the unit files never execute in CI, so the only thing that
 * can hold their invariants is something that reads them. Each assertion below
 * fails if you delete the corresponding line from the artefact — verified by
 * doing exactly that, not assumed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// apps/orchestrator/src/__tests__ → repo root
const REPO = join(__dirname, "..", "..", "..", "..");
const SCRIPT = readFileSync(
  join(REPO, "scripts", "host", "usr-local-sbin", "droplet-ssh-access"),
  "utf8",
);
const UNIT = readFileSync(
  join(REPO, "scripts", "host", "etc-systemd-system", "droplet-ssh-access.service"),
  "utf8",
);
const PATH_UNIT = readFileSync(
  join(REPO, "scripts", "host", "etc-systemd-system", "droplet-ssh-access.path"),
  "utf8",
);
const BOOT_RESET_UNIT = readFileSync(
  join(
    REPO,
    "scripts",
    "host",
    "etc-systemd-system",
    "droplet-ssh-access-boot-reset.service",
  ),
  "utf8",
);
const BOOT_RESET_SCRIPT = readFileSync(
  join(REPO, "scripts", "host", "usr-local-sbin", "droplet-ssh-access-boot-reset"),
  "utf8",
);
const INSTALLER = readFileSync(join(REPO, "scripts", "lib", "single-box.sh"), "utf8");

/** Strip comments so a rule is never satisfied by prose ABOUT the rule. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("the root unit cannot be fed arbitrary environment (ADR-037)", () => {
  it("never declares an EnvironmentFile", () => {
    // The LPE PR #551 nearly shipped: EnvironmentFile loads EVERY key, so a
    // droplet-writable file becomes arbitrary env in a root service.
    expect(code(UNIT)).not.toMatch(/EnvironmentFile/i);
  });

  it("never sources or evals the droplet-writable intent file", () => {
    const body = code(SCRIPT);
    // `. file` / `source file` would execute its contents AS ROOT.
    expect(body).not.toMatch(/^\s*\.\s+["']?\$?\{?INTENT/m);
    expect(body).not.toMatch(/\bsource\b\s+["']?\$?\{?INTENT/);
    expect(body).not.toMatch(/\beval\b/);
  });

  it("validates the parsed value against exactly on|off before acting", () => {
    const body = code(SCRIPT);
    // A `case` with an explicit on|off arm, and a default arm that exits.
    expect(body).toMatch(/case\s+"\$value"\s+in/);
    expect(body).toMatch(/on\|off\)/);
    expect(body).toMatch(/\*\)/);
  });

  it("never interpolates the parsed value into a command", () => {
    // `systemctl "$value"` or similar would turn file contents into an action.
    expect(code(SCRIPT)).not.toMatch(/systemctl\s+[^\n]*\$value/);
  });
});

describe("the toggle is LAN-only — it never widens the WAN edge", () => {
  // FOUNDATION.md: the Vault is never reachable from the internet side. A
  // firewall rule added here would break that guarantee silently, because
  // nothing else in the system would notice a new accept rule.
  it.each([
    ["iptables", /\biptables\b/],
    ["nftables", /\bnft\b|\bnftables\b/],
    ["ufw", /\bufw\b/],
    ["a port-forward", /port[_-]?forward|redirect/i],
    ["UPnP", /upnp|natpmp/i],
  ])("adds no %s rule", (_label, pattern) => {
    expect(code(SCRIPT)).not.toMatch(pattern);
  });
});

describe("the toggle does not silently persist across reboots", () => {
  it("starts sshd without enabling it", () => {
    const body = code(SCRIPT);
    expect(body).toMatch(/systemctl start/);
    // `systemctl enable ssh` would leave a standing open door after a reboot,
    // which is not what "allow SSH while I troubleshoot" means.
    expect(body).not.toMatch(/systemctl\s+enable\s+["']?\$?\{?unit/);
  });

  it("stops the socket too, so socket activation cannot revive it", () => {
    // A stopped ssh.service with a live ssh.socket accepts the next
    // connection anyway — the toggle would read "off" over an open port.
    expect(code(SCRIPT)).toMatch(/\.socket/);
  });

  it("the applier unit carries no [Install] section at all", () => {
    // The path watcher is the ONLY thing that may start this unit. An
    // [Install]/WantedBy= stanza here is inert right up until some future
    // installer edit runs `systemctl enable droplet-ssh-access.service` — at
    // which point the applier runs at every boot with whatever the intent
    // file already says, and SSH silently survives reboots. With no stanza,
    // that `enable` fails loudly ("has no installation config") instead.
    expect(code(UNIT)).not.toMatch(/\[Install\]/);
    expect(code(UNIT)).not.toMatch(/WantedBy/);
  });
});

describe("the toggle resets to OFF at boot, so the readback cannot lie after a reboot", () => {
  // The applier `start`s sshd without enabling it, so sshd is down after
  // every reboot — deliberate. But PathModified= does NOT fire when the path
  // unit starts against a pre-existing unchanged file, so without the boot
  // reset nothing re-ran the applier: `state` kept saying `on` from before
  // the reboot and the dashboard rendered a green toggle over a box nobody
  // could reach. The boot reset rewrites the INTENT to `off`; the
  // already-watching path unit sees a genuine modification and the applier
  // records `state=off` truthfully.
  it("orders the reset after the watcher and before multi-user.target", () => {
    // After= the path unit: the write must land while the watcher is already
    // watching, or the modification happens unobserved and the applier never
    // runs. Before= multi-user.target: the boot is not "up" until the reset
    // has landed, so a dashboard readback never races it.
    expect(code(BOOT_RESET_UNIT)).toMatch(/^Wants=droplet-ssh-access\.path$/m);
    expect(code(BOOT_RESET_UNIT)).toMatch(/^After=droplet-ssh-access\.path$/m);
    expect(code(BOOT_RESET_UNIT)).toMatch(/^Before=multi-user\.target$/m);
  });

  it("is a plain oneshot running the boot-reset script", () => {
    expect(code(BOOT_RESET_UNIT)).toMatch(/^Type=oneshot$/m);
    expect(code(BOOT_RESET_UNIT)).toMatch(
      /^ExecStart=\/usr\/local\/sbin\/droplet-ssh-access-boot-reset$/m,
    );
    expect(code(BOOT_RESET_UNIT)).not.toMatch(/RemainAfterExit/);
  });

  it("is enabled at boot — unlike the applier, this unit is MEANT to run then", () => {
    expect(code(BOOT_RESET_UNIT)).toMatch(/^WantedBy=multi-user\.target$/m);
  });

  it("resets to off — it never re-applies the stored intent", () => {
    // Re-applying the stored intent at boot would turn "allow SSH while I
    // troubleshoot" into a standing open door across reboots — explicitly
    // rejected. The script writes the literal off value; it never reads the
    // previous one and never drives systemd itself (acting stays the
    // applier's job, via the path unit).
    const body = code(BOOT_RESET_SCRIPT);
    expect(body).toMatch(/DROPLET_SSH_ACCESS=off/);
    expect(body).not.toMatch(/\bsystemctl\b/);
    expect(body).not.toMatch(/\bsed\b|\bgrep\b|\bawk\b/);
  });

  it("writes the intent atomically, like the orchestrator does", () => {
    // The path watcher must never observe a half-written file. Temp file in
    // the same directory + rename is the contract the .path unit documents.
    const body = code(BOOT_RESET_SCRIPT);
    expect(body).toMatch(/\.tmp/);
    expect(body).toMatch(/mv -f/);
  });
});

describe("the path unit actually fires every time", () => {
  it("watches the intent file and triggers the service", () => {
    // The exact path, not a prefix: `intent` must live in the writable
    // intent.d/ subtree, because the parent is bind-mounted read-only so the
    // container cannot forge `state`. A watcher left on the old top-level path
    // would silently never fire.
    expect(PATH_UNIT).toMatch(
      /PathModified=\/var\/lib\/droplet-ssh-access\/intent\.d\/intent$/m,
    );
    expect(PATH_UNIT).toMatch(/Unit=droplet-ssh-access\.service/);
  });

  it("keeps the service a plain oneshot", () => {
    // RemainAfterExit=yes would leave the unit permanently active, making
    // every path-triggered start a no-op — the toggle would work once and
    // then silently stop. That is why openwrt-attach needs a relay and this
    // does not.
    expect(code(UNIT)).toMatch(/Type=oneshot/);
    expect(code(UNIT)).not.toMatch(/RemainAfterExit/);
  });
});

describe("the artefacts ship through setup.sh, not by hand (guard rule 20)", () => {
  it.each([
    "usr-local-sbin/droplet-ssh-access",
    "etc-systemd-system/droplet-ssh-access.service",
    "etc-systemd-system/droplet-ssh-access.path",
    "usr-local-sbin/droplet-ssh-access-boot-reset",
    "etc-systemd-system/droplet-ssh-access-boot-reset.service",
  ])("installs %s", (artefact) => {
    expect(INSTALLER).toContain(artefact);
  });

  it("enables the WATCHER without starting the service", () => {
    // Installing the toggle must not itself change whether SSH is on.
    expect(INSTALLER).toMatch(/systemctl enable --now droplet-ssh-access\.path/);
    expect(INSTALLER).not.toMatch(/systemctl\s+start\s+droplet-ssh-access\.service/);
  });

  it("enables the boot reset for the NEXT boot, without running it now", () => {
    // `enable`, never `enable --now`: the reset belongs to the next boot.
    // Running it at install time would flip a live support session's intent
    // to off mid-setup — installing the toggle must not itself change
    // whether SSH is on, in either direction.
    expect(INSTALLER).toMatch(/systemctl enable droplet-ssh-access-boot-reset\.service/);
    expect(INSTALLER).not.toMatch(/enable --now droplet-ssh-access-boot-reset/);
    expect(INSTALLER).not.toMatch(/systemctl\s+start\s+droplet-ssh-access-boot-reset/);
  });

  it("never enables the applier service itself", () => {
    // The trap the missing [Install] section closes, closed at the installer
    // end too: `systemctl enable droplet-ssh-access.service` would make SSH
    // survive reboots.
    expect(INSTALLER).not.toMatch(/systemctl\s+enable\s+(--now\s+)?droplet-ssh-access\.service/);
  });
});
