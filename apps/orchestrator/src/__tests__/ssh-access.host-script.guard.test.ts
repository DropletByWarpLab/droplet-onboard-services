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
// WARP-2142: the autoinstall seed opens the install-mode SSH window and
// setup.sh closes it — both are part of the toggle's contract now, so both
// are read here.
const USER_DATA = readFileSync(
  join(REPO, "scripts", "image", "autoinstall", "user-data"),
  "utf8",
);
const SETUP = readFileSync(join(REPO, "scripts", "setup.sh"), "utf8");

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
    // rejected. The script writes fixed literals; it never reads the
    // previous intent value and never drives systemd itself (acting stays
    // the applier's job, via the path unit).
    //
    // WARP-2142 carve-out, pinned in its own describe below: while a fresh
    // install-mode MARKER is present the script stamps the literal `on`
    // instead — still a fixed literal, still gated on a file only root can
    // write, still never the stored intent. The steady-state contract here
    // is unchanged: no marker, no open door.
    const body = code(BOOT_RESET_SCRIPT);
    expect(body).toMatch(/DROPLET_SSH_ACCESS=off/);
    expect(body).not.toMatch(/\bsystemctl\b/);
    expect(body).not.toMatch(/\bsed\b|\bgrep\b|\bawk\b/);
    // "Never reads the previous intent" made explicit now that the script
    // legitimately reads ANOTHER file (the marker): the intent file itself
    // must only ever be a write target here.
    expect(body).not.toMatch(/(cat|read[^A-Za-z_])[^\n]*INTENT_FILE/);
    expect(body).not.toMatch(/<\s*"?\$\{?INTENT_FILE/);
  });

  it("writes the intent atomically, like the orchestrator does", () => {
    // The path watcher must never observe a half-written file. Temp file in
    // the same directory + rename is the contract the .path unit documents.
    const body = code(BOOT_RESET_SCRIPT);
    expect(body).toMatch(/\.tmp/);
    expect(body).toMatch(/mv -f/);
  });
});

describe("install mode (WARP-2142) — SSH open while commissioning, closed by the box itself", () => {
  // The commissioning dead-ends of 2026-08 (WARP-2100 hang with no way in,
  // 2122's toggle with no execute path, 2133's OTA stall) all reduced to "a
  // box mid-install that nobody could reach". Install mode is the fix:
  // fail-OPEN while the box is being commissioned, fail-CLOSED the moment
  // provisioning succeeds — or after the 48h backstop when it never does.
  // The window is anchored to one root-owned marker file; these assertions
  // pin every leg of its lifecycle, and above all that the THREE files that
  // spell its path (seed, boot reset, completion hook) actually agree.
  const MARKER = "/var/lib/droplet-ssh-access/install-mode";

  it("the seed plants an epoch-stamped marker at the exact path the boot reset checks", () => {
    // A typo between user-data and the boot reset would be a window that
    // silently never opens (or never closes) — it must die here, in CI.
    expect(code(USER_DATA)).toContain(`date +%s > ${MARKER}`);
    // The boot reset composes the same path from its default state dir...
    expect(BOOT_RESET_SCRIPT).toMatch(
      /DROPLET_SSH_ACCESS_DIR:-\/var\/lib\/droplet-ssh-access\}/,
    );
    // ...and the marker basename, pinned as an exact assignment.
    expect(code(BOOT_RESET_SCRIPT)).toMatch(
      /INSTALL_MODE_FILE="\$STATE_DIR\/install-mode"/,
    );
  });

  it("the marker lives in the root-owned half — a container can never mint install mode", () => {
    // intent.d/ is droplet-writable by design; the marker must NOT be. If it
    // moved under intent.d, a compromised orchestrator could re-open the
    // window forever.
    expect(code(BOOT_RESET_SCRIPT)).not.toMatch(/intent\.d\/install-mode/);
    expect(code(USER_DATA)).not.toMatch(/intent\.d/);
  });

  it("the seed enables ssh in the installed target", () => {
    // On boot 1 none of the WARP-1984 machinery exists yet — setup.sh
    // installs it mid-provision — so standing enablement in the target is
    // the only thing that can open the window on the very first boot.
    expect(code(USER_DATA)).toMatch(/systemctl enable ssh\.service/);
  });

  it("the boot reset honors the marker only within the 48h backstop, then deletes it", () => {
    const body = code(BOOT_RESET_SCRIPT);
    expect(body).toMatch(/172800/);
    expect(body).toMatch(/rm -f "\$INSTALL_MODE_FILE"/);
  });

  it("the boot reset validates the marker as digits before doing arithmetic on it", () => {
    // Same posture as the applier's on|off parse: strict validation, no code
    // path from file contents to a command — and still no external parser
    // (the sed/grep/awk ban above covers this file's whole body).
    expect(code(BOOT_RESET_SCRIPT)).toMatch(/\*\[!0-9\]\*/);
  });

  it("install mode still stamps fixed literals, never file contents", () => {
    const body = code(BOOT_RESET_SCRIPT);
    expect(body).toMatch(/DROPLET_SSH_ACCESS=on/);
    expect(body).toMatch(/DROPLET_SSH_ACCESS=off/);
    // No interpolation into the stamped value: the marker chooses BETWEEN
    // the two literals, it is never part of one.
    expect(body).not.toMatch(/DROPLET_SSH_ACCESS=\$/);
  });

  it("a SUCCESSFUL provision closes the window: marker removed, ssh disabled, intent off", () => {
    const installer = code(INSTALLER);
    // The hook exists, removes the same marker path, and undoes the seed's
    // standing enablement — steady state returns to WARP-1984
    // start-not-enable, owner-toggle-only.
    expect(installer).toMatch(/close_install_mode_ssh_window\(\)/);
    expect(installer).toContain(MARKER);
    expect(installer).toMatch(/systemctl disable ssh\.service ssh\.socket/);
    expect(installer).toMatch(/systemctl disable sshd\.service sshd\.socket/);
    // ...and re-asserts the off intent so the APPLIER (via the path unit)
    // stops sshd and records state=off — acting stays the applier's job.
    expect(installer).toMatch(/DROPLET_SSH_ACCESS=off/);
  });

  it("setup.sh calls the close hook from its success tail", () => {
    // set -e semantics make placement the failure contract: a provision that
    // dies anywhere earlier never reaches the call, the marker survives, and
    // the box stays rescuable over SSH — exactly the point.
    expect(code(SETUP)).toMatch(/close_install_mode_ssh_window/);
  });

  it("the completion hook never drives the applier service directly", () => {
    // Closing the window must ride the same path as every other intent
    // change: write the file, let the watcher fire. Starting or enabling
    // droplet-ssh-access.service from the installer stays banned (the
    // assertions in the installer describe below pin the same thing for the
    // install path).
    expect(code(INSTALLER)).not.toMatch(
      /systemctl\s+(start|enable)\s+(--now\s+)?droplet-ssh-access\.service/,
    );
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
