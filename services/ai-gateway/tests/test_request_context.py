import logging
import re
import uuid

from request_context import (
    new_request_id,
    sanitize_request_id,
    get_request_id,
    set_request_id,
    configure_logging,
    RequestIdFilter,
)


def test_new_request_id_is_uuid4():
    val = new_request_id()
    assert uuid.UUID(val).version == 4


def test_sanitize_accepts_valid_rejects_junk():
    assert sanitize_request_id(new_request_id()) is not None
    assert sanitize_request_id("abc123_-Z9") == "abc123_-Z9"
    assert sanitize_request_id("short") is None
    assert sanitize_request_id("has space") is None
    assert sanitize_request_id("bad\nnl") is None
    assert sanitize_request_id("x" * 65) is None
    assert sanitize_request_id(None) is None


def test_get_set_request_id():
    set_request_id("rid-77")
    assert get_request_id() == "rid-77"


def test_filter_injects_marker_when_unset(caplog):
    # Fresh contextvar state: a new id, then assert the record carries it.
    f = RequestIdFilter()
    record = logging.LogRecord("n", logging.INFO, __file__, 1, "msg", None, None)
    set_request_id("rid-filter-1")
    assert f.filter(record) is True
    assert record.request_id == "rid-filter-1"
