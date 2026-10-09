import main


def test_capabilities_require_auth(client, monkeypatch):
    assert client.get("/capabilities").status_code == 401
    monkeypatch.setattr(main, "DOC_RENDER_SERVICE_TOKEN", "")
    assert client.get("/capabilities").status_code == 503


def test_capabilities_are_static_and_do_not_render(client, auth, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("A readiness query must not render content")
    monkeypatch.setattr(main.renderers, "render_slide_deck", forbidden)
    monkeypatch.setattr(main.renderers, "render_xlsx", forbidden)
    response = client.get("/capabilities", headers=auth)
    assert response.status_code == 200
    assert response.json() == {"version": 1, "formats": ["pdf", "docx", "xlsx", "pptx"], "office": True}
