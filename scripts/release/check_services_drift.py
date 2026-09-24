#!/usr/bin/env python3
"""WARP-3001 — drift gate between docker/docker-compose.yml and the OTA
release service list (scripts/release/services.json).

publish-release.yml builds, pushes and pins ONLY what services.json lists,
and the device-side update agent swaps only what the signed manifest
names. A compose service with a `build:` block that is missing from the
list therefore never gets a new image on an OTA-updated box, silently
(8 services had drifted out by 2026-09-22: gateway, doc-render, sandbox,
inference-manager, ...). This gate makes that divergence a red build:

  * every compose service with `build:` is listed, or named in
    services.json's `excluded` map with a reason;
  * every listed (or excluded) name is a compose `build:` service;
  * each listed context/dockerfile matches compose's build block (compose
    contexts are relative to docker/, services.json's to the repo root).

Runs as a pytest (test_check_services_drift.py) in release-scripts-tests
(PR lane) and in publish-release.yml's generator gate; also runnable:
    python3 scripts/release/check_services_drift.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
COMPOSE = REPO / "docker" / "docker-compose.yml"
SERVICES = REPO / "scripts" / "release" / "services.json"


def compose_builds(compose_path: Path) -> dict[str, tuple[str, str]]:
    """{service: (repo-relative context, dockerfile)} for every build: service."""
    doc = yaml.safe_load(compose_path.read_text(encoding="utf-8"))
    base = compose_path.parent
    out: dict[str, tuple[str, str]] = {}
    for name, svc in (doc.get("services") or {}).items():
        build = (svc or {}).get("build")
        if build is None:
            continue
        if isinstance(build, str):
            build = {"context": build}
        ctx = os.path.relpath((base / build.get("context", ".")).resolve(), REPO)
        out[name] = (ctx, build.get("dockerfile", "Dockerfile"))
    return out


def drift(compose_path: Path = COMPOSE, services_path: Path = SERVICES) -> list[str]:
    """Every divergence as a human-readable line; [] means in sync."""
    builds = compose_builds(compose_path)
    doc = json.loads(services_path.read_text(encoding="utf-8"))
    listed = {s["name"]: s for s in doc["services"]}
    excluded = doc.get("excluded") or {}
    problems: list[str] = []

    for name in sorted(builds):
        if name not in listed and name not in excluded:
            problems.append(
                f"{name}: compose builds it but services.json neither lists it "
                "nor excludes it (an OTA box would never get its new image)")
    for name, reason in sorted(excluded.items()):
        if not str(reason).strip():
            problems.append(f"{name}: excluded without a reason")
        if name in listed:
            problems.append(f"{name}: both listed and excluded")
    for name in sorted(set(listed) | set(excluded)):
        if name not in builds:
            problems.append(f"{name}: in services.json but not a compose build: service")
    for name, entry in sorted(listed.items()):
        if name not in builds:
            continue
        want = builds[name]
        got = (os.path.normpath(entry["context"]), entry["dockerfile"])
        if got != want:
            problems.append(f"{name}: services.json builds {got}, compose builds {want}")
    return problems


def main() -> int:
    problems = drift()
    for p in problems:
        print(f"check_services_drift: {p}", file=sys.stderr)
    if not problems:
        print("check_services_drift: services.json matches every compose build: service")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
