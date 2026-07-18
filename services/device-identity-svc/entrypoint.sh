#!/bin/sh
# WARP-1248 — fix bind-mount ownership at container start, then drop root.
#
# The Compose file bind-mounts /var/lib/droplet/tpm/ (TPM artifacts) and
# /var/run/droplet/ (gRPC unix socket) from the host, and the non-root
# `droplet` user must own both. On any host where a bind source does not
# pre-exist — every fresh CI runner, a fresh device before host prep, or
# /var/run after any reboot (tmpfs) — dockerd auto-creates the source
# directory root:root 0755. The image's own chown is shadowed by the
# mount, so the first EK-cert write fails deterministically
# (PermissionError: '/var/lib/droplet/tpm/ek-cert.pem.tmp') and the
# sidecar crash-loops under `restart: always`. Dev Macs never see this:
# Docker Desktop/colima's macOS file sharing maps host-mount ownership to
# the container user.
#
# The numeric uid is image-internal and shifts with the base image's
# system accounts (currently 997 — the tss group from tpm2-tools moved
# it), so host-side pre-create+chown cannot be a stable contract. Fix
# ownership HERE instead: start as root, chown the two mounted dirs, then
# exec the service as `droplet` via setpriv (util-linux, in the base
# image). Same start-as-root-then-drop pattern as the official
# postgres/redis/mosquitto images (they use gosu/su-exec).
#
# NOTE for the real-TPM backend (IDX-002): /dev/tpm0 access is granted
# via the host `tss` group and `--init-groups` resets supplementary
# groups to the droplet user's own — when Compose-side `group_add` wiring
# lands, carry the extra gid through setpriv `--groups` here.
set -eu

STORAGE_DIR="${DROPLET_DI_STORAGE:-/var/lib/droplet/tpm}"
SOCKET_DIR="$(dirname "${DROPLET_DI_SOCKET:-/var/run/droplet/device-identity.sock}")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$STORAGE_DIR" "$SOCKET_DIR"
  chown -R droplet:droplet "$STORAGE_DIR" "$SOCKET_DIR"
  exec setpriv --reuid droplet --regid droplet --init-groups -- "$@"
fi

# Already non-root (e.g. a Compose `user:` override) — ownership prep is
# then the operator's concern; behave exactly like the pre-WARP-1248 image.
exec "$@"
