"""First-time camera provisioning (a.k.a. "take a fresh-from-box camera and
give it an admin password").

Most IP cameras ship with a mandatory first-run flow where the web UI
forces the operator to pick an admin password before any other API
becomes available. Until that step happens, RTSP/ONVIF/SUNAPI all return
401/403 and auto-discovery stalls. This module drives that flow via HTTP
so the operator doesn't have to tunnel into the camera VLAN with a
browser just to unblock adoption.

Current coverage:
  * Hanwha / Samsung Wisenet X series — ``/init-cgi/pw_init.cgi``
    (observed on XNV-C8083R, firmware exposing ``wmf`` web UI)

The Hanwha flow is:
  1. GET ``/init-cgi/pw_init.cgi?msubmenu=statuscheck&action=view`` ->
     plain-text ``key=value`` response with ``Initialized=(True|False)``
     and a PEM-encoded RSA-2048 ``PublicKey``.
  2. RSA-encrypt the plaintext admin password with PKCS#1 v1.5 padding
     using that public key, base64 the ciphertext, URL-encode the
     base64 string, and POST it as the raw request body to
     ``/init-cgi/pw_init.cgi?msubmenu=setinitpassword&action=set&IsPasswordEncrypted=True``.
  3. A 200 response means the admin account is live; SUNAPI stops
     returning 403 and ONVIF/RTSP start honoring credentials.

Vendor dispatch is keyed off signals we can read without auth (the
``/init-cgi/`` path itself is Hanwha-specific — Axis/Amcrest/Reolink use
entirely different schemes). New vendors plug in by implementing the
three functions in :class:`VendorInitializer`.
"""

from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

# WARP-583 (launch-readiness audit): TLS verification for the vendor-init
# HTTPS clients. Cameras ship per-device self-signed certs on first run, so
# pinning is only possible where the operator has captured the device cert /
# vendor CA up-front — hence opt-in via CAMERA_INIT_CA_CERT.
# Residual risk when unpinned: an on-LAN MITM between this service and the
# camera VLAN can intercept the first-run admin-password set. We keep that
# historical unverified fallback because it is the only workable default for
# fresh-from-box cameras, but it is explicit and warn-logged — and a
# configured-but-missing cert path fails closed rather than silently
# downgrading, which is the false-assurance trap the audit flagged.
_unverified_tls_warned = False


def _ca_cert_path() -> str:
    """The configured CAMERA_INIT_CA_CERT, or "" when unset."""
    return os.environ.get("CAMERA_INIT_CA_CERT", "").strip()


def _probe_schemes(default: tuple[str, ...]) -> tuple[str, ...]:
    """WARP-1029 — the URL schemes a first-run probe may use.

    `verify=` alone does not make a pin meaningful: both probes below walked
    `https` AND `http`, `continue`-ing to plaintext on ANY `httpx.HTTPError`
    — including a pinned-TLS handshake failure. An active on-path attacker
    could therefore break the handshake, watch the caller retry over plain
    HTTP, serve its own `PublicKey` on that channel, and recover the admin
    password the caller is about to POST. A configured CA cert protected
    only against a PASSIVE eavesdropper, never the active MITM a pin implies.

    So when the operator has pinned, the fallback is dropped and the probe
    fails closed. Unpinned deployments keep the historical order byte-for-byte
    — fresh-from-box cameras are the reason that fallback exists (see
    `_tls_verify`), and this must not break them.
    """
    if _ca_cert_path():
        return ("https",)
    return default


def _tls_verify() -> bool | str:
    """Resolve the httpx ``verify=`` value for vendor-init clients.

    Returns the CAMERA_INIT_CA_CERT path when configured (httpx then
    verifies the camera's TLS cert against it), or ``False`` — with a
    once-per-process warning — when unset. Raises ``ValueError`` when the
    configured path does not exist.
    """
    global _unverified_tls_warned
    ca_cert = _ca_cert_path()
    if ca_cert:
        if not os.path.isfile(ca_cert):
            raise ValueError(
                f"CAMERA_INIT_CA_CERT is set to '{ca_cert}' but no such file "
                f"exists; refusing to fall back to unverified TLS. Fix the "
                f"path or unset CAMERA_INIT_CA_CERT to use the (insecure) "
                f"self-signed default."
            )
        return ca_cert
    if not _unverified_tls_warned:
        _unverified_tls_warned = True
        logger.warning(
            "TLS certificate verification disabled for camera vendor-init "
            "(per-device self-signed certs expected on first run). Set "
            "CAMERA_INIT_CA_CERT to a CA bundle / device cert to enable "
            "verification. (Warning logged once per process.)"
        )
    return False


@dataclass
class InitStatus:
    """Result of a pre-flight status check.

    ``initialized`` is ``None`` when we can't tell (endpoint missing,
    network error); the caller must not assume anything about whether
    the camera needs setup in that case.
    """

    vendor: str
    initialized: bool | None
    needs_initialization: bool
    details: dict


@dataclass
class InitResult:
    success: bool
    vendor: str
    message: str
    http_status: int | None = None


class VendorInitializer(Protocol):
    """Minimal interface every vendor implementation must provide."""

    vendor: str

    async def matches(self, client: httpx.AsyncClient, ip: str) -> bool: ...

    async def status(self, client: httpx.AsyncClient, ip: str) -> InitStatus: ...

    async def initialize(
        self,
        client: httpx.AsyncClient,
        ip: str,
        username: str,
        password: str,
    ) -> InitResult: ...


# ---------------------------------------------------------------------------
# Hanwha Wisenet
# ---------------------------------------------------------------------------

_HANWHA_STATUS_PATH = "/init-cgi/pw_init.cgi?msubmenu=statuscheck&action=view"
_HANWHA_SET_PATH = (
    "/init-cgi/pw_init.cgi?msubmenu=setinitpassword&action=set&IsPasswordEncrypted=True"
)


def _parse_kv_block(body: str) -> dict:
    """Parse Hanwha's ``key=value`` status response.

    The PublicKey value is a multi-line PEM block that must be kept
    together verbatim. We explicitly accumulate everything from
    ``-----BEGIN`` through ``-----END`` under the ``PublicKey`` key
    rather than relying on line ordering (Hanwha firmwares have been
    observed to emit PEM before the ``PublicKey=`` key on some
    models, which the naive "==" check would silently miss).
    """
    result: dict[str, str] = {}
    pem_key: str | None = None  # which key we're still accumulating into
    pem_buf: list[str] = []

    for line in body.splitlines():
        if pem_key is not None:
            pem_buf.append(line)
            if line.startswith("-----END"):
                result[pem_key] = "\n".join(pem_buf)
                pem_key = None
                pem_buf = []
            continue

        if "=" in line and not line.startswith("-----"):
            key, _, value = line.partition("=")
            key = key.strip()
            result[key] = value
            # Hanwha emits: ``PublicKey=-----BEGIN RSA PUBLIC KEY-----`` on
            # the same line as the key, then the base64 body + ``-----END``
            # on subsequent lines. Switch into accumulation mode when the
            # value starts a PEM block.
            if value.startswith("-----BEGIN"):
                pem_key = key
                pem_buf = [value]

    # Orphaned PEM buffer (no -----END seen) — still return whatever we
    # captured so the caller's ``startswith('-----BEGIN')`` check fails
    # cleanly rather than succeeding on a truncated key.
    if pem_key is not None and pem_buf:
        result[pem_key] = "\n".join(pem_buf)

    return result


def _rsa_encrypt_pkcs1v15(public_key_pem: str, plaintext: str) -> bytes:
    """Encrypt ``plaintext`` with the PEM-encoded RSA public key using
    PKCS#1 v1.5 padding, matching what JSEncrypt does in the Hanwha
    web UI. Return the raw ciphertext bytes (caller base64-encodes).
    """
    # Import lazily so the rest of the module is usable for status
    # checks even on images where cryptography isn't installed yet.
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    pem_bytes = public_key_pem.strip().encode("ascii")
    public_key = load_pem_public_key(pem_bytes)
    return public_key.encrypt(plaintext.encode("utf-8"), padding.PKCS1v15())


class HanwhaInitializer:
    vendor = "hanwha"

    async def matches(self, client: httpx.AsyncClient, ip: str) -> bool:
        """Quick signature test — Hanwha's init endpoint returns a
        ``key=value`` body even pre-init, which nothing else does. We
        probe the status URL on both HTTP and HTTPS because Wisenet
        cameras redirect HTTP to HTTPS on some firmwares.

        WARP-1029: HTTPS-only once CAMERA_INIT_CA_CERT is set. Unpinned this
        still tries plaintext FIRST, which is the historical behaviour and
        stays untouched.
        """
        for scheme in _probe_schemes(("http", "https")):
            try:
                resp = await client.get(
                    f"{scheme}://{ip}{_HANWHA_STATUS_PATH}", timeout=5.0
                )
            except httpx.HTTPError:
                continue
            if resp.status_code == 200 and "Initialized=" in resp.text:
                return True
        return False

    async def _fetch_status(
        self, client: httpx.AsyncClient, ip: str
    ) -> tuple[str, dict] | None:
        """Return ``(base_url, parsed)`` for the first scheme that responds.

        WARP-1029: the returned ``base_url`` is what `initialize` POSTs the
        RSA-encrypted admin password to, so this loop is the one that decides
        whether the secret travels over TLS. HTTPS-only once pinned.
        """
        for scheme in _probe_schemes(("https", "http")):
            base = f"{scheme}://{ip}"
            try:
                resp = await client.get(f"{base}{_HANWHA_STATUS_PATH}", timeout=5.0)
            except httpx.HTTPError as exc:
                logger.debug("Hanwha status probe (%s): %s", scheme, exc)
                continue
            if resp.status_code == 200 and "Initialized=" in resp.text:
                return base, _parse_kv_block(resp.text)
        return None

    async def status(self, client: httpx.AsyncClient, ip: str) -> InitStatus:
        probe = await self._fetch_status(client, ip)
        if probe is None:
            return InitStatus(
                vendor=self.vendor,
                initialized=None,
                needs_initialization=False,
                details={"error": "status endpoint unreachable"},
            )
        _, parsed = probe
        initialized = parsed.get("Initialized", "").strip().lower() == "true"
        return InitStatus(
            vendor=self.vendor,
            initialized=initialized,
            needs_initialization=not initialized,
            details={
                "model_language": parsed.get("Language", ""),
                "max_channel": parsed.get("MaxChannel", ""),
                "new_password_policy": parsed.get("NewPasswordPolicy", ""),
                "public_key_present": "PublicKey" in parsed,
            },
        )

    async def initialize(
        self,
        client: httpx.AsyncClient,
        ip: str,
        username: str,
        password: str,
    ) -> InitResult:
        # Hanwha's init flow only provisions the built-in "admin" account;
        # other UserIDs have to be created later via security.cgi once the
        # admin exists. Reject other usernames up-front rather than
        # silently applying the password to admin.
        if username != "admin":
            return InitResult(
                success=False,
                vendor=self.vendor,
                message=(
                    f"Hanwha first-run flow only sets the 'admin' account; "
                    f"got username={username!r}"
                ),
            )
        if not password:
            return InitResult(
                success=False,
                vendor=self.vendor,
                message="password must not be empty",
            )

        probe = await self._fetch_status(client, ip)
        if probe is None:
            return InitResult(
                success=False,
                vendor=self.vendor,
                message="could not reach /init-cgi/pw_init.cgi statuscheck",
            )
        base, parsed = probe

        if parsed.get("Initialized", "").strip().lower() == "true":
            return InitResult(
                success=False,
                vendor=self.vendor,
                message="camera is already initialized; use /cameras/{ip}/credentials instead",
            )

        public_key_pem = parsed.get("PublicKey", "").strip()
        if not public_key_pem.startswith("-----BEGIN"):
            return InitResult(
                success=False,
                vendor=self.vendor,
                message="statuscheck response missing PEM public key",
            )

        try:
            ciphertext = _rsa_encrypt_pkcs1v15(public_key_pem, password)
        except Exception as exc:  # cryptography raises many subclasses
            logger.exception("Hanwha RSA encrypt failed")
            return InitResult(
                success=False,
                vendor=self.vendor,
                message=f"RSA encrypt failed: {exc}",
            )

        # Match the JS: body is URL-encoded base64 of the ciphertext.
        body = quote(base64.b64encode(ciphertext).decode("ascii"), safe="")

        try:
            resp = await client.post(
                f"{base}{_HANWHA_SET_PATH}",
                content=body,
                headers={
                    "Accept": "application/json",
                    # The web UI sends no explicit Content-Type; lighttpd
                    # treats the payload as an opaque form body either way.
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                timeout=15.0,
            )
        except httpx.HTTPError as exc:
            return InitResult(
                success=False,
                vendor=self.vendor,
                message=f"setinitpassword POST failed: {exc}",
            )

        if resp.status_code == 200:
            return InitResult(
                success=True,
                vendor=self.vendor,
                message="admin password set",
                http_status=200,
            )
        # Hanwha uses 490 for 'password does not meet complexity policy'
        if resp.status_code == 490:
            return InitResult(
                success=False,
                vendor=self.vendor,
                message=(
                    "password rejected by NewPasswordPolicy — need 8+ chars with "
                    "3+ character classes, or 10+ with 2+. Retry with a stronger password."
                ),
                http_status=490,
            )
        return InitResult(
            success=False,
            vendor=self.vendor,
            message=f"camera returned HTTP {resp.status_code}: {resp.text[:200]}",
            http_status=resp.status_code,
        )


# ---------------------------------------------------------------------------
# Registry + dispatch
# ---------------------------------------------------------------------------

_VENDORS: list[VendorInitializer] = [HanwhaInitializer()]


async def detect_vendor(
    client: httpx.AsyncClient, ip: str
) -> VendorInitializer | None:
    """Return the first registered vendor that claims this IP, or None."""
    for vendor in _VENDORS:
        try:
            if await vendor.matches(client, ip):
                return vendor
        except Exception as exc:
            logger.debug("vendor match probe %s raised: %s", vendor.vendor, exc)
    return None


async def check_status(ip: str) -> InitStatus | None:
    """Public entry point: identify the vendor and return its status."""
    # WARP-583: verify= comes from CAMERA_INIT_CA_CERT (see _tls_verify).
    async with httpx.AsyncClient(verify=_tls_verify()) as client:
        vendor = await detect_vendor(client, ip)
        if vendor is None:
            return None
        return await vendor.status(client, ip)


async def initialize_camera(
    ip: str, username: str, password: str
) -> InitResult:
    """Public entry point: drive the first-run password set.

    The caller is responsible for picking ``username`` / ``password``;
    this function does not consult env vars for credentials so unit tests
    and CLI invocations stay deterministic.
    """
    # WARP-583: verify= comes from CAMERA_INIT_CA_CERT (see _tls_verify).
    async with httpx.AsyncClient(verify=_tls_verify()) as client:
        vendor = await detect_vendor(client, ip)
        if vendor is None:
            return InitResult(
                success=False,
                vendor="unknown",
                message="no registered vendor initializer recognized this camera",
            )
        return await vendor.initialize(client, ip, username, password)
