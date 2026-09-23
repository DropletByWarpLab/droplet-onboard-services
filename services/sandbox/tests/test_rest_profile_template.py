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


def _write_rendered(work: Path, draft: dict) -> None:
    """A minimal, consistent render — what `npm run build` leaves, by hand, so
    these tests do not need node. The node-backed test below proves the real
    renderer's output satisfies the same reader."""
    p = draft["provider"]
    paths = connector_draft.output_paths(p)
    up = p.upper().replace("-", "_")
    (work / "connector-draft.json").write_text(json.dumps(draft, indent=2), encoding="utf-8")
    files = {
        paths["profile"]: f"export const {up}_PROVIDER = {json.dumps(p)};\nexport const {up}_PROFILE = "
        + json.dumps({"provider": p, "baseUrl": draft["baseUrl"]})
        + ";\n",
        paths["guide"]: GUIDE,
        paths["adr042"]: "| Vendor | What the owner pastes | Accepted shape | Full-privilege alternative to refuse "
        "| Scope granularity | Expires? | Verified |\n",
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


def test_a_bad_provider_id_is_a_problem_and_no_path_is_built_from_it():
    seen: list[str] = []

    def read(rel: str):
        seen.append(rel)
        return json.dumps({**_static_draft(), "provider": "../etc"}) if rel == "connector-draft.json" else None

    facts = connector_draft.describe_tree(read)
    assert any("provider" in p for p in facts["problems"])
    assert seen == ["connector-draft.json"]


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
    with pytest.raises(StoreError) as exc:
        workspace.propose(f"ws-bad-{breakage}", "Acme", "0.1.0", "s", ALICE)
    assert exc.value.status == 409 and expect in str(exc.value) and "npm run build" in str(exc.value)
    assert store.git(["tag", "--list"], store.bare_path(f"ws-bad-{breakage}")).stdout.strip() == ""


def test_propose_refuses_a_scheme_url_in_a_dynamic_draft(store):
    work = _draft_workspace(store, "ws-dyn", _dynamic_draft())
    guide = work / connector_draft.output_paths("globex")["guide"]
    guide.write_text(GUIDE + "\nSee https://acme.globex.example/settings\n", encoding="utf-8")
    with pytest.raises(StoreError) as exc:
        workspace.propose("ws-dyn", "Globex", "0.1.0", "s", ALICE)
    assert exc.value.status == 409 and "scheme URL" in str(exc.value)
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
@pytest.mark.parametrize("draft", [_static_draft(), _dynamic_draft()], ids=["static", "dynamic"])
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


@pytest.mark.skipif(not Path("/usr/local/bin/npm").exists(), reason="the sandbox image's npm is not here")
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
