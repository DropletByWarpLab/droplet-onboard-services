"""WARP-214: db.upsert_chunk persists the optional metadata jsonb column."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch


def test_upsert_chunk_writes_metadata_when_provided():
    """When metadata is a dict, it's serialized as JSON and bound to the INSERT."""
    fake_conn = MagicMock()
    fake_cursor = MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor

    with patch("db.get_conn", return_value=fake_conn):
        from db import upsert_chunk

        upsert_chunk(
            user_id="alice",
            nc_file_id=42,
            path="/foo/bar.zip",
            chunk_idx=0,
            text="hello",
            embedding=[0.0] * 384,
            source="brain",
            brain_item_id="bmi-abc",
            page_number=None,
            warnings=[],
            metadata={"chain": [{"filename": "bar.zip", "mime": "application/zip"}]},
        )

    # Inspect the SQL execute call. The SQL must include 'metadata',
    # and the bound value at the metadata position is the JSON string or dict.
    sql = fake_cursor.execute.call_args[0][0]
    binds = fake_cursor.execute.call_args[0][1]
    assert '"metadata"' in sql
    expected = {"chain": [{"filename": "bar.zip", "mime": "application/zip"}]}
    metadata_in_binds = any(
        b == expected
        or (isinstance(b, str) and b == json.dumps(expected))
        for b in binds
    )
    assert metadata_in_binds, f"metadata not bound: binds={binds}"


def test_upsert_chunk_writes_null_metadata_when_omitted():
    """When metadata is None, the SQL still references metadata but bound value is None."""
    fake_conn = MagicMock()
    fake_cursor = MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor

    with patch("db.get_conn", return_value=fake_conn):
        from db import upsert_chunk

        upsert_chunk(
            user_id="alice",
            nc_file_id=42,
            path="/foo/bar.txt",
            chunk_idx=0,
            text="hello",
            embedding=[0.0] * 384,
            source="nextcloud",
            brain_item_id=None,
            page_number=None,
            warnings=[],
            metadata=None,
        )

    sql = fake_cursor.execute.call_args[0][0]
    binds = fake_cursor.execute.call_args[0][1]
    # SQL still references the column (so existing rows can be updated),
    # but the bound value is None.
    assert '"metadata"' in sql
    # None should be in binds
    assert None in binds
