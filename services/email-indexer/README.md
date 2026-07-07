# email-indexer

WARP-465 D1 follow-up — Python service that drives IMAP IDLE per
EmailAccount, parses inbound MIME, posts the canonical shape to the
orchestrator, and drains the outbound SMTP queue.

## Responsibilities

- One async IDLE loop per EmailAccount (apscheduler-managed, no
  `while True`). Exponential backoff on disconnect (1s → 60s cap).
- MIME parser canonicalizes each new message into the shape the
  orchestrator's `POST /api/email/:accountId/messages-ingest`
  expects. RFC 5322 thread keying (References > In-Reply-To >
  Message-ID).
- Outbound SMTP poller scans `EmailDraft.status='queued'` every 10s;
  one send per draft via `aiosmtplib`; flips draft status to `sent` /
  `failed` via `PATCH /api/email/drafts/:id/status` on the
  orchestrator.
- MQTT publish on `email/<accountId>/new` after each successful
  ingest so the dashboard's email tabs refresh without polling.

## What this service does NOT do

- Write the email tables directly. All writes go through orchestrator
  endpoints so the schema + business logic stays centralized.
- Decide off-LAN gating. `POST /api/email/drafts/:id/send` (operator
  surface) and outbound SMTP both honor the Phase E `outbound_email`
  channel via the orchestrator.
- Speak to the LLM. Thread summarization happens in the orchestrator's
  `/threads/:id/analysis` endpoint (D2, WARP-466) — this service is a
  pure mail pump.

## Files

| File | Role |
|---|---|
| `main.py` | FastAPI app + lifespan; wires scheduler, IDLE pool, outbound poller. |
| `idle.py` | Per-account IDLE loop with backoff. Pluggable dispatcher for tests. |
| `outbound.py` | SMTP send + MIME assembly. Pure helpers (`build_message`, `envelope_recipients`) exported for testing. |
| `parser.py` | MIME → canonical dict. RFC 5322 thread keying. |
| `backoff.py` | Pure backoff state machine (1s → 60s, GROWTH_FACTOR=2). |
| `creds.py` | Fernet decryption of `EmailAccount.passwordEnc`. Fail-fast on missing key. |
| `db.py` | Read-only asyncpg helpers (account list, queued drafts). |
| `mqtt_bridge.py` | paho-mqtt publish on new mail. Best-effort. |
| `orchestrator_client.py` | httpx wrapper for ingest + status callbacks. |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | (required) | asyncpg pool target. Same as Prisma's. |
| `ORCHESTRATOR_URL` | `http://orchestrator:3000` | Ingest + status callbacks. |
| `ORCHESTRATOR_SERVICE_TOKEN` | (required at runtime) | Service-principal bearer. |
| `EMAIL_KEY_PATH` | `/data/secrets/email.key` | Fernet key path (mode 0600). |
| `MQTT_HOST` / `MQTT_PORT` | `broker` / `8883` | MQTT broker (mTLS listener). |
| `MQTT_TLS` | `1` | Present the service TLS bundle (identity = cert CN, WARP-235). `0` = plaintext dev broker. |
| `OUTBOUND_POLL_SECONDS` | `10` | SMTP poller cadence. |
| `ACCOUNT_REFRESH_SECONDS` | `300` | Account re-discovery cadence. |
| `DROPLET_FIPS_REQUIRED` | `true` | WARP-229 boot self-test. |

## Tests

```
cd services/email-indexer
pytest tests/
```

Coverage:
- `tests/test_parser.py` — MIME parsing (12 cases).
- `tests/test_backoff.py` — geometric growth + cap + reset (5 cases).
- `tests/test_outbound.py` — MIME assembly + envelope recipients (6 cases).
- `tests/test_creds.py` — Fernet round-trip + invalid token (3 cases).

**Production validation requires a test IMAP mailbox** — the IDLE
network plumbing is not exercised by these unit tests. Standard
deploy checklist:

1. Add an EmailAccount via the dashboard with a known-test mailbox.
2. Tail `email-indexer` logs — should see `IDLE session` + `ingest`
   lines within ~10s.
3. Send a test mail; confirm an EmailMessage row lands in postgres
   and `email/<accountId>/new` MQTT fires.
4. Author a draft via the dashboard; click Send; confirm draft flips
   to `sent` and the destination mailbox receives.

## Architecture rules honored

- IMAP IDLE reconnect uses `apscheduler.AsyncIOScheduler` —
  droplet-architecture-guard rule 9 (no `while True`).
- `EmailAccount.passwordEnc` is Fernet ciphertext at rest; only this
  service holds the key.
- Writes go through orchestrator REST (service-principal), never
  directly to postgres — schema/business logic stays centralized.
- One model, no swap — this service does no inference.
