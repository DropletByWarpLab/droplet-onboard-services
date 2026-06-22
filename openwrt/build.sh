#!/bin/sh
# ADR-024 Phase 4 — EasyMesh controller (prplMesh). DRAFT / UNVALIDATED:
# prplMesh's HAL targets Intel/Qualcomm, NOT mt76 — controller-only mode +
# hostapd Multi-AP fronthaul on mt76 needs real-hardware validation on the lab
# box before this ships. See docs/ADR-024 §2.
# =============================================================================
#
# WHAT THIS IS (and is NOT):
#   This is a REVIEWABLE PACKAGE-SET DRAFT, not a runnable image build. The
#   historical bare-metal router image-build (the previous openwrt/build.sh)
#   was RETIRED under ADR-011 — the shipping path is the in-container
#   single-box image (openwrt/singlebox-image/Dockerfile), whose package set is
#   its `opkg install` list. This file declares the ADDITIONAL packages the
#   prplMesh EasyMesh CONTROLLER would need, so review can see the dependency
#   surface before any hardware build is attempted. It deliberately does NOT
#   run a build (see the guard at the bottom).
#
# CONTROLLER-ONLY (ADR-024 §2): the box runs prplMesh as the 1905.1 CONTROLLER
#   only. Its mt76 (MT7922) radio is NEVER an EasyMesh RF agent — the certified
#   third-party AP is the Agent and brings its own vendor RF stack. The box's
#   own fronthaul BSS uses hostapd Multi-AP (nl80211), which mt76 supports (see
#   files/etc/config/wireless). So we add the CONTROLLER package, NOT the agent.
#
# RESEARCH-NEEDED (lab checklist — do NOT pretend any of these resolve here):
#   R1. prplMesh controller package name in the stock OpenWrt 24.10 feed:
#       UNCONFIRMED. prplMesh is generally distributed via a CUSTOM prpl feed
#       (feeds.conf.default entry pointing at the prpl Foundation package feed),
#       NOT the stock OpenWrt feed. The `PRPLMESH_CONTROLLER_PACKAGES` below are
#       best-guess names and MUST be confirmed against the prpl feed.
#   R2. bcm27xx / x86_64 build availability for the controller package:
#       UNCONFIRMED. prplMesh's prebuilt targets are Intel/Qualcomm reference
#       boards; whether the controller (control-plane only, no RF HAL) builds
#       clean for our target arch is exactly what the lab build proves.
#   R3. Whether the controller can run with NO local agent on this box (pure
#       controller, agent disabled) on a prplMesh build — to be validated.
#
# When R1–R3 are answered on the lab box, fold the confirmed feed + package
# names into the single-box image (singlebox-image/Dockerfile) the same way the
# hostapd/umdns/dawn packages are baked today.
# =============================================================================

set -eu

# --- prplMesh EasyMesh CONTROLLER package set (DRAFT — names UNCONFIRMED) ---
# These would be APPENDED to the image's package list once R1 (feed) + R2 (arch)
# are confirmed. Controller-only: no agent package, no vendor RF HAL package.
# `prplmesh` is the umbrella; a real build may split controller/agent — the
# controller-only subset is what we want (see 99-droplet-setup gating).
PRPLMESH_CONTROLLER_PACKAGES="prplmesh"

# The Multi-AP fronthaul primitive on OUR radio is hostapd (nl80211), already
# baked into the single-box image (hostapd-mbedtls). No new RF package here —
# the controller is control-plane only. Listed for the reviewer's context, not
# re-installed.
HOSTAPD_MULTIAP_NOTE="hostapd Multi-AP fronthaul uses the already-baked hostapd-mbedtls (nl80211)"

# Append to the image PACKAGES set (the variable the image build would consume).
# Guarded so sourcing this file in a future build picks it up, but running it
# standalone is a no-op research dump (see guard below).
PACKAGES="${PACKAGES:-} ${PRPLMESH_CONTROLLER_PACKAGES}"

echo "ADR-024 Phase 4 — prplMesh CONTROLLER package-set DRAFT (UNVALIDATED)."
echo "  controller packages (UNCONFIRMED, may need a custom prpl feed): ${PRPLMESH_CONTROLLER_PACKAGES}"
echo "  fronthaul: ${HOSTAPD_MULTIAP_NOTE}"
echo "  research-needed: R1 prpl-feed package name, R2 bcm27xx/x86_64 build availability, R3 controller-no-agent run."
echo "  This is a reviewable draft — it does NOT build an image (needs lab hardware)."

# Do NOT run an OpenWrt image build from here — it can't be validated without
# hardware and the controller package source (R1/R2) is unconfirmed. Exit before
# any build step so this file stays a documentation/manifest draft only.
exit 0
