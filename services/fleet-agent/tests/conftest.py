"""Shared pytest fixtures for services/fleet-agent (WARP-963).

Every test runs against a mocked portal (respx) and a tmp_path state
dir — no real network, no real /proc dependency (collectors are
injected as fakes so the suite passes on any dev host).
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `import config` / `import agent` etc. work when pytest is invoked
# from the repo root (mirrors services/routing/tests/conftest.py).
_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))

import pytest  # noqa: E402

from agent import FleetAgent  # noqa: E402
from config import load_config  # noqa: E402
from portal import PortalClient  # noqa: E402
from state import StateStore  # noqa: E402

PORTAL_URL = "https://analytics.warp-lab.ai/api/v1"

BASE_ENV = {
    "DROPLET_TELEMETRY_ENABLED": "1",
    "DROPLET_TELEMETRY_PORTAL_URL": PORTAL_URL,
    "DROPLET_TELEMETRY_PROVISIONING_CODE": "prov-code-123",
    "DROPLET_FIRMWARE_VERSION": "0.9.3+pytest",
    "DROPLET_HOSTNAME": "droplet-pytest",
}


class FakeCollector:
    """Deterministic stand-in for collectors.HostCollector."""

    def __init__(self) -> None:
        self.heartbeat_calls = 0

    def heartbeat_payload(self, ts: str) -> dict:
        self.heartbeat_calls += 1
        return {
            "ts": ts,
            "uptime_s": 1000 + self.heartbeat_calls,
            "load": {"1m": 0.1, "5m": 0.2, "15m": 0.3},
            "cpu_pct": 5.0,
            "ram": {"used_mb": 512, "total_mb": 4096},
        }

    def metrics_samples(self, ts: str) -> list[dict]:
        return [{"ts": ts, "name": "system.cpu.pct", "value": 5.0}]

    def inventory_payload(self, ts: str) -> dict:
        return {"ts": ts, "firmware_version": "0.9.3+pytest"}

    def network_payload(self, ts: str) -> dict:
        return {"ts": ts}


class RaisingCollector(FakeCollector):
    """Collector whose reads blow up — the agent must fail open."""

    def heartbeat_payload(self, ts: str) -> dict:  # noqa: ARG002
        raise OSError("/proc unreadable in this environment")


@pytest.fixture
def state_dir(tmp_path: Path) -> Path:
    return tmp_path / "fleet-agent-state"


@pytest.fixture
def env(state_dir: Path) -> dict:
    e = dict(BASE_ENV)
    e["DROPLET_TELEMETRY_STATE_DIR"] = str(state_dir)
    return e


@pytest.fixture
def collector() -> FakeCollector:
    return FakeCollector()


def build_agent(env: dict, collector: FakeCollector | None = None) -> FleetAgent:
    cfg = load_config(env)
    store = StateStore(cfg.state_dir)
    portal = PortalClient(
        base_url=cfg.portal_url,
        firmware_version=cfg.firmware_version,
    )
    return FleetAgent(
        config=cfg,
        state=store,
        portal=portal,
        collector=collector or FakeCollector(),
    )


@pytest.fixture
def agent(env: dict, collector: FakeCollector) -> FleetAgent:
    return build_agent(env, collector)


def register_response() -> dict:
    return {
        "machine_id": "01J9MZTEST",
        "ingest_token": "dpl_01J9MZTEST_secret",
        "ingest_endpoint": PORTAL_URL,
        "config": {
            "heartbeat_interval_s": 30,
            "metrics_interval_s": 60,
            "network_snapshot_interval_s": 300,
            "command_poll_interval_s": 15,
        },
    }
