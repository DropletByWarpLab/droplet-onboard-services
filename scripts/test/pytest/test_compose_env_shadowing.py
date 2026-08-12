"""WARP-1908 — `environment:` must never shadow an `env_file:` value with "".

Compose resolves `${VAR}` in `environment:` against the env file it finds next
to the compose file — `docker/.env` — which is NOT the `env_file: ../.env` the
services actually load. When a key lives only in the root `.env`, the
substitution yields "" and, because `environment:` outranks `env_file:`, that
empty string SHADOWS the operator's real value. The service then starts
mis-configured with no error anywhere.

This has now shipped twice:

  * WARP-1860 — `SERVICE_TOKEN_RAG_EVAL=${SERVICE_TOKEN_RAG_EVAL:-}` on the
    orchestrator. 15 consecutive nightly RAGAS runs 401'd on every query while
    pinning the GPU.
  * WARP-1908 — `RAGAS_EVAL_USER=${RAGAS_EVAL_USER:-}` on rag-eval. Every
    search went out with no `?user=` and 400'd on `eval_user_required`, so
    every run aborted at the third query.

Both were the same one-line mistake, and both were invisible until someone
read a failing run's log by hand. The rule the WARP-1860 fix wrote into
docker-compose.yml is: *only* use `${...}` in `environment:` for a value that
genuinely needs RENAMING. A self-reference (`KEY=${KEY...}`) renames nothing —
env_file already delivers that exact key — so it can only ever blank a good
value. This test makes that rule mechanical.

`test_upsert_writes_through_the_env_symlink` covers the other half: what let
the two env files diverge in the first place.

Hermetic by design — no pyyaml (see shell-validation-tests.yml: a
requirements.txt appearing in this lane means a test stopped being hermetic),
so the compose file is scanned line-wise rather than parsed into objects.
"""
from __future__ import annotations

import re
import subprocess
import textwrap
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_COMPOSE = _REPO_ROOT / "docker" / "docker-compose.yml"

# `- KEY=value` (list form) and `KEY: value` (mapping form) both occur in this
# compose file, so both have to be recognised.
_LIST_ENTRY = re.compile(r"^ {6}- ([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
_MAP_ENTRY = re.compile(r"^ {6}([A-Za-z_][A-Za-z0-9_]*): (.*)$")


def _services_with_env_file_and_environment() -> dict[str, dict]:
    """Return {service: {"env_file": [...], "environment": [(key, value), ...]}}.

    Line-wise, keyed off this file's indentation contract: services at 2
    spaces, their keys at 4, entries at 6.
    """
    services: dict[str, dict] = {}
    in_services = False
    service: str | None = None
    section: str | None = None

    for raw in _COMPOSE.read_text(encoding="utf-8").splitlines():
        if raw.strip().startswith("#") or not raw.strip():
            continue

        if re.match(r"^[A-Za-z_-]+:", raw):           # top-level key
            in_services = raw.startswith("services:")
            service = section = None
            continue
        if not in_services:
            continue

        m = re.match(r"^ {2}([A-Za-z0-9_-]+):\s*$", raw)   # service name
        if m:
            service = m.group(1)
            services[service] = {"env_file": [], "environment": []}
            section = None
            continue
        if service is None:
            continue

        m = re.match(r"^ {4}([A-Za-z0-9_-]+):", raw)       # key within service
        if m:
            section = m.group(1)
            continue

        if section == "env_file":
            # Either `- ../.env` or `- path: ../.env`.
            m = re.match(r"^ {6,}-?\s*(?:path:\s*)?(\S+)\s*$", raw)
            if m and m.group(1) not in ("required:", "true", "false"):
                services[service]["env_file"].append(m.group(1))
        elif section == "environment":
            m = _LIST_ENTRY.match(raw) or _MAP_ENTRY.match(raw)
            if m:
                services[service]["environment"].append((m.group(1), m.group(2)))

    return services


# NOTE ON SCOPE. `KEY=${KEY:-}` appears ~40 times across this compose file,
# almost all of them optional tuning knobs where "" and unset mean the same
# thing to the service. Banning the shape outright would be ~40 findings of
# mostly-noise, so this suite does NOT do that. What actually makes those ~40
# harmless is the invariant below: docker/.env is a SYMLINK to ../.env, so
# Compose's interpolation source and the services' env_file are one file and
# a self-reference resolves to the operator's own value. WARP-1908 happened
# because that symlink was destroyed, not because the shape is wrong.
#
# So the guards here are: the symlink stays declared (test_compose_sh_*), the
# writers stop destroying it (test_upsert_*), and the one key with no safe
# empty behaviour is not re-declared at all (test_rag_eval_user_*).


def test_compose_file_is_readable():
    """Guard the guard: a parser that silently finds nothing would pass forever."""
    services = _services_with_env_file_and_environment()
    assert len(services) > 20, f"only parsed {len(services)} services — parser drifted"
    assert "rag-eval" in services, "rag-eval service not found — parser drifted"
    assert any(
        p.endswith("../.env") for p in services["rag-eval"]["env_file"]
    ), "rag-eval lost its `env_file: ../.env`"
    assert (
        len(services["rag-eval"]["environment"]) > 5
    ), "rag-eval environment entries not parsed — parser drifted"


def test_compose_sh_still_links_docker_env_to_the_root_env():
    """The invariant that makes every other `${KEY:-}` in this file harmless.

    Without this symlink, Compose interpolates against a docker/.env that no
    installer keeps in step with the root .env, and every self-reference
    quietly becomes "".
    """
    compose_sh = (_REPO_ROOT / "scripts" / "lib" / "compose.sh").read_text(
        encoding="utf-8"
    )
    assert re.search(r"ln -sfn\s+\.\./\.env\s+\"\$\{?\w+\}?\"", compose_sh), (
        "scripts/lib/compose.sh no longer links docker/.env -> ../.env. That "
        "link is what keeps Compose's ${...} interpolation source and the "
        "services' `env_file: ../.env` the same file (WARP-1908)."
    )
    assert '_compose_env_link="$REPO_ROOT/docker/.env"' in compose_sh, (
        "compose.sh no longer points the link at docker/.env — the ln above "
        "is only meaningful if that is its destination."
    )
    assert "-L " in compose_sh, (
        "compose.sh lost its regular-file check. `ln -sfn` over a drifted "
        "regular docker/.env deletes it silently; WARP-1908 wants that "
        "reported and backed up, not swallowed."
    )


def test_rag_eval_user_reaches_the_container_via_env_file_only():
    """The specific WARP-1908 regression, named so a re-introduction is obvious."""
    rag_eval = _services_with_env_file_and_environment()["rag-eval"]
    declared = [k for k, _ in rag_eval["environment"]]
    assert "RAGAS_EVAL_USER" not in declared, (
        "rag-eval re-declared RAGAS_EVAL_USER in `environment:`. That shadows "
        "the operator's value from `env_file: ../.env` with \"\", the runner "
        "then omits ?user=, and every retrieval-eval search 400s on "
        "eval_user_required (WARP-1908)."
    )


# --- the other half: what let the two env files diverge --------------------

_UPSERT_SCRIPTS = [
    ("flip-single-box.sh", "upsert"),
    ("rollback-single-box.sh", "upsert"),
    ("rollback-single-box.sh", "drop_key"),
]


def _extract_bash_function(script: Path, name: str) -> str:
    """Pull `name() { ... }` out of a script that cannot be sourced.

    These scripts run top-level code (preflights, docker calls) the moment
    they load, so the helper is lifted out by text instead.
    """
    lines = script.read_text(encoding="utf-8").splitlines()
    start = next(
        (i for i, ln in enumerate(lines) if re.match(rf"^{re.escape(name)}\(\)", ln)),
        None,
    )
    assert start is not None, f"{name}() not found in {script.name}"
    end = next((i for i in range(start + 1, len(lines)) if lines[i] == "}"), None)
    assert end is not None, f"{name}() has no closing brace in {script.name}"
    return "\n".join(lines[start : end + 1])


@pytest.mark.parametrize("script_name,func", _UPSERT_SCRIPTS)
def test_upsert_writes_through_the_env_symlink(tmp_path, script_name, func):
    """WARP-1908: `mv` onto a symlink REPLACES it, forking the two env files.

    scripts/lib/compose.sh points docker/.env at ../.env precisely so Compose's
    ${...} interpolation source and the services' env_file are one file. A
    staged-write helper that `mv`s onto the link path destroys that, and from
    then on every key added to root .env alone silently interpolates to "".
    """
    script = _REPO_ROOT / "scripts" / "dmr" / script_name
    helper = _extract_bash_function(script, func)
    resolver = _extract_bash_function(script, "_resolve_env_target")

    root_env = tmp_path / ".env"
    root_env.write_text("EXISTING=keep\nINFERENCE_RUNTIME=ollama\n", encoding="utf-8")
    compose_dir = tmp_path / "docker"
    compose_dir.mkdir()
    link = compose_dir / ".env"
    link.symlink_to("../.env")

    call = (
        f'upsert "{link}" INFERENCE_RUNTIME dmr'
        if func == "upsert"
        else f'drop_key "{link}" INFERENCE_RUNTIME'
    )
    program = textwrap.dedent(
        f"""
        set -euo pipefail
        {resolver}
        {helper}
        {call}
        """
    )
    subprocess.run(["bash", "-c", program], check=True, capture_output=True)

    assert link.is_symlink(), (
        f"{script_name}:{func}() replaced the docker/.env SYMLINK with a regular "
        "file. Compose's interpolation source and the services' env_file have "
        "now forked, and every key that only root .env carries will silently "
        "substitute as \"\" (WARP-1908)."
    )
    body = root_env.read_text(encoding="utf-8")
    assert "EXISTING=keep" in body, "writing through the link lost existing keys"
    if func == "upsert":
        assert "INFERENCE_RUNTIME=dmr" in body, "upsert did not reach the link target"
    else:
        assert "INFERENCE_RUNTIME" not in body, "drop_key did not reach the link target"
