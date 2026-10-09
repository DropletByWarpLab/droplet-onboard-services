import asyncio
import json
import socket

import httpx
import pytest

import web_content as web
from .conftest import AUTH


def response(text="hello", *, status=200, headers=None):
    body = text.encode() if isinstance(text, str) else text
    return httpx.Response(status, headers={"Content-Type": "text/html", **(headers or {})}, stream=httpx.ByteStream(body))


@pytest.fixture
def boundary(monkeypatch):
    calls = []
    def install(handler):
        async def dns(host):
            calls.append(("dns", host))
            if host == "private.example":
                raise web.WebError("blocked_destination")
            return "93.184.215.14"
        monkeypatch.setattr(web, "resolve_public", dns)
        def request_handler(req):
            calls.append(("http", req))
            return handler(req)
        monkeypatch.setattr(web, "create_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(request_handler)))
        return calls
    return install


@pytest.mark.parametrize("url", ["http://example.com", "https://example.com:8080", "https://user:pass@example.com", "https://localhost", "https://router.local", "https://192.168.1.1", "https://127.0.0.1", "https://169.254.169.254/latest/meta-data", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://example.com\\@localhost", "https://example.com/?token=abcdef", "https://example.com/?q=alice%40example.com", "https://example.com/%0aHeader"])
def test_bad_urls_never_connect(client, boundary, url):
    calls = boundary(lambda _: pytest.fail("HTTP must not happen"))
    result = client.post("/fetch", json={"url": url}, headers=AUTH)
    assert result.status_code == 400
    assert not calls


@pytest.mark.parametrize("ip", ["0.0.0.0", "127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "192.0.2.1", "::", "::1", "fe80::1", "fd00::1", "::ffff:8.8.8.8", "2002:0808:0808::1", "64:ff9b::a00:1"])
def test_non_public_and_transition_addresses(ip):
    assert not web.public_ip(ip)


@pytest.mark.asyncio
async def test_dns_checks_every_answer(monkeypatch):
    async def lookup(*args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ("8.8.8.8", "127.0.0.1")]
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", lookup)
    with pytest.raises(web.WebError, match="blocked_destination"):
        await web.resolve_public("mixed.example")


def test_page_pins_checked_ip_keeps_tls_hostname_and_strips_active_content(client, boundary):
    calls = boundary(lambda _: response('<html><title>A source</title><nav>menu</nav><main><h1>Evidence</h1><p>Clear text &amp; more.</p><script>steal()</script><style>hidden</style><div hidden>secret</div><iframe>bad</iframe></main></html>'))
    result = client.post("/fetch", json={"url": "https://example.com/article#section"}, headers=AUTH)
    assert result.status_code == 200
    data = result.json()
    assert data["title"] == "A source"
    assert "Clear text & more." in data["text"]
    assert all(word not in data["text"] for word in ["steal", "hidden", "secret", "menu", "bad"])
    assert data["url"] == "https://example.com/article"
    assert data["trust"] == "untrusted_web" and len(data["sourceId"]) == 16
    req = calls[1][1]
    assert req.url.host == "93.184.215.14" and req.headers["host"] == "example.com"
    assert req.extensions["sni_hostname"] == "example.com"
    assert "authorization" not in req.headers and "cookie" not in req.headers


def test_redirect_rechecks_dns_and_refuses_lan(client, boundary):
    calls = boundary(lambda _: response(status=302, headers={"location": "https://private.example/"}))
    result = client.post("/fetch", json={"url": "https://example.com"}, headers=AUTH)
    assert result.status_code == 400 and result.json()["detail"] == "blocked_destination"
    assert len([c for c in calls if c[0] == "http"]) == 1


def test_redirect_count_bounded(client, boundary):
    calls = boundary(lambda _: response(status=302, headers={"location": "/again"}))
    result = client.post("/fetch", json={"url": "https://example.com"}, headers=AUTH)
    assert result.status_code == 502 and result.json()["detail"] == "redirect_limit"
    assert len([c for c in calls if c[0] == "http"]) == 4


@pytest.mark.parametrize("location", ["/next", "https://other.example/next"])
def test_redirect_never_replays_server_cookies(client, boundary, location):
    calls = []

    def handler(req):
        calls.append(req)
        if len(calls) == 1:
            return response(status=302, headers={"location": location, "set-cookie": "tracking=private; Path=/; Secure"})
        return response("Public evidence")

    boundary(handler)
    result = client.post("/fetch", json={"url": "https://example.com/start"}, headers=AUTH)
    assert result.status_code == 200
    assert len(calls) == 2
    assert all("cookie" not in req.headers for req in calls)


@pytest.mark.parametrize("headers,code,status", [({"Content-Type": "application/pdf"}, "unsupported_content_type", 400), ({"Content-Encoding": "gzip"}, "unsupported_content_encoding", 400), ({"Content-Length": "524289"}, "response_too_large", 413)])
def test_response_headers_fail_closed(client, boundary, headers, code, status):
    boundary(lambda _: response(headers=headers))
    result = client.post("/fetch", json={"url": "https://example.com"}, headers=AUTH)
    assert result.status_code == status and result.json()["detail"] == code


def test_stream_limit_without_content_length(client, boundary):
    boundary(lambda _: response("x" * 1025))
    result = client.post("/fetch", json={"url": "https://example.com", "maxBytes": 1024}, headers=AUTH)
    assert result.status_code == 413


def test_extraction_truncation_is_explicit_and_credentials_redacted(client, boundary):
    boundary(lambda _: response("<p>password=verysecretvalue</p><p>" + "x" * 25000 + "</p>"))
    data = client.post("/fetch", json={"url": "https://example.com"}, headers=AUTH).json()
    assert len(data["text"]) == 24000 and data["truncated"] is True
    assert "verysecretvalue" not in data["text"]


@pytest.mark.parametrize("path", ["fetch", "search"])
def test_new_routes_need_service_auth(client, path):
    result = client.post("/" + path, json={"url": "https://example.com"} if path == "fetch" else {"query": "public data"})
    assert result.status_code == 401


@pytest.mark.parametrize("payload", [{"query": "alice@example.com"}, {"query": "token=veryprivate"}, {"query": "MRN: 123456"}, {"query": "word " * 76}])
def test_search_screens_before_key_or_http(client, boundary, monkeypatch, payload):
    monkeypatch.setattr(web, "BRAVE_SEARCH_API_KEY", "fake-provider-key")
    calls = boundary(lambda _: pytest.fail("must not dial"))
    assert client.post("/search", json=payload, headers=AUTH).status_code == 400
    assert not calls


def test_search_key_missing_is_named_closed_failure(client, boundary, monkeypatch):
    monkeypatch.setattr(web, "BRAVE_SEARCH_API_KEY", "")
    calls = boundary(lambda _: pytest.fail("must not dial"))
    result = client.post("/search", json={"query": "public research"}, headers=AUTH)
    assert result.status_code == 503 and result.json()["detail"] == "search_not_configured"
    assert not calls


def test_search_normalized_metadata_and_unsafe_result_filter(client, boundary, monkeypatch):
    monkeypatch.setattr(web, "BRAVE_SEARCH_API_KEY", "fake-provider-key")
    calls = boundary(lambda _: response(json.dumps({"web": {"results": [{"url": "https://example.com/source", "title": "<b>Source</b>", "description": "<p>Facts</p><script>do bad things</script>", "age": "2026-10-01"}, {"url": "https://127.0.0.1/secret", "title": "bad", "description": "bad"}]}}), headers={"Content-Type": "application/json"}))
    result = client.post("/search", json={"query": "public research", "count": 2}, headers=AUTH)
    assert result.status_code == 200
    data = result.json()
    assert data["provider"] == "brave" and data["skipped"] == 1
    assert data["results"][0]["title"] == "Source" and data["results"][0]["snippet"] == "Facts"
    req = calls[1][1]
    assert req.headers["X-Subscription-Token"] == "fake-provider-key"
    assert req.headers["Host"] == "api.search.brave.com" and req.url.params["q"] == "public research"


def test_search_never_forwards_key_on_provider_redirect(client, boundary, monkeypatch):
    monkeypatch.setattr(web, "BRAVE_SEARCH_API_KEY", "fake-provider-key")
    calls = boundary(lambda _: response(status=302, headers={"location": "https://example.com/steal"}))
    assert client.post("/search", json={"query": "public research"}, headers=AUTH).status_code == 502
    assert len([c for c in calls if c[0] == "http"]) == 1


def test_literal_percentage_search_supported(client, boundary, monkeypatch):
    monkeypatch.setattr(web, "BRAVE_SEARCH_API_KEY", "fake-provider-key")
    boundary(lambda _: response('{"web":{"results":[]}}', headers={"Content-Type": "application/json"}))
    assert client.post("/search", json={"query": "inflation forecast 5%"}, headers=AUTH).status_code == 200


def test_deeply_encoded_private_data_refused():
    with pytest.raises(web.WebError, match="invalid_input"):
        web.screen_outbound("alice%2525252540example.com")


def test_upstream_timeout_is_structured(client, boundary):
    def timeout(req):
        raise httpx.ReadTimeout("error could contain secret URL", request=req)
    boundary(timeout)
    result = client.post("/fetch", json={"url": "https://example.com"}, headers=AUTH)
    assert result.status_code == 502 and result.json()["detail"] == "upstream_unavailable"


@pytest.mark.parametrize("route,payload", [("fetch", {"url": "https://example.com", "maxBytes": True}), ("search", {"query": "hello", "count": True}), ("fetch", {"url": "https://example.com", "extra": "bad"})])
def test_strict_schema(client, route, payload):
    assert client.post("/" + route, json=payload, headers=AUTH).status_code == 422
