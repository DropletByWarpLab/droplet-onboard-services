#!/bin/sh
# 02-canonical-host.sh — render the canonical-host include at container start
# (warning-free droplet.local). Same /docker-entrypoint.d slot pattern as
# 00-fips-profile.sh / 01-internal-scheme.sh. The render script re-runs on
# every cert swap via scripts/lib/tls-reload.sh.
set -eu
/usr/local/bin/render-canonical-host.sh
