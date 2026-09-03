/**
 * WARP-2217 — the provider registry: one descriptor per provider, and the only
 * gate on what a provider IS.
 *
 * `IntegrationConnection.provider` is free-text TEXT with no enum and no check
 * constraint (`schema.prisma`), so a new provider key has never needed a
 * migration. What it needed instead was four hand-edits in two apps. This file
 * replaces all four: adding a provider is adding one object here, plus its
 * `Connector` implementation and its egress allowlist entries.
 *
 * Both apps read THIS list. The orchestrator drives config validation,
 * connector dispatch and the metered-call budget off it; the dashboard drives
 * its hub catalog and its credential form off it. That is the point — before
 * this, the dashboard's idea of a provider's credential fields was
 * structurally unrelated to the orchestrator's, so the two could not even be
 * compared.
 *
 * Ordering in this file is the historical order of the two provider lists it
 * replaces (`KNOWN_ERP_PROVIDERS`, then the cloud tracks), so the derived lists
 * come out in the order callers already see. Hub ordering is separate and
 * pinned by `catalog.order`.
 */
import { setupGuideHrefFor, type ProviderDescriptor } from "./provider-descriptor";

/** Practice-management datasets — mirrors `PRACTICE_DATASETS` in the connector
 *  package, gated by the orchestrator's dataset-vocabulary drift test. */
const PRACTICE_DATASETS = ["appointment", "patient", "account"] as const;

/** 30 days in ms — `CallBudget`'s shipped period, matching Intuit's monthly
 *  allowance rather than a calendar month (which would need a timezone a
 *  connector has no business having an opinion about). */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The providers this appliance knows about.
 *
 * `as const satisfies` rather than a plain annotation ON PURPOSE: the literal
 * types survive, so a `datasets` entry outside the closed union of six is a
 * `tsc` error at the declaration site — see the `@ts-expect-error` fixture in
 * `provider-registry.test.ts`.
 */
export const BUILT_IN_PROVIDER_DESCRIPTORS = [
  {
    id: "eaglesoft",
    displayName: "Eaglesoft",
    category: "Practice management",
    // The flagship direct-SQL track: reads a Patterson SAP SQL Anywhere
    // database on the practice LAN, via the erp-sql-bridge sidecar.
    track: "lan",
    credentialFields: [
      {
        name: "host",
        label: "Server host or IP",
        type: "string",
        required: true,
        secret: false,
        storage: "column",
        help: "The machine on your network running the Eaglesoft database.",
      },
      {
        name: "port",
        label: "TCP port",
        type: "positiveInteger",
        required: false,
        secret: false,
        storage: "column",
        help: "Defaults to 2638, SQL Anywhere's port.",
      },
      {
        name: "databaseName",
        label: "Database name",
        type: "string",
        required: false,
        secret: false,
        storage: "column",
        help: 'Defaults to "PattersonPM".',
      },
      {
        // A POINTER into the encrypted secret store, never cleartext — which
        // is why it is not marked `secret`: the value in this field is a
        // label that appears in logs and audit rows by design.
        name: "secretRef",
        label: "Read-account secret reference",
        type: "string",
        required: false,
        secret: false,
        storage: "column",
      },
    ],
    // Never leaves the LAN. An empty list is a CLAIM, checked by the egress
    // drift gate like any other — not an omission.
    egressHosts: [],
    datasets: PRACTICE_DATASETS,
    // The owner-facing connect flow. Every string a practice owner reads in
    // the wizard's four steps is HERE or on `displayName` — the wizard itself
    // names no vendor, so a second LAN vendor is a descriptor, not a second
    // wizard (WARP-2451). Transcribed verbatim from the shipped
    // `ConnectWizard.tsx`; the flow is generalised, not re-worded.
    lanProvisioning: {
      accountName: "droplet_ro",
      databaseName: "PattersonPM",
      defaultPort: 2638,
      hostPlaceholder: "10.0.1.5 or server-pc",
      reachableLabel: "an Eaglesoft database",
      // The droplet_ro password is generated (strong, unique per box) and
      // stored via a secretRef by Droplet when it provisions — never
      // fabricated in the browser (that would strand a live credential the
      // connector cannot retrieve). The script carries the PLACEHOLDER Droplet
      // fills in with the issued value; mirrors
      // services/erp-connector/sql/provision.sql (WARP-1094, brief §8.1).
      script: [
        "-- Run once as a SQL Anywhere DBA on the PattersonPM database.",
        "-- Replace <GENERATED_BY_DROPLET> with the password Droplet issues on the setup screen.",
        "CREATE USER droplet_ro IDENTIFIED BY '<GENERATED_BY_DROPLET>';",
        "GRANT SELECT ON dba.patient TO droplet_ro;",
        "GRANT SELECT ON dba.appointment TO droplet_ro;",
        "GRANT SELECT ON dba.provider TO droplet_ro;",
        "GRANT SELECT ON dba.service TO droplet_ro;",
        "GRANT SELECT ON dba.serv_trans TO droplet_ro;",
        "GRANT SELECT ON dba.recall TO droplet_ro;",
        "GRANT SELECT ON dba.account TO droplet_ro;   -- AR read only",
      ],
      // Ids are the `ErpScope` union the connect endpoint accepts; the
      // dashboard pins that correspondence in `connectors.test.ts` rather than
      // trusting it, because this file cannot import the dashboard's type.
      scopes: [
        { id: "schedule", label: "Schedule & appointments" },
        { id: "patients", label: "Patients & contact info", tag: "PHI" },
        { id: "providers", label: "Providers & chairs" },
        { id: "financials", label: "Production & accounts receivable", tag: "financial" },
        { id: "recall", label: "Recall / recare" },
      ],
      writeOptIn: {
        label: "Let Droplet schedule appointments back into Eaglesoft",
        caution:
          "Off by default. When on, Droplet still asks you to confirm every change before it writes. You can turn this off any time.",
      },
    },
    catalog: {
      id: "eaglesoft",
      name: "Eaglesoft",
      category: "Practice management",
      description:
        "Read your schedule, patients, and balances — directly from Eaglesoft, on your network.",
      availability: "available",
      order: 0,
    },
  },
  {
    id: "eaglesoft-api",
    displayName: "Eaglesoft (Patterson API)",
    category: "Practice management",
    // The dual-track official-REST-API provider — Patterson Innovation
    // Connection over HTTPS :9888, still on the practice LAN.
    track: "lan",
    credentialFields: [
      {
        name: "host",
        label: "Server host or IP",
        type: "string",
        required: true,
        secret: false,
        storage: "column",
      },
      {
        name: "port",
        label: "HTTPS port",
        type: "positiveInteger",
        required: false,
        secret: false,
        storage: "column",
        help: "Defaults to 9888, Patterson's Innovation Connection port.",
      },
      {
        name: "integrationKey",
        label: "Integration key",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
      },
      {
        name: "userId",
        label: "User id",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
      },
      {
        name: "password",
        label: "Password",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
      },
    ],
    // The box is named by a connection row, not by a fixed vendor hostname, so
    // there is no static destination to register. Host safety on this track is
    // the operator's network, not an allowlist.
    egressHosts: [],
    datasets: PRACTICE_DATASETS,
    // No `catalog` block: the hub shows ONE "Eaglesoft" card, and the direct
    // track above carries it. Two cards for two transports of one vendor would
    // be a question no practice owner can answer.
  },
  {
    id: "quickbooks-online",
    displayName: "QuickBooks Online",
    category: "Accounting",
    track: "cloud",
    credentialFields: [
      {
        name: "realmId",
        label: "QuickBooks company id",
        type: "string",
        required: true,
        secret: false,
        storage: "providerConfig",
        // Deliberately NO `pattern`. Intuit's realm ids are opaque and their
        // documented format has changed; a regex here would reject companies
        // that work today for the sake of a validation nobody asked for.
        help: "Intuit calls this the realm id. It arrives with the OAuth grant.",
      },
      {
        name: "baseUrl",
        label: "API base URL",
        type: "string",
        required: false,
        secret: false,
        storage: "providerConfig",
        // Not validated here on purpose: `QBO_ALLOWED_API_HOSTS` +
        // UnsafeBaseUrlError refuse an unsafe host at DIAL time, where the
        // refusal is a blocked read the operator can act on. Rejecting it here
        // instead would turn that into an indistinguishable "not configured".
        help: "Leave blank for production. Set to Intuit's sandbox to rehearse.",
      },
      {
        name: "callCeiling",
        label: "Metered calls per 30 days",
        type: "positiveInteger",
        required: false,
        secret: false,
        storage: "providerConfig",
        help: "Overrides the default ceiling for this connection.",
      },
    ],
    egressHosts: [
      "quickbooks.api.intuit.com",
      "sandbox-quickbooks.api.intuit.com",
      // The OAuth token endpoint. Dialed by the orchestrator's OAuth wiring
      // rather than by the connector (which holds no token endpoint at all),
      // but it is this provider's egress and belongs in its declaration.
      "oauth.platform.intuit.com",
    ],
    datasets: ["invoice", "bill", "ap_summary"],
    rateLimit: {
      // Today's shipped `DEFAULT_CALL_CEILING`. 5,000 metered reads per 30 days
      // ≈ 166/day, which covers a daily sync plus an assistant answering
      // questions all day and puts ~100 boxes inside the free Builder pool.
      callCeiling: 5_000,
      periodMs: THIRTY_DAYS_MS,
      ceilingOverrideField: "callCeiling",
    },
    catalog: {
      id: "quickbooks",
      name: "QuickBooks",
      category: "Accounting",
      description:
        "Production, receivables, and deposits from your books — no export, no upload.",
      availability: "coming-soon",
      order: 2,
    },
  },
  {
    id: "dentrix-ascend",
    displayName: "Dentrix Ascend",
    category: "Practice management",
    track: "cloud",
    credentialFields: [
      {
        name: "organizationId",
        label: "Organization ID",
        type: "string",
        required: true,
        secret: false,
        storage: "providerConfig",
        help: "Issued by Henry Schein One at vendor enrolment.",
      },
      {
        name: "locationId",
        label: "Location ID",
        type: "string",
        // Optional BY DESIGN, and load-bearing: without a location the
        // connector still serves the schedule and patients and refuses only
        // the AR read, which is more useful than refusing the connection.
        required: false,
        secret: false,
        storage: "providerConfig",
      },
      {
        name: "baseUrl",
        label: "API base URL",
        type: "string",
        required: false,
        secret: false,
        storage: "providerConfig",
        help: "Leave blank for production. Set to the sandbox during enrolment.",
      },
    ],
    egressHosts: ["prod.hs1api.com", "test.hs1api.com"],
    datasets: PRACTICE_DATASETS,
    // No `rateLimit`, deliberately: Ascend's limits are per-endpoint and
    // dynamic, handled by reacting to a 429 where it arrives. A local ceiling
    // invented for it would be a guess wearing a policy's clothes.
    catalog: {
      id: "dentrix",
      name: "Dentrix",
      category: "Practice management",
      description: "Schedule, patients, and ledgers from Dentrix — read on your own network.",
      availability: "coming-soon",
      order: 1,
    },
  },
  {
    id: "opendental",
    displayName: "Open Dental",
    category: "Practice management",
    // A hub card with NO shipped track (WARP-1101 framework placeholder).
    // `catalog` says so explicitly rather than leaving it to be inferred from
    // an absent connector factory — absence is never a silent anything, and
    // this is what keeps it out of the buildable-provider list.
    track: "catalog",
    credentialFields: [],
    egressHosts: [],
    datasets: [],
    catalog: {
      id: "opendental",
      name: "Open Dental",
      category: "Practice management",
      description:
        "Read the schedule and patient records straight from your Open Dental database.",
      availability: "coming-soon",
      order: 3,
    },
  },
  // ── WARP-2214 SaaS business connectors (registered by WARP-2466) ─────────
  //
  // All three take a credential the CUSTOMER mints in their own vendor account
  // and pastes into the box (ADR-042), so none needs OAuth, none needs a Warp
  // Lab vendor registration, and the `pattern` on each secret field is the
  // boundary rejection ADR-042 §4 requires — a full-privilege key is refused
  // before it is ever stored, not after it has been used.

  {
    id: "stripe",
    displayName: "Stripe",
    category: "Payments",
    track: "cloud",
    credentialFields: [
      {
        name: "apiKey",
        label: "Stripe restricted key",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
        // `rk_` ONLY. A secret key (`sk_`) can move money; a restricted key
        // cannot, and refusing the wrong shape here is why a merchant cannot
        // accidentally hand this box the ability to issue refunds. The
        // connector re-checks with the same rule at dial time — the two
        // together are the "allowlist at point of use" pattern, not a
        // duplicate.
        pattern: "^rk_(live|test)_",
        help:
          "Create it in the Stripe Workbench with the resources you want read set to Read. " +
          "A live key's value is shown once, so a lost key is a re-create.",
      },
    ],
    egressHosts: ["api.stripe.com", "files.stripe.com"],
    // Mirrors `STRIPE_DATASETS`, and WARP-2497 widened both together: a
    // descriptor that claimed less than the track serves would hide `charge`
    // from every caller that resolves a dataset through the registry, which is
    // how the cloud read tool finds its connection.
    datasets: ["invoice", "charge"],
    rateLimit: {
      // `STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION`. Not a Stripe-imposed ceiling
      // — Stripe rate-limits per second, not per month — but the connector's
      // own read allocation, which is what `ReadAllocationMeter` enforces.
      callCeiling: 10_000,
      periodMs: THIRTY_DAYS_MS,
    },
    // `STRIPE_MIN_POLL_INTERVAL_SECONDS` (900s) in ms. The first shipped track
    // to carry one: this floor is enforced in the connector by
    // `assertStripePollIntervalSeconds`, so the descriptor is stating a real
    // number rather than the guess the field's docstring warns about.
    pollIntervalFloorMs: 900_000,
    catalog: {
      id: "stripe",
      name: "Stripe",
      category: "Payments",
      description: "Payments, refunds and payouts read straight from Stripe — never money movement.",
      availability: "available",
      // WARP-2451 — REQUIRED by the type for an `available` cloud track: the
      // customer creates this credential in a vendor console we do not
      // control, so shipping the card without the click-path is shipping an
      // unusable connector. Served from `docs/integrations/stripe.md`,
      // bundled at build so the link works with no internet.
      setupGuideHref: "/help/integrations/stripe",
      order: 4,
    },
  },
  {
    id: "hubspot",
    displayName: "HubSpot",
    category: "CRM",
    track: "cloud",
    credentialFields: [
      {
        name: "accessToken",
        label: "HubSpot private app token",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
        // `HUBSPOT_PRIVATE_APP_TOKEN_PATTERN`. HubSpot has no PKCE, so a
        // private app token is the only customer-creatable credential.
        pattern: "^pat-[a-z]{2}[0-9]+-",
        help:
          "A super admin creates it under Settings → Integrations → Private Apps. " +
          "Create it on an account that will outlive any one individual.",
      },
      {
        name: "portalId",
        label: "HubSpot portal id",
        type: "string",
        required: true,
        secret: false,
        storage: "providerConfig",
        // Required because the Search governor is keyed on it. Two connections
        // pointed at one portal MUST share a governor — the ceiling is per
        // ACCOUNT, not per app — so a connection that cannot name its portal
        // cannot be rate-limited correctly and must not be built.
        help: "Shown in your HubSpot account settings, and in the portal URL.",
      },
    ],
    egressHosts: ["api.hubapi.com"],
    datasets: ["contact", "company", "deal", "ticket", "engagement"],
    rateLimit: {
      // `HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND`. Expressed as 5 per 1000ms
      // rather than folded into a monthly number because that is what HubSpot
      // actually enforces, and because the ceiling is ACCOUNT-keyed: it is not
      // a budget this connection spends, it is a rate two connections share.
      callCeiling: 5,
      periodMs: 1_000,
    },
    catalog: {
      id: "hubspot",
      name: "HubSpot",
      category: "CRM",
      description: "Contacts, companies, deals and tickets from your CRM — read on request.",
      availability: "available",
      // WARP-2451 — REQUIRED by the type for an `available` cloud track: the
      // customer creates this credential in a vendor console we do not
      // control, so shipping the card without the click-path is shipping an
      // unusable connector. Served from `docs/integrations/hubspot.md`,
      // bundled at build so the link works with no internet.
      setupGuideHref: "/help/integrations/hubspot",
      order: 5,
    },
  },
  {
    id: "mailchimp",
    displayName: "Mailchimp",
    category: "Marketing",
    track: "cloud",
    credentialFields: [
      {
        name: "apiKey",
        label: "Mailchimp API key",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
        // `MAILCHIMP_API_KEY_PATTERN`. The `-us14` suffix is not decoration —
        // it SELECTS THE HOST, so a key that does not carry one cannot be
        // dialed at all and is refused here rather than producing a request to
        // a URL whose first label is the string "undefined".
        pattern: "^([0-9A-Za-z]{20,64})-([a-z]{2}\\d{1,2})$",
        help:
          "Account → Extras → API keys. The key ends in a datacentre suffix like -us14, " +
          "which tells the box which Mailchimp server your account lives on.",
      },
      {
        name: "datacenter",
        label: "Mailchimp datacentre",
        type: "string",
        required: true,
        secret: false,
        storage: "providerConfig",
        // NOT secret, and stored separately from the key on purpose (ADR-042
        // §5: "non-secret connection facts … go in `providerConfig`, never in
        // the encrypted blob and never re-derived per request"). Keeping it
        // here means answering "where does this connection dial?" never
        // requires decrypting a credential — and it means a key swapped
        // out-of-band cannot silently move the destination.
        pattern: "^[a-z]{2}\\d{1,2}$",
        help: "The suffix of your API key, without the dash — e.g. us14.",
      },
    ],
    // EMPTY, and not because this track stays on the LAN — it emphatically
    // does not. The host is `<dc>.api.mailchimp.com` where `<dc>` comes out of
    // the customer's own key, so there is no name to register and no literal
    // for the egress scanner to find. `dynamicEgress` below is what says so.
    egressHosts: [],
    dynamicEgress: {
      configKey: "IntegrationConnection.providerConfig.datacenter",
      registryId: "mailchimp-marketing-api",
    },
    datasets: ["audience_member", "campaign", "ecommerce_order"],
    // No `rateLimit`: Mailchimp meters by CONCURRENT CONNECTIONS (10), not by
    // a call ceiling over a period, and `ConnectionSemaphore` enforces that
    // where it applies. A monthly number invented here would be a guess
    // wearing a policy's clothes — the same reason Dentrix Ascend has none.
    catalog: {
      id: "mailchimp",
      name: "Mailchimp",
      category: "Marketing",
      description: "Audiences, campaign performance and attributed orders — read from Mailchimp.",
      availability: "available",
      // WARP-2451 — REQUIRED by the type for an `available` cloud track: the
      // customer creates this credential in a vendor console we do not
      // control, so shipping the card without the click-path is shipping an
      // unusable connector. Served from `docs/integrations/mailchimp.md`,
      // bundled at build so the link works with no internet.
      setupGuideHref: "/help/integrations/mailchimp",
      order: 6,
    },
  },
  // ── WARP-2650 — the first MCP-backed provider ────────────────────────────
  //
  // #1944 built the outbound MCP client, #1956 the Atlassian profile and #1964
  // the bridge service and its three fail-closed gates. The third gate is a
  // CONNECTED `IntegrationConnection` row holding an ADR-042-sealed credential,
  // and NOTHING could create one: there was no `atlassian` descriptor, so the
  // credential configurator had no provider to render, `requireDescriptor()`
  // 404'd the PATCH, and the row had to be inserted by hand. This is that
  // descriptor.
  {
    id: "atlassian",
    displayName: "Atlassian (Jira & Confluence)",
    category: "Project management",
    track: "mcp",
    // WARP-2659 — the hub tile's one line. Says what the track actually does
    // (the model calls Atlassian's own tools, on request) rather than
    // promising the dataset reads every other card offers, because this track
    // has none: nothing is copied onto the box and nothing syncs.
    description:
      "Ask about Jira issues and Confluence pages — Droplet calls Atlassian directly, nothing is copied onto the box.",
    // The bridge's `SESSION_FACTORIES` key. Gated against the bridge's own
    // source by `adr-043-boundary.test.ts`, which now checks four declarations.
    mcpServerId: "atlassian",
    credentialFields: [
      {
        // `readAtlassianCredential` (`remote-mcp-servers.ts`) reads exactly
        // this name out of `providerConfig`. The three names below are a wire
        // contract with that function, and `provider-registry.test.ts` asserts
        // it rather than trusting it — a renamed field here would produce a row
        // the attach path reports as `credential_incomplete`, which reads as a
        // customer mistake.
        name: "email",
        label: "Atlassian account email",
        type: "string",
        required: true,
        secret: false,
        storage: "providerConfig",
        help:
          "The account the API token belongs to. The token carries that person's " +
          "full permissions, so choose an account that will outlive any one individual.",
      },
      {
        name: "apiToken",
        label: "Atlassian API token",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
        // Deliberately NO `pattern`. Atlassian's `ATATT`-prefixed format is not
        // a documented contract the way Stripe's `rk_` is — it has changed
        // before — and a regex that rejects a token the vendor considers valid
        // would present as "your token is wrong" with no way for a customer to
        // be right. The boundary rejection ADR-042 §4 asks for is not available
        // here at all: the token is UNSCOPED by design, so there is no narrower
        // shape to insist on. The guide says so instead.
        // The click-path names the MENU, not the host. A bare `id.atlassian.com`
        // literal here is read by `scripts/check-egress-allowlist.py` as an
        // outbound destination and refused — correctly: the box never dials it,
        // the customer's browser does. The full URL lives in the guide, which
        // is where a person following a click-path actually is.
        help:
          "Account settings → Security → Create and manage API tokens. Copy it once; " +
          "Atlassian never shows it again.",
      },
      {
        name: "cloudId",
        label: "Atlassian site (cloud) ID",
        type: "string",
        required: true,
        secret: false,
        storage: "providerConfig",
        // Required, and load-bearing: the token is NOT bound to a site, so every
        // call has to name one. `withAtlassianCloudId` forces this value onto
        // each call LAST, overwriting anything the model supplied — an argument
        // the model could win would be a prompt-injection path to a different
        // site the same token can reach.
        help: "Visit <your-site>.atlassian.net/_edge/tenant_info to read it.",
      },
      {
        name: "tokenExpiresAt",
        label: "Token expiry date",
        type: "string",
        // OPTIONAL, and the optionality is a stated position rather than
        // leniency: Atlassian does not tell the box when a token expires, so
        // this is the customer transcribing what their own console showed them.
        // Requiring it would block a connection over a date nobody can look up
        // after the fact. A connection without it reports `EXPIRY_UNKNOWN` —
        // its own status, never `VALID` (see `credentialExpiry` below).
        required: false,
        secret: false,
        storage: "providerConfig",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        help:
          "YYYY-MM-DD, from the API tokens page. Atlassian tokens last at most 365 " +
          "days and there is no grace period — Droplet warns 30 days ahead if it knows the date.",
      },
    ],
    // `mcp.atlassian.com` is the ONE host this integration dials, registered by
    // #1956 as `atlassian-mcp` (`kind: egress`, fixed hosted-only endpoint).
    // Declared here as the descriptor's half of that registration even though
    // the socket lives in `services/mcp-bridge` — ADR-043 §5 puts the transport
    // in another process, not the egress in another repo. `auth.atlassian.com`
    // (OAuth, a v1 non-goal) and `api.atlassian.com` are deliberately absent:
    // nothing dials them, and a registered host nothing dials is a permanent
    // unfalsifiable hole in a default-deny list.
    egressHosts: ["mcp.atlassian.com"],
    // Empty BY CONSTRUCTION — the type is `readonly []`, not "empty for now".
    datasets: [],
    credentialExpiry: {
      field: "tokenExpiresAt",
      // WARP-2353's number, mirrored from `ATLASSIAN_TOKEN_EXPIRY_WARNING_DAYS`
      // and asserted equal to it (`provider-registry.test.ts`) rather than
      // imported: this module is bundled into the dashboard and that one is
      // orchestrator-only.
      warningDays: 30,
      maxLifetimeDays: 365,
    },
    setupGuideHref: "/help/integrations/atlassian",
  },
] as const satisfies readonly ProviderDescriptor[];

/**
 * Descriptors registered at runtime, on top of the built-in list.
 *
 * The extension seam AC #7 is about: a provider can be added without touching
 * the orchestrator's factory module at all. Used in-repo by the fixture
 * provider in `__tests__`, and by any future descriptor that ships outside this
 * file.
 */
const registered = new Map<string, ProviderDescriptor>();

/** Register a descriptor. Replaces an existing registration with the same id;
 *  built-in descriptors are never replaced (they are the shipped contract). */
export function registerProviderDescriptor(descriptor: ProviderDescriptor): void {
  if (BUILT_IN_PROVIDER_DESCRIPTORS.some((d) => d.id === descriptor.id)) {
    throw new Error(
      `cannot re-register built-in provider "${descriptor.id}" — edit its descriptor instead`,
    );
  }
  registered.set(descriptor.id, descriptor);
}

/** Drop every runtime registration. Test seam only. */
export function __resetRegisteredProvidersForTest(): void {
  registered.clear();
}

/** Every descriptor, built-in first then registered, in declaration order. */
export function providerDescriptors(): readonly ProviderDescriptor[] {
  return [...BUILT_IN_PROVIDER_DESCRIPTORS, ...registered.values()];
}

/**
 * The descriptor for a provider key, or undefined.
 *
 * Undefined here means "not a provider we know about" and is the ONLY place
 * that question is answered. Callers that cannot proceed without one throw;
 * callers describing a row degrade. Neither guesses.
 */
export function providerDescriptor(id: string): ProviderDescriptor | undefined {
  return (
    BUILT_IN_PROVIDER_DESCRIPTORS.find((d) => d.id === id) ?? registered.get(id)
  );
}

/**
 * Providers the ERP CONNECTOR FACTORY can build — the descriptor-derived
 * replacement for the hand-maintained `KNOWN_ERP_PROVIDERS`.
 *
 * An explicit `lan | cloud` allow-list, not `!== "catalog"`. Those two were the
 * same set while three tracks existed, and WARP-2650's `mcp` track is exactly
 * the case that separates them: it IS a valid `IntegrationConnection.provider`
 * (unlike `catalog`) and it has NO connector (unlike `lan`/`cloud`), so a
 * negative filter would have admitted it here and `connectorForProvider` would
 * have thrown the first time a real row used it. A positive list makes the next
 * track's author classify it rather than inherit an answer.
 */
export function buildableProviderIds(): readonly string[] {
  return providerDescriptors()
    .filter((d) => d.track === "lan" || d.track === "cloud")
    .map((d) => d.id);
}

/**
 * The MCP-backed tracks (ADR-043).
 *
 * Kept as its own derivation for the same reason {@link cloudProviderIds} is:
 * a caller genuinely needs to know which kind a row is. An MCP row's credential
 * is opened by `attachAtlassianRemote`, not by a `Connector`, and it serves no
 * dataset — so a caller that folded it into the cloud list would resolve a
 * dataset to a connection nothing can read.
 */
export function mcpProviderIds(): readonly string[] {
  return providerDescriptors()
    .filter((d) => d.track === "mcp")
    .map((d) => d.id);
}

/**
 * Every provider whose credential is minted by the CUSTOMER in a vendor console
 * and therefore ships with a setup guide — the set
 * `scripts/check-setup-guides.sh`'s `CLOUD_PROVIDERS` must cover.
 *
 * Derived from `setupGuideHrefFor`, so it is the same read the tile, the
 * wizard and the credential configurator make. A `coming-soon` cloud card
 * declares none and is correctly absent: it has no connect flow, so there is no
 * moment of use to link from.
 */
export function providersWithSetupGuide(): readonly string[] {
  return providerDescriptors()
    .filter((d) => setupGuideHrefFor(d) !== undefined)
    .map((d) => d.id);
}

/**
 * The cloud tracks — the descriptor-derived replacement for the hand-maintained
 * `CLOUD_ERP_PROVIDERS`.
 *
 * Kept as a distinction rather than collapsed away: cloud rows take their
 * account identity from `providerConfig` and their credentials from
 * `providerTokensEnc`, so a caller genuinely needs to know which kind a row is.
 */
export function cloudProviderIds(): readonly string[] {
  return providerDescriptors()
    .filter((d) => d.track === "cloud")
    .map((d) => d.id);
}

/** Every descriptor that puts a card on the Integrations hub, in hub order. */
export function catalogDescriptors(): readonly ProviderDescriptor[] {
  return providerDescriptors()
    .filter((d) => d.catalog !== undefined)
    .slice()
    .sort((a, b) => (a.catalog?.order ?? 0) - (b.catalog?.order ?? 0));
}

/** The descriptor behind a hub card id (`quickbooks` → `quickbooks-online`).
 *  The hub's vocabulary is vendor-level; a descriptor's is track-level. */
export function descriptorForCatalogId(catalogId: string): ProviderDescriptor | undefined {
  return providerDescriptors().find((d) => d.catalog?.id === catalogId);
}
