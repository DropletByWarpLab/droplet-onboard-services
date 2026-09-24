"""WARP-3001 — the compose <-> services.json drift gate.

The first test IS the gate on the real tree; the rest prove it catches each
drift shape, so a future edit can't quietly defang it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import check_services_drift as gate  # noqa: E402


def test_real_tree_has_no_drift():
    assert gate.drift() == []


@pytest.fixture
def tree(tmp_path, monkeypatch):
    """A fake repo: docker/docker-compose.yml + a services.json."""
    monkeypatch.setattr(gate, "REPO", tmp_path)
    (tmp_path / "docker").mkdir()
    compose = tmp_path / "docker" / "docker-compose.yml"
    services = tmp_path / "services.json"

    def write(compose_services: dict, listed: list, excluded: dict | None = None):
        import yaml
        compose.write_text(yaml.safe_dump({"services": compose_services}))
        services.write_text(json.dumps({"services": listed, "excluded": excluded or {}}))
        return gate.drift(compose, services)

    return write


def _svc(dockerfile: str, **extra):
    return {"build": {"context": "..", "dockerfile": dockerfile}, **extra}


def _entry(name: str, dockerfile: str):
    return {"name": name, "context": ".", "dockerfile": dockerfile,
            "healthcheck": {"type": "none"}}


def test_in_sync(tree):
    assert tree({"a": _svc("a/Dockerfile"), "db": {"image": "postgres"}},
                [_entry("a", "a/Dockerfile")]) == []


def test_new_compose_service_missing_from_manifest_fails(tree):
    problems = tree({"a": _svc("a/Dockerfile"),
                     "brand-new": _svc("b/Dockerfile", profiles=["x"])},
                    [_entry("a", "a/Dockerfile")])
    assert len(problems) == 1 and problems[0].startswith("brand-new:")


def test_reasoned_exclusion_passes_and_empty_reason_fails(tree):
    assert tree({"a": _svc("a/Dockerfile")}, [], {"a": "eval harness"}) == []
    assert any("without a reason" in p
               for p in tree({"a": _svc("a/Dockerfile")}, [], {"a": " "}))


def test_listed_service_gone_from_compose_fails(tree):
    assert any(p.startswith("ghost:") for p in
               tree({}, [_entry("ghost", "g/Dockerfile")]))


def test_dockerfile_mismatch_fails(tree):
    assert any("compose builds" in p for p in
               tree({"a": _svc("a/Dockerfile.new")}, [_entry("a", "a/Dockerfile")]))


def test_context_is_resolved_relative_to_docker_dir(tree):
    compose = {"ow": {"build": {"context": "../openwrt", "dockerfile": "x/Dockerfile"}}}
    ok = [{"name": "ow", "context": "openwrt", "dockerfile": "x/Dockerfile",
           "healthcheck": {"type": "none"}}]
    assert tree(compose, ok) == []
