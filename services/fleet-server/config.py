"""Configuration for the Warp fleet HQ TLS issuance service (ADR-023, C1).

Every secret and host-specific value comes from the environment — NO
secrets in tracked files (droplet-architecture-guard rule: secrets are
HQ-only env/secret-file, never tracked). This service is deployed to
hq.warp-lab.com, NOT to a box.

We read config lazily (helpers, not import-time module constants) so a
test conftest that sets env vars before importing the service modules is
honored, and so a missing required secret surfaces as a clear error at
the call site rather than at import.
"""

from __future__ import annotations

import os

# --- Issuance / labelling (ADR-023 §Decision 2) ---

#: Base zone under which every per-device FQDN lives, e.g.
#: ``devices.warp-lab.ai``. Authoritative on Cloudflare nameservers.
ISSUANCE_DOMAIN_BASE = os.environ.get("ISSUANCE_DOMAIN_BASE", "devices.warp-lab.ai")


def hq_label_secret() -> bytes:
    """HMAC key for the opaque per-device label. HQ-only secret.

    Raises if unset — a missing key would silently produce attacker-
    guessable labels.
    """
    secret = os.environ.get("HQ_LABEL_SECRET", "")
    if not secret:
        raise RuntimeError("HQ_LABEL_SECRET is not set")
    return secret.encode("utf-8")


# --- Cloudflare DNS-01 (ADR-023 §Decision 6 — HQ-only token) ---

def cloudflare_api_token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        raise RuntimeError("CLOUDFLARE_API_TOKEN is not set")
    return token


def cloudflare_zone_id() -> str:
    zone = os.environ.get("CLOUDFLARE_ZONE_ID", "").strip()
    if not zone:
        raise RuntimeError("CLOUDFLARE_ZONE_ID is not set")
    return zone


CLOUDFLARE_API_BASE = os.environ.get(
    "CLOUDFLARE_API_BASE", "https://api.cloudflare.com/client/v4"
).rstrip("/")

# How long to wait for the TXT record to propagate before answering the
# ACME challenge, and the poll cadence.
DNS_PROPAGATION_TIMEOUT_SEC = int(os.environ.get("DNS_PROPAGATION_TIMEOUT_SEC", "120"))
DNS_PROPAGATION_POLL_SEC = int(os.environ.get("DNS_PROPAGATION_POLL_SEC", "5"))

# --- ACME (ADR-023 §Risk: use LE staging for all plumbing tests) ---

#: ACME directory. Defaults to LE *staging* so a misconfigured deploy
#: never burns the production rate limit.
ACME_DIRECTORY_URL = os.environ.get(
    "ACME_DIRECTORY_URL", "https://acme-staging-v02.api.letsencrypt.org/directory"
)
ACME_CONTACT_EMAIL = os.environ.get("ACME_CONTACT_EMAIL", "").strip()

#: Where the persisted ACME account key lives. HQ-only secret-file,
#: never tracked. Default sits under a runtime data dir, not the repo.
ACME_ACCOUNT_KEY_PATH = os.environ.get(
    "ACME_ACCOUNT_KEY_PATH", "/data/fleet-server/acme-account.key"
)
ACME_ORDER_TIMEOUT_SEC = int(os.environ.get("ACME_ORDER_TIMEOUT_SEC", "90"))

# --- Database (ADR-023 §Decision 2 — registry + device_certificates) ---

DATABASE_URL = os.environ.get("DATABASE_URL", "")

# --- Issuance flow tunables ---

#: Single-use challenge nonce TTL (issuance contract: 120s).
NONCE_TTL_SEC = int(os.environ.get("NONCE_TTL_SEC", "120"))
#: Per-device rate limit on POST /order/challenge (requests / window).
CHALLENGE_RATE_LIMIT = int(os.environ.get("CHALLENGE_RATE_LIMIT", "5"))
CHALLENGE_RATE_WINDOW_SEC = int(os.environ.get("CHALLENGE_RATE_WINDOW_SEC", "60"))

#: Renew certs whose not_after is within this many days (LE = 90-day life).
RENEW_BEFORE_DAYS = int(os.environ.get("RENEW_BEFORE_DAYS", "30"))
RENEWAL_CRON_HOUR = int(os.environ.get("RENEWAL_CRON_HOUR", "3"))
