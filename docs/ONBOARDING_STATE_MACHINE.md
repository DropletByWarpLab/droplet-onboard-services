# Onboarding — first-run state machine

The implemented wizard resumes from the singleton `ApplianceSetup` row,
independently of Nextcloud installation status. `AuthGate` consumes
`GET /api/setup/state`; `GET /api/auth/setup` reports whether a local owner
still needs to be created. These are separate questions.

## Current sequence

```text
welcome → claim → account → org → twofactor → wifi → address → storage
        → discovery → cameras → vpn → ai → voice → accounts → team → done
```

Accounts offers optional Google mail/calendar and Microsoft work or school
connections. Provider consent connects services; it does not replace local
Droplet sign-in. Continuing or skipping proceeds to team setup. Existing
appliances at `team` or `done` retain their position.

## Persisted state

The lifecycle has two explicit values: `unclaimed` while setup is unfinished,
and `ready` once the owner finishes. Physical device claim is separate; a
claimed device remains `unclaimed` in this lifecycle until setup finishes.

Persisted steps, in authoritative wizard order:

```text
welcome claim account org internet storage discovery cameras vpn ai accounts team done
```

The additive database migration does not change existing rows. The service's
ordered `SETUP_STEPS` tuple governs comparisons, not database enum order.
`twofactor` is client-only; `wifi` and `address` persist as `internet`; `voice`
persists as `ai`. Refreshing those presentation steps resumes at the preceding
persisted step. Accounts is durable because provider consent leaves the page.

Wizard and workspace writes advance monotonically using a serializable
transaction with bounded conflict retries. Back/rail navigation never lowers
progress. A delayed earlier write cannot displace `team` or terminal `done`.
The exception is a legacy late pointer without an owner: the next legitimate
claim/account write repairs it durably before owner creation.

## HTTP and session contract

- `GET /api/setup/state` returns `{ appliance, setup_step, user_tour_completed }`
  without writing. Before a row exists it returns the welcome baseline. Legacy
  unfinished rows that point past account creation without a local owner resume
  at `claim` or, for an already claimed device, `account`.
- `PATCH /api/setup/state { setup_step }` validates step membership and advances
  the resume position. Anonymous first-run progress is limited to `welcome`,
  `claim`, and `account`. Later steps and all completed-appliance writes require
  a live owner session, including revocation and denylist checks.
- `POST /api/setup/org` requires that owner session before saving the workspace
  and advancing progress. Unauthorized mixed progress requests fail before any
  state transition.
- `PATCH /api/setup/state { appliance: "ready" }` requires a live owner session,
  including revocation and denylist checks before first-run finishes. Existing
  user rows never authorize anonymous completion. The transition lands on
  `done` and is idempotent.
- `PATCH /api/setup/state { user_tour_completed: true }` records the tour
  separately. Done owns the flourish and embedded tour; refreshing Done does
  not restart setup.
- Claimed-device and serializable first-owner checks prevent creating another
  owner. The owner account auto-signs in before authenticated steps mount.

A cold refresh after account creation waits for the session probe. An expired
session renders a sign-in-only AccountStep with authenticator/recovery support.
Signing in restores the saved step without creating another owner or resetting
progress. Two-factor verification freezes wizard navigation until its recovery
codes arrive, so enabling it cannot strand codes in an unmounted component.
Protected workspace, consent-progress, finish, and tour writes renew an expired
access cookie through the normal refresh flow before retrying. Authentication
failures return 401; an authenticated caller without the required role gets 403.

## Provider handoff

Accounts reuses the Settings cards and one-time registration. Before leaving,
it awaits a successful progress PATCH; failure leaves a retryable error.
Skipping during an in-flight save/start suppresses navigation from that card.

Google and Microsoft store an allowlisted local `returnTo` inside encrypted
pending consent state. Settings retains `/settings`; onboarding uses
`/setup?step=accounts`. The callback selects this stored destination only after
browser cookie and state match, and preserves it for success, denial, expiry,
and provider failure. Arbitrary URLs are rejected.

The query hint can reopen accounts only if already reached and setup has not
finished. It preserves furthest progress, cannot bypass owner creation, and
is consumed once. Provider outcome parameters remain available to their card.
Registration guides open a separate tab, and `/help` descendants remain
reachable during setup.

## Current limits and release checks

Provider apps need the exact callback URI displayed in Account connection
setup. Google hostname/verification and Microsoft tenant consent rules still
apply. See [Google's authorization guide](https://developers.google.com/identity/protocols/oauth2/web-server)
and [Microsoft's authorization guide](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
Keep provider secrets and tokens out of browser responses and tracked files.

Local tests cover claim, owner creation, workspace, invitation delivery,
monotonic resume, expired sessions, completion, consent outcomes, and existing
network/storage/discovery/AI/voice screens. Live appliance checks must also
exercise real consent, first mail/calendar sync, network hardware, storage,
cameras, voice I/O and reboot recovery. Mocked tests and previews do not
certify those device integrations.

`REQUIRE_ADMIN_TWO_STEP=true` is documented as unsupported by the dashboard's
current enrollment policy. This change does not claim that mode works.

## Source of truth

- `apps/orchestrator/src/services/setup.service.ts`
- `apps/orchestrator/src/routes/setup.ts`
- `apps/web-dashboard/src/components/setup/wizard-steps.ts`
- `apps/web-dashboard/src/app/setup/page.tsx`
- `apps/web-dashboard/src/components/AuthGate.tsx`
