"""WARP-3513 -- the encrypted-bay contract, pinned ACROSS its copies.

The always-encrypted bay scheme is spelled out in places that cannot share code:
standalone bash scripts installed into /usr/local/sbin, the unprivileged Python
bridge, a systemd-adjacent automount script, the factory-reset library and a
TypeScript route. Each copy has its own hermetic tests (test_storage_pool_script,
test_automount_script, test_device_bridge_*, factory-reset-storage-wipe,
storage*.test.ts). What none of them can notice is one copy drifting away from
the others -- a renamed mapper prefix, a crypttab option dropped on one side, an
op added to the host allow-list but not the bridge's (the "four-place allow-list
trap"). This file reads the sources and pins that they still AGREE.

Pure text reads: no bash, no root, no stubs -- cheap enough to run everywhere.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]

POOL_SCRIPT = REPO / "scripts" / "host" / "droplet-storage-pool.sh"
LUKS_PROVISION = REPO / "scripts" / "host" / "droplet-luks-provision.sh"
AUTOMOUNT = REPO / "services" / "automount" / "droplet-automount.sh"
STORAGE_WIPE = REPO / "scripts" / "lib" / "storage-wipe.sh"
SECRETS_WIPE = REPO / "scripts" / "lib" / "secrets-wipe.sh"
FACTORY_RESET = REPO / "scripts" / "factory-reset.sh"
INSTALL_BRIDGE = REPO / "scripts" / "install-device-bridge.sh"
EXPIRY_SERVICE = (
    REPO / "services" / "oled-display" / "droplet-bay-recovery-expiry.service"
)
EXPIRY_TIMER = REPO / "services" / "oled-display" / "droplet-bay-recovery-expiry.timer"
BRIDGE = REPO / "services" / "oled-display" / "device-bridge.py"
STORAGE_ROUTE = REPO / "apps" / "orchestrator" / "src" / "routes" / "storage.ts"
SAFETY_RULES = (
    REPO / "apps" / "orchestrator" / "src" / "config" / "storage-safety-rules.ts"
)
TOOLS_CORE_SRC = REPO / "packages" / "tools-core" / "src"

# /data's crypttab options (droplet-luks-provision.sh) -- a bay uses the SAME line
# shape so the two volumes behave identically at boot.
CRYPTTAB_OPTS = (
    "tpm2-device=auto,luks,discard,nofail,headless=true,"
    "x-systemd.device-timeout=30s"
)
# ADR-070: the recovery key is escrowed on the ENCRYPTED /data and nowhere else --
# never the unencrypted OS disk.
ESCROW_DIR = "/data/droplet/secrets/bay-recovery"
# The custody operations: the first two are owner-driven (orchestrator -> bridge
# -> root host script); the third is the host-only 7-day sweep run by a timer.
OWNER_RECOVERY_OPS = ("recovery_key_reveal", "recovery_key_regenerate")
HOST_ONLY_RECOVERY_OPS = ("recovery_key_expire",)
# `files/` is the household-files directory of a bay: project id 4097 (WARP-3514
# puts the recordings' nvr/ at 4096 and sets the limits).
FILES_PROJECT_ID = "4097"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_every_copy_of_the_contract_exists():
    for p in (POOL_SCRIPT, LUKS_PROVISION, AUTOMOUNT, STORAGE_WIPE, SECRETS_WIPE,
              FACTORY_RESET, INSTALL_BRIDGE, EXPIRY_SERVICE, EXPIRY_TIMER, BRIDGE,
              STORAGE_ROUTE, SAFETY_RULES):
        assert p.is_file(), f"{p.relative_to(REPO)} is gone -- update this contract test"


def test_bay_crypttab_options_are_the_data_volumes_options():
    assert f"none {CRYPTTAB_OPTS}" in _text(LUKS_PROVISION), (
        "droplet-luks-provision.sh no longer writes the crypttab options this "
        "contract pins -- bays must follow /data's line shape"
    )
    pool = _text(POOL_SCRIPT)
    assert f'BAY_CRYPTTAB_OPTS="{CRYPTTAB_OPTS}"' in pool, (
        "the pool script's bay crypttab options drifted from /data's"
    )


def test_every_component_agrees_on_the_mapper_prefix():
    # `droplet-usb-` is the existing hot-plug USB mapper; bays are distinct.
    assert 'BAY_MAPPER_PREFIX="droplet-bay-"' in _text(POOL_SCRIPT)
    for path in (AUTOMOUNT, STORAGE_WIPE):
        assert "droplet-bay-" in _text(path), (
            f"{path.relative_to(REPO)} no longer knows the droplet-bay- mapper prefix"
        )


def test_bay_mount_options_and_filesystem_flags_agree():
    pool = _text(POOL_SCRIPT)
    assert 'BAY_MOUNT_OPTS="rw,nosuid,nodev,noatime,prjquota"' in pool
    assert "-O quota,project" in pool, "bays must be created with ext4 project quota"
    # The reboot / hot-plug / reconcile path must mount the same filesystems with
    # prjquota too (it checks the `project` feature first, then mounts prjquota).
    automount = _text(AUTOMOUNT)
    assert "prjquota" in automount, (
        "droplet-automount.sh must mount project-quota ext4 with prjquota"
    )
    assert "fs_has_project_quota" in automount


def test_files_directory_project_id_agrees_between_prepare_and_automount():
    pool = _text(POOL_SCRIPT)
    automount = _text(AUTOMOUNT)
    # (the pool script keeps a test seam: ${DROPLET_FILES_PROJID:-4097})
    assert re.search(
        r'^BAY_FILES_PROJID="\$\{DROPLET_FILES_PROJID:-%s\}"' % FILES_PROJECT_ID,
        pool, re.M), "the pool script's files/ project id drifted from 4097"
    assert re.search(
        r"^BAY_FILES_PROJID=%s$" % FILES_PROJECT_ID, automount, re.M), (
        "the automount fallback that creates files/ must use the SAME project id "
        "as the prepare script"
    )
    for name, text in (("pool script", pool), ("automount", automount)):
        assert re.search(r'chattr \+P -p "\$BAY_FILES_PROJID"', text), (
            f"{name} no longer sets the project id on files/"
        )


def test_nextcloud_is_registered_at_files_never_the_drive_root():
    pool = _text(POOL_SCRIPT)
    assert 'datadir="/host/$1/files"' in pool or "/host/$name/files" in pool
    automount = _text(AUTOMOUNT)
    assert "/files" in automount and "33:33" in automount
    assert "NEXTCLOUD_UID=33" in pool


def test_a_plain_drive_keeps_its_root_registration_until_it_is_prepared():
    # Decided with ADR-070: no migration of existing drive-root registrations --
    # the Prepare wipe replaces the drive and registers files/ only.
    automount = _text(AUTOMOUNT)
    for gone in ("nc_migrate_root_registrations", "nc_root_registrations",
                 "unmanaged_entries", "nextcloud-root-registration-retained"):
        assert gone not in automount, (
            f"droplet-automount.sh grew back the root-registration migration ({gone})"
        )
    assert "nextcloud_deregister" in _text(POOL_SCRIPT), (
        "preparing a drive must deregister the replaced drive's Nextcloud entry"
    )


def test_recovery_escrow_is_on_the_encrypted_data_volume_and_only_there():
    pool = _text(POOL_SCRIPT)
    assert ESCROW_DIR in pool, "pool script lost the escrow dir"
    assert "/var/lib/droplet-storage" not in pool, (
        "the recovery key must never be held on the unencrypted OS disk"
    )
    # The eraser (factory reset) must know where the writer puts keys, or a
    # recovery key would survive a reset.
    wipe = _text(STORAGE_WIPE) + _text(SECRETS_WIPE)
    assert ESCROW_DIR in wipe or ESCROW_DIR.rsplit("/", 1)[0] in wipe, (
        f"factory reset no longer knows the escrow location {ESCROW_DIR}: a "
        "recovery key would survive a reset"
    )
    assert "/var/lib/droplet-storage" not in _text(STORAGE_WIPE)


def test_prepare_has_no_no_tpm_override():
    # ADR-070: Prepare REQUIRES a TPM2. /data's dev-only DROPLET_LUKS_ALLOW_NO_TPM
    # escape must not leak into the pool script.
    assert "ALLOW_NO_TPM" not in _text(POOL_SCRIPT)


def test_machine_refusal_codes_agree_between_host_bridge_and_orchestrator():
    pool = _text(POOL_SCRIPT)
    assert "EXIT_TPM_REQUIRED=75" in pool
    assert "EXIT_ENCRYPTED_DATA_REQUIRED=76" in pool
    bridge = _text(BRIDGE)
    codes = re.search(r"_POOL_REFUSAL_CODES\s*=\s*\{(.*?)\}", bridge, re.S)
    assert codes, "the bridge lost its exit-code -> code table"
    assert re.search(r'75:\s*"tpm_required"', codes.group(1))
    assert re.search(r'76:\s*"encrypted_data_required"', codes.group(1))
    route = _text(STORAGE_ROUTE)
    for code in ("tpm_required", "encrypted_data_required"):
        assert f'"{code}"' in route, f"the orchestrator no longer maps {code}"


def test_owner_recovery_ops_are_in_every_allow_list():
    # host script (case allow-list), bridge (_POOL_OPS), orchestrator (route +
    # safety rules) -- the four-place trap, for the ops that are NOT destructive
    # erases and NOT AI tools.
    pool = _text(POOL_SCRIPT)
    allow = re.search(
        r"^\s*(recovery_key_\w+(?:\|recovery_key_\w+)*)\)\s*;;?", pool, re.M)
    assert allow, "host allow-list lost the recovery-key ops"
    host_ops = set(allow.group(1).split("|"))
    assert host_ops == set(OWNER_RECOVERY_OPS) | set(HOST_ONLY_RECOVERY_OPS), (
        f"host allow-list recovery ops drifted: {sorted(host_ops)}"
    )
    bridge = _text(BRIDGE)
    ops_block = re.search(r"_POOL_OPS\s*=\s*frozenset\(\{(.*?)\}\)", bridge, re.S)
    assert ops_block, "the bridge lost _POOL_OPS"
    for op in OWNER_RECOVERY_OPS:
        assert f'"{op}"' in ops_block.group(1), f"bridge _POOL_OPS lost {op}"
        assert op in _text(STORAGE_ROUTE), f"the orchestrator route lost {op}"
        assert op in _text(SAFETY_RULES), f"the safety rules lost {op}"
    for op in HOST_ONLY_RECOVERY_OPS:
        # The 7-day sweep is a root timer's job: the unprivileged bridge and the
        # orchestrator must never be able to ask for it.
        assert f'"{op}"' not in ops_block.group(1), f"{op} must not be bridge-callable"
        # (word-boundary: "recovery_key_expired" is a legitimate reveal answer)
        assert not re.search(rf"{op}", _text(STORAGE_ROUTE))


def test_the_reveal_is_a_post_through_the_existing_confirm_handshake_never_a_get():
    route = _text(STORAGE_ROUTE)
    assert re.search(
        r'router\.post\(\s*"/storage/drives/:uuid/recovery-key/reveal"', route), (
        "the one-time reveal must be a POST (a GET can be prefetched and spend it)"
    )
    assert re.search(
        r'router\.post\(\s*"/storage/drives/:uuid/recovery-key/regenerate"', route)
    assert not re.search(r'router\.get\(\s*"/storage/drives/:uuid/recovery-key', route), (
        "a GET route for the recovery key is back"
    )
    # Executed by the shared confirm route, owner-only.
    assert "OWNER_ONLY_OPS" in route
    rules = _text(SAFETY_RULES)
    assert "STORAGE_TIER_2_OPERATIONS" in rules and "STORAGE_TIER_3_OPERATIONS" in rules


def test_the_ai_surface_never_learns_the_recovery_key_ops():
    # "AI gets no write tool": the recovery key must be unreachable from
    # packages/tools-core (the only tool registry the model can call).
    for path in TOOLS_CORE_SRC.rglob("*.ts"):
        text = path.read_text(encoding="utf-8")
        for op in OWNER_RECOVERY_OPS:
            assert op not in text, (
                f"{path.relative_to(REPO)} names the recovery-key op {op}"
            )
        assert not re.search(r"recovery[_-]?key", path.name, re.I)


def test_the_installer_ships_the_tpm_lib_quota_tools_and_the_expiry_timer():
    installer = _text(INSTALL_BRIDGE)
    assert "droplet-tpm-lib.sh" in installer, (
        "the pool script sources droplet-tpm-lib.sh from its own directory; "
        "install-device-bridge.sh must install it alongside"
    )
    assert re.search(r"\bquota\b", installer) and "setquota" in installer, (
        "the quota package (setquota/repquota) must be provisioned by the installer"
    )
    # The pool script resolves the lib next to ITSELF -- if that ever changes,
    # the installer's destination must change with it.
    assert 'droplet-tpm-lib.sh' in _text(POOL_SCRIPT)
    for unit in ("droplet-bay-recovery-expiry.service",
                 "droplet-bay-recovery-expiry.timer"):
        assert unit in installer, f"the installer no longer installs {unit}"
    assert "enable --now droplet-bay-recovery-expiry.timer" in installer


def test_the_expiry_timer_runs_the_host_only_sweep_and_factory_reset_removes_it():
    service = _text(EXPIRY_SERVICE)
    assert re.search(
        r"^ExecStart=/usr/local/sbin/droplet-storage-pool\.sh recovery_key_expire\s*$",
        service, re.M), "the expiry unit no longer runs the host sweep"
    assert f"ConditionPathExists={ESCROW_DIR}" in service
    timer = _text(EXPIRY_TIMER)
    assert "Unit=droplet-bay-recovery-expiry.service" in timer
    assert re.search(r"^OnCalendar=daily\s*$", timer, re.M)
    assert "Persistent=true" in timer
    reset = _text(FACTORY_RESET)
    assert "droplet-bay-recovery-expiry.timer" in reset, (
        "factory reset must remove the expiry timer it was installed with"
    )
