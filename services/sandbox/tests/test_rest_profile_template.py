"""Connector drafts (WARP-2899, ADR-056 slice L).

The `rest-profile` template renders an ADR-046 REST profile, its guide, its
egress entry and its ADR-042 rows from one connector-draft.json. What this file
pins:

  * the template carries no scheme URL (the egress gate's own pattern);
  * the generator's node suite passes, and the draft suite FAILS on the
    untouched template (an empty draft is not a connector);
  * `workspace_propose` on a connector draft writes NO extension manifest,
    refuses (409, nothing tagged) while the rendered files are missing or
    disagree with the draft, and refuses a workspace that also holds a
    manifest;
  * the Python reader (connector_draft.py) agrees with the JS renderer.

Hosts are RFC-2606 names under .example.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

import connector_draft
import workspace
from gitstore import StoreError

ALICE = ("Alice", "alice@example.test")
TEMPLATE = Path(__file__).resolve().parents[3] / "extensions" / "templates" / "rest-profile"
NODE = shutil.which("node")
# A copy of scripts/check-egress-allowlist.py's URL_RE. Copied, not imported:
# the gate is a script, not a package.
GATE_URL_RE = re.compile(r"(?:https?|wss?|ftp)://([A-Za-z0-9._-]+\.[A-Za-z]{2,})")

ORIGIN = "https://api.acme.example"
GUIDE = "\n".join(
    [
        "<!-- Drafted on a Droplet box by the rest-profile template (WARP-2899). -->",
        "",
        "# Acme — setup",
        "",
        *[f"{h}\n\nTODO(verify)\n" for h in connector_draft.GUIDE_SECTIONS],
    ]
)


def _static_draft(provider: str = "acme") -> dict:
    return {
        "provider": provider,
        "displayName": "Acme Tasks",
        "baseUrl": {"kind": "static", "origin": ORIGIN},
        "auth": {"headerName": "Authorization", "valueTemplate": "Bearer {{token}}"},
        "constantHeaders": {},
        "probePath": "/v1/me",
        "minRequestIntervalMs": None,
        "datasets": [
            {
                "dataset": "task",
                "path": "/v1/tasks",
                "watermark": None,
                "pagination": {"kind": "link-header"},
                "rowsPath": "",
                "fieldMap": {"task_id": "id", "status": "state"},
            }
        ],
        "egress": {"dataClass": "user-content-on-request", "purpose": "tasks"},
        "credential": {},
        "guide": {"clickPath": []},
    }


def _dynamic_draft() -> dict:
    d = _static_draft("globex")
    d["displayName"] = "Globex"
    d["baseUrl"] = {
        "kind": "dynamic",
        "configField": "companyDomain",
        "allowedSuffixes": [".globex.example"],
        "allowedHosts": ["eu.globex-hosted.example"],
        "hostShape": "the customer's own subdomain",
    }
    return d


def _profile_text(draft: dict) -> str:
    """The profile exactly as scripts/render.mjs lays it out (renderProfile)."""
    p = draft["provider"]
    up = p.upper().replace("-", "_")
    base = draft["baseUrl"]
    if base["kind"] == "static":
        base = {"kind": "static", "origin": base["origin"]}
    else:
        base = {k: base[k] for k in ("kind", "configField", "allowedSuffixes", "allowedHosts") if k in base}
    body = json.dumps({"provider": p, "baseUrl": base, "probePath": draft["probePath"]}, indent=2)
    return "\n".join(
        [
            "// Drafted on a Droplet box by the rest-profile template (WARP-2899). Not verified.",
            "// Rendered from connector-draft.json by `npm run build`. Edit the draft, not this file.",
            'import type { RestVendorProfile } from "../profile.js";',
            "",
            f"export const {up}_PROVIDER = {json.dumps(p)};",
            "",
            f"export const {up}_PROFILE: RestVendorProfile = {body};",
            "",
        ]
    )


def _rows_text(name: str) -> str:
    """The three ADR-042 tables, one row each, as renderAdr042 lays them out."""
    return "\n".join(
        [
            "## §2 What the owner pastes",
            "",
            (
                "| Vendor | What the owner pastes | Accepted shape | Full-privilege alternative to refuse "
                "| Scope granularity | Expires? | Verified |"
            ),
            "|---|---|---|---|---|---|---|",
            f"| **{name}** | TODO(verify) | TODO(verify) | TODO(verify) | TODO(verify) | TODO(verify) | TODO(verify) |",
            "",
            "## §4 Accept and reject",
            "",
            "| Vendor | Accept | Reject |",
            "|---|---|---|",
            f"| {name} | TODO(verify) | TODO(verify) |",
            "",
            "## §7 Who provisions",
            "",
            "| Integration | Who provisions | Does Warp Lab register or publish anything? |",
            "|---|---|---|",
            f"| {name} | TODO(verify) | **No** TODO(verify) |",
            "",
        ]
    )


def _write_rendered(work: Path, draft: dict) -> None:
    """A minimal, consistent render — what `npm run build` leaves, by hand, so
    these tests do not need node. The node-backed test below proves the real
    renderer's output satisfies the same reader."""
    p = draft["provider"]
    paths = connector_draft.output_paths(p)
    (work / "connector-draft.json").write_text(json.dumps(draft, indent=2), encoding="utf-8")
    files = {
        paths["profile"]: _profile_text(draft),
        paths["guide"]: GUIDE,
        paths["adr042"]: _rows_text(draft["displayName"]),
    }
    if draft["baseUrl"]["kind"] == "static":
        files[paths["egress"]] = "entries:\n  - id: acme-api\n    destination:\n      hosts: [\"api.acme.example\"]\n"
    else:
        files[paths["egress"]] = (
            "entries:\n  - id: globex-api\n    kind: dynamic\n"
            f"    config_key: \"IntegrationConnection.providerConfig.{draft['baseUrl']['configField']} (words)\"\n"
        )
    for rel, text in files.items():
        target = work / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="")


# ── the template ────────────────────────────────────────────────────────────


def test_the_template_carries_no_scheme_url():
    # AC6. The egress gate does not scan extensions/ (SCOPE_PREFIXES), so this
    # is the rule's only enforcement until an exported profile lands in
    # services/. MUTATION: add a sample vendor URL to the template README → red.
    hits = []
    for f in sorted(TEMPLATE.rglob("*")):
        if f.is_file():
            for m in GATE_URL_RE.finditer(f.read_text(encoding="utf-8")):
                hits.append(f"{f.relative_to(TEMPLATE)}: {m.group(0)}")
    assert hits == []
    assert (TEMPLATE / "connector-draft.json").is_file()
    assert not (TEMPLATE / "extension-manifest.json").exists(), "a connector draft is not an extension"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_the_generator_suite_passes_and_the_empty_draft_fails():
    ok = subprocess.run([NODE, "--test", "test/render.test.mjs"], cwd=TEMPLATE, capture_output=True, text=True, encoding="utf-8", check=False, timeout=180)
    assert ok.returncode == 0, ok.stdout[-2000:] + ok.stderr[-2000:]
    empty = subprocess.run([NODE, "--test", "test/draft.test.mjs"], cwd=TEMPLATE, capture_output=True, text=True, encoding="utf-8", check=False, timeout=60)
    assert empty.returncode != 0, "the untouched template's empty draft must not pass npm test"


# ── the reader ──────────────────────────────────────────────────────────────


def test_describe_is_none_without_a_draft_and_reports_what_it_can_read(tmp_path):
    assert connector_draft.describe_tree(lambda _p: None) is None
    facts = connector_draft.describe_tree(lambda p: "{nope" if p == "connector-draft.json" else None)
    assert facts is not None and facts["problems"] == ["connector-draft.json is not valid JSON"]

    work = tmp_path / "w"
    work.mkdir()
    _write_rendered(work, _static_draft())
    read = lambda rel: (work / rel).read_text(encoding="utf-8") if (work / rel).is_file() else None
    facts = connector_draft.describe_tree(read)
    assert facts["problems"] == []
    assert facts["provider"] == "acme" and facts["displayName"] == "Acme Tasks"
    assert facts["host"] == {"kind": "static", "hosts": ["api.acme.example"]}
    assert facts["files"]["profile"] == "services/erp-connector/src/rest/vendors/acme.ts"

    dyn = tmp_path / "d"
    dyn.mkdir()
    _write_rendered(dyn, _dynamic_draft())
    read = lambda rel: (dyn / rel).read_text(encoding="utf-8") if (dyn / rel).is_file() else None
    facts = connector_draft.describe_tree(read)
    assert facts["problems"] == []
    assert facts["host"] == {
        "kind": "dynamic",
        "configField": "companyDomain",
        "allowedSuffixes": [".globex.example"],
        "allowedHosts": ["eu.globex-hosted.example"],
        "hostShape": "the customer's own subdomain",
    }


@pytest.mark.parametrize(
    "provider",
    # The second: Python's `$` matches before a final "\n" and JS's .test
    # does not (rjouffret on #2324). MUTATION: PROVIDER_RE.match → red.
    ["../etc", "acme\n"],
    ids=["traversal", "trailing-newline"],
)
def test_a_bad_provider_id_is_a_problem_and_no_path_is_built_from_it(provider):
    seen: list[str] = []

    def read(rel: str):
        seen.append(rel)
        return json.dumps({**_static_draft(), "provider": provider}) if rel == "connector-draft.json" else None

    facts = connector_draft.describe_tree(read)
    assert any("provider" in p for p in facts["problems"])
    assert facts["provider"] == "" and facts["files"] == {}
    assert seen == ["connector-draft.json"]


def test_a_scheme_in_a_draft_string_is_a_problem_except_the_static_origin():
    # validate.mjs's rule, re-read at propose: nothing but a static origin
    # carries "://". MUTATION: skip the draft-string walk → red.
    dyn = _dynamic_draft()
    dyn["baseUrl"]["hostShape"] = "like https://acme.globex.example"
    facts = connector_draft.describe_tree(lambda p: json.dumps(dyn) if p == "connector-draft.json" else None)
    assert any("baseUrl.hostShape carries a scheme URL" in p for p in facts["problems"])
    static = _static_draft()
    static["guide"]["cost"] = "see https://api.acme.example/pricing"
    facts = connector_draft.describe_tree(lambda p: json.dumps(static) if p == "connector-draft.json" else None)
    assert any("guide.cost carries a scheme URL" in p for p in facts["problems"])
    assert not any("baseUrl.origin" in p for p in facts["problems"])


def test_a_scheme_in_a_draft_key_is_a_problem_and_no_key_spells_the_origin():
    # A key is a string too (rjouffret on #2324), and a key that is not a
    # plain name is located as [?], so a root "baseUrl.origin" key is not
    # the static origin. MUTATION: walk values only, or locate keys by their
    # raw text → red.
    dyn = _dynamic_draft()
    dyn["guide"]["https://exfil.evil.example/x"] = ""
    facts = connector_draft.describe_tree(lambda p: json.dumps(dyn) if p == "connector-draft.json" else None)
    assert any("guide.[?] (key) carries a scheme URL" in p for p in facts["problems"])
    assert not any("exfil" in p for p in facts["problems"])
    static = _static_draft()
    static["baseUrl.origin"] = "https://exfil.evil.example"
    facts = connector_draft.describe_tree(lambda p: json.dumps(static) if p == "connector-draft.json" else None)
    assert any("[?] carries a scheme URL" in p for p in facts["problems"])


def test_the_readback_only_ever_names_a_domain_and_a_bounded_name():
    # rjouffret on #2324: describe_tree does not re-validate the draft, so a
    # hand-written suffix or host (an IP, free prose) reached "nothing on
    # this box will dial X". Each is now a problem AND left out of the facts
    # the readback is built from; the display name is capped.
    # MUTATION: skip the grammar in _host → red.
    dyn = _dynamic_draft()
    dyn["displayName"] = "G" * 500
    dyn["baseUrl"]["allowedSuffixes"] = [".globex.example", ".127.0.0.1", "free prose here"]
    dyn["baseUrl"]["allowedHosts"] = ["eu.globex-hosted.example", "127.0.0.1", "a host; rm"]
    facts = connector_draft.describe_tree(lambda p: json.dumps(dyn) if p == "connector-draft.json" else None)
    assert facts["host"]["allowedSuffixes"] == [".globex.example"]
    assert facts["host"]["allowedHosts"] == ["eu.globex-hosted.example"]
    assert sum("is not a domain" in p for p in facts["problems"]) == 4
    assert len(facts["displayName"]) <= connector_draft.MAX_DISPLAY_NAME

    static = _static_draft()
    static["baseUrl"]["origin"] = "https://127.0.0.1"
    facts = connector_draft.describe_tree(lambda p: json.dumps(static) if p == "connector-draft.json" else None)
    assert facts["host"] is None
    assert any("by domain" in p for p in facts["problems"])


# ── propose ─────────────────────────────────────────────────────────────────


def _draft_workspace(store, wid: str, draft: dict) -> Path:
    store.create_workspace(wid, "rest-profile", ALICE)
    work = store.work_path(wid)
    _write_rendered(work, draft)
    return work


def test_propose_a_connector_draft_writes_no_manifest_and_tags(store):
    # MUTATION: let a connector draft fall through to the extension path (always
    # write the manifest) → red.
    work = _draft_workspace(store, "ws-cd", _static_draft())
    p = workspace.propose("ws-cd", "Acme draft", "0.1.0", "Drafts Acme.", ALICE)
    assert p["kind"] == "connector-draft" and p["manifest"] is None and p["tag"] == "proposal/0.1.0"
    assert p["connectorDraft"]["provider"] == "acme" and p["connectorDraft"]["problems"] == []
    assert not (work / "extension-manifest.json").exists()
    tree = store.git(["ls-tree", "-r", "--name-only", "proposal/0.1.0"], store.bare_path("ws-cd")).stdout.split()
    assert "extension-manifest.json" not in tree
    assert "services/erp-connector/src/rest/vendors/acme.ts" in tree
    assert store.status("ws-cd")["dirty"] is False


@pytest.mark.parametrize(
    "breakage, expect",
    [
        ("profile", "vendors/acme.ts is missing"),
        ("guide-order", "six sections"),
        ("egress-host", "does not name api.acme.example"),
        ("adr042", "adr-042/acme"),
        # A hand-edited profile that dials another host while the draft's
        # origin still sits in a comment (review of #2324).
        ("profile-origin-comment", "not the profile `npm run build` renders"),
        ("profile-origin", "baseUrl does not match connector-draft.json"),
        ("profile-extra-code", "not the profile `npm run build` renders"),
        ("profile-escaped-url", "scheme URL other than its origin"),
        # The same URL as a KEY, whose value is a number (rjouffret's repro),
        # and as a value under a key that spells the origin's location.
        ("profile-escaped-url-key", "scheme URL other than its origin"),
        ("profile-origin-spelling-key", "scheme URL other than its origin"),
        # A URL in the egress entry: YAML decodes a double-quoted `\/` (the
        # text holds no "://"), and a plain one is in the text.
        ("egress-escaped-url", "allowed-egress.acme.draft.yaml carries a backslash"),
        ("egress-plain-url", "allowed-egress.acme.draft.yaml carries a scheme URL"),
        ("adr042-header-only", "no §2 row for Acme Tasks"),
        ("adr042-no-provisioning", "no §7 provisioning row for Acme Tasks"),
        ("adr042-blank-cell", "no §4 accept/reject row for Acme Tasks"),
        ("static-url-in-guide", "carries a scheme URL"),
    ],
)
def test_propose_refuses_a_draft_whose_renders_are_missing_or_disagree(store, breakage, expect):
    # MUTATION: skip the describe/problems check in propose → no 409, a tag.
    work = _draft_workspace(store, f"ws-bad-{breakage}", _static_draft())
    paths = connector_draft.output_paths("acme")
    if breakage == "profile":
        (work / paths["profile"]).unlink()
    elif breakage == "guide-order":
        (work / paths["guide"]).write_text(GUIDE.replace("## Cost", "## Costs"), encoding="utf-8")
    elif breakage == "egress-host":
        (work / paths["egress"]).write_text("entries: []\n", encoding="utf-8")
    elif breakage == "adr042":
        (work / paths["adr042"]).unlink()
    elif breakage == "profile-origin-comment":
        (work / paths["profile"]).write_text(
            'export const ACME_PROFILE = {origin:"https://api.evil.example"}; // "https://api.acme.example"\n',
            encoding="utf-8",
        )
    elif breakage == "profile-origin":
        text = (work / paths["profile"]).read_text(encoding="utf-8")
        (work / paths["profile"]).write_text(text.replace(ORIGIN, "https://api.evil.example"), encoding="utf-8")
    elif breakage == "profile-extra-code":
        text = (work / paths["profile"]).read_text(encoding="utf-8")
        (work / paths["profile"]).write_text(text + 'ACME_PROFILE.probePath = "/x";\n', encoding="utf-8")
    elif breakage == "profile-escaped-url":
        # `\/` is "/" to TypeScript and to JSON: the text holds no "://", the value does.
        text = (work / paths["profile"]).read_text(encoding="utf-8")
        (work / paths["profile"]).write_text(
            text.replace('"probePath": "/v1/me"', '"probePath": "https:\\/\\/api.evil.example/v1"'), encoding="utf-8"
        )
    elif breakage in ("profile-escaped-url-key", "profile-origin-spelling-key"):
        text = (work / paths["profile"]).read_text(encoding="utf-8")
        extra = (
            '"https:\\/\\/exfil.evil.example\\/x": 1'
            if breakage == "profile-escaped-url-key"
            else '"baseUrl.origin": "https:\\/\\/exfil.evil.example\\/x"'
        )
        edited = text.replace('"probePath": "/v1/me"', f'"probePath": "/v1/me", {extra}')
        assert edited.count("://") == 1  # the origin's own, nothing else in the text
        (work / paths["profile"]).write_text(edited, encoding="utf-8")
    elif breakage in ("egress-escaped-url", "egress-plain-url"):
        url = "https:\\/\\/exfil.evil.example\\/x" if breakage == "egress-escaped-url" else "https://exfil.evil.example/x"
        egress = work / paths["egress"]
        egress.write_text(egress.read_text(encoding="utf-8") + f'    purpose: "{url}"\n', encoding="utf-8")
    elif breakage == "adr042-header-only":
        (work / paths["adr042"]).write_text(
            "| Vendor | What the owner pastes | Accepted shape | Full-privilege alternative to refuse "
            "| Scope granularity | Expires? | Verified |\n",
            encoding="utf-8",
        )
    elif breakage == "adr042-no-provisioning":
        rows = _rows_text("Acme Tasks")
        (work / paths["adr042"]).write_text(rows[: rows.index("## §7")], encoding="utf-8")
    elif breakage == "adr042-blank-cell":
        rows = _rows_text("Acme Tasks").replace("| Acme Tasks | TODO(verify) | TODO(verify) |", "| Acme Tasks |  | TODO(verify) |")
        (work / paths["adr042"]).write_text(rows, encoding="utf-8")
    elif breakage == "static-url-in-guide":
        (work / paths["guide"]).write_text(GUIDE + "\nSee https://docs.acme.example/tokens\n", encoding="utf-8")
    with pytest.raises(StoreError) as exc:
        workspace.propose(f"ws-bad-{breakage}", "Acme", "0.1.0", "s", ALICE)
    assert exc.value.status == 409 and expect in str(exc.value) and "npm run build" in str(exc.value)
    assert store.git(["tag", "--list"], store.bare_path(f"ws-bad-{breakage}")).stdout.strip() == ""


def test_propose_refuses_a_scheme_url_in_a_dynamic_draft(store):
    work = _draft_workspace(store, "ws-dyn", _dynamic_draft())
    guide = work / connector_draft.output_paths("globex")["guide"]
    # Any scheme, not only the gate's dotted-TLD shape: an IP and a single
    # label are URLs too (validate.mjs refuses any "://"). MUTATION: go back
    # to URL_RE for the dynamic scan → the last two red.
    for url in ("https://acme.globex.example/settings", "https://127.0.0.1/settings", "https://intranet/settings"):
        guide.write_text(GUIDE + f"\nSee {url}\n", encoding="utf-8")
        with pytest.raises(StoreError) as exc:
            workspace.propose("ws-dyn", "Globex", "0.1.0", "s", ALICE)
        assert exc.value.status == 409 and "scheme URL" in str(exc.value), url
    guide.write_text(GUIDE, encoding="utf-8")
    # A `\/`-escaped URL in the profile's values: no "://" in the text, one
    # in the value (rjouffret's repro on #2324). MUTATION: scan the decoded
    # values for static drafts only → red.
    profile = work / connector_draft.output_paths("globex")["profile"]
    rendered = profile.read_text(encoding="utf-8")
    profile.write_text(
        rendered.replace('"probePath": "/v1/me"', '"probePath": "/v1/me", "note": "https:\\/\\/exfil.evil.example\\/x"'),
        encoding="utf-8",
    )
    assert "://" not in profile.read_text(encoding="utf-8")
    with pytest.raises(StoreError) as escaped:
        workspace.propose("ws-dyn", "Globex", "0.1.0", "s", ALICE)
    assert escaped.value.status == 409 and "scheme URL" in str(escaped.value)
    # The same URL as a KEY beside probePath, its value a number
    # (rjouffret's repro on #2324). MUTATION: walk values only → red.
    profile.write_text(
        rendered.replace('"probePath": "/v1/me"', '"probePath": "/v1/me", "https:\\/\\/exfil.evil.example\\/x": 1'),
        encoding="utf-8",
    )
    assert "://" not in profile.read_text(encoding="utf-8")
    with pytest.raises(StoreError) as keyed:
        workspace.propose("ws-dyn", "Globex", "0.1.0", "s", ALICE)
    assert keyed.value.status == 409 and "scheme URL" in str(keyed.value)
    profile.write_text(rendered, encoding="utf-8")
    # The egress entry: a double-quoted `\/` URL (YAML decodes it; the text
    # holds no "://") and a plain one. MUTATION: drop the backslash rule →
    # the escaped case goes through.
    egress = work / connector_draft.output_paths("globex")["egress"]
    entry = egress.read_text(encoding="utf-8")
    for url, expect in (("https:\\/\\/exfil.evil.example\\/x", "carries a backslash"), ("https://exfil.evil.example/x", "scheme URL")):
        egress.write_text(entry + f'    purpose: "{url}"\n', encoding="utf-8")
        with pytest.raises(StoreError) as bad_egress:
            workspace.propose("ws-dyn", "Globex", "0.1.0", "s", ALICE)
        assert bad_egress.value.status == 409 and expect in str(bad_egress.value), url
    egress.write_text(entry, encoding="utf-8")
    guide.write_text(GUIDE, encoding="utf-8")
    p = workspace.propose("ws-dyn", "Globex", "0.1.0", "s", ALICE)
    assert p["connectorDraft"]["host"]["kind"] == "dynamic"


def test_a_draft_beside_an_extension_manifest_is_refused(store):
    store.create_workspace("ws-both", "typescript-tool", ALICE)
    _write_rendered(store.work_path("ws-both"), _static_draft())
    with pytest.raises(StoreError) as exc:
        workspace.propose("ws-both", "Both", "0.1.0", "s", ALICE)
    assert exc.value.status == 409 and "extension-manifest.json" in str(exc.value)
    assert store.git(["tag", "--list"], store.bare_path("ws-both")).stdout.strip() == ""


def test_an_extension_still_proposes_as_one(store):
    store.create_workspace("ws-ext", "typescript-tool", ALICE)
    p = workspace.propose("ws-ext", "Word counter", "0.1.0", "Counts.", ALICE)
    assert p["kind"] == "extension" and p["manifest"]["egress"] == "none"
    assert "connectorDraft" not in p


# ── the real renderer, end to end ───────────────────────────────────────────


def _node_render(work: Path, draft: dict) -> subprocess.CompletedProcess:
    (work / "connector-draft.json").write_text(json.dumps(draft, indent=2), encoding="utf-8")
    return subprocess.run([NODE, "scripts/render.mjs"], cwd=work, capture_output=True, text=True, encoding="utf-8", check=False, timeout=60)


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.parametrize(
    "draft",
    # The third: a display name with a backslash before a pipe — both readers
    # escape it as cell() does, backslash first. MUTATION: escape only the
    # pipe in connector_draft._cell → red.
    [_static_draft(), _dynamic_draft(), {**_static_draft(), "displayName": "Acme\\|Tasks"}],
    ids=["static", "dynamic", "odd-name"],
)
def test_the_python_reader_agrees_with_the_js_renderer(store, draft):
    wid = f"ws-js-{draft['baseUrl']['kind']}"
    store.create_workspace(wid, "rest-profile", ALICE)
    work = store.work_path(wid)
    r = _node_render(work, draft)
    assert r.returncode == 0, r.stdout + r.stderr
    t = subprocess.run([NODE, "--test", "test/draft.test.mjs"], cwd=work, capture_output=True, text=True, encoding="utf-8", check=False, timeout=60)
    assert t.returncode == 0, t.stdout[-2000:]
    p = workspace.propose(wid, "Draft", "0.1.0", "s", ALICE)
    assert p["kind"] == "connector-draft" and p["connectorDraft"]["problems"] == []


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_the_rendered_egress_entry_carries_no_backslash_and_parses_back(store):
    # rjouffret on #2324: YAML decodes "https:\/\/..." to a URL, so the
    # readers refuse any backslash in the egress entry, and the renderer must
    # write none: free text is single-quoted, on one line. MUTATION: go back
    # to JSON-quoting the free text → the propose below is refused.
    yaml = pytest.importorskip("yaml")
    assert yaml.safe_load('purpose: "https:\\/\\/exfil.evil.example\\/x"')["purpose"] == "https://exfil.evil.example/x"
    draft = _dynamic_draft()
    draft["egress"]["purpose"] = 'the "Export" tab\'s\r\n\trows'
    draft["baseUrl"]["hostShape"] = 'the customer\'s "own"\nsubdomain'
    store.create_workspace("ws-js-quoted", "rest-profile", ALICE)
    work = store.work_path("ws-js-quoted")
    r = _node_render(work, draft)
    assert r.returncode == 0, r.stdout + r.stderr
    text = (work / connector_draft.output_paths("globex")["egress"]).read_text(encoding="utf-8")
    assert "\\" not in text
    entry = yaml.safe_load(text)["entries"][0]
    assert entry["purpose"] == 'the "Export" tab\'s rows'
    assert entry["config_key"] == 'IntegrationConnection.providerConfig.companyDomain (the customer\'s "own" subdomain)'
    p = workspace.propose("ws-js-quoted", "Draft", "0.1.0", "s", ALICE)
    assert p["connectorDraft"]["problems"] == []


# The image, not just any host with /usr/local/bin/npm: a GitHub runner has
# that npm too, and there this test hung the sandbox job to its 15-minute
# timeout (the run's rlimits and env are the image's, not the runner's).
# /app/templates is the image's own layout (services/sandbox/Dockerfile).
IN_THE_IMAGE = Path("/usr/local/bin/npm").exists() and Path("/app/templates").is_dir()


@pytest.mark.skipif(not IN_THE_IMAGE, reason="runs only inside the sandbox image")
def test_end_to_end_in_the_image(store, tmp_path):
    # The live path: the run allow-list's `npm run build` / `npm test`, then
    # propose, then the bundle an owner downloads, cloned with no network.
    store.create_workspace("ws-e2e", "rest-profile", ALICE)
    workspace.write("ws-e2e", "connector-draft.json", json.dumps(_static_draft(), indent=2))
    assert workspace.run("ws-e2e", ["npm", "run", "build"], 120_000)["exitCode"] == 0
    res = workspace.run("ws-e2e", ["npm", "test"], 120_000)
    assert res["exitCode"] == 0, res["stdout"][-2000:]
    workspace.commit("ws-e2e", "draft acme", ALICE)
    workspace.propose("ws-e2e", "Acme", "0.1.0", "s", ALICE)
    body, _head = store.bundle("ws-e2e")
    (tmp_path / "x.bundle").write_bytes(body)
    store.must(store.git(["clone", "-q", str(tmp_path / "x.bundle"), str(tmp_path / "c")], tmp_path), "clone")
    assert (tmp_path / "c" / "services/erp-connector/src/rest/vendors/acme.ts").is_file()
