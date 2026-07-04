#!/usr/bin/env bash
# =============================================================================
# WARP-966 — droplet-verify-encryption-lib: pure evaluators + report/manifest/
# signing helpers for the on-hardware encryption verification harness.
#
# This file is SOURCED, never executed. It contains only pure functions:
#   * evaluators that take captured command output (files/strings) and print a
#     single verdict line "PASS|<detail>", "FAIL|<detail>", or "SKIP|<reason>";
#   * JSON/Markdown report rendering;
#   * manifest hashing and offline bundle verification.
# No command execution against the live stack, no root, no Docker — so the whole
# file is unit-testable against committed fixtures (tests/verify-encryption.test.sh).
#
# Mirrors the split proven by droplet-backup.sh + droplet-backup-lib.sh.
# =============================================================================
set -u
