"""WARP-963 — flag + credential gating and geo canonicalization.

The agent is DISABLED unless DROPLET_TELEMETRY_ENABLED=1 AND credentials
are present (a provisioning code, or an already-persisted identity).
"""

from __future__ import annotations

from config import load_config
from state import StateStore

from .conftest import BASE_ENV, build_agent


def _env_without(env: dict, *keys: str) -> dict:
    e = dict(env)
    for k in keys:
        e.pop(k, None)
    return e


class TestGating:
    def test_disabled_by_default(self, state_dir):
        """No env at all → gate closed, honest reason."""
        cfg = load_config({"DROPLET_TELEMETRY_STATE_DIR": str(state_dir)})
        assert cfg.flag_enabled is False
        agent = build_agent({"DROPLET_TELEMETRY_STATE_DIR": str(state_dir)})
        active, reason = agent.gate()
        assert active is False
        assert "DROPLET_TELEMETRY_ENABLED" in reason

    def test_flag_zero_is_disabled(self, env):
        e = dict(env)
        e["DROPLET_TELEMETRY_ENABLED"] = "0"
        agent = build_agent(e)
        active, _ = agent.gate()
        assert active is False

    def test_flag_without_credentials_is_disabled(self, env):
        e = _env_without(env, "DROPLET_TELEMETRY_PROVISIONING_CODE")
        agent = build_agent(e)
        active, reason = agent.gate()
        assert active is False
        assert "credential" in reason.lower()

    def test_flag_plus_provisioning_code_is_enabled(self, env):
        agent = build_agent(env)
        active, _ = agent.gate()
        assert active is True

    def test_flag_plus_persisted_identity_is_enabled(self, env, state_dir):
        """No provisioning code, but a previous registration persisted an
        ingest token → gate open."""
        e = _env_without(env, "DROPLET_TELEMETRY_PROVISIONING_CODE")
        store = StateStore(load_config(e).state_dir)
        store.save_identity(
            machine_id="01J9MZTEST",
            ingest_token="dpl_01J9MZTEST_secret",
            ingest_endpoint=BASE_ENV["DROPLET_TELEMETRY_PORTAL_URL"],
            intervals={"heartbeat_interval_s": 30},
        )
        agent = build_agent(e)
        active, _ = agent.gate()
        assert active is True


class TestGeoFields:
    def test_geo_omitted_when_unset(self, env):
        cfg = load_config(env)
        assert cfg.geo_country is None
        assert cfg.geo_region is None

    def test_geo_empty_string_is_omitted(self, env):
        """An empty geoRegion 422s the whole heartbeat server-side — the
        config layer must translate '' to omission."""
        e = dict(env)
        e["DROPLET_TELEMETRY_GEO_COUNTRY"] = ""
        e["DROPLET_TELEMETRY_GEO_REGION"] = "   "
        cfg = load_config(e)
        assert cfg.geo_country is None
        assert cfg.geo_region is None

    def test_geo_country_canonicalized_uppercase(self, env):
        e = dict(env)
        e["DROPLET_TELEMETRY_GEO_COUNTRY"] = "de"
        cfg = load_config(e)
        assert cfg.geo_country == "DE"

    def test_geo_country_invalid_shape_is_omitted(self, env):
        e = dict(env)
        e["DROPLET_TELEMETRY_GEO_COUNTRY"] = "DEU"  # alpha-3 → reject
        cfg = load_config(e)
        assert cfg.geo_country is None

    def test_geo_region_too_long_is_omitted(self, env):
        e = dict(env)
        e["DROPLET_TELEMETRY_GEO_REGION"] = "x" * 101
        cfg = load_config(e)
        assert cfg.geo_region is None
