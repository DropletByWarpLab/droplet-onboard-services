import main


def test_capabilities_require_auth(client, monkeypatch):
    assert client.get("/capabilities").status_code == 401
    monkeypatch.setattr(main, "WEB_FETCH_SERVICE_TOKEN", "")
    assert client.get("/capabilities").status_code == 503


def test_capabilities_never_contact_a_provider_or_return_the_key(client, monkeypatch):
    async def forbidden(*args, **kwargs):
        raise AssertionError("Readiness cannot send an external request")
    monkeypatch.setattr(main.web_content, "search_web", forbidden)
    monkeypatch.setattr(main.web_content, "fetch_page", forbidden)
    monkeypatch.setattr(main.web_content, "BRAVE_SEARCH_API_KEY", "private-provider-key")
    response = client.get("/capabilities", headers={"Authorization": "Bearer pytest-fake-token"})
    assert response.status_code == 200
    assert response.json() == {"version": 1, "fetch": True, "search": True}
    assert "private-provider-key" not in response.text
    monkeypatch.setattr(main.web_content, "BRAVE_SEARCH_API_KEY", "")
    assert client.get("/capabilities", headers={"Authorization": "Bearer pytest-fake-token"}).json()["search"] is False
