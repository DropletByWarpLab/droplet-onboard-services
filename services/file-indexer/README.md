# file-indexer

Filesystem indexer + embedder for Droplet's RAG pipeline. Watches the
Nextcloud admin user-files dir and the brain-memory volume, dispatches
each file through MIME-routed extractors (PDF / DOCX / image OCR /
text/code/HTML), chunks the extracted text, calls ai-gateway for
embeddings, and writes `FileContentChunk` rows into the orchestrator
DB.

This service replaces the older `file-sync` service — the rename
reflects that it indexes + embeds, not "syncs" anything.

## Layout

```
extractors/       MIME-routed text extractors (registry.py dispatches)
brain_ingest.py   Per-user brain-memory ingest (chat-attached files)
chunker.py        Token-aware chunking
embedder.py       gRPC client to ai-gateway's embed endpoint
db.py             Prisma-shaped raw inserts into FileContentChunk
mqtt_client.py    Status events to broker (chip updates in dashboard)
watcher.py        watchdog observer wired to extractors.dispatch
```

## Local unit tests

```bash
cd services/file-indexer
python -m pytest -v
```

Tests skip gracefully if Tesseract isn't installed locally — CI
installs it via the Dockerfile's `apt-get install tesseract-ocr`.

## Integration testing

The full RAG path (extractors → embeddings → pgvector → MCP retrieval
→ chat citations) is covered by the integration suite at the repo
root, not here. See **[`docs/RAG_TESTING.md`](../../docs/RAG_TESTING.md)**
for what each test covers, how to run them locally, and how to read
failure modes.

Quick start:

```bash
# From repo root:
./scripts/test-rag.sh            # full suite
./scripts/test-rag.sh --only extractors  # just the extractor lane
```
