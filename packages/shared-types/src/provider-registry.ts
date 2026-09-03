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
import type { ProviderDescriptor } from "./provider-descriptor";

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
  {
    id: "shopify",
    displayName: "Shopify",
    category: "Commerce",
    track: "cloud",
    credentialFields: [
      {
        name: "shopDomain",
        label: "Store domain",
        type: "string",
        required: true,
        secret: false,
        storage: "providerConfig",
        // NOT secret, and stored separately from the credentials on purpose
        // (ADR-042 §5: "non-secret connection facts … go in `providerConfig`,
        // never in the encrypted blob and never re-derived per request").
        // Keeping it here means answering "where does this connection dial?"
        // never requires decrypting a credential — which matters more on this
        // track than anywhere else, because the store domain IS the host for
        // both the API and the token endpoint.
        //
        // `SHOPIFY_SHOP_NAME_PATTERN` with the suffix appended. The suffix is
        // mandatory in the FORM even though the connector accepts a bare
        // handle: a merchant typing a custom domain they pointed at the store
        // is the mistake this field exists to catch, and Shopify authenticates
        // only on the myshopify one.
        pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.myshopify\\.com$",
        // The help text names the SUFFIX and never a sampled store: a
        // "your-store.myshopify.com" example here is a bare hostname in a
        // string literal, which `egress-gate` reads as an unregistered
        // destination and denies — correctly, since the dynamic entry
        // registers no hosts. The example belongs in the setup guide, which
        // the scanner does not read.
        help:
          "Your store's .myshopify.com address, not a custom domain you point at the store. " +
          "Shopify authenticates on this one.",
      },
      {
        name: "clientId",
        label: "Client ID",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
        // `SHOPIFY_CLIENT_CREDENTIAL_PATTERN`. The NEGATIVE half is the
        // boundary rejection ADR-042 §4 requires: a `shpat_` admin-created
        // token is refused before it is ever stored, because Shopify removed
        // the flow that minted it on 2026-01-01 and it cannot be re-created if
        // it stops working. The positive half is deliberately loose — Shopify
        // publishes no format guarantee, and a false rejection here blocks a
        // paying customer's onboarding for no security gain.
        //
        // Marked `secret` although a client id is not, strictly, a secret: it
        // is half of a credential PAIR that authenticates on its own, so it is
        // sealed with the other half rather than left in `providerConfig`
        // where a read view would render it.
        pattern: "^(?!shp(at|ca|pa|ss)_)\\S+$",
        help:
          "From your own Dev Dashboard app at shopify.dev, in the same Shopify organization " +
          "as the store. An old shpat_ token is not this — that flow was removed in 2026.",
      },
      {
        name: "clientSecret",
        label: "Client secret",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
        // The only vendor in WARP-2214 whose paste includes a client secret —
        // the MERCHANT's secret, for the MERCHANT's app, on the MERCHANT's box
        // (ADR-042 §2). Compatible with §3 precisely because Warp Lab minted
        // none of it, and Shopify's own rule that the app and the store share
        // an organization is what makes it unmistakably theirs.
        pattern: "^(?!shp(at|ca|pa|ss)_)\\S+$",
        help: "Shown once when the app is created. Treat it like a password.",
      },
    ],
    // EMPTY, and not because this track stays on the LAN — it emphatically does
    // not. Every request goes to `<store>.myshopify.com`, THE TOKEN MINT
    // INCLUDED: Shopify's client-credentials grant posts to the store's own
    // host, so unlike QuickBooks Online there is no separate OAuth host to
    // register and no static name for the egress scanner to find.
    // `dynamicEgress` below is what says so.
    egressHosts: [],
    dynamicEgress: {
      configKey: "IntegrationConnection.providerConfig.shopDomain",
      registryId: "shopify-admin-api",
    },
    // Mirrors `SHOPIFY_DATASETS`. These three names were RESERVED for Shopify
    // when the vocabulary was widened (WARP-2280) and the columns were compared
    // before this list was written — `ecommerce_order` is deliberately NOT here
    // (it is Mailchimp's attribution shadow, with no tax, refund or fulfilment
    // column) and neither is `contact` (a CRM person, not a storefront buyer).
    datasets: ["order", "product", "customer"],
    // No `rateLimit`: Shopify's GraphQL Admin API meters by QUERY COST against
    // a refilling leaky bucket, not by a call ceiling over a period, so a
    // monthly number invented here would be a guess wearing a policy's clothes
    // — the same reason Dentrix Ascend and Mailchimp have none. The connector
    // derives its backoff from the `throttleStatus` the vendor returns.
    catalog: {
      id: "shopify",
      name: "Shopify",
      category: "Commerce",
      description: "Orders, catalogue and inventory read straight from your store — never a write.",
      availability: "available",
      // WARP-2451 — REQUIRED by the type for an `available` cloud track: the
      // customer creates this credential in a vendor console we do not control,
      // so shipping the card without the click-path is shipping an unusable
      // connector. Served from `docs/integrations/shopify.md`, bundled at build
      // so the link works with no internet.
      setupGuideHref: "/help/integrations/shopify",
      order: 7,
    },
  },
  {
    id: "xero",
    displayName: "Xero",
    category: "Accounting",
    track: "cloud",
    // WARP-2394 — NOTHING is shared between the two authentication paths, so
    // `credentialFields` is empty and every field lives on a variant.
    //
    // Xero is the vendor `CredentialVariant` was introduced for (WARP-2451,
    // `provider-descriptor.ts:298-320`) and it is the first descriptor to use
    // it. The two paths are not one flow with optional extras: a Custom
    // Connection is a paid, per-organisation app with a client SECRET and no
    // redirect at all, while a customer-owned PKCE app has *"no option to
    // generate a client secret"* and reaches an organisation through an
    // authorization-code redirect. Merging them would render a form asking for
    // a secret that cannot exist on one path and a redirect that is meaningless
    // on the other — which is exactly ADR-042 §4's "these are disjoint
    // variants, not optional fields".
    credentialFields: [],
    credentialVariants: [
      {
        id: "custom-connection",
        label: "Custom Connection (implemented)",
        description:
          "A paid, per-organisation Xero app you create in Xero's developer portal. " +
          "AU, NZ, UK and US only, and Xero bills you $10 AUD / £5 / $5 USD per month " +
          "for each organisation you connect.",
        fields: [
          {
            name: "clientId",
            label: "Xero client id",
            type: "string",
            required: true,
            // NOT secret, and stored where "where does this connection dial,
            // and as whom?" can be answered without decrypting anything —
            // ADR-042 §5's rule for non-secret connection facts. An OAuth
            // client id is a public identifier; only the secret half is a
            // credential.
            secret: false,
            storage: "providerConfig",
            help: "Shown on the Custom Connection's page in Xero's developer portal.",
          },
          {
            name: "clientSecret",
            label: "Xero client secret",
            type: "string",
            required: true,
            secret: true,
            storage: "encrypted",
            // Deliberately NO `pattern`. Stripe's `^rk_` and HubSpot's `^pat-`
            // are refusals of a MORE-PRIVILEGED credential the vendor also
            // issues (ADR-042 §4); Xero issues exactly one shape of client
            // secret and publishes no format for it, so a regex here could
            // only reject a valid secret a future rotation happens to produce.
            // The variant discriminator is what makes a wrong-path credential
            // impossible, not a shape check.
            help:
              "Generate it on the same page and copy it immediately — Xero shows it once. " +
              "Rotating it is a re-paste here; Droplet cannot rotate what it did not mint.",
          },
        ],
      },
      {
        id: "pkce-app",
        label: "Customer-owned PKCE app (not implemented)",
        description:
          "Declared so the choice is visible and a row can record it, but NOT built: it " +
          "needs an authorization-code redirect this appliance has no inbound path for. " +
          "Choosing it is refused at connect time with a message saying so.",
        // Client id ONLY. ADR-042 §2 records that this Xero app type has "no
        // option to generate a client secret", and §4 makes a Path B config
        // carrying a secret a refusal rather than a tolerated extra. Declaring
        // no secret field is what makes that unrepresentable instead of merely
        // discouraged.
        fields: [
          {
            name: "clientId",
            label: "Xero client id",
            type: "string",
            required: true,
            secret: false,
            storage: "providerConfig",
            help: "This path is not implemented; see the setup guide for the supported one.",
          },
        ],
      },
    ],
    // Both as FULL-STRING literals in the connector
    // (`services/erp-connector/src/xero/connector.ts`), which is what the
    // static egress scanner extracts; these bare hosts are the descriptor's
    // half of the same registration (WARP-2399 / WARP-2403).
    egressHosts: ["api.xero.com", "identity.xero.com"],
    // WARP-2414 — mirrors `XERO_DATASETS`. Reconciled BY COLUMN LIST against
    // `export-drop/profiles.ts` rather than by name, per that file's rule:
    // an ACCREC invoice and an ACCPAY bill are the canonical `invoice`/`bill`
    // shapes, and a Xero contact is the canonical `contact` (a party that may
    // have bought nothing and carries no money of its own) rather than the
    // commerce `customer`, whose `orders_count` / `total_spent_amount` /
    // `currency` a Xero contact has no source for.
    datasets: ["invoice", "bill", "contact"],
    rateLimit: {
      // Xero's per-TENANT daily ceiling. The per-minute limit (60) and the
      // app-wide pooled one (10,000/min across the whole fleet) are real and
      // are handled where they can be: the fleet pool by the per-box schedule
      // jitter (`erp-sync/schedule-jitter.ts`, which names this exact number),
      // and the minute limit by the 4-hour cadence below — a tick costs a
      // handful of calls, so a minute is never the binding constraint.
      // `CallBudget` models spend over a period, which is what the daily
      // number is; expressing the minute rate here instead would make the
      // budget refuse a healthy tick.
      callCeiling: 5_000,
      periodMs: 24 * 60 * 60 * 1000,
    },
    // WARP-2417 — four hours, and the first floor on this track that is a
    // POLICY rather than a vendor-published number. It bounds the egress bill:
    // Xero's daily allowance is per tenant and its minute allowance is shared
    // across the fleet, and an accounting ledger does not change on a
    // fifteen-minute timescale in a business small enough to buy this box.
    // `claimDueErpCursors` enforces it, jittered per box.
    pollIntervalFloorMs: 4 * 60 * 60 * 1000,
    catalog: {
      id: "xero",
      name: "Xero",
      category: "Accounting",
      description:
        "Invoices, bills and contacts read from one Xero organisation — never written to.",
      availability: "available",
      // WARP-2451 — REQUIRED by the type for an `available` cloud track. Xero
      // needs it more than any other card: the guide is where the customer
      // learns the connection is unavailable outside AU/NZ/UK/US and that Xero
      // bills them per organisation. Served from `docs/integrations/xero.md`.
      setupGuideHref: "/help/integrations/xero",
      order: 8,
    },
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
 * Providers with a shipped transport — the descriptor-derived replacement for
 * the hand-maintained `KNOWN_ERP_PROVIDERS`.
 *
 * Excludes `catalog` tracks: a placeholder card is not something a connection
 * row may name.
 */
export function buildableProviderIds(): readonly string[] {
  return providerDescriptors()
    .filter((d) => d.track !== "catalog")
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
