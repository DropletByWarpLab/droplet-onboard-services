"""Health-sidecar configuration.

Loaded from environment variables, validated at startup. Per architecture-guard
rule 14, defaults must work on a brand-new install OR fail loud — no
host-specific defaults.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Sidecar settings from env. Fail-CLOSED on missing required values."""

    model_config = SettingsConfigDict(
        env_prefix="DROPLET_PM_",
        case_sensitive=False,
        extra="ignore",
    )

    # Plane internal API URL — compose-network DNS, not a host IP.
    api_url: str = Field(
        default="http://pm-api:8000",
        description="Plane backend API base URL inside the compose network.",
    )

    # Sidecar polling cadence — no `while True` (architecture-guard rule 9);
    # the sidecar runs asyncio sleep with cancellation in main.py.
    health_poll_interval: int = Field(
        default=30,
        ge=5,
        le=300,
        description="Seconds between background polls of pm-api/api/health.",
    )

    health_stale_after: int = Field(
        default=90,
        ge=30,
        le=600,
        description="Cached health result age beyond which we report degraded.",
    )

    # Plane upstream pin — surfaced in /health responses. The actual image is
    # pinned in docker-compose; this string is informational only.
    plane_version: str = Field(
        default="unknown",
        description="Pinned Plane upstream SHA, injected at image build time.",
    )


settings = Settings()
