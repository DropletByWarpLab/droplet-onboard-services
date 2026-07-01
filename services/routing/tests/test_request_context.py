import logging
import uuid

from request_context import (
    new_request_id, sanitize_request_id, get_request_id, set_request_id, RequestIdFilter,
)


def test_new_request_id_is_uuid4():
    assert uuid.UUID(new_request_id()).version == 4


def test_sanitize():
    assert sanitize_request_id("abc123_-Z9") == "abc123_-Z9"
    assert sanitize_request_id("short") is None
    assert sanitize_request_id("has space") is None
    assert sanitize_request_id(None) is None


def test_filter_injects():
    f = RequestIdFilter()
    rec = logging.LogRecord("n", logging.INFO, __file__, 1, "m", None, None)
    set_request_id("rid-r-1")
    assert f.filter(rec) is True
    assert rec.request_id == "rid-r-1"
