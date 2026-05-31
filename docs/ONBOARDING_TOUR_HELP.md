# Onboarding — Tour, Help search, Health (scaffold)

> **Status: DRAFT scaffold — no implementation in this PR.** Refs WARP-___.

## Purpose

The post-setup **product tour**, the persistent **Help** panel/search, and the
aggregated **/health** the help footer reads. Mostly client-side anchors + three
small backends. UI source: `onboarding-handoff/src/OnbTourHelp.jsx`.

## Backend contract

### Tour
- `POST /me/tour { completed: true }` → per-user flag so the tour shows once and
  is **replayable from Help**. Spotlight targets are client-side anchors (no API).
- Add `User.tourCompletedAt` (explicit column, not `IS NULL`).

### Help search
- `GET /help/search?q=` → semantic search over **locally shipped** help articles,
  indexed in the same embedding store used by Files/chat (reuse the file-indexer +
  ai-gateway `EmbedText`; `nomic-embed-text`/sentence-transformers). Articles ship
  on the box. "Ask Droplet AI" routes the query into on-device chat.

### Health
- `GET /health` aggregated across services (routing, ai-gateway, file-indexer,
  camera-discovery, …) → green only when **all** report up. Extend the per-service
  `/health` pattern (`services/pm/main.py`, `services/routing/main.py`).

## Architecture rules

- Reuse the existing embedding index — do not stand up a second vector store.
- No `while True` for any poller; use the schedulers.
- Tour state is an explicit timestamp column.

## Dependencies

Tour blocked by setup state machine (`user_tour_completed` in `/setup/state`).
Help search depends on the existing file-indexer/embeddings. Health is standalone.

## Acceptance criteria

- Tour shows once, replayable from Help; flag persists per user.
- `/help/search` returns ranked local articles; offline-only.
- `/health` reflects real per-service status; footer turns green only when all up.

## References

`onboarding-handoff/src/OnbTourHelp.jsx`; `apps/web-dashboard/src/components/help/`
(`WizardReplay.tsx`, `/help` page); `services/file-indexer/`, `services/ai-gateway/`;
`services/pm/main.py`; `FEATURES.md §10`.
