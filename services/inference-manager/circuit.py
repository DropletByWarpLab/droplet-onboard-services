"""Circuit breaker for the Ollama upstream call.

Wraps ``circuitbreaker.CircuitBreaker`` with our specific failure threshold
and expected-exception list. Counts only transport-level failures
(``httpx.ConnectError``, ``ReadTimeout``, ``RemoteProtocolError``); 4xx/5xx
HTTP responses are valid signals from Ollama, not transport failures, and
do not trip the breaker.
"""

from __future__ import annotations

from circuitbreaker import CircuitBreaker
import httpx

_FAILURE_THRESHOLD = 5
_RECOVERY_TIMEOUT = 60  # seconds — open → half_open after this elapsed


class OllamaBreaker(CircuitBreaker):
    FAILURE_THRESHOLD = _FAILURE_THRESHOLD
    RECOVERY_TIMEOUT = _RECOVERY_TIMEOUT
    # Full httpx TransportError hierarchy, NOT just ConnectError/ReadTimeout:
    # ConnectTimeout/PoolTimeout/WriteTimeout subclass TimeoutException (a
    # sibling of ConnectError, not a subclass), and ReadError/WriteError/
    # CloseError subclass NetworkError. Listing only the three narrow types
    # meant a real network partition (SYN dropped -> ConnectTimeout) or pool
    # exhaustion (PoolTimeout) never counted toward the breaker, so it never
    # opened — contradicting RESILIENCE.md's "breaker trips" promise.
    EXPECTED_EXCEPTION = (
        httpx.TimeoutException,
        httpx.NetworkError,
        httpx.RemoteProtocolError,
    )
    NAME = "ollama_proxy"


OLLAMA_BREAKER = OllamaBreaker()


def get_circuit_state() -> str:
    """Return the breaker's current state as a lowercase string.

    One of ``closed`` | ``open`` | ``half_open``.
    """
    state = OLLAMA_BREAKER.state
    if state == "closed":
        return "closed"
    if state == "open":
        return "open"
    return "half_open"


def reset_circuit() -> None:
    """Test-only: reset to closed with zero failure count.

    Uses the library's public ``CircuitBreaker.reset()`` (circuitbreaker
    2.1.3) rather than poking private attributes, so a library bump that
    reshapes internal state breaks loudly here in one place instead of
    silently leaking open-breaker state across tests. ``reset()`` sets
    ``_state`` closed and zeroes the failure count/last-failure, which is
    exactly what we need.
    """
    OLLAMA_BREAKER.reset()
