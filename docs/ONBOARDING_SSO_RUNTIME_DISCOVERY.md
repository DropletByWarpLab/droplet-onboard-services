# Onboarding — runtime SSO provider discovery (local-first)

> **Status: SPEC (WARP-629).** Refs ADR-013 and [`ONBOARDING_SSO_OIDC.md`](ONBOARDING_SSO_OIDC.md).
> Makes the Aurora login **local-first, SSO optional**: each appliance advertises
> only the identity providers it has actually configured, instead of a fixed
> build-time set baked identically into every image.

## Problem

The login SSO buttons (Continue with Google / Microsoft / Okta) are gated by a
**build-time constant** — `ONB_SSO_PROVIDERS_LIVE` in
`apps/web-dashboard/src/components/auth/flags.ts`, hardcoded
`{ google: true, entra: true, okta: true }` and identical on every image.

But a provider is only *usable* when its four
`DROPLET_SSO_<P>_{ISSUER,CLIENT_ID,CLIENT_SECRET,REDIRECT_URI}` env vars are set
(`config.ts`). `getOidcProviderConfig` fails closed otherwise, and
`POST /api/sso/oidc/authorize` returns `400 SSO_PROVIDER_NOT_CONFIGURED`
(`routes/sso.ts`). The two gates are **decoupled**: the front end never consults
what the box has configured, so an appliance with no SSO env still shows three
"live" buttons that **400 on click**. (The claim in `ONBOARDING_SSO_OIDC.md` that
an unconfigured provider "stays the disabled Soon pill" is therefore wrong — the
button is rendered live by the static flag and only fails at the backend.)

## Design

Single source of truth for "which SSO buttons this box shows" = what the
orchestrator actually has configured, read at runtime. The backend already
computes it (`enabledSsoProviders()`, `services/sso-oidc.service.ts`); expose it
and let the login page render from it.

### Backend — public discovery endpoint

`GET /api/sso/oidc/providers`, added to `apps/orchestrator/src/routes/sso.ts`,
mounted on the **PUBLIC** router (before `authMiddleware` — the login page has no
session yet, exactly like `/authorize` and `/callback`).

```http
GET /api/sso/oidc/providers  →  200 { "providers": ["google"] }   // or []
```

- Body is `enabledSsoProviders()` — **provider IDs only**. Never issuer,
  client-id, client-secret, or redirect URI. Nothing sensitive crosses the wire
  (the IDs are the same information the rendered buttons already reveal).
- `Cache-Control: no-store` — provider config can change (an operator edits
  `.env` + restarts) without a dashboard rebuild, so the answer must not be
  cached stale.
- No `prisma` dependency: discovery reads env config only, so it answers even if
  the directory is mid-migration.

### Frontend — render from discovery, not the flag

In `apps/web-dashboard/src/app/login/page.tsx`, mirror the existing passkey
capability pattern (`useEffect` → `setPasskeyReady`):

```ts
const [ssoProviders, setSsoProviders] = useState<string[]>([]);
useEffect(() => {
  let alive = true;
  getEnabledSsoProviders()                       // new lib/api.ts helper
    .then((p) => { if (alive) setSsoProviders(p); })
    .catch(() => { /* local-first: ignore, password login stands alone */ });
  return () => { alive = false; };
}, []);
```

Pass `ssoProviders` to `SignInForm`, which renders a live `SsoProviderButton` for
each returned provider (in the canonical order google → entra → okta) and
**nothing** for the rest. Remove the `ONB_SSO_PROVIDERS_LIVE` gating and the SSO
`ComingSoon` pill entirely. An empty list → no SSO block and no
"OR USE YOUR DIRECTORY ACCOUNT" divider.

### Local-first invariant

The email/password form renders **immediately** and works regardless of the
discovery request — including when it errors, times out, or the box is offline.
SSO is purely additive. Directory password login (ADR-013, argon2id) remains the
self-contained, air-gap-safe default and the source of truth.

## Privacy

The login footer — "Sign-in happens on your local network — nothing leaves the
box" (`login/page.tsx`) — is true for the password path but not for an SSO
sign-in (which federates to an external IdP). Keep it accurate: scope the line to
the password path, or caveat it when any SSO button is shown.

## Acceptance criteria

- `GET /api/sso/oidc/providers` is reachable without a session and returns
  `{ providers }` = only fully-configured providers; payload carries no secrets.
- No `DROPLET_SSO_*` set → login is password-only (no SSO buttons, no divider).
- Google configured → live "Continue with Google" that starts the real flow (no
  400); no Microsoft/Okta button.
- No code path renders a disabled "Soon" pill for SSO, and no SSO button can POST
  to an unconfigured provider.
- Password login renders and works even if discovery fails/times out.
- `ONB_SSO_PROVIDERS_LIVE` removed (or clearly repurposed); this doc +
  `ONBOARDING_SSO_OIDC.md` reflect runtime discovery.
- `tsc` clean; existing auth/login tests stay green; new tests below pass.

## Test plan

**Orchestrator** (`routes/sso.test.ts` or a sibling):
- env none → `GET /providers` ⇒ `{ providers: [] }`.
- env google complete → ⇒ `{ providers: ["google"] }`.
- partial google env (missing secret) → provider omitted (fails closed).
- response contains no `*_CLIENT_SECRET` / issuer / client-id value.
- route resolves without an auth cookie.

**Dashboard** (`login.aurora.test.tsx` / `SignInForm.test.tsx`):
- discovery `[]` → no SSO buttons, no divider, password form present.
- discovery `["google"]` → one live Google button that POSTs to
  `/api/sso/oidc/authorize`; no Soon pill; no Microsoft/Okta.
- discovery rejects → password login still renders and submits.

## Out of scope

- A Settings / Setup-wizard step that writes `DROPLET_SSO_*` into `.env`
  (follow-up). Secrets stay in `.env` per the "secrets flow only through .env"
  ADR and the SSO design (no `SsoConnection` DB model).
- Hostname / HTTPS / cert work for Google's redirect URI (Google rejects raw
  IPs) and the LAN-mirror / air-gap path (already deferred in
  `ONBOARDING_SSO_OIDC.md`).
- Deploying current `main` to the box at `192.168.1.87` (separate op).

## References

ADR-013; PRs #378 (Google/Entra), #396 (Okta + SCIM);
[`ONBOARDING_SSO_OIDC.md`](ONBOARDING_SSO_OIDC.md);
`apps/orchestrator/src/routes/sso.ts`,
`apps/orchestrator/src/services/sso-oidc.service.ts`,
`apps/web-dashboard/src/components/auth/{flags.ts,SignInForm.tsx}`,
`apps/web-dashboard/src/app/login/page.tsx`.
