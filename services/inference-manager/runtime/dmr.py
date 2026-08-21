"""Docker Model Runner backend — opt-in, ships dark (WARP-1743).

`docker/model-runner` v1.2.6, Apache-2.0, port 12434. Selected only by an
explicit ``INFERENCE_RUNTIME=dmr``; nothing here runs on a box that has not been
deliberately configured for it (ADR-005 §8). Phase 0 (WARP-1741) has not passed
the hardware gate, so this code exists to make the seam real and testable, not
because DMR is being switched on.

**What is shared, and why.** ``GET /api/tags`` and ``GET /api/ps`` are
field-for-field identical to Ollama's — verified against `docker/model-runner`
@ main, ``pkg/ollama/http_handler.go``, where ``handlePS`` returns ``size_vram``
that Docker's own compatibility docs fail to mention (ADR-005 §2). They are
therefore inherited from :class:`~runtime.base.OllamaWireRuntime` rather than
re-implemented, so a fix to either applies to both backends at once.

**What genuinely differs** is only:

* **delete** — the native, OCI-shaped ``DELETE /models/{namespace}/{name}``,
  which carries the identifier in the *path* rather than a JSON body.
* **the identifier itself** — DMR model ids are OCI references (``ai/gpt-oss``),
  while every ``name`` / ``pull_tag`` in ``models/model-manifest.json`` and
  every caller of ``/models/*`` uses Ollama's ``name:tag``. ADR-005 §2 calls
  this "the real incompatibility... not an endpoint — it is the identifier".

Pull is *not* in that list: DMR serves the ollama-compatible ``POST /api/pull``
with the same streaming-NDJSON ``{status, digest, total, completed, error}``
shape, so ``main.py``'s progress proxy works against it unchanged.
"""

from __future__ import annotations

import json

import httpx

from timeouts import TIMEOUT_PULL

from .base import (
    OllamaWireRuntime,
    RuntimePullError,
    deleted_result,
    pulled_result,
)

# DMR's ollama-compatible pull. Preferred over the native `POST /models/create`
# because it already emits the exact NDJSON progress shape `/models/pull?stream=true`
# proxies (WARP-1111 §7.1) — using the native endpoint would mean writing and
# maintaining a second progress translation for no gain. `/models/create` stays
# the documented fallback if the compat pull is ever dropped upstream; it is not
# implemented, because two code paths that both "work" but are exercised
# differently is how the untested one rots.
PULL_PATH = "/api/pull"

# NOTE: DMR's native `DELETE /models/{ns}/{name}` and `POST /models/create` are
# deliberately NOT used. Its ollama-compat `/api/delete` and `/api/pull` accept
# the same shapes Ollama does — both verified live on 2026-08-05 against
# docker/model-runner:v1.2.6 — so routing through them keeps this adapter a
# base-URL change rather than a second protocol. The native delete additionally
# could not address the registry-qualified ids (`docker.io/ai/x:latest`) that
# DMR itself reports, which is what made the first draft wrong.

# Namespace applied to a bare Ollama-style id. `ai/` is the namespace of the
# first-party catalog (`ai/smollm2`, `ai/gpt-oss`, `ai/qwen2.5`).
#
# This derivation is a *fallback*, not the intended long-term source of truth:
# ADR-005 §2 puts the authoritative OCI reference on the manifest entry itself,
# alongside `pull_tag`. That is a manifest-schema change and belongs to the
# distribution phase, not to this ticket — so for now the adapter derives one,
# and derives it in exactly one place.
DEFAULT_NAMESPACE = "ai"


def to_runtime_id(model: str) -> str:
    """Translate a caller-facing model id into DMR's OCI form.

    ``gpt-oss:20b`` → ``ai/gpt-oss``.

    **Idempotent by construction.** Anything already carrying a namespace
    separator is returned untouched, and every value this function produces
    carries one — so ``to_runtime_id(to_runtime_id(x)) == to_runtime_id(x)`` for
    all inputs. That property is what lets the loop close: ``/models/available``
    on a DMR box lists DMR's own ids, a caller hands one straight back to
    ``/models/pull``, and it survives the round trip instead of being mangled
    into ``ai/ai``.

    Note the direction: translation happens **outbound only**, at the wire
    boundary. Nothing translates a DMR id back into ``name:tag`` — there is no
    information to reconstruct one from, and inventing names would be worse than
    passing through what the daemon actually reports. Callers of ``/models/*``
    keep the identifier they supplied in every response body (see
    :func:`~runtime.base.pulled_result`), so the ``/models/*`` contract is
    unchanged whichever backend is behind it.
    """
    candidate = (model or "").strip()
    if not candidate:
        raise ValueError("model id must be a non-empty string")
    if "/" in candidate:
        # Already an OCI reference. Normalise rather than pass through: DMR
        # REPORTS fully-qualified, tagged ids (`docker.io/ai/smollm2:latest`)
        # from /api/tags and /api/ps — verified live on 2026-08-05 — so a
        # pass-through leaks the registry host straight back into the next
        # request and breaks every comparison against a manifest name.
        return _normalize_oci_reference(candidate)
    # Ollama's `:tag` is a quantization/size selector inside one repo; the OCI
    # equivalent lives in the tag of the OCI reference, which we cannot derive.
    # Drop it and let DMR resolve its own default rather than fabricate one.
    repository = candidate.split(":", 1)[0]
    return f"{DEFAULT_NAMESPACE}/{repository}"


#: Tag that carries no selection information — OCI's implicit default.
_IMPLICIT_TAG = "latest"


def _normalize_oci_reference(reference: str, *, drop_tag: bool = False) -> str:
    """Reduce an OCI reference toward the form we address by.

    ``docker.io/ai/smollm2:latest``  → ``ai/smollm2``
    ``ai/smollm2:360M-Q4_K_M``       → ``ai/smollm2:360M-Q4_K_M``  (tag KEPT)
    ``ai/smollm2``                   → ``ai/smollm2``              (idempotent)

    **Drop a leading registry host, always.** A first segment containing a
    ``.`` or a ``:`` (port), or the literal ``localhost``, is a host — the same
    rule the OCI distribution spec uses to tell ``ai/smollm2`` from
    ``docker.io/ai/smollm2``. Those name one model, so the prefix is noise.
    References deeper than three segments are left alone rather than guessed at.

    **Keep the tag, except ``:latest``.** This is the correction that matters:
    an OCI tag is load-bearing here — ``ai/smollm2:360M-Q4_K_M`` selects a
    quantization, and stripping it would silently pull a different weight file
    than the caller asked for. Only ``:latest`` is dropped, because it is the
    implicit default and keeping it would make ``ai/x`` and ``ai/x:latest``
    compare unequal despite naming the same thing.

    ``drop_tag=True`` removes the tag entirely. That is for *set membership*
    only — "is some build of this repository installed?" — never for addressing
    a model. See :meth:`DmrRuntime.comparable_id`.

    The tag is only ever split off the LAST segment, so a registry port
    (``localhost:5000/ai/x``) is never mistaken for a tag.
    """
    segments = [s for s in reference.split("/") if s]
    if len(segments) == 3:
        first = segments[0]
        if "." in first or ":" in first or first == "localhost":
            segments = segments[1:]
    repository, _, tag = segments[-1].partition(":")
    if drop_tag or tag == _IMPLICIT_TAG or not tag:
        segments[-1] = repository
    return "/".join(segments)


def _pull_error_in_body(text: str) -> str | None:
    """Return the first ``error`` a pull response reported, if any.

    Defensive, and deliberately DMR-only. Ollama signals a failed blocking pull
    with a non-2xx status, so the default path never needed this. DMR's
    ollama-compat pull is documented as *streaming* NDJSON, and the verified
    shape includes an ``error`` field — which means a failure could plausibly
    arrive as a 200 whose body's last line says it went wrong. Reporting that as
    ``{"status": "pulled"}`` would be a silent lie to ``/models/sync``.

    Parses defensively rather than assuming a form: any JSON object on any line
    that carries a truthy ``error`` counts, which covers both a single object
    (if ``stream:false`` is honoured) and a stream of them (if it is not).
    """
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get("error"):
            return str(obj["error"])
    return None


class DmrRuntime(OllamaWireRuntime):
    """Docker Model Runner. Selected only by ``INFERENCE_RUNTIME=dmr``."""

    name = "dmr"

    def preferred_id(self, pull_tag: str, oci: str | None = None) -> str:
        """A DECLARED OCI reference beats the derived one (WARP-2130).

        :func:`to_runtime_id` can only ever produce ``ai/<repo>`` from an Ollama
        id — it drops the tag on purpose, because "the OCI equivalent lives in
        the tag of the OCI reference, which we cannot derive". An OCI tag is
        precisely what selects a quantization, so a manifest that cannot state
        one cannot say which build of a model the appliance serves; the daemon
        resolves ``latest`` instead.

        A declared reference already carries a namespace separator, so
        :func:`to_runtime_id` passes it through :func:`_normalize_oci_reference`
        and **keeps its tag**. That is the whole mechanism: declaring the
        reference is what makes the tag survive to the wire.

        Falls back to ``pull_tag`` when nothing is declared, so every entry that
        predates the field behaves exactly as it did. A blank/whitespace value
        counts as undeclared — a compose-style ``${VAR:-}`` expansion landing in
        a manifest must not address the empty repository.
        """
        declared = (oci or "").strip()
        return declared or pull_tag

    def comparable_id(self, model: str) -> str:
        """Both vocabularies reduced to a bare ``namespace/name``.

        A manifest ``smollm2:360M`` becomes ``ai/smollm2``; a reported
        ``docker.io/ai/smollm2:latest`` becomes ``ai/smollm2``. Only then does
        ``entry.name in available`` mean what ``model_sync`` thinks it means.

        The tag is dropped here and NOWHERE else. Membership asks "is some build
        of this repository already on disk?", which is the question that stops
        the re-pull storm. Addressing a model still goes through
        :func:`to_runtime_id`, which preserves a meaningful tag, because pulling
        ``ai/smollm2`` when the caller said ``ai/smollm2:360M-Q4_K_M`` would
        fetch different weights.
        """
        return _normalize_oci_reference(to_runtime_id(model), drop_tag=True)

    def _pull_body(self, model: str, *, stream: bool) -> dict[str, object]:
        # Both `model` and `name` are sent. DMR's ollama-compat layer accepts
        # either spelling where we have verified it (`/api/chat` takes
        # `{model|name, ...}`); we have not verified which one its `/api/pull`
        # binds, and Ollama's own request struct carries both fields (`name`
        # being the legacy one), so sending both is correct against either and
        # costs one JSON key. Collapse this to a single key once it has been
        # confirmed against a live DMR — not before.
        runtime_id = to_runtime_id(model)
        return {"model": runtime_id, "name": runtime_id, "stream": stream}

    async def pull(self, model: str) -> dict[str, str]:
        resp = await self._client.post(
            PULL_PATH,
            json=self._pull_body(model, stream=False),
            timeout=TIMEOUT_PULL,
        )
        resp.raise_for_status()
        reported = _pull_error_in_body(resp.text)
        if reported is not None:
            raise RuntimePullError(f"pull of {model!r} failed: {reported}")
        # The caller's identifier, not the translated one — the `/models/*`
        # response shape must not leak OCI ids to callers that handed us
        # `name:tag`.
        return pulled_result(model)

    async def open_pull_stream(self, model: str) -> httpx.Response:
        request = self._client.build_request(
            "POST",
            PULL_PATH,
            json=self._pull_body(model, stream=True),
            timeout=TIMEOUT_PULL,
        )
        return await self._client.send(request, stream=True)

    async def delete(self, model: str) -> dict[str, str]:
        """Delete via the Ollama-compatible body form — same shape as Ollama.

        An earlier draft used DMR's native ``DELETE /models/{ns}/{name}`` on the
        assumption that the body form was Ollama-only. Measured on 2026-08-05
        against a live ``docker/model-runner:v1.2.6``:
        ``DELETE /api/delete {"name": "ai/smollm2"}`` returns 200 and the model
        disappears from ``/api/tags``. The path form exists too, but using it
        bought nothing and cost a real bug — it cannot address the
        registry-qualified ids DMR actually reports (``docker.io/ai/smollm2``
        has three segments, not two), so the shape guard raised ValueError on
        precisely the ids the daemon hands back.

        Keeping the body form means delete is genuinely identical across the two
        backends, which is one fewer difference for the adapter to be wrong
        about.
        """
        resp = await self._client.request(
            "DELETE", "/api/delete", json={"name": to_runtime_id(model)}
        )
        resp.raise_for_status()
        return deleted_result(model)
