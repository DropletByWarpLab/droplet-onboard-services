"""ACME order orchestration with an EXTERNAL box CSR (ADR-023 §Decision 1).

Flow for one order/renewal:

  1. ``new_order(csr_pem)`` — the acme lib derives the order's identifier
     from the box-supplied CSR's SAN. The box private key never leaves the
     box; HQ only ever sees the CSR.
  2. Find the DNS-01 challenge in the authorization.
  3. Compute the TXT validation value from the account key.
  4. The Cloudflare worker creates ``_acme-challenge.<fqdn>`` TXT, awaits
     propagation, then we ``answer_challenge`` + ``poll_and_finalize``.
  5. The worker DELETES the TXT in its finally block (even on failure).
  6. Return the OrderResource carrying ``fullchain_pem``.

The underlying ``acme.client.ClientV2`` is injected so the orchestration
is unit-testable with a fake (no live LE). The acme lib is synchronous;
the answer/finalize body runs on a worker thread so it never blocks the
event loop.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

_DNS01_TYPE = "dns-01"


class AcmeOrderError(RuntimeError):
    """An ACME order could not be completed (maps to 502 at the route)."""


class AcmeIssuer:
    """Drives one ACME order using a box CSR + Cloudflare DNS-01."""

    def __init__(
        self,
        *,
        acme_client_v2: Any,
        account_key: Any,
        dns: Any,
        order_timeout_sec: int,
    ) -> None:
        self._acme = acme_client_v2
        self._account_key = account_key
        self._dns = dns
        self._order_timeout = order_timeout_sec

    @staticmethod
    def _find_dns01(orderr: Any):
        """Return (authz_domain, challenge_body) for the DNS-01 challenge,
        or raise if the order has no DNS-01 option."""
        for authz in orderr.authorizations:
            domain = authz.body.identifier.value
            for challb in authz.body.challenges:
                if getattr(challb.chall, "typ", None) == _DNS01_TYPE:
                    return domain, challb
        raise AcmeOrderError("order has no dns-01 challenge")

    async def order_certificate(self, *, csr_pem: str, fqdn: str) -> Any:
        """Place + finalize an ACME order for ``fqdn`` using the external
        box CSR. Returns the finalized OrderResource (has fullchain_pem)."""
        csr_bytes = csr_pem.encode("utf-8") if isinstance(csr_pem, str) else csr_pem

        # new_order is sync; run off the loop.
        orderr = await asyncio.to_thread(self._acme.new_order, csr_bytes)

        domain, challb = self._find_dns01(orderr)
        dns01 = challb.chall
        txt_value = dns01.validation(self._account_key)
        record_name = dns01.validation_domain_name(domain)

        async def _answer_and_finalize() -> None:
            # Answer the challenge then finalize — both sync acme calls.
            def _do() -> Any:
                response = dns01.response(self._account_key)
                self._acme.answer_challenge(challb, response)
                deadline = datetime.datetime.now() + datetime.timedelta(
                    seconds=self._order_timeout
                )
                return self._acme.poll_and_finalize(orderr, deadline)

            self._finalized = await asyncio.to_thread(_do)

        self._finalized: Optional[Any] = None
        await self._dns.publish_challenge(record_name, txt_value, _answer_and_finalize)

        if self._finalized is None or not getattr(self._finalized, "fullchain_pem", None):
            raise AcmeOrderError(f"order for {fqdn} finalized without a fullchain")
        logger.info("acme: issued certificate for %s", fqdn)
        return self._finalized

    async def revoke_certificate(self, fullchain_pem: str, *, reason: int = 0) -> None:
        """ACME-revoke a previously-issued certificate (deregistration)."""
        import josepy as jose
        from cryptography import x509
        from cryptography.hazmat.primitives.serialization import Encoding
        from OpenSSL import crypto as openssl_crypto

        # The fullchain leads with the leaf; revoke just the leaf.
        leaf = x509.load_pem_x509_certificate(fullchain_pem.encode("utf-8"))
        comparable = jose.ComparableX509(
            openssl_crypto.load_certificate(
                openssl_crypto.FILETYPE_ASN1, leaf.public_bytes(Encoding.DER)
            )
        )
        await asyncio.to_thread(self._acme.revoke, comparable, reason)
        logger.info("acme: revoked certificate")
