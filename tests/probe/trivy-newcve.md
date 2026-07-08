# Trivy image-gate probe — a NEW fixable HIGH/CRITICAL must fail the build

The WARP-243 image-vuln gate (`.github/workflows/docker-build.yml`, Trivy step)
is deterministic — pinned DB (`.github/trivy-db-version`) + committed baseline
(`.trivyignore`) — so it never flake-blocks on DB drift over pre-existing
findings. This probe proves it still blocks a genuinely NEW fixable vuln.

## Reproduce (Docker + trivy 0.7x)

```bash
PIN="ghcr.io/aquasecurity/trivy-db@$(grep -v '^#' .github/trivy-db-version | tr -d '[:space:]')"
export TRIVY_DB_REPOSITORY="$PIN" TRIVY_SKIP_VERSION_CHECK=true

# A tiny image with a known-vulnerable, NOT-baselined pin:
printf 'FROM python:3.12-slim\nRUN pip install --no-cache-dir "urllib3==1.26.5"\n' > /tmp/Dockerfile.probe
docker build -q -t droplet-ci/probe:scan -f /tmp/Dockerfile.probe /tmp

# Same flags as CI. Expect exit 1 (blocks) — urllib3 1.26.5 has fixable HIGH CVEs
# (CVE-2023-43804, CVE-2025-66418, CVE-2026-21441, …) absent from .trivyignore.
trivy image --severity HIGH,CRITICAL --ignore-unfixed --scanners vuln \
  --ignorefile .trivyignore --exit-code 1 droplet-ci/probe:scan; echo "exit=$?"
```

## Verified 2026-07-05 (pinned DB sha256:a8a1af88…)
- Probe image, baseline applied → **exit 1** (5 fixable urllib3 HIGH CVEs reported, blocked).
- Same 5 CVEs added to `.trivyignore` → **exit 0** (baseline suppresses — proves the
  baseline, not a broken gate, is what makes real images pass).
- All 12 shipped images against the pinned DB + committed baseline → **exit 0**.
