# Adding a new integration provider — developer guide

> **Audience:** an engineer adding a new integration (a second PMS, an accounting system, a generic ODBC ERP).
> **Prereq reading:** [`README.md`](README.md) (architecture) and [`eaglesoft.md`](eaglesoft.md) (provider reference). The `EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF.md` build spec is an unpublished working doc (not in-repo); the two in-repo docs above are the authority.
> **Reference implementation:** Eaglesoft (`services/erp-connector/`, provider #1). Copy its shape.

The orchestrator service + route layer and the dashboard hub are **provider-agnostic** — you rarely touch them. Adding a provider is mostly: implement the `Connector`, declare its read/write operations, provision its least-privilege accounts, expose tools, and add dashboard metadata.

---

## 0. Where a provider lives

Today all providers live in the `@droplet/erp-connector` package (`services/erp-connector/`). If you're adding an ERP/PMS-shaped provider, add it there behind the same `Connector` interface. A radically different category (non-database, API-based) may warrant its own sidecar package following the same contract — discuss in an ADR first (`droplet-architecture-guard`).

> **Building a cloud connector — read [ADR-041](../ADR-041-cloud-connector-class.md) first.**
> A provider whose system of record is a SaaS (Microsoft 365, Salesforce) is a **cloud connector**, a separate class with its own terms: outbound-only (the box registers no webhook — it polls, because it has no inbound path), enabled per-account by the owner rather than configured by an operator, every destination registered in [`allowed-egress.yaml`](../security/allowed-egress.yaml) with a declared `data_class`, tokens encrypted at rest and purged on disconnect, and synced data **persisted** on the box (unlike the read-through ERP tracks). The ADR also settles where the code goes: **in-process in the orchestrator, not the sidecar** — the sidecar exists to isolate a *native driver*, and an HTTPS API needs none. Sections 1–4 below describe the LAN/database shape and mostly do not apply; §5 (tools) and §6 onward do.

> **Before writing a connector at all — can the export-drop track cover it?**
> If the product can export its reports to a file, adding it is a **declarative profile**, not a provider: a header signature plus a column map, in code or in an operator's JSON. No connector, no driver, no vendor enrolment, and read-only by construction. See [`export-drop.md`](export-drop.md) §4. Sections 1–4 below are for a provider that needs a live connection to the system of record — reach for them when the practice needs data fresher than an export, or needs writes.

---

## 1. Implement the `Connector`

`services/erp-connector/src/connector.ts` defines the interface. Every database-touching method is async and, until the driver is wired, rejects with `ConnectorBlockedError` (the DB-independent slice — see [`README.md`](README.md) §7).

```ts
export interface Connector {
  readonly provider: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<{ ok: boolean }>;            // SELECT 1 + last-read + fingerprint + pool stats
  introspect(): Promise<IntrospectionResult>;    // discover the live schema, fingerprint it
  runRead(name: string, params): Promise<unknown[]>;
  applyWrite(name: string, params): Promise<unknown>;
}
```

Provide, alongside it:

- **A connection string builder** (`connection-string.ts` pattern) — provider-specific, secrets by `secretRef` pointer, prefer TLS. *(SQL Anywhere e.g. forbids `Host=` and `CommLinks=` together — provider quirks live here.)*
- **Version + catalog detection** (`version-detect.ts` pattern) — detect the engine/product version and branch the introspection queries to the right catalog dialect. Never assume one schema shape.
- **Schema map + drift fingerprint** (reuse `schema-map.ts`: `buildSchemaMap`, `computeSchemaFingerprint`). The fingerprint is what freezes writes on an upstream upgrade — reuse it verbatim.

Keep the driver dependency **inside the sidecar package** (and, if native, inside its container image), so the orchestrator stays language-agnostic behind the internal REST contract.

---

## 2. Declare read operations (the read-query registry)

Reads leave the external system **only** through a fixed set of named, parameterized queries (`read-queries.ts`). This is the injection- and over-fetch-proof data plane.

- Each query resolves table/column **identifiers through the schema map** (`resolveTable` / `resolveColumn`) — never string-concatenated, never from caller input.
- Every **value** binds as `?`.
- Escape user-supplied search terms (see `escapeLike` — a bare `%` must not turn a name search into a full-table scan; PHI minimum-necessary).
- Register the query; an unknown query name throws `UnknownReadQueryError`.

The orchestrator's `erp.service.ts` calls `connector.runRead("<name>", params)` and maps rows to the API shape; the assistant reaches reads only via tools (§5).

---

## 3. Declare write operations (the write-command registry)

Writes are the sharp edge (`write-commands.ts`). Each command is a named object with:

- a `targetTable` and an **`allowedColumns`** list (a bind outside it throws `DisallowedColumnError`);
- an **optimistic guard** on the discovered watermark column (e.g. `WHERE id = ? AND last_modified = ?`) so Droplet never clobbers a change a front-desk user made a second earlier;
- a `buildStatement`, a `reversalPlan`, and a `verifyQuery`.

**`FORBIDDEN_WRITE_TABLES` + `assertTargetAllowed` make ledger / clinical / claim tables impossible targets** — enforced at registration, at `buildStatement`, and at `verifyQuery`. An unknown command name throws `UnknownWriteCommandError`.

> **Before allow-listing any write:** on a **copy** database, capture what the external application does when *it* performs the same operation (triggers, audit-trail rows, side-effect tables) vs. what your raw SQL touches. If the app writes tables your `droplet_rw` won't, the raw write will desync the system — escalate to the vendor's sanctioned write API instead. Raw writes can also be **invisible to live clients until a service restart** — surface this. (Eaglesoft: [`eaglesoft.md`](eaglesoft.md).)

---

## 4. Provision least-privilege accounts

Ship a `provision.sql` and a `revoke.sql` (`services/erp-connector/sql/` pattern):

- `droplet_ro` — `SELECT` only, on the specific tables/views the read registry uses (prefer granting on **views** to pin the contract).
- `droplet_rw` — created but **no grants at creation**; each enabled write capability adds exactly the `INSERT`/`UPDATE(cols)` it needs. Never `DELETE`, DDL, or admin.

Provisioning must be **idempotent / self-healing** (re-runnable on connect-failure). Passwords are Droplet-generated, referenced by `secretRef`, and use placeholders in the tracked SQL — **never** a literal credential in the repo.

---

## 5. Expose assistant tools

The assistant reaches the provider **only** through named tools in `packages/tools-core/src/handlers/erp/`:

- Add a handler per operation; register it in `registry.ts`; set `requiresWrite` + `requiresConfirmation` to match the tier (reads: both false; writes: both true).
- A write tool **creates a write-request** (stages the outbox) — it must **never** apply a write directly.
- Update `INVENTORY.md` + the registry test's expected tool set.

The MCP server picks tools up automatically; the orchestrator's `WRITE_TOOLS` is **derived** from `requiresWrite` — never maintain a parallel list.

---

## 6. Add dashboard metadata

The hub's catalog is **derived** from your provider's `ProviderDescriptor` (WARP-2217, `packages/shared-types/src/provider-registry.ts`) — `apps/web-dashboard/src/lib/connectors.ts` reads it and holds no provider list of its own. Declare the `catalog` block:

```ts
catalog: {
  id, name, category, description,
  availability: "available" | "coming-soon",
  order,                 // sort position on the hub, pinned
  setupGuideHref,        // WARP-2342 — REQUIRED for a cloud track that is `available`
}
```

`setupGuideHref` is where the customer reads how to produce the credential. It is **not optional for an `available` cloud card** — `ProviderDescriptor`'s cloud arm requires it, so omitting it is a `tsc` error at the declaration site, not a review note. A `coming-soon` card is exempt: it has no connect flow, so there is no moment of use to link from. LAN tracks are exempt for the same reason the guide gate is cloud-only — there is no vendor console involved.

**The value is always `/help/integrations/<providerId>`** (WARP-2490). That route serves `docs/integrations/<providerId>.md` from a **bundled** `?raw` import — the markdown is inlined into the JS at build time and the page prerenders static, so the guide opens on a box whose browser has no route to the internet. An external link would break exactly the promise the appliance is sold on. Two consequences when you add a guide:

1. **Add the import** to `apps/web-dashboard/src/lib/integration-guides.ts`. A static import is the only kind a bundler can inline, so the list is hand-written; `scripts/check-setup-guides.sh` fails if a cloud provider's guide is missing from it, and `integration-guides.test.ts` fails if the bundle and `docs/integrations/*.md` disagree in either direction.
2. **The drift gate** in that same test asserts every descriptor's `setupGuideHref` resolves to a page `generateStaticParams` emits — so a descriptor pointing at a guide nobody wrote goes red instead of shipping a 404 to the one screen where the owner is stuck.

Cross-guide links keep working: the renderer rewrites `credential-handling.md#anchor` to `/help/integrations/credential-handling#anchor` and gives headings GitHub-compatible ids. A link this build cannot serve (`../ADR-041-…`) renders as plain text rather than as an anchor to nowhere.

Live connection **status** is merged in from `GET /api/integrations`; the descriptor is only the descriptive metadata (safe client-side). Add a connector icon/visual in `components/integrations/connector-visuals.tsx`. The connect wizard, per-provider surface, and manage flows are generic — a new provider inherits them.

**The connect wizard is descriptor-driven (WARP-2451).** It renders whatever `credentialFields` you declare, in the shapes the v1 vendors actually span:

- **one pasted secret** — one field, `secret: true`, an optional `pattern`;
- **a pair** — two fields, only the secret one masked;
- **a discriminated choice** — declare `credentialVariants`, each with its own `fields`; the wizard renders the chosen path's fields only, and sends the chosen `credentialVariant` id alongside them. Fields common to every path stay in `credentialFields`.

A descriptor that declares `lanProvisioning` instead gets the LAN-database flow (find the server → provision the read-only account → choose read scopes → confirm). That block carries every string the flow shows: `accountName`, `databaseName`, `defaultPort`, `hostPlaceholder`, `reachableLabel`, the one-off DBA `script`, the read `scopes`, and the optional `writeOptIn`. **`ConnectWizard.tsx` names no vendor and a test asserts it** — if a provider needs special handling there, the descriptor is under-specified and that is the bug to fix.

> **A cloud/SaaS provider also needs a customer setup guide** at `docs/integrations/<id>.md`, listed in `SETUP.md` §3.3, before it can ship. The credential is created by the customer in a vendor console we do not control, so an undocumented click-path is the connector being unusable rather than an inconvenience. `scripts/check-setup-guides.sh` enforces coverage, the six required sections, the per-vendor fact pins and link integrity, and runs on every PR. Start from an existing guide — [`stripe.md`](stripe.md) is the simplest, [`xero.md`](xero.md) the one with the most qualification gates — and link the shared [`credential-handling.md`](credential-handling.md) rather than paraphrasing it. Point `setupGuideHref` at that guide; the hub card and the wizard's credential step both render it.

---

## 7. Wire the build graph (don't skip this — it's a silent CI-redder)

The moment the **orchestrator imports your connector package**, the build graph changes. If you add a *new* connector package (rather than extending `erp-connector`), you must also:

1. **Declare the dependency** in `apps/orchestrator/package.json` (`"@droplet/<pkg>": "0.1.0"`). Without it, workspace resolution + the Docker targeted-install won't include it → build/runtime failure.
2. **Build it before the orchestrator** in:
   - `apps/orchestrator/Dockerfile` — `COPY` its `package.json` + source, add `-w @droplet/<pkg>` to the targeted `npm ci`, and `RUN npm run -w @droplet/<pkg> build`;
   - `scripts/test/ship-check.sh` — add it to the **leaf-build list** (the `for leaf_pkg in …` loop), so `ship-check tsc-full` and CI build its `dist` + `.d.ts` before the orchestrator typecheck.
3. **Sync the lockfile** — `npm install --package-lock-only` (a new workspace/dependency edge reddens all node CI at `npm ci` if the lockfile is stale — see the `new-npm-workspace-needs-lockfile-sync` note).

*(Extending the existing `erp-connector` package avoids most of this — it's already wired.)*

---

## 8. The hard rules (a review will block violations)

- **The assistant never emits SQL** — named registry commands only; no raw-SQL escape hatch against a live third-party system.
- **Read-only by default**; writes are a per-practice opt-in behind the confirm-outbox.
- **Financial/clinical/claim tables are never written** (`FORBIDDEN_WRITE_TABLES`).
- **Explicit-enum state** — never derive status from a null/absent row (WARP-218).
- **`secretRef` pointer** — never a cleartext password in a row, log, or export.
- **Audit `scope` is PHI-free** — ids/counts/tokens only; redact search terms.
- **No `while True`** — schedule via `cron-runtime`; **no new `MATTER_*` env vars**; **no `any`**; **no** "poc"/"test"/"dev"/"prototype" naming in surfaces.
- **On-box** — a LAN connector adds **no egress at all**; a cloud connector egresses only to its registered `allowed-egress.yaml` destination, only once the owner connects that account (ADR-041).

---

## 9. Testing

- **Unit tests with a stubbed connector** (`*.service.test.ts`, `erp-connector/__tests__/*`): the connector's live methods throw `ConnectorBlockedError`; the service/registry logic is fully testable with **no database** — honest degradation, the write-request state machine, RBAC, audit emission, identifier resolution, forbidden-target rejection, fingerprint stability.
- **No mock-database integration tests** (team rule — a prior mock/prod divergence incident). DB-touching paths stay stubbed + unit-tested, or run against a **real** database.
- **The copy-DB harness** (`services/erp-connector/harness/`, WARP-1106): a PostgreSQL mock (`Variant A`, runs in CI now) and a real-engine template (`Variant B`, needs the provider's dev-edition binaries). It runs the connector's **actual built SQL** against a synthetic schema to prove reads/writes/guards before a live driver exists. Use it as the live target for a new provider's driver.
- **Gate:** `./scripts/test/ship-check.sh tsc-full` (typecheck all workspaces) + `lifecycle-naming`. Run before every PR.
  - **Interpreter prerequisite: bash 3.2+.** The script targets the bash 3.2 feature set — the version macOS ships as `/bin/bash` — so it runs on the dev Mac unchanged; no `brew install bash` (WARP-2449). On an older interpreter it exits **4** with a message naming the requirement and the remedy.
  - **Exit 4 means COULD NOT RUN, not "a check failed"** (only exit 1 means that). A run that exited 4 is not a passing gate — say so rather than reporting the gate as clean.

---

## 10. Checklist

- [ ] `Connector` implemented; live methods stubbed until the driver lands.
- [ ] Connection-string + version/catalog detection + schema-map/fingerprint.
- [ ] Read-query registry (parameterized, identifiers via schema map, terms escaped).
- [ ] Write-command registry (allowlist, forbidden tables, optimistic guard, reversal, verify).
- [ ] `provision.sql` / `revoke.sql` (idempotent, least-privilege, `secretRef`).
- [ ] tools-core handlers (`requiresWrite`/`requiresConfirmation`, writes stage a request).
- [ ] Dashboard connector metadata + visual.
- [ ] Build graph wired (dep + Dockerfile + ship-check leaf + lockfile) — if a new package.
- [ ] Unit tests green; ship-check `tsc-full` + `lifecycle-naming` pass.
- [ ] A WARP ticket filed for the work; PR opened review-ready (never self-merged).
