"""Shared test fixtures for services/fleet-server.

Sets env-var defaults so the service modules import cleanly in a test
context, and puts the service root on sys.path (mirrors the
camera-discovery / ai-gateway conftests). No live ACME / Cloudflare /
Postgres is ever touched by the default suite — the ACME client and
Cloudflare httpx calls are mocked.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Deterministic HMAC secret so the opaque-label tests assert exact bytes.
os.environ.setdefault("HQ_LABEL_SECRET", "pytest-fixed-label-secret")
os.environ.setdefault("ISSUANCE_DOMAIN_BASE", "devices.warp-lab.ai")
os.environ.setdefault("CLOUDFLARE_API_TOKEN", "pytest-fake-cf-token")
os.environ.setdefault("CLOUDFLARE_ZONE_ID", "pytest-fake-zone")
os.environ.setdefault("ACME_DIRECTORY_URL", "https://acme-staging-v02.api.letsencrypt.org/directory")
os.environ.setdefault("ACME_CONTACT_EMAIL", "fleet-ops@warp-lab.com")
os.environ.setdefault("DATABASE_URL", "postgresql://fleet:fleet@localhost:5432/fleet_test")

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))
