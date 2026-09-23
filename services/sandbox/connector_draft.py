"""WARP-2899 (ADR-056 slice L) — what a connector draft IS, read from its files.

A workspace made from the `rest-profile` template holds a connector-draft.json
and, after `npm run build`, the four files it renders (the template's
scripts/render.mjs): an ADR-046 REST profile, a setup guide, an egress entry
and the ADR-042 rows. This module reads them back and says two things:

  * the facts a person needs to recognise the draft — which vendor, and which
    host it WOULD dial — for the readback on the Workshop, the propose result
    and the activity row;
  * the problems that make it not ready to propose: a rendered file missing,
    a guide whose sections are not the six in order, an egress entry that does
    not name the host, a scheme URL in a dynamic draft.

It mirrors checkRendered() in the template's scripts/validate.mjs, and the
tests prove the two agree on the renderer's real output. It is deliberately
NOT a second validator of the profile: the template's `npm test` and, at PR
time, assertValidRestProfile() own that. Nothing here loads a profile —
nothing on the box does (the draft is data; it ships only through a Warp Lab
PR).

Pure: `describe_tree(read)` takes a reader, so propose can run it over the
checkout and the orchestrator's readback over the bare repo at a ref. Stdlib
only — the checks on the generated YAML are substring checks, on purpose.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

DRAFT_FILE = "connector-draft.json"

# scripts/check-setup-guides.sh REQUIRED_SECTIONS, in its order.
GUIDE_SECTIONS = [
    "## Plan prerequisite",
    "## Cost",
    "## Click-path",
    "## Scopes and permissions",
    "## Rotation and expiry",
    "## Revocation",
]

PROVIDER_RE = re.compile(r"^[a-z][a-z0-9-]{1,40}$")

# A copy of scripts/check-egress-allowlist.py's URL_RE — the pattern the gate
# reads destinations with once an exported profile lands in services/.
URL_RE = re.compile(r"(?:https?|wss?|ftp)://[A-Za-z0-9._-]+\.[A-Za-z]{2,}")

ADR042_HEADER = "| Vendor | What the owner pastes |"

Reader = Callable[[str], "str | None"]


def output_paths(provider: str) -> dict[str, str]:
    """The rendered files, by role. Only ever called with a validated id."""
    return {
        "profile": f"services/erp-connector/src/rest/vendors/{provider}.ts",
        "guide": f"docs/integrations/{provider}.md",
        "egress": f"docs/security/allowed-egress.{provider}.draft.yaml",
        "adr042": "docs/adr-042/" + provider + ".rows" + ".md",
    }


def _host(base: Any, problems: list[str]) -> dict[str, Any] | None:
    if not isinstance(base, dict):
        problems.append("connector-draft.json has no baseUrl")
        return None
    if base.get("kind") == "static":
        origin = base.get("origin")
        parts = urlsplit(origin) if isinstance(origin, str) else None
        if not parts or parts.scheme != "https" or not parts.hostname:
            problems.append("baseUrl.origin is not an https origin yet")
            return None
        return {"kind": "static", "hosts": [parts.hostname]}
    if base.get("kind") == "dynamic":
        field = base.get("configField")
        suffixes = [s for s in base.get("allowedSuffixes") or [] if isinstance(s, str)]
        hosts = [h for h in base.get("allowedHosts") or [] if isinstance(h, str)]
        shape = base.get("hostShape") if isinstance(base.get("hostShape"), str) else ""
        if not isinstance(field, str) or not field:
            problems.append("baseUrl.configField is empty")
            return None
        if not suffixes and not hosts:
            problems.append("a dynamic baseUrl names no allowed suffix or host")
        return {"kind": "dynamic", "configField": field, "allowedSuffixes": suffixes, "allowedHosts": hosts, "hostShape": shape}
    problems.append("baseUrl.kind must be static or dynamic")
    return None


def _h2(text: str) -> list[str]:
    return [line.rstrip() for line in text.replace("\r\n", "\n").split("\n") if line.startswith("## ")]


def describe_tree(read: Reader) -> dict[str, Any] | None:
    """The draft's facts and problems, or None when the tree holds no draft."""
    raw = read(DRAFT_FILE)
    if raw is None:
        return None
    facts: dict[str, Any] = {"provider": "", "displayName": "", "host": None, "files": {}, "problems": []}
    problems: list[str] = facts["problems"]
    try:
        draft = json.loads(raw)
    except ValueError:
        problems.append("connector-draft.json is not valid JSON")
        return facts
    if not isinstance(draft, dict):
        problems.append("connector-draft.json must hold one JSON object")
        return facts
    provider = draft.get("provider")
    display = draft.get("displayName")
    facts["displayName"] = display.strip() if isinstance(display, str) else ""
    host = _host(draft.get("baseUrl"), problems)
    facts["host"] = host
    if not isinstance(provider, str) or not PROVIDER_RE.match(provider):
        # No path is built from an id that failed the grammar.
        problems.append("provider must match ^[a-z][a-z0-9-]{1,40}$")
        return facts
    facts["provider"] = provider
    paths = output_paths(provider)
    facts["files"] = paths
    const = provider.upper().replace("-", "_")
    ready = "; run `npm run build`"

    profile = read(paths["profile"])
    if profile is None:
        problems.append(f"{paths['profile']} is missing{ready}")
    else:
        if f"export const {const}_PROFILE" not in profile:
            problems.append(f"{paths['profile']} does not export {const}_PROFILE")
        if host and host["kind"] == "static" and json.dumps(draft["baseUrl"]["origin"]) not in profile:
            problems.append(f"{paths['profile']} does not carry the draft's origin")

    guide = read(paths["guide"])
    if guide is None:
        problems.append(f"{paths['guide']} is missing{ready}")
    elif _h2(guide) != GUIDE_SECTIONS:
        problems.append(f"{paths['guide']} must have exactly the six sections, in order: {', '.join(GUIDE_SECTIONS)}")

    egress = read(paths["egress"])
    if egress is None:
        problems.append(f"{paths['egress']} is missing{ready}")
    elif host and host["kind"] == "static":
        for name in host["hosts"]:
            if name not in egress:
                problems.append(f"{paths['egress']} does not name {name}")
    elif host:
        key = f"IntegrationConnection.providerConfig.{host['configField']}"
        if key not in egress:
            problems.append(f"{paths['egress']} does not name {key}")

    adr042 = read(paths["adr042"])
    if adr042 is None or ADR042_HEADER not in adr042:
        problems.append(f"{paths['adr042']} is missing its ADR-042 rows{ready}")

    if host and host["kind"] == "dynamic":
        for rel, text in ((DRAFT_FILE, raw), *((paths[k], t) for k, t in (("profile", profile), ("guide", guide), ("egress", egress), ("adr042", adr042)))):
            if text and URL_RE.search(text):
                problems.append(f"{rel} carries a scheme URL in a dynamic draft; describe the host in words")
    return facts
