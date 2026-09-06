"""WARP-2734 — connecting a mailbox: verify it, then encrypt its password.

Until this module existed the whole IMAP subsystem was unreachable. `creds.py`
could only DECRYPT, so no code anywhere could produce a `passwordEnc`, so
nothing anywhere created an `EmailAccount` row — the README's "add an account
via the dashboard" was false on every box that ever shipped.

── Why the credential work happens HERE and not in the orchestrator ─────────

The Fernet key lives at `/data/secrets/email.key`, owned by this service. The
orchestrator holds the Prisma pool and every other credential on the box;
mounting the mail key there too would put a new secret and a hand-rolled Fernet
encoder into the process with the largest blast radius, to save one hop inside
a mesh that already has mTLS.

So the split is: this service owns the KEY and the IMAP client, the
orchestrator owns the ROW. The plaintext password crosses one internal hop and
is never written to a log, a response body, or a database column on either side.

── Verify BEFORE encrypt, in one call ───────────────────────────────────────

🔴 The order is the point. An account whose password was stored but never
tested reaches `imapStatus = paused` and stays there, and the owner is told
their mailbox is connected while nothing is being read. WARP-2734's acceptance
criterion is `imapStatus = idle`, which is a claim about a connection that
worked — not about a row that was written.

One call rather than two because the probe needs the plaintext anyway, and a
separate `/encrypt` would be a bare encryption oracle with no reason to exist.
"""
from __future__ import annotations

import asyncio
import logging
import ssl
from dataclasses import dataclass
from typing import Optional

import aioimaplib

import creds

logger = logging.getLogger(__name__)

# A mailbox that does not answer in this long is not one a person should be
# left waiting on behind a form submit. Shorter than the orchestrator's own
# timeout so the failure is OURS and carries a reason, rather than surfacing as
# a hop that timed out.
PROBE_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    #: A short machine reason, never the server's raw text.
    #:
    #: 🔴 An IMAP server's rejection string is attacker-influenced and
    #: frequently echoes the credential ("LOGIN failed for
    #: user@example.com"). It is logged here at debug and NEVER returned.
    reason: Optional[str] = None


#: The reasons this module will say out loud. A closed set, so a server's own
#: prose can never reach a response body by accident.
REASONS = {
    "auth_failed": "auth_failed",
    "unreachable": "unreachable",
    "tls_failed": "tls_failed",
    "timeout": "timeout",
}


async def probe_imap(
    host: str, port: int, use_tls: bool, username: str, password: str
) -> ProbeResult:
    """Log in once, then log out. Nothing is read and nothing is stored."""
    client = None
    try:
        if use_tls:
            client = aioimaplib.IMAP4_SSL(
                host=host, port=port, timeout=PROBE_TIMEOUT_SECONDS,
                ssl_context=ssl.create_default_context(),
            )
        else:
            client = aioimaplib.IMAP4(host=host, port=port, timeout=PROBE_TIMEOUT_SECONDS)
        await asyncio.wait_for(client.wait_hello_from_server(), PROBE_TIMEOUT_SECONDS)
        resp = await asyncio.wait_for(
            client.login(username, password), PROBE_TIMEOUT_SECONDS
        )
        if resp.result != "OK":
            # `resp.lines` can echo the username back. Debug only.
            logger.debug("imap login rejected: %s", resp.result)
            return ProbeResult(False, REASONS["auth_failed"])
        return ProbeResult(True)
    except asyncio.TimeoutError:
        return ProbeResult(False, REASONS["timeout"])
    except ssl.SSLError as exc:
        logger.debug("imap tls failure: %s", exc)
        return ProbeResult(False, REASONS["tls_failed"])
    except (OSError, aioimaplib.Abort) as exc:
        logger.debug("imap unreachable: %s", exc)
        return ProbeResult(False, REASONS["unreachable"])
    finally:
        if client is not None:
            # 🔴 LOGOUT, then CLOSE THE TRANSPORT — and the second half is the
            # one that matters.
            #
            # A security review found that `logout()` alone leaks the socket in
            # exactly the cases that fail: against a host that accepts the
            # connection and then stays silent, the pre-greeting path raises
            # `Abort` before a session exists, and the post-greeting path
            # writes LOGOUT and waits five seconds for a reply that never
            # comes. aioimaplib 2.0.1 never closes a transport itself, so the
            # socket and its protocol object survive for the life of the
            # process.
            #
            # An operator retrying a wrong password against an unresponsive
            # host is an ordinary thing to do, so this is a file-descriptor
            # leak on the ordinary path rather than an exotic one.
            try:
                await asyncio.wait_for(client.logout(), 5.0)
            except Exception:  # noqa: BLE001 — a failed logout is not a failed probe
                pass
            try:
                transport = getattr(getattr(client, "protocol", None), "transport", None)
                if transport is not None:
                    transport.close()
            except Exception:  # noqa: BLE001 — best effort; never mask the probe result
                pass


async def provision(
    host: str, port: int, use_tls: bool, username: str, password: str
) -> tuple[ProbeResult, Optional[str]]:
    """Verify the mailbox, and return its ciphertext only if it answered.

    🔴 Returns `None` for the ciphertext on a failed probe rather than
    encrypting anyway. An unusable credential that got stored is worse than one
    that was refused: the row exists, the surface says a mailbox is connected,
    and the only symptom is silence.
    """
    result = await probe_imap(host, port, use_tls, username, password)
    if not result.ok:
        return result, None
    return result, creds.encrypt(password)
