"""WARP-242 — wrapped per-document DEK persistence (Python twin of
apps/orchestrator/src/services/document-key.service.ts).

The file-indexer is the MINTER: a document's DEK is generated at its first
chunk-write (brain_ingest / transcription_worker / reindex_one) and stored
wrapped under the doc-KEK in DocumentEncryptionKey, keyed (keyId, version).
Until DEK rotation lands every keyId has exactly version 1; readers take the
latest version. Crypto-shredding (deleting the rows) is the orchestrator's
delete flow — this module never deletes.
"""

from __future__ import annotations

import column_crypto
import config
import db

_kek: bytes | None = None


def _get_kek() -> bytes:
    """Load + derive the doc-KEK once per process. Raises (fails closed)
    when the keyfile is missing — brain indexing must never silently fall
    back to writing plaintext chunks. Reads config.DOC_KEK_PATH at call
    time so tests can monkeypatch the path."""
    global _kek
    if _kek is None:
        _kek = column_crypto.load_doc_kek(config.DOC_KEK_PATH)
    return _kek


def get_or_create_dek(key_id: str) -> bytes:
    """Return the latest-version DEK for ``key_id``, minting version 1 at
    first chunk-write. Concurrency-safe via ON CONFLICT DO NOTHING +
    re-read (two writers race benignly to the same row).

    IDX-01: runs on the shared module connection under ``db._db_lock`` —
    same discipline as every other helper touching ``db.get_conn()``.
    """
    kek = _get_kek()
    select_sql = (
        'SELECT "wrappedDek" FROM "DocumentEncryptionKey" '
        'WHERE "keyId" = %s ORDER BY "version" DESC LIMIT 1'
    )
    with db._db_lock, db.get_conn().cursor() as cur:
        cur.execute(select_sql, (key_id,))
        row = cur.fetchone()
        if row is not None:
            return column_crypto.unwrap_dek(kek, row[0], key_id)
        dek = column_crypto.generate_dek()
        cur.execute(
            'INSERT INTO "DocumentEncryptionKey" ("keyId", "version", "wrappedDek") '
            "VALUES (%s, 1, %s) ON CONFLICT (\"keyId\", \"version\") DO NOTHING",
            (key_id, column_crypto.wrap_dek(kek, dek, key_id)),
        )
        # A concurrent minter may have won the PK race — the stored row is
        # canonical either way.
        cur.execute(select_sql, (key_id,))
        row = cur.fetchone()
        if row is None:  # pragma: no cover - insert+select on one conn
            raise RuntimeError(f"doc_keys: mint race lost AND no row for {key_id}")
        return column_crypto.unwrap_dek(kek, row[0], key_id)


def reset_for_tests() -> None:
    """Drop the cached KEK so tests can repoint DOC_KEK_PATH."""
    global _kek
    _kek = None
