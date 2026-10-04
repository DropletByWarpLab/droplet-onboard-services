#!/usr/bin/env python3
"""Static guards for the compose secret-distribution and hardening work.

Run by scripts/test-security.sh (a required-ish CI lane that needs no Docker).
Needs only PyYAML, like the other compose checks there.

WARP-3588  Services converted off `env_file: ../.env`:
             * must not regain an env_file;
             * must still receive every secret they need, resolved the way the box
               renders them (compose interpolation, bare names), so a typo in a
               variable name or a dropped entry fails here, not on a box.
           Recipients of the high-value secrets are an explicit allowlist: a new
           service that receives DEVICE_SECRET_KEY, JWT_SECRET or the database
           credentials (by env_file or by naming them) fails until a human adds it.
WARP-3625  voice-io, rag-eval and file-indexer keep their fail-closed bearer
           dependency, and the compose wiring that gives them their token.
WARP-3656  Services listed in NO_NEW_PRIVS keep `no-new-privileges:true`.

Exit 0 = ok, 1 = findings (one per line on stderr).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
COMPOSE = REPO / "docker" / "docker-compose.yml"

# --- WARP-3588 ---------------------------------------------------------------

# Services whose env_file ../.env was removed. They must not get it back.
NO_ENV_FILE = {
    "cache", "db", "mcp-bridge", "fleet-agent", "erp-sql-bridge",
    "rag-eval", "voice-io", "device-identity-svc",
}

# Variables a converted service must still receive non-empty when the box has
# them set. Everything else it reads is an optional knob.
REQUIRED = {
    "db": {"POSTGRES_PASSWORD"},
    "mcp-bridge": {"MCP_BRIDGE_SERVICE_TOKEN"},
    "erp-sql-bridge": {"SERVICE_TOKEN_ERP_BRIDGE"},
    "rag-eval": {
        "ORCHESTRATOR_SERVICE_TOKEN", "SERVICE_TOKEN_RAG_EVAL",
        "RAG_EVAL_SERVICE_TOKEN", "RAGAS_EVAL_USER", "DATABASE_URL",
    },
    "voice-io": {"ORCHESTRATOR_TOKEN", "VOICE_IO_SERVICE_TOKEN"},
}

# The secret keys a provisioned box's .env defines (scripts/lib/secrets.sh). The
# render below sets exactly these, so a typo'd variable name renders empty.
BOX_ENV_SECRETS = {
    "POSTGRES_PASSWORD", "DATABASE_URL", "MCP_BRIDGE_SERVICE_TOKEN",
    "SERVICE_TOKEN_ERP_BRIDGE", "SERVICE_TOKEN_RAG_EVAL", "RAG_EVAL_SERVICE_TOKEN",
    "RAGAS_EVAL_USER", "SERVICE_TOKEN_VOICE", "VOICE_IO_SERVICE_TOKEN",
}

# Who may receive each high-value secret (by env_file ../.env or by naming it).
# Adding a service here is a security decision: say why in the PR.
ENV_FILE_HOLDERS = {
    "orchestrator", "mcp-server", "ai-gateway", "file-indexer",
    "inference-manager", "nextcloud",
}
SECRET_RECIPIENTS = {
    "DEVICE_SECRET_KEY": ENV_FILE_HOLDERS,
    "JWT_SECRET": ENV_FILE_HOLDERS,
    # The shared database role is still handed out by name; the per-service role
    # work (WARP-3590, docs/security/postgres-per-service-roles.md) shrinks it.
    "POSTGRES_PASSWORD": ENV_FILE_HOLDERS | {"db", "email-indexer", "rag-eval"},
    "DATABASE_URL": ENV_FILE_HOLDERS | {"db", "email-indexer", "rag-eval"},
}

# --- WARP-3656 ---------------------------------------------------------------

# Services that already ship no-new-privileges and must keep it, plus the ones
# this change adds it to (none of them runs a setuid helper in its main process;
# the reasoning per service is in the PR description).
NO_NEW_PRIVS = {
    "web-fetch", "doc-render", "sandbox", "inference-manager", "voice-io",
    "oled-display", "ops-console", "dmr", "dmr-cuda",
    # added by WARP-3656:
    "mcp-bridge", "erp-sql-bridge", "fleet-agent", "rag-eval",
    "mcp-server", "email-indexer", "web-dashboard", "gateway",
}

# Services that run with `cap_drop: [ALL]` (the four that already did, plus
# mcp-bridge: unprivileged `node` user, port 9096, no volume).
CAP_DROP_ALL = {"web-fetch", "doc-render", "sandbox", "inference-manager", "mcp-bridge"}

# --- WARP-3625 ---------------------------------------------------------------

# (file, regex that must match) — the fail-closed bearer dependency exists.
BEARER_WIRING = [
    ("services/voice-io/main.py", r"dependencies=\[Depends\(require_bearer\)\]"),
    ("services/rag-eval/server.py", r"dependencies=\[Depends\(require_bearer\)\]"),
    ("services/file-indexer/main.py", r"dependencies=\[Depends\(require_bearer\)\]"),
    # ...and every orchestrator caller presents the token.
    ("apps/orchestrator/src/routes/voice.ts", r"serviceBearerHeader\(VOICE_IO_TOKEN_ENV\)"),
    ("apps/orchestrator/src/routes/voice-profiles.ts", r"serviceBearerHeader\(VOICE_IO_TOKEN_ENV\)"),
    ("apps/orchestrator/src/routes/admin-rag-eval.ts", r"serviceBearerHeader\(RAG_EVAL_TOKEN_ENV\)"),
    ("apps/orchestrator/src/routes/crm-filing.ts", r"serviceBearerHeader\(RAG_EVAL_TOKEN_ENV\)"),
    ("apps/orchestrator/src/services/file-reindex.service.ts", r"serviceBearerHeader\(FILE_INDEXER_TOKEN_ENV\)"),
]


def _services() -> dict:
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]


def _env_pairs(cfg: dict) -> list[tuple[str, str | None]]:
    env = cfg.get("environment") or []
    if isinstance(env, dict):
        return [(str(k), None if v is None else str(v)) for k, v in env.items()]
    pairs = []
    for e in env:
        e = str(e)
        if "=" in e:
            k, v = e.split("=", 1)
            pairs.append((k, v))
        else:
            pairs.append((e, None))  # bare name: value comes from the environment
    return pairs


_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)-([^${}]*))?\}")


def _interpolate(value: str, env: dict[str, str]) -> str:
    """The subset of compose interpolation this file uses: ${V}, ${V:-d}, ${V-d}."""
    def sub(m: re.Match) -> str:
        name, colon, default = m.group(1), m.group(2), m.group(3)
        have = env.get(name)
        if have is not None and not (colon and have == ""):
            return have
        return default or ""
    prev = None
    while prev != value:
        prev, value = value, _VAR.sub(sub, value)
    return value


def render_env(cfg: dict, host_env: dict[str, str]) -> dict[str, str]:
    """What the container would see for `environment:` given a host env."""
    out: dict[str, str] = {}
    for k, v in _env_pairs(cfg):
        if v is None:
            if k in host_env:
                out[k] = host_env[k]
        else:
            out[k] = _interpolate(v, host_env)
    return out


def _has_env_file(cfg: dict) -> bool:
    ef = cfg.get("env_file")
    if ef is None:
        return False
    entries = ef if isinstance(ef, list) else [ef]
    paths = [e.get("path") if isinstance(e, dict) else e for e in entries]
    return any("../.env" in str(p) for p in paths)


def _names(cfg: dict, secret: str) -> bool:
    """True if the service is handed THIS secret: a bare `- NAME`, or any value
    that interpolates ${NAME}. A container variable that merely shares the name
    but is fed from another source (docserver: JWT_SECRET=${ONLYOFFICE_JWT_SECRET})
    is a different secret and does not count."""
    for k, v in _env_pairs(cfg):
        if v is None and k == secret:
            return True
        if v is not None and re.search(r"\$\{" + secret + r"[:}-]", v):
            return True
    return False


def check(services: dict) -> list[str]:
    bad: list[str] = []

    for name in sorted(NO_ENV_FILE):
        cfg = services.get(name)
        if cfg is None:
            bad.append(f"{name}: service missing (WARP-3588 list is stale)")
        elif cfg.get("env_file") is not None:
            bad.append(f"{name}: regained env_file (WARP-3588 removed it)")

    for name, needed in sorted(REQUIRED.items()):
        cfg = services.get(name) or {}
        rendered = render_env(cfg, {v: "x" for v in BOX_ENV_SECRETS})
        for var in sorted(needed):
            if not rendered.get(var):
                bad.append(f"{name}: would render {var} empty although the box sets it")

    for secret, allowed in SECRET_RECIPIENTS.items():
        for name, cfg in sorted(services.items()):
            if name in allowed:
                continue
            if _has_env_file(cfg) or _names(cfg, secret):
                bad.append(f"{name}: receives {secret} but is not an allowed recipient")

    for name in sorted(NO_NEW_PRIVS):
        cfg = services.get(name)
        if cfg is None:
            continue
        opts = [str(o).strip('"') for o in (cfg.get("security_opt") or [])]
        if "no-new-privileges:true" not in opts:
            bad.append(f"{name}: security_opt lost no-new-privileges:true (WARP-3656)")

    for name in sorted(CAP_DROP_ALL):
        cfg = services.get(name)
        if cfg is not None and "ALL" not in [str(c).upper() for c in (cfg.get("cap_drop") or [])]:
            bad.append(f"{name}: lost cap_drop ALL (WARP-3656)")

    if not any(
        line.strip() == "data/secrets"
        for line in (REPO / ".dockerignore").read_text(encoding="utf-8").splitlines()
    ):
        bad.append(".dockerignore: data/secrets missing (WARP-3656)")

    for rel, pattern in BEARER_WIRING:
        text = (REPO / rel).read_text(encoding="utf-8")
        if not re.search(pattern, text):
            bad.append(f"{rel}: bearer dependency missing (WARP-3625)")
    return bad


def self_check() -> list[str]:
    """The guard must fail on a violation: mutate a copy and expect findings."""
    services = _services()
    probes = []
    m = {k: dict(v) for k, v in services.items()}
    m["db"]["env_file"] = ["../.env"]
    probes.append(("env_file on db", m))
    m = {k: dict(v) for k, v in services.items()}
    m["mcp-bridge"]["environment"] = [
        e for e in m["mcp-bridge"]["environment"]
        if not str(e).startswith("MCP_BRIDGE_SERVICE_TOKEN")
    ]
    probes.append(("mcp-bridge token dropped", m))
    m = {k: dict(v) for k, v in services.items()}
    m["web-fetch"]["environment"] = list(m["web-fetch"]["environment"]) + ["JWT_SECRET"]
    probes.append(("JWT_SECRET to web-fetch", m))
    miss = [label for label, svc in probes if not check(svc)]
    return [f"self-check: guard did not fail on '{label}'" for label in miss]


def main() -> int:
    bad = check(_services()) + self_check()
    for line in bad:
        print(line, file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
