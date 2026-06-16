"""Build/runtime helper scripts for voice-io.

Currently houses `fetch_vosk_model` — the SHA-256-pinned, zip-slip-safe
extractor the Dockerfile uses to bundle the Vosk wake-word model. Kept
as an importable package so the supply-chain checks are unit-tested
(`tests/test_fetch_vosk_model.py`) rather than living in an inline
`python -c` one-liner in the Dockerfile.
"""
