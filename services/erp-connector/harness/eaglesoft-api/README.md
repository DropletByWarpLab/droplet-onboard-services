# Dummy Eaglesoft REST API box

A synthetic stand-in for the Patterson **Innovation Connection** API — the
ASP.NET Web-API-2 service a real Eaglesoft box serves on HTTPS **:9888** — so
`EaglesoftApiConnector` can be driven **end-to-end over a real TLS socket**
without a dental office, a live box, a Patterson vendor enrollment, or one byte
of PHI.

> ⚠ **Test harness only.** Never add this to `docker/docker-compose.yml`. It
> accepts dev credentials and exposes a `/__control/*` plane that makes it fail
> on demand.

## Why this exists

The API track's HTTP machinery (`api-auth.ts`, `api-connector.ts`,
`api-dto.ts`) is real, working code — it is blocked in production only because
two things are missing: the discovered route contract and the vendor
credentials. Both are injectable. So unlike the direct-SQL track, this one
**can** be proven against a live server today, and this is that server.

The failures an install actually hits are transport failures: a certificate
that doesn't verify, a session token the box stopped honouring, a slow response
that outlives the timeout, an IIS error page where JSON was promised, a dropped
connection. A mocked `fetch` cannot produce any of them. This can, and
[`__tests__/api-connector.live.test.ts`](../../__tests__/api-connector.live.test.ts)
asserts the connector survives every one.

## What it is (and is not) faithful to

| Faithful to | Deliberately not |
|---|---|
| the `Authenticate` → session-token → `Authorization` header handshake | **Patterson's real route templates or field names** |
| Web-API-2 response conventions (PascalCase, envelope objects, 401/404/405 semantics) | the real `/help` page's HTML |
| a `/help` discovery page — the same place an installer reads the contract from | Patterson's error-body schema |
| the optimistic-concurrency guard on the one v1 write (409 on a guard miss) | any real practice data |
| TLS against a private CA, mirroring Patterson's `PdcoTechCA` | Patterson's actual certificate chain |

The verbs, templates, and field names in [`fixture.mjs`](fixture.mjs) are
**synthetic stand-ins**. The real ones are compiled `[Route]`/DTO attributes
inside `Patterson.Eaglesoft.Api.Server.dll` and must be **discovered per box**
from its `/help` page — never guessed (see `src/api-route-map.ts`). What this
harness proves is that the connector works correctly against *whatever contract
it is given*; swapping in a discovered map is a fixture edit, not a code change.

### The one design rule

`ROUTE_MAP` in `fixture.mjs` is **both** the server's routing table (and what
`/help` renders) **and** a valid `EaglesoftApiRouteMap` that drops straight into
the connector's config. They are the same object, so the dummy box cannot drift
from the contract the connector is driven with. Serving a route means
publishing it, and publishing a route means serving it.

## Run it

### In CI and locally — no Docker needed

The live-box suite starts this server **in-process** on an ephemeral port, so it
runs in the ordinary package test run (and therefore in the existing
`erp-connector` CI leg, at no extra spend):

```bash
npm run -w @droplet/erp-connector test
```

Two prerequisites, both probed by `preflight.mjs` (WARP-2611):

- the `openssl` CLI, because the harness mints its own CA so TLS verification
  can stay **on** (Node has no X.509 signing API);
- **Node 20** — the version `.nvmrc`, `engines.node` and every CI `setup-node`
  pin. The connector reaches this box by handing an `undici` `Agent` carrying
  the harness CA to the built-in `fetch`, and from Node 22 on the built-in
  undici rejects an undici@6 dispatcher outright (`UND_ERR_INVALID_ARG: invalid
  onError method`). Every request then fails as a bare `fetch failed`, which
  reads exactly like an unreachable box.

Missing either, the suites **skip with the reason printed** — never red on a
clean checkout — and **fail in CI**, where both hold, so the coverage can never
go missing silently.

### As a long-lived box — Docker

Use this when you want something to point the orchestrator, the dashboard, or a
hand-driven `curl` at:

```bash
docker compose -f services/erp-connector/harness/eaglesoft-api/docker-compose.yml up -d --build
```

Discover the contract exactly as an installer would:

```bash
curl -sk https://localhost:9888/help | jq .Routes          # JSON
open https://localhost:9888/help                            # or the HTML table
```

Read out the CA the connector must trust:

```bash
docker compose -f services/erp-connector/harness/eaglesoft-api/docker-compose.yml \
  exec eaglesoft-mock-api cat /harness/.certs/harness-ca.crt > /tmp/harness-ca.crt
```

Or skip Docker entirely — `node main.mjs` from this directory does the same
thing and prints the credentials, the CA path, and the anchor date.

## Driving it from the connector

```ts
import { Agent } from "undici";
import { EaglesoftApiConnector } from "@droplet/erp-connector";
import { ROUTE_MAP } from "./fixture.mjs";

const connector = new EaglesoftApiConnector(
  {
    host: "127.0.0.1",
    httpsPort: 9888,
    credentialsSecretRef: "secret://harness/eaglesoft-api/creds",
    routeMap: ROUTE_MAP,          // in production: discovered from /help
  },
  {
    // The production TLS shape: a dispatcher carrying the CA to trust. The
    // connector never disables certificate verification.
    dispatcher: new Agent({ connect: { ca: harnessCaPem } }),
    resolveSecret: async () => ({
      integrationKey: "mock-vendor-integration-key",
      userId: "droplet_api",
      password: "mock_dev_password",
    }),
  },
);

await connector.connect();
await connector.runRead("get_schedule_today", { from, to });
```

## Pointing the ORCHESTRATOR at it (the full rehearsal)

The connector snippet above proves the transport. To rehearse the thing an
installer actually does — configure a connection, then watch real data appear —
`POST /api/integrations/eaglesoft/connect` with the REST provider and the three
pieces of connection material:

```jsonc
{
  "provider": "eaglesoft-api",
  "host": "127.0.0.1",
  "port": 9888,
  "apiCredentials": {                        // stored encrypted, never echoed back
    "integrationKey": "mock-vendor-integration-key",
    "userId": "droplet_api",
    "password": "mock_dev_password"
  },
  "apiRouteMap": { /* ROUTE_MAP from fixture.mjs, or a real /help discovery */ },
  "apiCaCert": "-----BEGIN CERTIFICATE-----\n…"   // .certs/harness-ca.crt
}
```

After that, `GET /api/erp/schedule?date=…` returns the box's appointments
through the ordinary dashboard path. On install day the only things that change
are the host, the credentials, and the route map — the shape is identical.

Credentials are encrypted at rest with the same `encryption.service`
(`DEVICE_SECRET_KEY`) the calendar integration uses, and no read path ever
returns them. If the credentials are missing, undecryptable, the route map is
absent, or the box's certificate doesn't verify, the connection degrades to
`ERP_NOT_CONNECTED` rather than half-working — each of those is asserted in
`apps/orchestrator/src/services/erp-api-live.test.ts`, which drives the real
orchestrator service against this box.

## The data

Fictional computer scientists, `555-01xx` reserved phone numbers, mirroring the
Postgres mock's seed (`../init/02-seed.sql`) so the two harnesses tell the same
story. Appointments are anchored to the UTC date the box started (reported as
`anchorDate`), so `get_schedule_today` always has rows and no one has to edit
dates. `get_ar_summary` totals **634.50 across 5 accounts** in both harnesses.

The box returns MORE than the connector maps — `DateOfBirth`, `Phone`, `Reason`
— on purpose. The DTO layer must project down to the canonical keys, so a
minimum-necessary regression shows up as a leaked field in a test.

## Fault injection

Arm a fault, and every `/api/*` request misbehaves until it is cleared (`/help`
and `/__control/*` stay reachable, or an armed fault could never be cleared):

```bash
curl -sk -X PUT https://localhost:9888/__control/faults \
  -H 'content-type: application/json' -d '{"status":500}'
curl -sk -X DELETE https://localhost:9888/__control/faults
```

| Field | Effect |
|---|---|
| `status` | answer every call with this HTTP status |
| `delayMs` | stall before answering (drive the connector's timeout) |
| `malformedJson` | serve IIS-style HTML where JSON was promised |
| `closeConnection` | destroy the socket mid-request |
| `count` | make the fault transient — fail N times, then heal |

In-process, the same knobs are on the returned box object (`setFaults`,
`expireTokens`, `reset`), plus `requests()` for wire-hygiene assertions such as
"no credential ever travelled in a URL".

## What this does NOT cover

- **The direct-SQL track.** A different provider entirely — see
  [`../README.md`](../README.md). Its connector is stubbed, so no dummy server
  can exercise it until the Python/unixODBC bridge exists.
- **Session reuse.** The orchestrator builds and closes a connector per call, so
  every read costs one `Authenticate` round-trip. Correct, but not free — if it
  shows up under real load the fix belongs in the connector (a pooled session
  that knows when its token expires), not a token cached in the service.
- **The REST write path.** `applyWrite` is deferred in the connector and stays
  honestly blocked. The box implements `PUT /api/schedule/appointment` with the
  optimistic guard so the write slice has a target the day it lands.
- **Patterson's real contract.** Discovery against a live box is still the first
  step of a real install; this proves everything downstream of it.
- **Wildcard over-fetch on the REST track.** There is no sanitization here:
  `toApiQuery` renames the param and passes the value through untouched, and
  `escapeLike` belongs to the SQL track's statement builder alone. This box
  matches a literal prefix, so `%` matches nothing — but that is the *mock's*
  behaviour, not a defence in the connector. Whether one is needed depends on
  how a real box matches `lastName`, which is undiscovered. Settle it during
  `/help` discovery, before any practice data is reachable. See the note above
  `find_patient` in [`fixture.mjs`](fixture.mjs).
