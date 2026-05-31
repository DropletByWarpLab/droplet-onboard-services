# Onboarding — appliance claim + hardware contract (scaffold)

> **Status: DRAFT scaffold — no implementation in this PR.** Refs WARP-___.
> Relates to WARP-564 (atomic single-use pairing-code claim).

## Purpose

Bind a fresh appliance to its workspace. The customer reads a **claim code off
the PyPortal lid display** and confirms it; the Claim wizard step also shows the
detected hardware.

## Backend contract

- `GET /setup/appliance` → hardware contract (`FEATURES.md §9`):
  `{ appliance_id, compute, storage, network, display, supply_chain }`. **Read
  whatever the live box reports** — do not hardcode the handoff's fixed spec list.
- `POST /setup/claim { code }` → bind appliance to workspace. **Atomic, single-
  use, rate-limited**; the code **rotates**. (Reuse the WARP-564 pairing-claim
  pattern.)

## PyPortal claim-code render

- Adafruit PyPortal, USB vendor `239a`. A small display service renders the live
  rotating code on the lid. Likely lives near `services/oled-display/` (confirm)
  — **not** a hand-rolled script that bypasses `setup.sh`.

## Data model (Prisma)

```prisma
model ClaimCode {
  id        String   @id @default(uuid())
  codeHash  String   // store hashed; never plaintext
  expiresAt DateTime
  usedAt    DateTime?
  attempts  Int      @default(0)
}
```

## Architecture rules

- Rate-limit + lockout on `attempts`; constant-time compare; never echo the real code.
- Explicit `usedAt`/state, not `IS NULL` inference for "claimed".

## Dependencies

Blocked by: setup state machine. Pairs with: org/owner (claim → account → org).

## Acceptance criteria

- Wrong code decrements budget + inline error; correct code binds once and is idempotent on re-run.
- Hardware card renders from `GET /setup/appliance`.
- PyPortal shows the rotating code; rotation invalidates the previous.

## References

`FEATURES.md §9`; `services/routing/main.py` (`GET /system/info`); WARP-564 PR;
`onboarding-handoff/src/OnbWizard.jsx` (`WizClaim`).
