"""Hermetic test for the hostname validation in scripts/lib/local-dns.sh (WARP-995).

`local-dns.sh` makes the box reachable by name on the LAN. Before it interpolates
a hostname into `/etc/avahi/avahi-daemon.conf` (via `sed`, `host-name=<value>`) or
into the OpenWrt dnsmasq host-record, it screens the operator-controlled env vars
`DROPLET_MDNS_HOSTNAME` / `DROPLET_LAN_HOSTNAME` (and, later, `DROPLET_PUBLIC_FQDN`)
through `_valid_hostname()`. That guard is the unit under test.

Unlike the host scripts (WARP-988 box-name, WARP-994 public-fqdn) which validate an
argv value, `local-dns.sh` is a *sourced library*: it validates the env vars at
source time (the `if ! _valid_hostname ...` blocks blank the var on rejection), so
the payload rides in via the ENVIRONMENT block. That is also the Windows-safe
delivery — `CreateProcess` command-line quoting mangles a newline embedded in argv,
which would silently exercise a clean value instead of the injection payload.

The bug (WARP-995, mirroring WARP-994/WARP-988): `_valid_hostname` matched with a
line-based `printf '%s' "$name" | grep -Eq '^...$'`. `grep -q` succeeds if ANY line
matches, so a newline-bearing value like `droplet-ai\nHostName=evil` passes on its
first line and the injected second line survives into the rendered config. The fix
is bash whole-string matching (`[[ "$name" =~ ^...$ ]]`), which is newline-safe: the
char classes cannot match a newline and `$` anchors the end of the whole string, not
each line. These tests assert the newline payload is refused before any write while
legitimate single-label and dotted FQDN names still pass.

We drive bash in a subprocess, sourcing `logging.sh` then `local-dns.sh` exactly as
the real caller (`scripts/host/droplet-set-public-fqdn.sh`) does. Skipped
automatically if a POSIX `bash` isn't on PATH.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
LOCAL_DNS = _REPO_ROOT / "scripts" / "lib" / "local-dns.sh"
LOGGING = _REPO_ROOT / "scripts" / "lib" / "logging.sh"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")

# The classic config-injection payload: a valid first label, then a newline that
# opens a SECOND directive. A line-based grep matches line 1 and lets the rest ride
# along; whole-string `[[ =~ ]]` rejects it.
_NEWLINE_PAYLOAD = "droplet-ai\nHostName=evil"


def _source_dns(snippet: str, extra_env: dict | None = None) -> subprocess.CompletedProcess:
    """Source logging.sh + local-dns.sh, then run `snippet`, in a clean tmp cwd.

    Payload values are passed through the environment block (NUL-separated, so a
    literal newline survives) rather than argv. `local-dns.sh` reads the hostname
    env vars at source time, so this exercises the real validation path.
    """
    env = dict(os.environ)
    # Neutralize any inherited hostname/routing config from the dev shell so the
    # test is hermetic and never attempts a real DNS/curl/avahi side effect.
    for k in ("ROUTING_MODE", "DROPLET_PUBLIC_FQDN"):
        env.pop(k, None)
    env["ROUTING_MODE"] = "disabled"
    env["LOGGING"] = str(LOGGING)
    env["LOCAL_DNS"] = str(LOCAL_DNS)
    if extra_env:
        env.update(extra_env)
    driver = '. "$LOGGING"; . "$LOCAL_DNS"; ' + snippet
    return subprocess.run(
        [BASH, "-c", driver],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_scripts_exist_and_are_bash():
    for p in (LOCAL_DNS, LOGGING):
        assert p.exists(), f"missing {p}"
    first = LOCAL_DNS.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("#!") and "bash" in first


# --- _valid_hostname() called directly (unit) --------------------------------

@pytest.mark.parametrize("good", [
    "droplet-ai",                       # single mDNS label
    "droplet-ai.lan",                   # dotted FQDN (router DNS)
    "d-0123456789abcdef.devices.warp-lab.ai",  # opaque per-device FQDN
    "a",                                # minimal single char
])
def test_valid_hostname_accepts_legit_names(good):
    proc = _source_dns('_valid_hostname "$CAND"', {"CAND": good})
    assert proc.returncode == 0, f"{good!r} was rejected\n{proc.stderr}"


@pytest.mark.parametrize("bad", [
    "Droplet-AI",                       # uppercase
    "droplet_ai",                       # underscore
    "-droplet",                         # leading hyphen
    "droplet-",                         # trailing hyphen
    "droplet ai",                       # space
    "droplet;rm -rf",                   # shell metacharacter
    "",                                 # empty
])
def test_valid_hostname_rejects_malformed_names(bad):
    proc = _source_dns('_valid_hostname "$CAND"', {"CAND": bad})
    assert proc.returncode != 0, f"{bad!r} was accepted"


def test_valid_hostname_rejects_newline_payload():
    # The core WARP-995 regression: a line-based grep accepts this (line 1 matches);
    # whole-string bash matching must reject it.
    proc = _source_dns('_valid_hostname "$CAND"', {"CAND": _NEWLINE_PAYLOAD})
    assert proc.returncode != 0, "newline-bearing hostname was accepted by _valid_hostname"


def test_valid_hostname_rejects_trailing_newline():
    # A trailing newline alone must also fail — `$` in `[[ =~ ]]` anchors the end of
    # the whole string (no REG_NEWLINE), so it won't match before a trailing LF the
    # way an unanchored / line-based check would.
    proc = _source_dns('_valid_hostname "$CAND"', {"CAND": "droplet-ai\n"})
    assert proc.returncode != 0, "trailing-newline hostname was accepted"


# --- Source-time guard blanks the injected value before it can be written ----

def test_mdns_newline_injection_is_refused_before_write():
    # DROPLET_MDNS_HOSTNAME flows into /etc/avahi/avahi-daemon.conf via sed. A
    # newline would inject a second `HostName=evil` directive. The source-time
    # guard must blank the value so setup_mdns skips it entirely.
    proc = _source_dns(
        'printf "MDNS=<%s>" "$DROPLET_MDNS_HOSTNAME"',
        {"DROPLET_MDNS_HOSTNAME": _NEWLINE_PAYLOAD},
    )
    assert proc.returncode == 0, proc.stderr
    assert "HostName=evil" not in proc.stdout, "injected directive survived validation"
    assert "MDNS=<>" in proc.stdout, f"expected blanked value, got: {proc.stdout!r}"


def test_lan_newline_injection_is_refused_before_write():
    # DROPLET_LAN_HOSTNAME flows into the dnsmasq host-record / routing payload.
    proc = _source_dns(
        'printf "LAN=<%s>" "$DROPLET_LAN_HOSTNAME"',
        {"DROPLET_LAN_HOSTNAME": "droplet-ai.lan\naddress=/evil/6.6.6.6"},
    )
    assert proc.returncode == 0, proc.stderr
    assert "address=/evil" not in proc.stdout, "injected directive survived validation"
    assert "LAN=<>" in proc.stdout, f"expected blanked value, got: {proc.stdout!r}"


def test_legit_hostnames_survive_source_time_validation():
    # Guard against over-rejection: valid defaults must NOT be blanked.
    proc = _source_dns(
        'printf "MDNS=<%s> LAN=<%s>" "$DROPLET_MDNS_HOSTNAME" "$DROPLET_LAN_HOSTNAME"',
        {"DROPLET_MDNS_HOSTNAME": "droplet-ai", "DROPLET_LAN_HOSTNAME": "droplet-ai.lan"},
    )
    assert proc.returncode == 0, proc.stderr
    assert "MDNS=<droplet-ai>" in proc.stdout
    assert "LAN=<droplet-ai.lan>" in proc.stdout
