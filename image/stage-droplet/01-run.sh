#!/bin/bash -e
# =============================================================================
# pi-gen stage-droplet — build-time chroot run script
# =============================================================================
# Runs INSIDE the image's root filesystem at build time (pi-gen runs *-run.sh
# scripts in the target chroot). It installs Docker, clones the repo, warms the
# container images so first boot is offline-capable, and installs the
# first-boot oneshot unit.
#
# HARD INVARIANTS (asserted by tests/build-image.test.sh):
#   - Does NOT run scripts/setup.sh (setup runs at FIRST BOOT only).
#   - Does NOT create /opt/droplet/edge-platform/.env or any secret file.
#     All device-unique secrets are generated on first boot by setup.sh via
#     scripts/lib/secrets.sh — never baked. (Same precedent as the OpenWrt
#     99-droplet-setup first-boot credential gen.)
#   - Does NOT strip OPENSSL_CONF or set DROPLET_FIPS_REQUIRED=false — FIPS is
#     enforced INSIDE the app containers; image warm-up must not undermine it.
#   - Does NOT add host ports — the warmed compose.yml keeps Nginx as the single
#     entry point.
#
# DROPLET_IMAGE_RELEASE_REF is exported into the chroot by build-image.sh (it
# appends `export DROPLET_IMAGE_RELEASE_REF=...` to the pi-gen config, which
# pi-gen sources before running stage scripts).
# =============================================================================

REPO_URL="https://github.com/DropletByWarpLab/droplet-onboard-services.git"
# Path that droplet.service / its EnvironmentFile and droplet-firstboot.service
# expect the checkout to live at.
INSTALL_DIR="/opt/droplet/edge-platform"
RELEASE_REF="${DROPLET_IMAGE_RELEASE_REF:-main}"

echo "stage-droplet: installing Docker Engine + Compose v2 (Docker apt repo)"

# --- Docker Engine 25+ + compose-plugin from Docker's official apt repo ---
# We deliberately use Docker's repo (not distro docker.io) so we get Compose v2
# (`docker compose`), which scripts/lib/docker.sh + compose.sh require.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
    -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

# shellcheck disable=SC1091  # /etc/os-release is provided by the chroot at build time.
. /etc/os-release
echo \
  "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

# Enable docker so it's up before droplet-firstboot.service on first boot.
systemctl enable docker

echo "stage-droplet: cloning ${REPO_URL} @ ${RELEASE_REF} -> ${INSTALL_DIR}"

# --- Clone the platform repo at the pinned release ref ---
mkdir -p "$(dirname "$INSTALL_DIR")"
git clone "$REPO_URL" "$INSTALL_DIR"
git -C "$INSTALL_DIR" checkout "$RELEASE_REF" || \
    echo "stage-droplet: WARN could not checkout '${RELEASE_REF}', staying on default branch"

# Make the operator-facing scripts executable (the index exec bit may not
# survive a fresh clone on every filesystem; setup.sh's --systemd path needs
# these +x).
chmod +x "$INSTALL_DIR"/scripts/*.sh 2>/dev/null || true

# --- Install the first-boot oneshot unit (static, baked) ---
# This is the build-time counterpart of scripts/lib/systemd.sh::
# install_firstboot_service — kept byte-identical in intent so a
# manually-provisioned host and a baked image install the same unit.
install -m 0644 \
    "${INSTALL_DIR}/image/stage-droplet/files/droplet-firstboot.service" \
    /etc/systemd/system/droplet-firstboot.service

# Sentinel directory the unit's ConditionPathExists / ExecStartPost use.
install -d -m 0755 /var/lib/droplet

systemctl enable droplet-firstboot.service

echo "stage-droplet: warming container images (offline-capable first boot)"

# --- Warm the docker-compose stack's images at build time ---
# We reuse the SAME compose file + the SAME build_services rationale as
# scripts/lib/compose.sh::prepare_and_build so the baked image and a live
# setup.sh produce the same image set. NO .env is generated — compose only
# needs real values at `up` time (first boot), not to pull/build images.
#
# Docker isn't running as a daemon inside the build chroot, so we start a
# transient dockerd, warm the images, then stop it. The image layers persist
# in /var/lib/docker, which is part of the baked rootfs.
COMPOSE_FILE="${INSTALL_DIR}/docker/docker-compose.yml"

if command -v dockerd >/dev/null 2>&1; then
    dockerd --iptables=false >/var/log/docker-warmup.log 2>&1 &
    DOCKERD_PID=$!

    # Wait for the daemon socket (bounded — no infinite loop).
    for _ in $(seq 1 30); do
        if docker info >/dev/null 2>&1; then break; fi
        sleep 1
    done

    if docker info >/dev/null 2>&1; then
        # Base images (same list as compose.sh, sequential for slow links).
        for img in \
            postgres:16-alpine \
            redis:7-alpine \
            eclipse-mosquitto:2 \
            nginx:alpine \
            nextcloud:29-apache \
            node:20-alpine \
            python:3.12-slim \
            ghcr.io/blakeblackshear/frigate:stable; do
            docker pull "$img" || echo "stage-droplet: WARN pull failed for $img (first boot will retry)"
        done

        # Build the app images. A dummy --env-file keeps compose happy for the
        # BUILD step (image builds don't consume real secrets); the file holds
        # NO device secrets and is removed immediately after. First boot's
        # setup.sh writes the REAL .env with generated secrets.
        BUILD_ENV="$(mktemp)"
        : > "$BUILD_ENV"
        for svc in orchestrator web-dashboard ai-gateway routing \
                   file-indexer switch camera-discovery oled-display voice-io; do
            docker compose --profile full --profile linux \
                -f "$COMPOSE_FILE" --env-file "$BUILD_ENV" \
                build "$svc" \
                || echo "stage-droplet: WARN build failed for $svc (first boot will rebuild)"
        done
        rm -f "$BUILD_ENV"
    else
        echo "stage-droplet: WARN dockerd did not come up in the chroot — skipping warm-up"
        echo "stage-droplet:      first boot will pull/build on the device instead"
    fi

    # Stop the transient daemon so the baked rootfs isn't left with a running pid.
    kill "$DOCKERD_PID" 2>/dev/null || true
    wait "$DOCKERD_PID" 2>/dev/null || true
else
    echo "stage-droplet: WARN dockerd not found in chroot — skipping image warm-up"
fi

# --- Guard: assert NO secrets were baked ---
# Defensive belt-and-suspenders so a future edit can't silently bake a .env.
if [ -f "${INSTALL_DIR}/.env" ]; then
    echo "stage-droplet: FATAL a .env was created during image build — secrets must NOT be baked" >&2
    exit 1
fi

echo "stage-droplet: done (secrets generated on first boot by setup.sh)"
