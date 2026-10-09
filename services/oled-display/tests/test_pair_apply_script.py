"""Hermetic tests for the pairing ROOT executor (ADR-071 slice B).

scripts/host/droplet-pair-apply.sh is the ExecStart of droplet-pair-apply.service:
it consumes the ONE request the sandboxed bridge spooled, re-validates it, writes
docker/secrets/<role>_password and recreates the container that reads it. Under
test here:

  - target -> secret file + container mapping (router/ap -> routing, switch);
  - the secret is exactly the 32 hex characters, no trailing newline, mode 0600;
  - the write is atomic (no .pair.* leftovers) and replaces an old value;
  - the spool is consumed (zeroed + unlinked) on success AND on rejection;
  - a bad target / password writes nothing and exits non-zero;
  - the compose command is exactly `docker compose -p droplet -f <compose> up -d
    --no-deps --force-recreate <container>` and a recreate failure exits non-zero.

docker is a PATH stub; no root, no systemd, no real compose.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "host" / "droplet-pair-apply.sh"
BASH = shutil.which("bash")
PASSWORD = "fedcba9876543210fedcba9876543210"

pytestmark = [
    pytest.mark.skipif(BASH is None, reason="bash not available"),
    pytest.mark.skipif(shutil.which("python3") is None, reason="python3 not available"),
    pytest.mark.skipif(os.name == "nt", reason="POSIX shebang/ownership semantics"),
]


@pytest.fixture
def env(tmp_path):
    spool = tmp_path / "spool"
    spool.mkdir(mode=0o700)
    repo = tmp_path / "repo"
    (repo / "docker" / "secrets").mkdir(parents=True)
    (repo / "docker" / "docker-compose.yml").write_text("name: droplet\n")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "docker.log"
    docker = bindir / "docker"
    docker.write_text('#!/bin/bash\necho "$@" >> "%s"\nexit ${DOCKER_RC:-0}\n' % log)
    docker.chmod(0o755)
    e = {
        **os.environ,
        "PATH": "%s:%s" % (bindir, os.environ["PATH"]),
        "DROPLET_PAIR_SPOOL_DIR": str(spool),
        "DROPLET_PAIR_REPO_ROOT": str(repo),
        "DROPLET_PAIR_OWNER": os.environ.get("USER") or "root",
    }
    return {"env": e, "spool": spool, "repo": repo, "log": log}


def _spool(e, payload=None, raw=None):
    (e["spool"] / "request.json").write_text(raw if raw is not None else json.dumps(payload))


def _run(e, **extra):
    return subprocess.run([BASH, str(SCRIPT)], env={**e["env"], **extra},
                          capture_output=True, text=True, timeout=60)


@pytest.mark.parametrize("target,filename,container", [
    ("router", "openwrt_password", "routing"),
    ("ap", "ap_openwrt_password", "routing"),
    ("switch", "switch_password", "switch"),
])
def test_writes_the_role_secret_and_recreates_its_container(env, target, filename, container):
    _spool(env, {"target": target, "password": PASSWORD})
    r = _run(env)
    assert r.returncode == 0, r.stderr
    secret = env["repo"] / "docker" / "secrets" / filename
    assert secret.read_bytes() == PASSWORD.encode()          # no trailing newline
    assert stat.S_IMODE(secret.stat().st_mode) == 0o600
    assert not (env["spool"] / "request.json").exists()
    compose = env["repo"] / "docker" / "docker-compose.yml"
    assert env["log"].read_text().strip() == (
        "compose -p droplet -f %s up -d --no-deps --force-recreate %s" % (compose, container))
    assert PASSWORD not in r.stdout + r.stderr


def test_replaces_an_existing_secret_atomically(env):
    secret = env["repo"] / "docker" / "secrets" / "openwrt_password"
    secret.write_text("old-operator-value")
    _spool(env, {"target": "router", "password": PASSWORD})
    assert _run(env).returncode == 0
    assert secret.read_text() == PASSWORD
    assert [p.name for p in secret.parent.iterdir()] == ["openwrt_password"]


@pytest.mark.parametrize("payload", [
    {"target": "gateway", "password": PASSWORD},
    {"target": "router", "password": PASSWORD[:-1]},
    {"target": "router", "password": PASSWORD.upper()},
    {"target": "router", "password": PASSWORD + "\n"},
    {"target": "router"},
    ["router", PASSWORD],
])
def test_rejects_invalid_spool_writes_nothing_and_wipes_the_spool(env, payload):
    _spool(env, payload)
    r = _run(env)
    assert r.returncode != 0
    assert list((env["repo"] / "docker" / "secrets").iterdir()) == []
    assert not env["log"].exists()
    assert not (env["spool"] / "request.json").exists()
    assert PASSWORD not in r.stdout + r.stderr


def test_malformed_json_is_rejected_and_wiped(env):
    _spool(env, raw="{not json")
    assert _run(env).returncode != 0
    assert not (env["spool"] / "request.json").exists()


def test_no_spooled_request_is_an_executor_error(env):
    r = _run(env)
    assert r.returncode != 0
    assert "nothing to apply" in r.stderr


def test_recreate_failure_exits_nonzero_but_the_secret_is_written(env):
    _spool(env, {"target": "router", "password": PASSWORD})
    r = _run(env, DOCKER_RC="1")
    assert r.returncode != 0
    assert (env["repo"] / "docker" / "secrets" / "openwrt_password").read_text() == PASSWORD
    assert not (env["spool"] / "request.json").exists()
    assert PASSWORD not in r.stdout + r.stderr


def test_skip_recreate_hook_does_not_touch_docker(env):
    _spool(env, {"target": "router", "password": PASSWORD})
    assert _run(env, DROPLET_PAIR_SKIP_RECREATE="1").returncode == 0
    assert not env["log"].exists()


def test_external_router_sync_keeps_what_the_writer_produced(env):
    """sync_openwrt_password_secret keeps a NON-EMPTY file for an external router."""
    _spool(env, {"target": "router", "password": PASSWORD})
    assert _run(env).returncode == 0
    secret = env["repo"] / "docker" / "secrets" / "openwrt_password"
    assert secret.stat().st_size == 32


# --- ADR-071 slice C: the AP and switch targets ------------------------------
SECRETS = {
    "router": "openwrt_password",
    "ap": "ap_openwrt_password",
    "switch": "switch_password",
}


@pytest.mark.parametrize("target", ["router", "ap", "switch"])
def test_a_target_only_ever_replaces_its_own_secret(env, target):
    """Pairing the AP must not clobber the router's or the switch's credential."""
    secrets = env["repo"] / "docker" / "secrets"
    for name in SECRETS.values():
        (secrets / name).write_text("untouched-" + name)
    _spool(env, {"target": target, "password": PASSWORD})
    assert _run(env).returncode == 0
    for other, name in SECRETS.items():
        expected = PASSWORD if other == target else "untouched-" + name
        assert (secrets / name).read_text() == expected, other


@pytest.mark.parametrize("target", ["ap", "switch"])
def test_ap_and_switch_secrets_get_the_same_mode_and_no_newline(env, target):
    _spool(env, {"target": target, "password": PASSWORD})
    assert _run(env).returncode == 0
    secret = env["repo"] / "docker" / "secrets" / SECRETS[target]
    assert secret.read_bytes() == PASSWORD.encode()
    assert stat.S_IMODE(secret.stat().st_mode) == 0o600
    assert [p.name for p in secret.parent.iterdir()] == [SECRETS[target]]  # no .pair.* leftovers


@pytest.mark.parametrize("target,container", [("ap", "routing"), ("switch", "switch")])
def test_ap_and_switch_recreate_failure_names_the_container_not_the_secret(env, target, container):
    _spool(env, {"target": target, "password": PASSWORD})
    r = _run(env, DOCKER_RC="1")
    assert r.returncode != 0
    assert container + " recreate FAILED" in r.stderr
    assert PASSWORD not in r.stdout + r.stderr


def test_every_target_maps_to_a_compose_service_that_mounts_that_secret():
    """The recreate is only meaningful if the compose file really binds the secret
    into the container the script recreates (the router and AP into `routing`,
    the switch into `switch`), and the secret files are the ones the script writes."""
    import re

    compose = (REPO_ROOT / "docker" / "docker-compose.yml").read_text(encoding="utf-8")

    def service_block(name: str) -> str:
        m = re.search(
            r"^  %s:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|^[a-z]+:\n)" % re.escape(name),
            compose,
            re.S | re.M,
        )
        assert m, "compose service %s not found" % name
        return m.group(1)

    routing, switch = service_block("routing"), service_block("switch")
    assert re.search(r"^      - openwrt_password$", routing, re.M)
    assert re.search(r"^      - ap_openwrt_password$", routing, re.M)
    assert re.search(r"^      - switch_password$", switch, re.M)
    for name in SECRETS.values():
        pattern = r"^  %s:\n    file: \.\./docker/secrets/%s$" % (name, name)
        assert re.search(pattern, compose, re.M), name
