# ADR-017 — Claim-code mint + render (orchestrator owns the lifecycle)

> **Status: Accepted (WARP-632).**
> **Supersedes** the `docs/ONBOARDING_CLAIM.md` follow-up note that assigned
> claim-code mint/rotate to the display-service. That note now points here.
> Relates to PR #373 (the verify half — `setup-claim.service.ts` +
> `POST /api/setup/claim`) and WARP-624 (the orchestrator already owns the
> first-boot PyPortal screen via `screen-qr.service.ts`).

## Context

The onboarding Claim step shipped **verify-only** (PR #373): the orchestrator
verifies a single-use code read off the PyPortal lid, but **nothing mints or
seeds a code**, and the PyPortal had **no claim screen**. So the `ClaimCode`
table is empty on every fresh box, and the **non-skippable** setup step 2
dead-ends — the customer has no code to enter.

PR #373 explicitly deferred minting/rotation to "the PyPortal display-service,
a separate PR." Revisiting that under WARP-632, putting mint/rotate in the
display-service is the wrong owner: the seed is a write to the **orchestrator's
own Prisma DB**, and the orchestrator **already owns** what's on the first-boot
PyPortal screen (`screen-qr.service.ts`). Two owners writing the lid screen
would race.

## Decision

**The orchestrator owns the entire claim-code lifecycle**: mint, seed-hash,
decide-when-to-show, and push to the PyPortal. `oled-display` + the PyPortal
firmware are **thin renderers** (a new `claim` mode).

Rationale:
- **Single owner, no races.** The orchestrator already decides the first-boot
  lid screen via `screen-qr.service.ts`; the claim screen is just the new
  highest-priority branch of that same decision. One pusher.
- **The seed is the orchestrator's write.** `seedClaimCode()` (PR #373) writes
  the hash to the orchestrator's Prisma DB. Minting next to it keeps the hash
  generation and the verify path in one place, so they can't drift.

### Definitions + invariants

- **"claimed"** = a `ClaimCode` row with `state = 'consumed'` exists. Explicit
  `state` column, never inferred from `usedAt IS NULL` (CLAUDE.md no-guessing
  rule; WARP-218 precedent — the same discipline the verify path uses).

- **While NOT claimed**, maintain exactly **one** `available` code:
  - random, from an **unambiguous alphabet** with no `0/O/1/I`
    (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), format **`DRPL-XXXX-XXXX`**,
    crypto-random (`crypto.randomInt`, no modulo bias);
  - hold the **plaintext in memory only** (a module-level memo);
  - persist **only the hash**, via the existing `seedClaimCode()` /
    `hashClaimCode()` so the hash matches verification exactly;
  - on (re)mint, **delete prior `available` rows** (inside the same
    `$transaction` as the new seed) so they never pile up and the previous code
    is invalidated atomically with the new one.

- Because the plaintext is **not persisted**, the code **rotates on each
  unclaimed restart** — acceptable; "rotation invalidates the previous code."
  Within a single process the memo keeps the **same** plaintext across poll
  ticks (we only (re)mint when there is no in-memory plaintext *or* no matching
  `available` row), so the lid doesn't flicker a new code every tick.

- **`CLAIM_CODE` env**, if set, **overrides** minting — seed that exact code.
  The provisioning escape hatch documented in `.env.example`.

### Render path

```
orchestrator screen-qr.service (highest-priority branch)
  → ensureClaimCode(prisma)            # mint + seed (hash only)
  → display.client.pushClaimCode(code, setupUrl())
  → POST /display/claim                # SERVICE_TOKEN_DISPLAY bearer
  → display.py show_claim(code, setup_url)
  → firmware `claim` mode              # large centered code + setup URL
```

This is the dedicated `claim` mode — **NOT** the preview-only
`/display/custom` image path. The claim screen shows the code prominently plus
the setup URL.

### Once claimed

`ensureClaimCode` returns `null`; `screen-qr` stops pushing the claim screen
and **falls through** to the normal carousel (setup-URL / peer / wifi QR),
unchanged.

## Consequences

- Closes the setup dead-end for **every** fresh box.
- **No plaintext at rest** — only the hash is persisted; a DB read/backup can't
  recover a live code.
- The code **rotates on an unclaimed reboot** (plaintext is memory-only).
- The verify path (`POST /api/setup/claim`) is **unchanged** — the minted code
  verifies because the seeded hash comes from the same `hashClaimCode`.
- The **firmware render is device-verified** later: `pyportal/code.py` is
  CircuitPython and not CI-importable. The orchestrator + `display.py` halves
  are fully unit-tested.
- **QR on the lid is omitted** (text-only code + setup URL) — the code is short
  and meant to be typed; a QR is a clean follow-up (could reuse the existing
  wifi-QR matrix path).
  - *Follow-up landed* (design-handoff claim redesign): the claim screen now
    carries a scan QR via exactly that matrix path — the display service
    encodes `<setup_url>?c=<CODE>` host-side into a `setup_qr_matrix` claim
    frame key (or shows the WARP-819 Wi-Fi join QR instead when creds are
    pushed; at most one matrix per frame), and the dashboard's ClaimStep
    prefills the code from the `c` query param. The orchestrator's
    mint/verify contract above is unchanged.

## Alternatives considered

- **Display-service owns mint/rotate** (the original PR #373 follow-up plan):
  rejected — it would put a second writer on the lid screen (racing
  `screen-qr.service.ts`) and split hash generation away from the Prisma DB +
  verify path. ADR-017 supersedes that note.
- **Persist the plaintext** (so the code survives reboots): rejected — keeping
  plaintext at rest is exactly the posture PR #373 avoided; memory-only +
  rotate-on-reboot is the safer trade and "rotation invalidates the previous
  code" is acceptable for a setup-time code.

## References

- `docs/ONBOARDING_CLAIM.md` (verify half + the now-superseded follow-up note)
- `apps/orchestrator/src/services/claim-code.service.ts` (mint/seed)
- `apps/orchestrator/src/services/setup-claim.service.ts` (verify; hash helpers)
- `apps/orchestrator/src/services/screen-qr.service.ts` (decide + push)
- `apps/orchestrator/src/services/display.client.ts` (`pushClaimCode`)
- `services/oled-display/main.py` (`POST /display/claim`)
- `services/oled-display/display.py` (`show_claim` / `render_claim`)
- `services/oled-display/pyportal/code.py` (firmware `claim` mode)
- WARP-218 (explicit-state precedent), WARP-564 (atomic claim consume),
  WARP-624 (orchestrator owns the first-boot lid screen)
