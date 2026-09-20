#!/usr/bin/env bash
# =============================================================================
# droplet-tpm-lib.sh — shared TPM2 seams for the at-rest-encryption family
# (droplet-luks-provision.sh / droplet-usb-enroll.sh — WARP-232;
#  droplet-kek-seal.sh — WARP-1033, when that PR lands).
#
# Source this file; do not execute directly. Installed to
# /usr/local/sbin/droplet-tpm-lib.sh alongside its consumers (same pattern as
# droplet-backup-lib.sh, WARP-254).
#
# NOTE (WARP-232 landing order): the plan introduces this lib in the
# WARP-1033 PR (Task 1033.1). WARP-1033 is blocked on WARP-242 having merged,
# so this WARP-232 PR carries the lib itself. The two callers pin the same
# PCR set + tool seams here so the tickets can never drift apart.
#
# ── PCR bind set (CROSS-TICKET CONTRACT) ─────────────────────────────────────
# Default "0+2+4+7" — the SAME canonical set device-identity-svc seals the
# device key to (docker-compose.yml: DROPLET_TPM_PCRS "0,2,4,7"; WARP-230).
# systemd tools take '+'-separated PCRs, the sidecar takes commas; both name
# the identical set {0,2,4,7}: firmware (0), extended/option ROM code (2),
# boot manager (4), SecureBoot state (7). Override DROPLET_TPM_PCRS_BIND only
# together with DROPLET_TPM_PCRS in .env, or the LUKS/KEK seal and the device
# identity drift onto different boot-measurement policies.
#
# ── Tool seams ───────────────────────────────────────────────────────────────
# Every binary is env-overridable so the test harnesses can inject PATH stubs
# (tests/luks2-data-partition.test.sh, tests/usb-luks-enroll.test.sh) — the
# same seam discipline as DROPLET_AUTOMOUNT_* in droplet-automount.sh.
# Production never sets these; systemd invokes with a clean environment.
# =============================================================================

droplet_tpm_pcrs() {
  printf '%s' "${DROPLET_TPM_PCRS_BIND:-0+2+4+7}"
}

droplet_tpm_present() {
  [ -e "${DROPLET_TPM_DEVICE:-/dev/tpm0}" ]
}

# droplet_tpm_userspace_ok — is the TPM2 USERSPACE usable, not just the chip?
# /dev/tpm0 proves the hardware; systemd-cryptenroll additionally dlopens the
# tss2 stack (libtss2-esys/-mu/-rc) at runtime and fails "TPM2 support is not
# installed" when those packages are missing (WARP-2101 — the install seed
# didn't ship them). `--tpm2-device=list` exercises exactly that dlopen path
# without touching any LUKS device, so its exit code is the real probe.
droplet_tpm_userspace_ok() {
  "$(droplet_tpm_cryptenroll)" --tpm2-device=list >/dev/null 2>&1
}

droplet_tpm_systemd_creds() { printf '%s' "${DROPLET_SYSTEMD_CREDS_BIN:-systemd-creds}"; }
droplet_tpm_cryptsetup()    { printf '%s' "${DROPLET_CRYPTSETUP_BIN:-cryptsetup}"; }
droplet_tpm_cryptenroll()   { printf '%s' "${DROPLET_CRYPTENROLL_BIN:-systemd-cryptenroll}"; }
