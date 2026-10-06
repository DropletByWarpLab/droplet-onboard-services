"""Exceptions shared by the ingest client and the IDLE loop."""


class IngestTooLarge(Exception):
    """The orchestrator refused a message with 413 (WARP-3267).

    Ruling: this is the one ingest refusal that holds the watermark, and only
    for `MAX_TOO_LARGE_HOLDS` cycles (idle.py). The parser's payload budget
    means a valid message never gets a 413, so one that does is a limit drift
    (e.g. a rolling update) a deploy fixes, and the message should still be
    there to fetch when it does. After the cap it is skipped and logged with
    its UID, as IDX-07 decided for every other refusal.
    """


class OAuthTokenUnavailable(Exception):
    """Closed-set token failure; provider responses never enter an exception."""

    def __init__(self, *, needs_reconnect: bool = False) -> None:
        self.needs_reconnect = needs_reconnect
        super().__init__(
            "Google sign-in needs reconnecting."
            if needs_reconnect
            else "Google authorization is temporarily unavailable."
        )
