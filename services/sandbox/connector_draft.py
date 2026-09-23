"""WARP-2899 (ADR-056 slice L) — what a connector draft IS, read from its files.

A workspace made from the `rest-profile` template holds a connector-draft.json
and, after `npm run build`, the four files it renders (the template's
scripts/render.mjs): an ADR-046 REST profile, a setup guide, an egress entry
and the ADR-042 rows. This module reads them back and says two things:

  * the facts a person needs to recognise the draft — which vendor, and which
    host it WOULD dial — for the readback on the Workshop, the propose result
    and the activity row;
  * the problems that make it not ready to propose: a rendered file missing,
    a profile that is not the renderer's layout or dials another baseUrl, a
    guide whose sections are not the six in order, an egress entry that does
    not name the host, an ADR-042 table without its row, and any "://" but a
    static draft's one origin.

It mirrors checkRendered() in the template's scripts/validate.mjs, and the
tests prove the two agree on the renderer's real output. It is deliberately
NOT a second validator of the profile's datasets: the template's `npm test`
and, at PR time, assertValidRestProfile() own that. What it does own is that
the host the readback names is the host the profile dials: the profile must
be exactly the renderer's layout (comments, one import, two constants, a JSON
object) so its baseUrl can be read as data and compared with the draft's.
Nothing here loads a profile as code — nothing on the box does (the draft is
data; it ships only through a Warp Lab PR).

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

# validate.mjs HOST_RE / SUFFIX_RE: lowercase labels, at least two, and a last
# label with a letter in it — a domain, never an IP.
HOST_RE = re.compile(r"^(?:[a-z0-9-]+\.)+[a-z0-9-]*[a-z][a-z0-9-]*$")
SUFFIX_RE = re.compile(r"^\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z0-9-]*[a-z][a-z0-9-]*$")
MAX_HOST = 253
# The readback carries the name verbatim on three surfaces; bound it.
MAX_DISPLAY_NAME = 80

# renderAdr042's three tables: the header each starts with, and how its one
# data row names the vendor.
ADR042_TABLES = (
    ("§2", "| Vendor | What the owner pastes |", "| **{name}** |"),
    ("§4 accept/reject", "| Vendor | Accept | Reject |", "| {name} |"),
    ("§7 provisioning", "| Integration | Who provisions |", "| {name} |"),
)
_SEPARATOR_RE = re.compile(r"^\|(?:\s*:?-+:?\s*\|)+\s*$")
_PIPE_RE = re.compile(r"(?<!\\)\|")

# One `//` line comment. JavaScript also ends a line at U+2028/U+2029, so a
# comment may not contain them — code cannot hide behind one.
_COMMENT_LINE = r"[ \t]*//[^\n\r\u2028\u2029]*\n"

SCHEME = "://"

Reader = Callable[[str], "str | None"]


def output_paths(provider: str) -> dict[str, str]:
    """The rendered files, by role. Only ever called with a validated id."""
    return {
        "profile": f"services/erp-connector/src/rest/vendors/{provider}.ts",
        "guide": f"docs/integrations/{provider}.md",
        "egress": f"docs/security/allowed-egress.{provider}.draft.yaml",
        "adr042": "docs/adr-042/" + provider + ".rows" + ".md",
    }


def _domains(values: Any, pattern: re.Pattern[str], at: str, problems: list[str]) -> list[str]:
    """The entries that are domains (or `.domain` suffixes). Anything else is
    a problem and is left out, so the readback never names it."""
    kept = []
    for i, value in enumerate(values if isinstance(values, list) else []):
        if isinstance(value, str) and len(value) <= MAX_HOST and pattern.fullmatch(value):
            kept.append(value)
        else:
            problems.append(f"{at}[{i}] is not a domain{' suffix' if pattern is SUFFIX_RE else ''}")
    return kept


def _host(base: Any, problems: list[str]) -> dict[str, Any] | None:
    """What the draft would dial, as the readback may name it: domains only,
    by the grammar validate.mjs applies (the draft is not re-validated here,
    so a hand-written IP or prose never reaches "nothing will dial X")."""
    if not isinstance(base, dict):
        problems.append("connector-draft.json has no baseUrl")
        return None
    if base.get("kind") == "static":
        origin = base.get("origin")
        parts = urlsplit(origin) if isinstance(origin, str) else None
        if not parts or parts.scheme != "https" or not parts.hostname:
            problems.append("baseUrl.origin is not an https origin yet")
            return None
        if len(parts.hostname) > MAX_HOST or not HOST_RE.fullmatch(parts.hostname):
            problems.append("baseUrl.origin must name a host by domain, never an IP")
            return None
        return {"kind": "static", "hosts": [parts.hostname]}
    if base.get("kind") == "dynamic":
        field = base.get("configField")
        suffixes = _domains(base.get("allowedSuffixes"), SUFFIX_RE, "baseUrl.allowedSuffixes", problems)
        hosts = _domains(base.get("allowedHosts"), HOST_RE, "baseUrl.allowedHosts", problems)
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


_PLAIN_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")


def _strings(value: Any, at: str = "") -> list[tuple[str, str]]:
    """Every string in `value`, object KEYS as well as values, with its dotted
    location (validate.mjs strings()). A key is a string too: `"https:\\/\\/x": 1`
    decodes to a URL (review of #2324). A key that is not a plain name is
    located as `[?]`, so no key can spell `baseUrl.origin` (the one place a
    static draft may carry a scheme) and no URL is echoed into a problem."""
    if isinstance(value, str):
        return [(at, value)]
    if isinstance(value, list):
        return [pair for i, v in enumerate(value) for pair in _strings(v, f"{at}[{i}]")]
    if isinstance(value, dict):
        out: list[tuple[str, str]] = []
        for k, v in value.items():
            key = str(k)
            seg = key if _PLAIN_KEY_RE.fullmatch(key) else "[?]"
            loc = f"{at}.{seg}" if at else seg
            out.append((f"{loc} (key)", key))
            out.extend(_strings(v, loc))
        return out
    return []


def _expected_base(base: dict[str, Any]) -> dict[str, Any]:
    """The baseUrl renderProfile writes for the draft's baseUrl (profileOf)."""
    if base.get("kind") == "static":
        return {"kind": "static", "origin": base.get("origin")}
    return {k: base[k] for k in ("kind", "configField", "allowedSuffixes", "allowedHosts") if k in base}


def _profile_object(text: str, const: str, provider: str) -> Any:
    """The profile's object literal, read as JSON — or None when the file is
    not exactly the renderer's layout. Nothing else may sit in the file: no
    second statement can re-point the baseUrl the readback names."""
    m = re.fullmatch(
        rf"(?:{_COMMENT_LINE}|[ \t]*\n)*"
        r'import type \{ RestVendorProfile \} from "\.\./profile\.js";\n\s*'
        rf'export const {re.escape(const)}_PROVIDER = "{re.escape(provider)}";\n\s*'
        rf"export const {re.escape(const)}_PROFILE: RestVendorProfile = (\{{.*\}});\s*",
        text.replace("\r\n", "\n"),
        re.DOTALL,
    )
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return None


def _cell(text: str) -> str:
    """renderAdr042's cell(): the backslash first, then newlines, then pipes."""
    return re.sub(r"\r?\n", " ", text.replace("\\", "\\\\")).replace("|", "\\|")


def _adr042_problems(text: str, name: str, path: str) -> list[str]:
    """Each of the three tables has its header, a separator and the vendor's
    row, with as many cells as the header and none of them blank."""
    lines = text.replace("\r\n", "\n").split("\n")
    problems = []
    for label, header, row in ADR042_TABLES:
        at = next((i for i, line in enumerate(lines) if line.startswith(header)), None)
        ok = False
        if at is not None and at + 2 < len(lines):
            head_cells = _PIPE_RE.split(lines[at])[1:-1]
            row_line = lines[at + 2]
            cells = _PIPE_RE.split(row_line)[1:-1]
            ok = (
                bool(_SEPARATOR_RE.match(lines[at + 1]))
                and row_line.startswith(row.format(name=name))
                and len(cells) == len(head_cells)
                and all(c.strip() for c in cells)
            )
        if not ok:
            problems.append(f"{path} has no {label} row for {name}")
    return problems


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
    display = display.strip() if isinstance(display, str) else ""
    # The readback's copy is bounded; the rows check below reads the full name.
    facts["displayName"] = display if len(display) <= MAX_DISPLAY_NAME else display[: MAX_DISPLAY_NAME - 1] + "…"
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

    # Nothing but a static origin carries a scheme (validate.mjs's rule).
    base = draft.get("baseUrl")
    static = isinstance(base, dict) and base.get("kind") == "static"
    for at, value in _strings(draft):
        if SCHEME in value and not (static and at == "baseUrl.origin"):
            problems.append(f"{DRAFT_FILE} {at} carries a scheme URL; describe hosts in words (hostShape)")

    profile = read(paths["profile"])
    if profile is None:
        problems.append(f"{paths['profile']} is missing{ready}")
    elif f"export const {const}_PROFILE" not in profile:
        problems.append(f"{paths['profile']} does not export {const}_PROFILE")
    else:
        obj = _profile_object(profile, const, provider)
        if not isinstance(obj, dict):
            problems.append(f"{paths['profile']} is not the profile `npm run build` renders; edit the draft, not the render")
        else:
            if obj.get("provider") != provider:
                problems.append(f"{paths['profile']} names a provider other than {provider}")
            if host and obj.get("baseUrl") != _expected_base(draft["baseUrl"]):
                problems.append(f"{paths['profile']} baseUrl does not match connector-draft.json")
            # The values as well as the text: a `\/` escape hides "://" from
            # the text but not from the value. A static profile carries its
            # origin once; a dynamic one carries none (its text is scanned
            # below with the other files).
            extra = [at for at, v in _strings(obj) if SCHEME in v and not (static and at == "baseUrl.origin")]
            if static and (profile.count(SCHEME) != 1 or extra):
                problems.append(f"{paths['profile']} carries a scheme URL other than its origin")
            elif not static and extra:
                problems.append(f"{paths['profile']} carries a scheme URL in {', '.join(extra)}; describe the host in words")

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
    if adr042 is None:
        problems.append(f"{paths['adr042']} is missing its ADR-042 rows{ready}")
    else:
        name = _cell(display or provider)
        problems.extend(_adr042_problems(adr042, name, paths["adr042"]))

    # Any "://", not only the egress gate's URL_RE shape (which needs a
    # dotted alphabetic TLD): an IP or a single-label host is a URL too. A
    # dynamic draft carries none; a static one carries its origin in the
    # profile only (checked above).
    others = (("guide", guide), ("egress", egress), ("adr042", adr042))
    if not static:
        others = (("profile", profile), *others)
    for key, text in others:
        if text and SCHEME in text:
            problems.append(f"{paths[key]} carries a scheme URL; describe the host in words (only a static profile carries its origin)")
    return facts
