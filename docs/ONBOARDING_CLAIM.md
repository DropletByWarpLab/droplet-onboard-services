# Onboarding — appliance claim + hardware contract

> **Status: IMPLEMENTED (PR #373).** Stacks on the #372 setup state machine.
> Relates to WARP-564 (atomic single-use pairing-code claim — same consume
> pattern).

## Purpose

Bind a fresh appliance to its workspace. The customer reads a **claim code off
the PyPortal lid display** and confirms it; the Claim wizard step also shows the
detected hardware. Claim slots **first** in the wizard (welcome → claim →
account, #371 handoff §1) and is **not skippable**.

## Backend contract

- `GET /api/setup/appliance` → hardware contract
  `{ appliance_id, compute, storage, network, display, supply_chain }`
  (`FEATURES.md §9`). **A DOCUMENTED STUB** — `appliance-contract.service.ts`
  assembles it; no orchestrator facility produces this shape end-to-end yet.
  `compute`/`storage`/`display` are placeholders pending their real sources
  (device-bridge inventory, model-readiness, PyPortal service); `network` is
  best-effort enriched from the routing `/system/info` (router-only) and falls
  back cleanly on the single-box shape; `supply_chain` is a static TAA/NDAA-§889
  attestation. PUBLIC (runs before any account exists). The shape is the
  contract; the per-field sources harden in follow-ups.
- `POST /api/setup/claim { code }` → bind the appliance. **Atomic, single-use,
  rate-limited**; the code is **hashed at rest** (keyed HMAC-SHA256 over the
  normalized code) and compared in **constant time**. The consume is a
  conditional `updateMany WHERE state='available'` inside a `$transaction` (the
  WARP-564 pairing-claim pattern). Correct → 200 `{ claimed, next_step }` and
  advance the wizard to `account` (does NOT flip the appliance "ready" — that's
  the #372 finish transition). Already-claimed → 200 short-circuit. Wrong /
  unknown / expired → 400 `CLAIM_CODE_INVALID` (never revealing the real code),
  after decrementing the per-IP rate budget. Budget exhausted → 429.

## Claim-code provisioning — SCOPE

> **Update (WARP-632 / ADR-017):** minting/rotation now lives in the
> **orchestrator**, not the display-service. See
> `docs/ADR-017-claim-code-mint-and-render.md` — the orchestrator mints the
> code, seeds only its hash via `seedClaimCode()`, decides when to show it, and
> pushes it to the PyPortal (`claim` mode); `oled-display` + firmware are thin
> renderers. ADR-017 supersedes the "display-service owns mint/rotate"
> follow-up note that used to live here and below.

This PR (#373) shipped the **verify** half only. A code is hashed at rest via
`hashClaimCode` and verified by `POST /api/setup/claim`; `seedClaimCode()`
materializes the hash idempotently and `ClaimCode.expiresAt` is carried so the
mint owner can expire codes. The mint half — `claim-code.service.ts`
(`generateClaimCode` / `ensureClaimCode`) wired into `screen-qr.service.ts` —
landed in WARP-632 per ADR-017. `CLAIM_CODE` remains a provisioning override
(seed that exact code instead of minting).

## Data model (Prisma)

```prisma
enum ClaimCodeState { available consumed }   // explicit single-use lifecycle

model ClaimCode {
  id        String         @id @default(uuid())
  codeHash  String         @unique  // one-way hash; never plaintext
  state     ClaimCodeState @default(available)  // NOT derived from usedAt
  expiresAt DateTime
  usedAt    DateTime?      // audit-only; written in the consume transaction
  attempts  Int            @default(0)
  createdAt DateTime       @default(now())
  updatedAt DateTime       @updatedAt
}
```

`SetupStep` is also extended with `claim` (additive migration
`20260601000000`, ordered after #372's `20260531000000`; guarded idempotent
`ALTER TYPE … ADD VALUE`).

## Architecture rules (held)

- Rate-limit budget via the shared cache counter (no busy-loop; fails OPEN so a
  down cache can't lock the owner out). Constant-time compare; never echo the
  real code.
- Explicit `state` lifecycle, **not** `usedAt IS NULL` inference for "claimed"
  (CLAUDE.md no-guessing rule; WARP-218 `BrainMemoryItemStatus` precedent).

## Frontend

`components/setup/steps/ClaimStep.tsx` per `OnbWizard.jsx WizClaim` + #371 §2:
WizHead "Step 1" → "We found your Droplet"; appliance card (aurora badge +
mono `appliance_id` + "Detected on LAN" chip + 2×2 spec grid); formatted
claim-code field + PyPortal hint; supply-chain TAA/NDAA §889 chip. Edges:
appliance unreachable → "We can't see your Droplet yet" + retry (continue
blocked); wrong code → inline error; rate-limited → distinct message. Design
tokens only (aurora badge via `aurora-bg`/`aurora-ring` — the login PR's
`.aurora-brand` isn't on this branch).

## Follow-ups

- ~~PyPortal display-service: mint + rotate the claim code, render it on the
  lid.~~ **DONE in WARP-632, but the OWNER changed** — the **orchestrator**
  mints + rotates + decides-when-to-show and pushes to the PyPortal; the
  display-service + firmware are thin renderers. See
  `docs/ADR-017-claim-code-mint-and-render.md`.
- Claim-screen **QR** on the lid: WARP-632 ships text-only (code + setup URL).
  A QR (reusing the existing wifi-QR matrix path) is a clean follow-up.
- Firmware `claim` render is **device-verified** on the physical PyPortal
  (`pyportal/code.py` is CircuitPython, not CI-importable).
- Wire the real per-field sources into `GET /api/setup/appliance`
  (device-bridge drives, model-readiness compute, PyPortal display status,
  device-identity `appliance_id`).

## References

`FEATURES.md §9`; `services/routing/main.py` (`GET /system/info`); WARP-564 PR;
`onboarding-handoff/src/OnbWizard.jsx` (`WizClaim`); `docs/ONBOARDING_STATE_MACHINE.md`.
