"""The image's app templates really probe and remain apps through proposal."""
import json
import shutil

import pytest

import app_check
import workspace

AUTHOR = ("Alice", "alice@example.test")

@pytest.mark.parametrize("template", ["static-site", "node-app", "python-app"])
def test_template_runs_health_and_root_then_proposes_as_app(store, template, monkeypatch):
    if template == "node-app" and shutil.which("node") is None:
        pytest.skip("node is unavailable")
    if template == "node-app":
        monkeypatch.setattr(app_check, "NODE_BIN", shutil.which("node"))
    store.create_workspace("ws-template", template, AUTHOR)
    result = workspace.run("ws-template", ["app-check"], timeout_ms=5000)
    assert result["exitCode"] == 0, result
    assert result["appCheck"]["health"]["status"] == 200
    assert result["appCheck"]["root"]["status"] == 200
    proposal = workspace.propose("ws-template", "My UI", "0.1.1", "Actual health and root checks pass", AUTHOR)
    assert proposal["kind"] == "app"
    manifest = proposal["manifest"]
    assert manifest["kind"] == "app" and manifest["provides"]["tools"] == []
    assert manifest["egress"] == "none"
    saved = json.loads((store.work_path("ws-template") / "extension-manifest.json").read_text())
    assert saved == manifest
    if template == "static-site":
        assert "entrypoint" not in manifest
    assert "app-check" == workspace.last_run("ws-template")["argv"][0]
