"""Pydantic request/response models + the explicit certificate-status
enum for the fleet HQ issuance service (ADR-023, C1).

Status is an EXPLICIT 5-value enum, never derived from ``IS NULL``
(droplet-architecture-guard rule). The DB column carries a CHECK
constraint over exactly these values.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class CertStatus(str, Enum):
    """The only legal certificate states. Transitions:

        pending  -> active | failed        (first order / renew kickoff)
        active   -> renewing               (renewal job picks it up)
        renewing -> active | failed        (renew completes / errors)
        active   -> revoked                (deregistration)
        any      -> revoked                (deregistration, defensive)
    """

    PENDING = "pending"
    ACTIVE = "active"
    RENEWING = "renewing"
    REVOKED = "revoked"
    FAILED = "failed"


# --- POST /order/challenge ---

class ChallengeRequest(BaseModel):
    device_id: str = Field(..., min_length=1)


class ChallengeResponse(BaseModel):
    nonce: str
    expires_at: str  # ISO-8601 UTC
    public_label: str
    fqdn: str


# --- POST /order and POST /renew (identical body) ---

class OrderRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    csr_pem: str = Field(..., min_length=1)
    nonce: str = Field(..., min_length=1)
    signature: str = Field(..., min_length=1)  # base64
    sig_alg: str = Field(..., min_length=1)
    key_fingerprint: str = Field(..., min_length=1)


class OrderAcceptedResponse(BaseModel):
    order_id: str
    status: CertStatus
    fqdn: str


# --- GET /order/{order_id} ---

class OrderStatusResponse(BaseModel):
    order_id: str
    status: CertStatus
    fqdn: str
    fullchain_pem: Optional[str] = None
    not_after: Optional[str] = None
    last_error: Optional[str] = None
