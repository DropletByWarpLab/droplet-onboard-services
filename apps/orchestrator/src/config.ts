import { z } from "zod";

// WARP-580 — production JWT-secret strength guard. A production boot must
// reject a secret that is too short OR is one of the shipped dev placeholders
// (a copy-paste from .env.example is the realistic foot-gun). setup.sh mints a
// 64-byte hex value, so a real deployment clears 32 chars with room to spare.
const JWT_SECRET_MIN_LENGTH = 32;
const KNOWN_DEV_JWT_SECRETS: readonly string[] = [
  "dev-jwt-secret-do-not-use-in-production",
  "changeme",
  "secret",
  "your-secret-here",
];

/** PURE — true when `s` is unfit for production use. Exported for tests. */
export function isWeakJwtSecret(s: string): boolean {
  return s.length < JWT_SECRET_MIN_LENGTH || KNOWN_DEV_JWT_SECRETS.includes(s);
}

/** PURE — resolve the agent iteration limits, clamping DEFAULT down to CAP
 *  when misconfigured: a bad env must not silently break chat. A
 *  misconfigured env clamps with a structured warning instead of crashing
 *  boot or silently misbehaving. Exported for tests. */
export function resolveAgentIterLimits(
  defaultIter: number,
  capIter: number,
  // Constructed lazily, via a DYNAMIC import — config.ts is on nearly every
  // orchestrator module's import graph (including test setup's
  // column-crypto.service.ts → config.ts chain), so even a plain top-level
  // `import { createLogger } from "./lib/logger.js"` here would load
  // logger.ts's own top-level `import pino from "pino"` before the actual
  // misconfigured-env path ever runs. That eager, unconditional pino require
  // gets cached by Node's module loader ahead of any given test file's own
  // `vi.mock("pino", ...)`, so the mock never takes — breaking every test
  // that mocks pino and asserts on its call history (model-readiness,
  // auth-throttle test suites). A dynamic import defers loading logger.js
  // until this default actually runs (the rare misconfigured-env path, which
  // no test exercises through the default), keeping pino out of config.ts's
  // module graph entirely.
  warn: (msg: string) => void = (msg) => {
    void import("./lib/logger.js").then(({ createLogger }) =>
      createLogger("config").warn(msg),
    );
  },
): { defaultIter: number; capIter: number } {
  if (defaultIter > capIter) {
    warn(
      `config: AGENT_MAX_ITER_DEFAULT (${defaultIter}) exceeds ` +
        `AGENT_MAX_ITER_CAP (${capIter}); clamping default to ${capIter}`,
    );
    return { defaultIter: capIter, capIter };
  }
  return { defaultIter, capIter };
}

// WARP-580 (part 2) — device/service secrets a PRODUCTION boot must carry
// non-empty. Their schema defaults are "" so dev laptops + the vitest suite
// run with zero env setup, but on a shipped box an empty value means either a
// torn/ancient .env or a hand-rolled deployment that skipped setup.sh — and
// the failure would otherwise surface later as a mystery (unencryptable
// device credentials, every service hop 401ing). scripts/lib/secrets.sh
// generates ALL of these (generate_env for fresh installs, migrate_env
// backfills upgrades), so a provisioned device always passes this gate.
//
// Scope: DEVICE_SECRET_KEY (the FIPS-sealed master encryption key) + every
// SERVICE_TOKEN_* declared in the schema. Deliberately NOT the optional
// integration secrets (ROUTING_SERVICE_TOKEN, DROPLET_SCIM_BEARER_TOKEN, …)
// whose emptiness is a documented fail-closed feature posture.
export const PRODUCTION_REQUIRED_SECRET_KEYS: readonly string[] = [
  "DEVICE_SECRET_KEY",
  "SERVICE_TOKEN_SWITCH",
  "SERVICE_TOKEN_AI_GATEWAY",
  "SERVICE_TOKEN_VOICE",
  "SERVICE_TOKEN_MCP",
  "SERVICE_TOKEN_EMAIL",
  "SERVICE_TOKEN_EGRESS_AUDIT",
];

// `.env.example` ships `change-me` for DEVICE_SECRET_KEY — a copy-pasted
// example file must fail the gate exactly like an empty value would.
const PLACEHOLDER_SECRET_VALUES: ReadonlySet<string> = new Set(["change-me"]);

/**
 * PURE — the subset of PRODUCTION_REQUIRED_SECRET_KEYS whose value in `env`
 * is missing, empty/whitespace, or a known placeholder. Exported for tests.
 */
export function findEmptyProductionSecrets(
  env: Record<string, unknown>,
): string[] {
  return PRODUCTION_REQUIRED_SECRET_KEYS.filter((key) => {
    const v = env[key];
    if (typeof v !== "string") return true;
    const trimmed = v.trim();
    return trimmed === "" || PLACEHOLDER_SECRET_VALUES.has(trimmed);
  });
}

/**
 * WARP-580 — resolve the EFFECTIVE auth posture (fail-closed).
 *
 * Auth is on unless an operator EXPLICITLY opts out in a non-production
 * environment. We read the LITERAL env string here rather than zod's coerced
 * boolean: `z.coerce.boolean()` runs JS `Boolean(...)`, so the string "false"
 * (non-empty) coerces to TRUE — it cannot represent an explicit opt-out. The
 * opt-out is therefore an explicit falsey token ("false"/"0"/"no"/"off",
 * case-insensitive); anything else (including an absent var) stays ON. In
 * production we force-ON regardless of the var, so the middleware's
 * owner-injection-when-disabled branch can never fire on a shipped box even if
 * `.env` carries a stale `AUTH_ENABLED=false`.
 */
const FALSEY_ENV_TOKENS: ReadonlySet<string> = new Set(["false", "0", "no", "off"]);
export function resolveAuthEnabled(
  rawAuthEnv: string | undefined,
  nodeEnv: string,
): boolean {
  // Production: fail-closed — auth is always on.
  if (nodeEnv === "production") return true;
  // Non-production: honour an EXPLICIT falsey opt-out only. An unset var stays ON.
  if (rawAuthEnv !== undefined && FALSEY_ENV_TOKENS.has(rawAuthEnv.trim().toLowerCase())) {
    return false;
  }
  return true;
}

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://droplet:droplet@localhost:5432/droplet"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  MQTT_BROKER: z.string().default("mqtt://localhost:1883"),
  // WARP-236 — internal service-to-service mTLS. Defaults keep dev/CI on plain
  // HTTP. WARP-1061 wired the mesh end-to-end: scripts/setup.sh writes the
  // knob (default "0") into every .env, compose delivers it + the per-service
  // bundles, and BOTH halves of every first-party hop (nginx proxy_ssl, the
  // FastAPI/uvicorn listeners, ai-gateway gRPC, this service's listener +
  // clients) key on it — an operator flips it to "1" and recreates the stack.
  // See docs/security/internal-mtls.md "Enforcement matrix".
  DROPLET_INTERNAL_TLS: z.string().default("0"),
  DROPLET_TLS_CERT: z.string().default("/data/service-tls/cert.pem"),
  DROPLET_TLS_KEY: z.string().default("/data/service-tls/key.pem"),
  DROPLET_TLS_CA: z.string().default("/data/service-tls/ca.pem"),
  AI_GATEWAY_URL: z.string().default("http://localhost:8000"),
  // WARP-1118 (§10) — the local model's effective context window in tokens,
  // read by the orchestrator's request-size estimator (context-budget.service.ts)
  // to PREVENT (not merely detect) the WARP-854 overflow. Mirrors the bundled
  // Ollama's own `OLLAMA_CONTEXT_LENGTH`: the compose file already sets both to
  // 16384 (the WARP-854 fix — Ollama's baked-in 4096 default is overflowed by
  // the owner-role tool schemas alone, which surfaced as instant empty chat
  // answers). Keep this equal to the deployed Ollama window so the estimator
  // doesn't degrade blocks the model could actually carry. This configures the
  // window only — it is NOT a model swap and does not touch the One-Model Rule.
  OLLAMA_CONTEXT_LENGTH: z.coerce.number().int().positive().default(16384),
  // Agent step-budget knobs (2026-07-21 agent-budgets spec §1). DEFAULT is
  // the per-turn iteration count when the caller sends no `max_iter`; CAP is
  // the ceiling both the /api/llm/chat zod schema and the agent loop's clamp
  // enforce. Both enforcement points read the SAME resolved value
  // (config.agentMaxIter) so they can never drift. `.positive()`: zero
  // iterations is meaningless, so zod rejects it at boot.
  //
  // DEFAULT is 10 per the 2026-07-21 staging tuning sweep (spec §6 phase 2,
  // staging-seed/eval/findings-2026-07-21-tuning.md): 23/36 twice-confirmed
  // vs 21 at the old default 5, iteration_limit endings 4→0, and four
  // previously-unpassable eval rows converting at 6-10 iterations — while
  // typical turns still finish in ~3.6 iterations, so the raised budget
  // costs nothing on easy turns. Only hard rows use the depth.
  AGENT_MAX_ITER_DEFAULT: z.coerce.number().int().positive().default(10),
  AGENT_MAX_ITER_CAP: z.coerce.number().int().positive().default(10),
  // WARP-1479 — include a bounded 500-char excerpt of the RAW model
  // completion in the blank-answer diagnostics. Off by default: that raw
  // text can quote corpus content (the model was mid-answer about the
  // user's own files), so it is opt-in for a debugging window and the
  // counts/labels alongside it are always safe to log.
  AGENT_BLANK_TURN_DEBUG: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.trim().toLowerCase() === "true"),
  // Spec §3 — relevance-based tool selection kill switch. "off" (default)
  // advertises the full effective pool exactly as before; "domains" narrows
  // per-turn via tool-selection.service.ts. The shipped default flips only
  // after the spec §6 phase-3 eval says so.
  // WARP-1921 — agent-budgets §3 relevance-based tool advertisement.
  // "domains" narrows each turn to the core set + keyword-matched domains
  // (+ domains already used in the conversation); "off" advertises the whole
  // chat scope and is the rollback.
  //
  // Shipped default flipped off → domains. The §6 phase-3 cell already scored
  // 24/36 — best of the 2026-07-21 sweep, zero self-heals, zero degradation
  // drops — and was held only by the cross-turn continuity gap, which
  // WARP-1921 closes (ChatPersistenceService.getConversationToolNames).
  // Measured effect: ~12.7K tokens of tools[] on EVERY turn drops to ~2.6K on
  // a camera turn, returning ~10K tokens to history and cutting prompt
  // prefill 3-5x on the box's local GPU.
  TOOL_SELECTION_MODE: z.enum(["off", "domains"]).default("domains"),
  // WARP-1122 (§8.2/§5-11) — the business-profile refresh nudge. Enabled-ness
  // is an EXPLICIT boolean, never derived from the days var's emptiness.
  BUSINESS_PROFILE_REVIEW_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "1" || v.trim().toLowerCase() === "true"),
  // `.nonnegative()` (not `.positive()`): 0 is a VALID interval meaning
  // "review on every daily check / immediate" — the reviewer-notes DoD boots
  // with BUSINESS_PROFILE_REVIEW_DAYS=0 to verify the nudge, and config.ts
  // `.parse()`s (not safeParse), so rejecting 0 would crash boot. The consumer
  // (business-review-nudge.service) uses this as a subtraction offset for the
  // staleness cutoff, so 0 → cutoff===now → any past `updatedAt` fires; there
  // is no division, so 0 needs no extra guard. Negatives stay rejected (a
  // negative interval would push the cutoff into the future and never fire).
  BUSINESS_PROFILE_REVIEW_DAYS: z.coerce.number().int().nonnegative().default(90),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(100),

  // --- CORS (WARP-562) ---
  // Comma-separated allowlist of browser Origins permitted to make
  // credentialed cross-origin requests against the orchestrator API. We keep
  // `credentials: true` (cookie-based `droplet_session` auth), so the allowlist
  // MUST be exact-match — never `origin: true`, which reflects any Origin and
  // hands `Access-Control-Allow-Origin: <attacker>` +
  // `Access-Control-Allow-Credentials: true` to any site the owner visits.
  //
  // Parsed into `config.corsAllowedOrigins` below. When unset it defaults to
  // the appliance's LAN dashboard origin (https://droplet-ai.local — already
  // covered by the TLS cert SANs, see scripts/lib/secrets.sh) plus
  // http://localhost:3000 in non-production for
  // the Next.js dev server. A `*` value is rejected at startup (see the
  // wildcard guard after parse), mirroring services/ai-gateway/main.py.
  CORS_ALLOWED_ORIGINS: z.string().default(""),

  // --- Nextcloud (single file storage backend) ---
  NEXTCLOUD_URL: z.string().default("http://localhost:8080"),
  // NEXTCLOUD_PUBLIC_PATH — browser-facing path the gateway fronts Nextcloud
  //   on (nginx `location /nextcloud/`). Used for URLs the dashboard's
  //   browser actually loads (the doc-editor iframe) — NEXTCLOUD_URL above is
  //   the compose-internal address (http://nextcloud:80), which a browser can
  //   never resolve (WARP-1686 fix to the WARP-882 editorUrl host).
  NEXTCLOUD_PUBLIC_PATH: z.string().default("/nextcloud"),

  // WARP-883 (ADR-027 WS-5) — name of the shared "Household" group folder
  // (Nextcloud `groupfolders` app). The groupfolders app mounts this folder
  // into every member's Nextcloud home as a top-level directory, so the
  // dashboard's "Shared" space is simply this well-known path prefix browsed
  // with the user's OWN WebDAV token — no separate account or WebDAV root.
  // The provisioning hook (docker/nextcloud-init.sh) creates the group folder
  // under this exact name and the files route hides it from the My-Files root
  // so it isn't shown twice. Deliberately NOT a `MATTER_*` var (no matter.js
  // collision); plain string, default "Household".
  DROPLET_SHARED_FOLDER_NAME: z.string().min(1).default("Household"),
  // WARP-580 — auth is FAIL-CLOSED. The default is `true`; the only way to run
  // with auth off is an EXPLICIT `AUTH_ENABLED=false` AND a non-production
  // NODE_ENV (see resolveAuthEnabled below). A bare/missing var, or `=false`
  // in production, both resolve to auth ENABLED. The middleware's
  // owner-injection-when-disabled path (middleware/auth.ts) therefore can
  // never fire in production. Parsed here as the raw operator INTENT; the
  // effective value is `config.AUTH_ENABLED` after resolveAuthEnabled.
  AUTH_ENABLED: z.coerce.boolean().default(true),

  // --- Device pairing ---
  // 32-byte base64 key used to encrypt per-device Nextcloud app passwords
  // at rest. Generated by scripts/setup.sh alongside other secrets. Empty
  // default lets tests run without setting the env var; production fails
  // closed via encryption.service.ts when the key is missing.
  DEVICE_SECRET_KEY: z.string().default(""),

  // WARP-242: path to the doc-KEK master keyfile (raw 32 bytes, mode 0600,
  // minted by scripts/setup.sh as data/secrets/doc-kek.key and single-file
  // bind-mounted read-only). Deliberately a FILE and never an .env value:
  // .env ships inside every restic snapshot, so a KEK carried there would
  // make snapshots self-decrypting and per-document crypto-shred would not
  // survive backups. The file is excluded from the backup set
  // (droplet-backup.sh); TPM-sealing it is WARP-1033. Read lazily by
  // column-crypto.service.ts at first encrypt/decrypt — fails closed with a
  // pointer to setup.sh when missing.
  DOC_KEK_PATH: z.string().default("/data/secrets/doc-kek.key"),

  // --- Matter (host-network sidecar client, WARP-850) ---
  //
  // DO NOT ADD NEW `MATTER_*` ENV VARS — ANYWHERE IN THE STACK.
  //
  // matter.js scans the entire process.env for `MATTER_*` at startup
  // (NodeJsEnvironment.js → vars.addUnixEnvStyle(process.env)) and folds
  // each one into its internal VariableService under a dot-namespaced
  // key (`MATTER_CONTROLLER_NAME` → var `controller.name`), which can
  // collide with root-node behavior schemas and crash controller init
  // with UnsupportedCastError. matter.js no longer runs in THIS process
  // — it moved to services/matter-controller (WARP-850) — but the rule
  // still applies there, and scripts/test-security.sh enforces it
  // repo-wide. `MATTER_STORAGE_PATH` is the single allow-listed
  // survivor and now lives in the sidecar's env (it deliberately folds
  // to matter.js's `storage.path`, pointing the fabric storage at the
  // matter-data volume).
  //
  // The orchestrator is now an HTTP client of the sidecar
  // (services/matter.service.ts). Same host-gateway rationale as
  // ROUTING_SERVICE_URL: the sidecar runs with `network_mode: host`
  // (raw HCI for BLE + native LAN mDNS), so the bridged orchestrator
  // reaches it via host.docker.internal on the host-service port
  // ladder (routing 8080, switch 8081, display 8082 → matter 8083).
  DROPLET_MATTER_SERVICE_URL: z
    .string()
    .default("http://host.docker.internal:8083"),
  // Shared bearer presented in the X-Droplet-Auth header (device-bridge
  // precedent). Generated by scripts/setup.sh into .env; the sidecar
  // fails closed (401s everything) when its copy is empty. Rotate both
  // sides in lockstep — orchestrator + matter-controller read the same
  // .env key via compose.
  DROPLET_MATTER_SERVICE_TOKEN: z.string().default(""),

  // --- JWT ---
  // In production this must be set — setup.sh generates a 64-byte random hex value.
  // The default is intentionally weak so tests work without env setup.
  //
  // WARP-580 — production secret-strength guard. In production the secret must
  // be at least JWT_SECRET_MIN_LENGTH chars AND must not match any known dev
  // placeholder. Outside production the weak default is allowed so tests + dev
  // laptops run without env setup. The refine runs at parse time (config load),
  // so a misconfigured production boot dies loud before serving a request.
  JWT_SECRET: z
    .string()
    .default("dev-jwt-secret-do-not-use-in-production")
    .refine(
      (s) => process.env.NODE_ENV !== "production" || !isWeakJwtSecret(s),
      `JWT_SECRET must be a strong random value in production (at least ${JWT_SECRET_MIN_LENGTH} characters and not a dev placeholder)`,
    ),

  // --- WARP-247: session management hardening (NIST 800-63B) ---
  // All values in SECONDS except the cap. Admin-class = owner|admin roles;
  // user-class = family|guest. Idle timeouts are SLIDING (any authenticated
  // request resets the clock, write-throttled to 30 s granularity); the
  // absolute timeout is FIXED from login and is never extended by activity
  // or token refresh. The cap evicts the OLDEST session at login (audited).
  // Enforced via Redis session records (services/session.service.ts) keyed
  // by the JWT `sid` claim.
  SESSION_IDLE_TIMEOUT_ADMIN_SECONDS: z.coerce.number().default(15 * 60),
  SESSION_IDLE_TIMEOUT_USER_SECONDS: z.coerce.number().default(60 * 60),
  SESSION_ABSOLUTE_TIMEOUT_SECONDS: z.coerce.number().default(8 * 60 * 60),
  SESSION_MAX_CONCURRENT_PER_USER: z.coerce.number().default(5),

  // --- OAuth2 ---
  AUTH_MODE: z.enum(["oauth2", "legacy"]).default("legacy"),
  OAUTH2_CLIENT_ID: z.string().default(""),
  OAUTH2_CLIENT_SECRET: z.string().default(""),

  // --- SSO (external-IdP OIDC: Google Workspace + Microsoft Entra) ---
  // ADR-013 (PR #378). The orchestrator acts as an OIDC RELYING PARTY here.
  // One group of four vars per provider; ALL FOUR must be set for that provider's
  // SSO button to go live (getOidcProviderConfig fails closed otherwise —
  // half-configured providers render disabled). Empty defaults keep tests +
  // un-configured appliances from minting half-built authorize URLs.
  //
  // The CLIENT_SECRET values are real provider secrets — they live ONLY in
  // `.env` (populated by the operator / setup.sh; never tracked) exactly like
  // OAUTH2_CLIENT_SECRET. They are read here
  // and never re-emitted, never logged.
  //
  // ISSUER is the provider's discovery base; openid-client appends
  // /.well-known/openid-configuration and pulls the JWKS from it (ID-token
  // signature validation). No host is hardcoded in code — the issuer is the
  // single source.
  //   - Google:  https://accounts.google.com
  //   - Entra:   https://login.microsoftonline.com/<tenant>/v2.0
  //   - Okta:    https://<org>.okta.com/oauth2/<authServerId> (or the org
  //              root issuer when no custom authorization server is used)
  // REDIRECT_URI must exactly match the redirect registered at the IdP and the
  // /api/sso/oidc/callback route this orchestrator serves.
  DROPLET_SSO_GOOGLE_ISSUER: z.string().default(""),
  DROPLET_SSO_GOOGLE_CLIENT_ID: z.string().default(""),
  DROPLET_SSO_GOOGLE_CLIENT_SECRET: z.string().default(""),
  DROPLET_SSO_GOOGLE_REDIRECT_URI: z.string().default(""),
  DROPLET_SSO_ENTRA_ISSUER: z.string().default(""),
  DROPLET_SSO_ENTRA_CLIENT_ID: z.string().default(""),
  DROPLET_SSO_ENTRA_CLIENT_SECRET: z.string().default(""),
  DROPLET_SSO_ENTRA_REDIRECT_URI: z.string().default(""),
  // WARP — Okta SSO. Okta is a plain OIDC provider; the orchestrator reuses
  // the same authorize/callback RP path as Google/Entra (sso-oidc.service.ts
  // / routes/sso.ts). All four must be set for the Okta button to go live.
  DROPLET_SSO_OKTA_ISSUER: z.string().default(""),
  DROPLET_SSO_OKTA_CLIENT_ID: z.string().default(""),
  DROPLET_SSO_OKTA_CLIENT_SECRET: z.string().default(""),
  DROPLET_SSO_OKTA_REDIRECT_URI: z.string().default(""),

  // --- SCIM 2.0 directory provisioning (Okta pushes users/groups here) ---
  // WARP — Okta's SCIM client authenticates to /scim/v2/* with a DEDICATED
  // provisioning bearer token (NOT a user session, NOT one of the
  // SERVICE_TOKEN_* principals — those carry the `service` ROLE for inbound
  // LLM/tool calls; SCIM provisioning is a separate trust boundary with its
  // own secret and its own middleware). This is the SCIM bearer; it is
  // validated (constant-time) on EVERY SCIM request and NEVER logged.
  //
  // EMPTY DEFAULT = FAIL CLOSED: with no token configured, every /scim/v2/*
  // request 401s (scim-auth middleware refuses an unset secret), so an
  // appliance that hasn't been wired for directory sync never accepts an
  // unauthenticated — or empty-bearer — provisioning call. Lives ONLY in .env
  // (operator / setup.sh generates it); never tracked, never re-emitted.
  DROPLET_SCIM_BEARER_TOKEN: z.string().default(""),

  // --- gRPC ---
  AI_GATEWAY_GRPC_URL: z.string().default("localhost:50051"),

  // --- OpenWrt Routing ---
  // Default uses `host.docker.internal` so the bridged orchestrator can
  // reach the routing service, which runs with `network_mode: host` (bound
  // to the appliance host's :8080). `localhost` would be the orchestrator
  // container itself and never resolve to :8080. The orchestrator compose
  // service wires `host.docker.internal` via `extra_hosts: host-gateway`.
  ROUTING_SERVICE_URL: z.string().default("http://host.docker.internal:8080"),
  // Shared bearer token for routing service (generated by scripts/setup.sh).
  // Empty default lets tests and dev laptops run without setup; routing service
  // rejects empty tokens when its own value is set.
  ROUTING_SERVICE_TOKEN: z.string().default(""),
  // WARP-44: `real` (default) talks to the routing service normally.
  // `mock` is equivalent on the orchestrator side — routing itself is
  // configured to serve fixtures.
  // `disabled` short-circuits every openwrt.client call with
  // RouterError.disabled() so the dashboard renders a "Router supervision
  // disabled" banner instead of spamming retries at a non-existent service.
  ROUTING_MODE: z.enum(["real", "mock", "disabled"]).default("real"),

  // KAN-8: the OpenWrt sysupgrade image this build pins for the router
  // firmware-check + upgrade path (multi-box / PRIMARY_ROUTER shape only). The
  // version embedded in this name is what /network/system/firmware-check
  // compares the running release against. Empty default → firmware-check
  // reports an undetermined pinned version (never a guessed "up to date"), and
  // there is no image to flash. The name follows the upgrade-router.sh
  // convention, e.g. `openwrt-24.10.0-droplet-squashfs-sysupgrade.img.gz`.
  ROUTER_FIRMWARE_IMAGE: z.string().default(""),

  // --- WireGuard / Remote Access ---
  // Hostname or IP that peer .conf files use as their `Endpoint`. Should be
  // reachable from outside the LAN — typically your home router's public IP
  // or another operator-set public DNS name. For inside-LAN testing you can
  // set this to the OpenWrt LAN IP (192.168.50.1). Empty default makes the orchestrator
  // refuse to mint peers with a clear error rather than handing out unusable
  // configs that point at "example.com" or similar.
  WIREGUARD_ENDPOINT_HOST: z.string().default(""),
  // VPN tunnel subnet. The server takes .1, peers get .2 through .254. Must
  // not collide with the LAN (192.168.50.0/24) or cameras (192.168.100.0/24).
  WIREGUARD_VPN_SUBNET: z.string().default("10.13.13.0/24"),
  WIREGUARD_LISTEN_PORT: z.coerce.number().default(51820),
  // CIDR + DNS server that the rendered peer .conf advertises to the client.
  // Defaults match the OpenWrt LAN. Override if the LAN is reconfigured.
  WIREGUARD_LAN_CIDR: z.string().default("192.168.50.0/24"),
  WIREGUARD_DNS: z.string().default("192.168.50.1"),
  // --- Home-mode remote access (hybrid P1) ---
  // A HOME-mode peer dials the box DIRECTLY at its home-network-facing LAN IP
  // (no server, no public inbound — the foundation-clean path). Over that
  // tunnel the client resolves the per-device FQDN through the box's own
  // split-horizon dnsmasq so the padlock works, exactly as ADR-023 §3.4
  // describes (the box answers the FQDN with 192.168.20.1 for tunnel clients).
  // These values shape the home-mode .conf; the away-mode path is untouched.
  //
  // WIREGUARD_HOME_DNS — the split-horizon resolver the home-mode client points
  //   at over the tunnel. Single-box: the WireGuard gateway 192.168.20.1, the
  //   SAME address DROPLET_PUBLIC_FQDN_IP defaults to (they must agree so the
  //   FQDN resolves). Override on a LAN whose gateway differs.
  WIREGUARD_HOME_DNS: z.string().default("192.168.20.1"),
  // WIREGUARD_HOME_ALLOWED_IPS — the box subnet(s) a home-mode client routes
  //   over the tunnel. HOME mode is SPLIT-tunnel to the box (never 0.0.0.0/0):
  //   only the box services subnet (single-box br-lan 192.168.20.0/24) plus the
  //   VPN tunnel subnet, which is appended automatically from
  //   WIREGUARD_VPN_SUBNET. Comma-separated; override for a multi-box LAN.
  WIREGUARD_HOME_ALLOWED_IPS: z.string().default("192.168.20.0/24"),
  // WIREGUARD_HOME_ENDPOINT_HOST — explicit fallback for the box's home-facing
  //   LAN IP when live discovery (routing-service network summary) can't supply
  //   it. Empty (default) means "no fallback": a home-mode mint with no
  //   discovered IP fails with a clear 503 rather than emitting a conf pointed
  //   at a wrong guess. The box IP is DHCP, so there is intentionally no
  //   host-specific default here.
  WIREGUARD_HOME_ENDPOINT_HOST: z.string().default(""),
  // REMOTE_ACCESS_MODE — how a phone reaches this box from OUTSIDE the home
  // LAN (WARP-993). Drives the honest `offLanReachable` boolean on
  // /api/vpn/status so the dashboard never promises "from anywhere" it can't
  // keep:
  //   "fqdn"  (default) — the per-device FQDN resolves only via the box's own
  //           split-horizon DNS (ADR-023 §3, no public A record). The minted
  //           WireGuard conf works on the home LAN but is NOT reachable from
  //           elsewhere.
  //   "relay" — the ADR-025 HQ relay is live and the endpoint is publicly
  //           routable. Flipping this is the relay rollout's job (WARP-974).
  REMOTE_ACCESS_MODE: z.enum(["fqdn", "relay"]).default("fqdn"),

  // --- Public-CA per-device TLS (ADR-023) ---
  // DROPLET_PUBLIC_FQDN — the opaque per-device subdomain
  //   `d-<hmac>.devices.warp-lab.ai`. The box CANNOT compute the HQ-keyed HMAC,
  //   so it learns this from the HQ challenge response and persists it back to
  //   .env (scripts/lib/secrets.sh). Empty until first HQ contact — the
  //   tls-issuance cron is a no-op while empty and the bootstrap self-signed
  //   cert keeps the box serving TLS. When set it is the TOP-priority canonical
  //   origin (trusted-origin.ts) and the one address that works at home AND
  //   over the WireGuard tunnel.
  DROPLET_PUBLIC_FQDN: z.string().default(""),
  // DROPLET_BOX_NAME — the owner-chosen box name (WARP-979). Set on the
  //   "Secured / name your box" setup step; becomes `<name>.droplet-us.com`
  //   (publicly-trusted, green padlock). Persisted to the host .env via the
  //   device-bridge (createBridgeBoxNamePersister), the SAME transport
  //   DROPLET_PUBLIC_FQDN uses. When set, tls-issuance sends it to HQ as the
  //   `requested_name` on the cert ORDER so HQ issues `<name>.droplet-us.com`
  //   instead of the opaque `d-<hmac>` fallback. Empty = no name chosen yet
  //   (the opaque-HMAC fallback stays in effect). The HQ device-authed name
  //   CLAIM is a coupled fleet-hq follow-up — until it lands, HQ may ignore
  //   requested_name and this is harmless.
  DROPLET_BOX_NAME: z.string().default(""),
  // DROPLET_PUBLIC_FQDN_IP — the IP the per-device FQDN resolves to via the
  //   split-horizon dnsmasq (ADR-023 C3). Defaults to the WireGuard gateway
  //   address 192.168.20.1, which is reachable on the single-box LAN AND over
  //   the tunnel, so the one FQDN works at home and remotely. The routing-leg
  //   registrar (createRoutingDnsRegistrar) POSTs {hostname, ip} to
  //   /dhcp/hostnames with this value; matches the host-leg default in
  //   scripts/lib/local-dns.sh::setup_public_fqdn_dns. Operators on a multi-box
  //   LAN whose box IP differs can override it.
  DROPLET_PUBLIC_FQDN_IP: z.string().default("192.168.20.1"),
  // HQ_ISSUANCE_URL — base URL of the fleet HQ issuance API
  //   (hq.warp-lab.com). Plain outbound HTTPS; does NOT require the fleet
  //   WireGuard tunnel. Empty disables live issuance (the cron skips), which is
  //   the correct posture for dev laptops + CI.
  HQ_ISSUANCE_URL: z.string().default(""),
  // DROPLET_PROVISION_TOKEN — one-time HQ-minted provisioning token (WARP-983).
  //   A fresh / factory-reset box has NO registry entry at HQ (factory-reset
  //   sends the ADR-023 signed deregister, which DELETES the device row), so on
  //   the next boot the tls-issuance challenge/order flow is rejected with 404
  //   `device_id not in registry` and the box would otherwise stay on the
  //   bootstrap self-signed cert forever. When this token is set, tls-issuance
  //   self-enrolls the box into the HQ registry (POST /api/issuance/provision
  //   with a TPM proof-of-possession over the token) on that 404, then retries
  //   issuance once. Empty (the default) = self-provision DISABLED — the correct
  //   posture for dev laptops + CI + a box that provisions via another path.
  //   PRESERVED from the provisioning environment across reflash (secrets.sh),
  //   the SAME way HQ_ISSUANCE_URL / TUNNEL_TOKEN are (WARP-978).
  DROPLET_PROVISION_TOKEN: z.string().default(""),
  // DROPLET_DEVICE_ID — the device's HQ registry id. Mirrors the value the
  //   device-identity sidecar reads (docker-compose.yml). Defaults to the
  //   hostname-derived `droplet` placeholder (matches scripts/lib/secrets.sh).
  DROPLET_DEVICE_ID: z.string().default("droplet"),

  // --- Direct-punch remote-access overlay (ADR-030 / WARP-1385) ---
  // OVERLAY_CONNECT_ENABLED — the box overlay connect agent (WARP-1767).
  //   Default TRUE. It was FALSE because the agent long-polls HQ's
  //   /api/overlay/* endpoints, which had not shipped yet, so polling would have
  //   404'd every tick. WARP-1384 deployed them and they answer, so the reason
  //   for the opt-in has expired — and while it persisted, the default silently
  //   meant no shipping box could be reached from outside at all. Set false to
  //   opt a box out (LAN-only); it changes nothing about home-LAN operation.
  //   Also requires HQ_ISSUANCE_URL (the agent shares that HQ base URL) and
  //   router supervision — index.ts gates on all three.
  OVERLAY_CONNECT_ENABLED: z
    .string()
    .transform((v) => v === "true" || v === "1")
    .default("true"),
  // Seconds between HQ long-poll ticks (event-driven; NOT a busy loop —
  // scheduled via cron-runtime). Bounded to keep the outbound heartbeat light.
  OVERLAY_CONNECT_POLL_SECONDS: z.coerce.number().int().min(2).max(300).default(15),
  // Hours an overlay peer may sit without a session OR an observed handshake
  // before the sweep revokes it. WARP-2060: overlay peers are CLIENT-initiated
  // — a phone that is simply away holds no endpoint on the box and is inert,
  // so an aggressive window buys no security and costs real breakage: at the
  // old 12h default a phone left home for a weekend came back to a silently
  // dead tunnel (row revoked, /profile 503s, owner re-approval required).
  // 720h (30 days) reaps genuinely abandoned enrollments; with the sweep's
  // handshake-sparing an active device is never reaped at any setting.
  OVERLAY_PEER_IDLE_EXPIRY_HOURS: z.coerce.number().int().min(1).max(720).default(720),

  // --- Coverage extender APs (WARP-446) ---
  // Per ADR-005. `DROPLET_AP_*` prefix is mandatory (see the long
  // MATTER_* warning above for why — same risk).
  //
  // DISCOVERY_INTERVAL — mDNS scan cadence in seconds. The orchestrator's
  //   discovery poller (cron-runtime.service.ts) queries
  //   `_droplet-ap._tcp.local` and upserts each new MAC into ApDevice.
  //   10s tracks new-AP-plugged-in within the 30s AC #1 budget.
  // APPROVAL_TIMEOUT — safe_apply timeout passed to the routing service
  //   on POST /aps/:mac/approve. 60s matches the rest of the codebase's
  //   confirmation-token TTL convention (WARP-41).
  // DAWN_ENABLED — master switch to disable dawn on every AP. Default on.
  //   Off only as a debugging escape hatch when an operator suspects
  //   dawn is the cause of an issue.
  // DEFAULT_TXPOWER — dBm cap on extender radios. Keeps household-floor
  //   cells small enough for clean roaming.
  DROPLET_AP_DISCOVERY_INTERVAL: z.coerce.number().default(10),
  DROPLET_AP_APPROVAL_TIMEOUT: z.coerce.number().default(60),
  DROPLET_AP_DAWN_ENABLED: z.coerce.boolean().default(true),
  DROPLET_AP_DEFAULT_TXPOWER: z.coerce.number().default(20),

  // --- ADR-024 multi-backend coverage APs (Phase 2) ---
  // Master switches for the third-party AP discovery backends. Both
  // default OFF — a single-box with no extenders ships exactly as today
  // (only the mDNS / DROPLET_IMAGE source runs). When off, the EasyMesh /
  // UniFi discovery sources return [] and contribute nothing.
  //
  // EASYMESH_ENABLED — turns on the IEEE 1905.1 discovery + prplMesh
  //   Controller-only onboarding path (ADR-024 §2). Real socket logic
  //   lands in Phase 4; this phase the source is a scaffold.
  // UNIFI_ENABLED — turns on the UBNT UDP 10001 discovery + UniFi Network
  //   API adoption path (ADR-024 §3). Real adapter lands in Phase 3.
  //
  // EXPLICIT string→bool (same idiom as DROPLET_CLAIM_GATE_ENABLED below):
  // z.coerce.boolean() would treat the non-empty strings "0"/"false" as
  // true and silently enable a backend. Only "1"/"true" enable it; an
  // absent var or anything else leaves it OFF.
  DROPLET_AP_EASYMESH_ENABLED: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.trim().toLowerCase() === "true"),
  DROPLET_AP_UNIFI_ENABLED: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.trim().toLowerCase() === "true"),

  // ADR-024 Phase 4 (§2) — the box runs prplMesh in CONTROLLER-ONLY mode (its
  // mt76 radio can't be an EasyMesh RF agent; the certified third-party AP is
  // the Agent). This points the orchestrator's EASYMESH backend at the LOCAL
  // prplMesh controller's ubus / IPC data-model endpoint (e.g. its
  // ubus-over-HTTP address or socket path). The controller is a loopback/LAN
  // local service, so this is an ADDRESS — not a secret — declared the same
  // plain-string-empty-default way as DROPLET_AP_UNIFI_CONTROLLER_URL.
  //
  // Empty default: an unconfigured box's EasyMesh client throws NOT_CONFIGURED,
  // but the discovery source only calls it when DROPLET_AP_EASYMESH_ENABLED is
  // on (default off), so a default single-box never touches it.
  DROPLET_AP_EASYMESH_CONTROLLER_URL: z.string().default(""),

  // ADR-024 Phase 3 (§3 + §"Open decision" Option B) — the box is a pure API
  // CLIENT to a UniFi Network controller the household ALREADY runs (a UDM /
  // CloudKey / self-host). We do NOT bundle or redistribute the controller;
  // these two vars point Droplet at the customer-supplied one.
  //
  // CONTROLLER_URL — local controller base URL (e.g. https://127.0.0.1:8443).
  //   Empty default: an unconfigured box's UniFi client throws NOT_CONFIGURED,
  //   but the discovery source only calls it when DROPLET_AP_UNIFI_ENABLED is
  //   on, so a default single-box never touches it.
  // API_KEY — **SECRET**. The official local API's API key (the 2024 key-auth
  //   surface; the legacy :8443 login-cookie flow is NOT used). Sourced from
  //   the secret store / .env, NEVER a tracked default — declared the same way
  //   as every other secret here (DROPLET_PM_WEBHOOK_SECRET, ROUTING_SERVICE_
  //   TOKEN, …): a plain string defaulting to empty. Never logged.
  DROPLET_AP_UNIFI_CONTROLLER_URL: z.string().default(""),
  DROPLET_AP_UNIFI_API_KEY: z.string().default(""),

  // --- Front-panel claim gate (WARP-165) ---
  // Physical-presence gate for POST /auth/setup: when ON, the first-owner
  // request must carry the claim code shown on the device's front panel
  // (verified read-only against the persisted ClaimCode — WARP-632/ADR-017
  // primitives), proving the operator is physically at the box and not merely
  // on its LAN. Closes the first-boot window where ANY LAN client could create
  // the owner before a physical operator does.
  //
  // DEFAULT OFF — a half-shipped gate (panel/firmware not yet present, or a
  // dashboard build that doesn't send the field) must never lock a user out of
  // their own box; existing setups stay back-compatible. Flip on only once the
  // panel CLAIM screen and the dashboard /setup code field both ship.
  //
  // EXPLICIT string→bool, NOT z.coerce.boolean(): coerce runs Boolean(...), so
  // the non-empty strings "0"/"false" would BOTH coerce to true and could
  // silently ENABLE the gate (a lockout foot-gun). Only "1"/"true" enable it;
  // anything else (including an absent var) leaves it OFF.
  DROPLET_CLAIM_GATE_ENABLED: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.trim().toLowerCase() === "true"),

  // WARP-586: retention window (days) for the append-only audit/log tables
  // ActivityRow, CommandAuditLog, NotificationLog. The daily 03:00 cron
  // (index.ts) deletes rows older than this. 90 days balances "enough
  // history for the dashboard's activity feed + an incident look-back"
  // against unbounded table growth. Set 0 to disable the purge entirely —
  // the safe "keep forever" stance, NOT a sentinel: 0 parses here and
  // audit-retention-purge.service.ts treats <= 0 as "skip" (defense in
  // depth). A negative window is nonsensical input, so the schema rejects
  // it at startup (fail fast) rather than silently treating it as disable;
  // .int() rejects sub-day floats and .finite() rejects Infinity.
  DROPLET_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).finite().default(90),

  // ── WARP-538: OTA update agent (WARP-534 epic) ──
  // RELEASES_URL — the GitHub Releases `latest` endpoint the update agent
  //   polls for cosign-signed OTA release manifests. Default is the
  //   canonical publisher (this repo's publish-release.yml); overridable
  //   for forks/mirrors and for the file-served fake in integration tests.
  // GITHUB_TOKEN — bearer for the private releases repo. Empty = send no
  //   Authorization header (public repos / the test fake). Injected via
  //   .env by setup.sh when fleet provisioning lands; never hardcoded.
  // POLL_INTERVAL — seconds between checks. 900 (15 min) per the design;
  //   floor of 60 keeps a typo'd "0" from hot-looping the GitHub API.
  DROPLET_OTA_RELEASES_URL: z
    .string()
    .url()
    .default(
      "https://api.github.com/repos/DropletByWarpLab/droplet-onboard-services/releases/latest",
    ),
  DROPLET_OTA_GITHUB_TOKEN: z.string().default(""),
  DROPLET_OTA_POLL_INTERVAL: z.coerce.number().int().min(60).finite().default(900),
  // WARP-539 — apply + health-gated swap + auto-rollback. The apply path is the
  // ONLY thing that drives the host Docker daemon, and only through the audited
  // host helper scripts/lib/apply-update.sh over the mounted compose socket
  // (docker/docker-compose.yml, orchestrator service ONLY — see the WARP-539
  // volume comment there).
  //   APPLY_SCRIPT   — absolute path to apply-update.sh as mounted in the
  //                    orchestrator container. Empty (the default) DISABLES the
  //                    apply window: the box still polls + tracks pending
  //                    releases, but never swaps containers. This is the correct
  //                    posture for dev laptops + CI (no host socket) and until
  //                    the compose socket mount is provisioned on a box.
  //   COMPOSE_FILE   — the compose file the helper drives. WARP-1669: this
  //                    path must be valid BOTH on the host and inside the
  //                    orchestrator container, because the compose CLI runs
  //                    in-container while the daemon resolves the file's
  //                    relative bind mounts on the host. docker-compose.yml
  //                    mounts the tree at its own host path (DROPLET_HOST_ROOT)
  //                    to satisfy that; the default below is only the
  //                    conventional install location.
  //   CONFIG_ROOT    — where a release's configs.tar.gz is extracted. CI packs
  //                    it as `docker/…` (`git archive HEAD docker`), so this is
  //                    the REPO ROOT, one level above the compose file. The
  //                    helper derives exactly that when this is unset.
  //   UPDATES_DIR    — root for <updateId>/{backup,configs.tar.gz}; the 7-day
  //                    backup GC (daily purge cron) reaps terminal-update dirs
  //                    under it. Maps to a named volume on the box.
  DROPLET_OTA_APPLY_SCRIPT: z.string().default(""),
  DROPLET_OTA_COMPOSE_FILE: z.string().default("/opt/droplet/docker/docker-compose.yml"),
  DROPLET_OTA_CONFIG_ROOT: z.string().default(""),
  DROPLET_OTA_UPDATES_DIR: z.string().default("/data/updates"),

  // Client-app downloads — the Droplet apps (Windows installer, Android APK,
  // iOS) the box hands to a customer's browser, staged INSIDE the appliance
  // image and mounted read-only (docker/docker-compose.yml, orchestrator).
  //   DIR                — root of the staged artifacts: catalog.json plus one
  //                        subdirectory per platform. A missing directory is a
  //                        legitimate state (dev boxes stage nothing) and the
  //                        surface degrades to "no apps available", never a 500.
  //   REQUIRE_SIGNATURE  — enforce the cosign signature over catalog.json.
  //                        OFF by default and that is deliberate: the OTA trust
  //                        anchor is still the WARP-535 placeholder, so turning
  //                        this on before the key ceremony makes every download
  //                        a 503. The always-on gate is the per-asset sha256
  //                        re-check in services/app-downloads/store.ts, which
  //                        works today; this flag exists so the ceremony can
  //                        upgrade the posture without a code change.
  //
  // EXPLICIT string→bool, NOT z.coerce.boolean(): coerce runs Boolean(...), so
  // the non-empty strings "0"/"false" would BOTH coerce to true — here that
  // would silently ENABLE the signature requirement against a placeholder
  // anchor and take every download offline. Only "1"/"true" enable it.
  DROPLET_APP_DOWNLOADS_DIR: z.string().default("/opt/droplet/app-downloads"),
  DROPLET_APP_DOWNLOADS_REQUIRE_SIGNATURE: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.trim().toLowerCase() === "true"),

  // WARP-808: which deployment shape broadcasts the home Wi-Fi AP. This is the
  // SAME knob the device-bridge reads (services/oled-display/device-bridge.py)
  // and that single-box.sh's configure_single_box_env upserts into .env.
  //   uci      — multi-box: a router-host OpenWrt holds the AP in UCI. Home
  //              Wi-Fi SSID/PSK writes go through the routing service (UCI/SSH),
  //              exactly as before. This is the back-compat default.
  //   hostapd  — single-box: the host runs a raw hostapd AP (no UCI), so a UCI
  //              write hits a nonexistent section (ubus NOT_FOUND → 500).
  //              network.service routes the SSID/PSK write through the
  //              device-bridge's POST /openwrt/wifi/hostapd instead.
  //   auto     — reserved for the bridge's auto-detect; the orchestrator treats
  //              anything other than "hostapd" as the UCI path (a box that wants
  //              the hostapd write path sets DROPLET_AP_MODE=hostapd explicitly,
  //              which single-box.sh does).
  // Defaulting to `uci` keeps every multi-box install behaving exactly as before.
  DROPLET_AP_MODE: z.enum(["uci", "hostapd", "auto"]).default("uci"),

  // --- Document server (WARP-882 / WS-4 — in-browser editing + co-authoring) ---
  // The Droplet integrates an OnlyOffice Document Server (the ENGINE) via the
  // Nextcloud connector app (`richdocuments` for collabora, `onlyoffice` for
  // onlyoffice) over a WOPI-style handshake. The engine is a CONFIG choice,
  // not a code dependency (docserver.client.ts stays engine-agnostic), so
  // swapping it needs only these vars (WARP-1686 / ADR-034).
  //
  // DOCS_INTERNAL_URL — internal (compose-network) base URL of the Document
  //   Server, e.g. http://docserver. EMPTY default = the engine is UNAVAILABLE:
  //   docServerHealthy() returns false and /files/docs/status reports
  //   "unavailable", so a box that hasn't enabled the `docs` compose profile
  //   degrades cleanly instead of dialing a non-existent host.
  DOCS_INTERNAL_URL: z.string().default(""),
  // DOCS_ENABLED — EXPLICIT master switch, deliberately NOT derived from
  //   DOCS_INTERNAL_URL emptiness (handbook "state is explicit, never inferred
  //   from absence"). Same string→bool idiom as DROPLET_CLAIM_GATE_ENABLED:
  //   z.coerce.boolean() would treat "0"/"false" as true. The OnlyOffice
  //   Document Server is DEFAULT-ON on the 32 GB box (AGPLv3 CE, ~2 GB image,
  //   which a 32 GB single-box absorbs comfortably), so this defaults to "1":
  //   scripts/lib/single-box.sh writes DOCS_ENABLED=1 + adds `docs` to
  //   COMPOSE_PROFILES above the small-box RAM threshold, and DOCS_ENABLED=0 +
  //   drops `docs` on a ≤8 GB box. Only "1"/"true" enable it; an explicit "0"
  //   (or "false"/"no"/"off") disables it on a small box.
  DOCS_ENABLED: z
    .string()
    .default("1")
    .transform((v) => v === "1" || v.trim().toLowerCase() === "true"),
  // DOCS_ENGINE — WHICH document engine runs behind the `docs` profile
  //   (WARP-1686 / ADR-034). Drives the engine-specific health-probe shape +
  //   the connector editor URL in docserver.client.ts; compose runs the
  //   matching image via DOCS_ENGINE_IMAGE and the gateway selects the /docs/
  //   proxy variant from the same knob (docker/nginx/docs-engine.*.conf) —
  //   scripts/lib/single-box.sh writes the trio together.
  //     collabora  (default) — Collabora CODE (LibreOffice technology, no
  //                licensing fee; connector app `richdocuments`).
  //     onlyoffice — OnlyOffice DS CE (connector app `onlyoffice`; kept for
  //                a future OEM-licensed SKU).
  DOCS_ENGINE: z.enum(["collabora", "onlyoffice"]).default("collabora"),
  // DOCS_EDITOR_PUBLIC_PATH — public path the gateway fronts the Document
  //   Server on (nginx `location /docs/`). Used to build browser-facing URLs;
  //   the WebSocket co-authoring channel rides this path.
  DOCS_EDITOR_PUBLIC_PATH: z.string().default("/docs/"),
  // DOCS_ACCESS_TOKEN_TTL_SECONDS — lifetime of the per-session editor access
  //   token. The dashboard refreshes before expiry. 30 min balances "long
  //   enough for a real editing session" against "short enough that a leaked
  //   token expires".
  DOCS_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  // ONLYOFFICE_JWT_SECRET — shared HS256 secret the Document Server, the
  //   Nextcloud connector, AND this orchestrator all verify. Generated by
  //   scripts/setup.sh into .env; lives ONLY there (never tracked), never
  //   logged. Empty default keeps tests/dev laptops running; the connector +
  //   engine reject unsigned requests when their copy is set.
  ONLYOFFICE_JWT_SECRET: z.string().default(""),

  // --- File indexer (WARP-287 re-index + WARP-598 health probe) ---
  FILE_INDEXER_URL: z.string().default("http://file-indexer:8090"),

  // --- ERP direct-SQL bridge (WARP-1106) ---
  // Compose-internal base URL of services/erp-sql-bridge, the unixODBC +
  // pyodbc sidecar that reaches a practice's SAP SQL Anywhere database (there
  // is no viable modern Node driver for it). Consumed by erp-provider.ts when
  // building the `eaglesoft` (direct-SQL) connector.
  //
  // The default is EMPTY, not the internal URL, and that is load-bearing: the
  // bridge is only useful once an operator has vendored the license-gated SAP
  // client into the image (services/erp-sql-bridge/vendor/README.md). With no
  // URL the connector blocks with the accurate "needs the SAP SQL Anywhere
  // client" remediation; pointing it at a bridge that exists but has no driver
  // would instead report a connection failure and send an installer looking
  // for a network problem that isn't there. The REST track (`eaglesoft-api`)
  // ignores this entirely.
  ERP_SQL_BRIDGE_URL: z.string().default(""),

  // --- ERP export-drop track (WARP-1964) ---
  // ERP_EXPORT_DROP_ROOT — the directory the practice's own PMS report exports
  // land in, typically a read-only CIFS mount of a share on the practice LAN.
  //
  // This is OPERATOR configuration and never request input, deliberately: a
  // caller-supplied filesystem path on a connect call would hand anyone who can
  // edit a connection an arbitrary-file read inside the orchestrator. A
  // per-practice subdirectory can come off the connection row, and is validated
  // for containment against this root.
  //
  // Empty by default, mirroring ERP_SQL_BRIDGE_URL: with nothing configured the
  // export-drop connector blocks with its own remediation ("point me at a
  // folder") rather than reporting a failure about a track the box is not
  // running.
  ERP_EXPORT_DROP_ROOT: z.string().default(""),

  // ERP_EXPORT_DROP_PROFILES — path to a JSON file of operator-authored export
  // profiles (header signature -> canonical columns). This is what lets an
  // install map a practice-management system we ship no built-in profile for,
  // or correct a built-in whose columns do not match that site's report layout,
  // without waiting for a release. See docs/integrations/export-drop.md.
  ERP_EXPORT_DROP_PROFILES: z.string().default(""),

  // --- Ambient web data (WARP-1436) ---
  // WEB_FETCH_URL — compose-internal base URL of the services/web-fetch
  // allowlisted fetcher (weather via api.open-meteo.com, currency rates
  // via www.ecb.europa.eu). Fronted by GET /api/web/weather + /rates,
  // which gate every call on the `ambient_data` off-LAN channel.
  WEB_FETCH_URL: z.string().default("http://web-fetch:8010"),
  // WEB_FETCH_SERVICE_TOKEN — outbound bearer for /api/web/* → web-fetch.
  // Optional (minted by setup.sh like the other SERVICE_TOKEN_* secrets);
  // when unset the /api/web routes fail CLOSED with 502 rather than call
  // the fetcher unauthenticated.
  WEB_FETCH_SERVICE_TOKEN: z.string().default(""),

  // --- Frigate NVR ---
  FRIGATE_URL: z.string().default("http://localhost:5000"),
  CAMERA_DISCOVERY_URL: z.string().default("http://localhost:8085"),

  // --- Managed Switch ---
  // Same rationale as ROUTING_SERVICE_URL above: switch runs with
  // `network_mode: host`, so the bridged orchestrator must reach it via
  // the host gateway.
  SWITCH_SERVICE_URL: z.string().default("http://host.docker.internal:8081"),

  // --- OLED / TFT Display ---
  // Same rationale again: the display service runs with `network_mode: host`
  // on the appliance (uvicorn on :8082). `localhost` inside the orchestrator
  // container would never resolve to it, so default to the host gateway.
  DISPLAY_SERVICE_URL: z.string().default("http://host.docker.internal:8082"),

  // --- Device-bridge (host-side wifi/drives/QR API) ---
  // The device-bridge (services/oled-display/device-bridge.py) runs on the
  // host (systemd, port 9090) and serves the auto-mounted drive snapshot
  // (storage.ts) and the Wi-Fi/pairing QR (screen-qr.service.ts). Same
  // host-gateway rationale as the URLs above: the orchestrator is on the
  // bridge network, so `localhost`/`172.17.0.1` (docker0 — DOWN on the
  // single-box, whose gateway is 172.18.0.1) never reach the host bridge.
  // `host.docker.internal` resolves via the orchestrator's
  // `extra_hosts: host-gateway` mapping and IS reachable — but ONLY once the
  // bridge binds an interface the gateway can hit (BRIDGE_BIND=0.0.0.0 in
  // droplet-device-bridge.service; a 127.0.0.1 bind refuses the gateway
  // connection). This single key replaces the two divergent hardcoded
  // defaults storage.ts (BRIDGE_URL → 172.17.0.1) and screen-qr
  // (DEVICE_BRIDGE_URL) used to carry. `BRIDGE_URL` is honored as a
  // backward-compatible alias for any deployment that already set it.
  DEVICE_BRIDGE_URL: z.string().default("http://host.docker.internal:9090"),

  // --- Service-to-service auth (shared secret for routing/switch/discovery services) ---
  SERVICE_SECRET: z.string().default(""),

  // SERVICE_TOKEN_SWITCH — dedicated outbound bearer for switch.client.ts →
  // switch service, replacing the legacy shared SERVICE_SECRET on that path
  // (same per-service-token shape as SERVICE_TOKEN_DISPLAY / WARP-165: the
  // switch container's SERVICE_SECRET used to be wired to DEVICE_SECRET_KEY,
  // the FIPS-sealed master encryption key, which this keeps off the wire).
  // Compose wires both ends to ${SERVICE_TOKEN_SWITCH}; switch.client.ts
  // falls back to SERVICE_SECRET so installs that pinned the legacy shared
  // secret keep working until setup.sh re-mints.
  SERVICE_TOKEN_SWITCH: z.string().default(""),

  // SERVICE_TOKEN_AI_GATEWAY — WARP-560. Dedicated outbound bearer for
  // ai-gateway.client.ts → ai-gateway, which previously had NO inbound auth
  // (/ai/chat, /ai/sessions/*, /ai/keys/* were all reachable by anything that
  // could open the socket). The ai-gateway's ServiceAuthMiddleware now requires
  // this Bearer on every /ai/* route (except /ai/health). Compose wires both
  // ends to ${SERVICE_TOKEN_AI_GATEWAY}; ai-gateway.client.ts falls back to
  // SERVICE_SECRET so installs whose .env predates this token keep working
  // until setup.sh re-mints. Empty = unauthenticated (dev/CI default).
  SERVICE_TOKEN_AI_GATEWAY: z.string().default(""),

  // --- Service-principal bearer tokens (inbound) ---
  // Per shared_brain `agentic-workflows.md` + `LLM_AGENT.md`: services that
  // need LLM + MCP tool dispatch MUST call the orchestrator's `/api/llm/chat`
  // route, not ai-gateway directly. The orchestrator is the only thing that
  // owns the agent loop + tool routing.
  //
  // SERVICE_TOKEN_VOICE — recognised by authMiddleware for the
  // voice-io / voice-assistant service. When the incoming Bearer matches,
  // the request is treated as a `service` role principal (see jwt.service.ts
  // Role union). Empty default means "no service token configured" — voice
  // calls will 401 until an operator sets it (matches the safe default for
  // SERVICE_SECRET above).
  //
  // To rotate: change the value here AND in voice-io's compose env in
  // lockstep. Both must agree or voice → orchestrator handshake fails.
  SERVICE_TOKEN_VOICE: z.string().default(""),

  // SERVICE_TOKEN_MCP — WARP-339. Same shape as SERVICE_TOKEN_VOICE,
  // for mcp-server's outbound calls back to the orchestrator's REST
  // surface (matter, audit-log, safety-tier). The mcp-server runs as
  // a sibling container and its `createHttpClient("orchestrator")`
  // attaches this value as a Bearer on every request.
  //
  // The dual-token shape (one per service consumer) rather than a
  // shared "internal" token gives us per-service rotation and a
  // clean audit trail (matchServiceToken sets distinct AuthUser
  // principals — `_service:voice` vs `_service:mcp` — so request
  // logs attribute correctly even when both speak at the same time).
  //
  // To rotate: change the value here AND in mcp-server's compose
  // env (ORCHESTRATOR_TOKEN) in lockstep.
  SERVICE_TOKEN_MCP: z.string().default(""),

  // SERVICE_TOKEN_EMAIL — WARP-465. Bearer the email-indexer service
  // presents on POST /api/email/_ingest/* and PATCH
  // /api/email/_ingest/drafts/:id. authMiddleware's matchServiceToken
  // sets `_service:email`. To rotate: change here AND in the
  // email-indexer's compose env (ORCHESTRATOR_SERVICE_TOKEN).
  SERVICE_TOKEN_EMAIL: z.string().default(""),

  // ORCHESTRATOR_SAMPLER_TOKEN — WARP-468 / WARP-470. Bearer presented
  // by the routing service's egress_meter (off-LAN sample POST) and
  // scheduler (throughput sample POST). Both run with network_mode: host
  // so they reach the orchestrator on localhost:3000 rather than via
  // compose service DNS. authMiddleware's matchServiceToken sets
  // `_service:sampler` for either source. To rotate: change here AND in
  // services/routing's compose env (ORCHESTRATOR_SAMPLER_TOKEN).
  ORCHESTRATOR_SAMPLER_TOKEN: z.string().default(""),

  // AI_GATEWAY_SAMPLER_TOKEN — WARP-468. Bearer presented by ai-gateway's
  // off_lan_gating middleware on GET /api/network/off-lan and
  // /api/settings/off-lan to read the cloud_model_escape posture. The
  // gate fails closed (451) without a valid reading, so a missing or
  // mis-registered token blocks every cloud-model call. authMiddleware's
  // matchServiceToken sets `_service:ai-gateway`. To rotate: change here
  // AND in services/ai-gateway's compose env (AI_GATEWAY_SAMPLER_TOKEN).
  AI_GATEWAY_SAMPLER_TOKEN: z.string().default(""),

  // SERVICE_TOKEN_EGRESS_AUDIT — WARP-268. Bearer presented by the
  // host-side egress-audit collector (droplet-egress-audit.service, a
  // systemd unit — NOT a compose service) on POST
  // /api/security/egress-anomaly. The launcher reads the token out of the
  // repo .env (same host-reads-.env precedent as droplet-backup-lib.sh);
  // authMiddleware's matchServiceToken sets `_service:egress-audit`. To
  // rotate: change in .env and restart both the orchestrator and
  // droplet-egress-audit.service.
  SERVICE_TOKEN_EGRESS_AUDIT: z.string().default(""),

  // SERVICE_TOKEN_RAG_EVAL — RAGAS eval-runner auth. Bearer the rag-eval
  // container's ragas_runner.py presents on GET
  // /api/admin/retrieval-eval/search (it reads the value as
  // ORCHESTRATOR_SERVICE_TOKEN; compose wires both ends to the same
  // secrets.sh-generated value). authMiddleware's matchServiceToken sets
  // `_service:rag-eval`. Empty default = principal disabled (same posture
  // as SERVICE_TOKEN_EMAIL); deliberately NOT in
  // PRODUCTION_REQUIRED_SECRET_KEYS — the eval endpoint 404s in production,
  // so a box without the rag-eval profile must still boot. To rotate:
  // change here AND in the rag-eval container's compose env
  // (ORCHESTRATOR_SERVICE_TOKEN).
  SERVICE_TOKEN_RAG_EVAL: z.string().default(""),

  // SERVICE_TOKEN_DISPLAY — WARP-165 wired this orchestrator → oled-display.
  // WARP-1800 uses the SAME token for the reverse leg: device-bridge presents
  // it on GET /api/network/wifi/join-code so the rack panel can resolve the
  // household join code from the one canonical source (WARP-1723) instead of
  // the box's own hostapd, which on the edge-router shape does not host the
  // household SSID at all. No new secret — compose already hands this value
  // to the orchestrator (line 274) and to the bridge as BRIDGE_AUTH_TOKEN.
  // authMiddleware's matchServiceToken sets `_service:display`. Empty default
  // = principal disabled, so a box without a panel still boots.
  SERVICE_TOKEN_DISPLAY: z.string().default(""),

  // --- Web Push (VAPID) ---
  // Pin these in .env after the first orchestrator boot — the push
  // service will generate ephemeral keys and log them on first run if
  // absent, but every restart with absent vars rotates the keys and
  // breaks every existing browser subscription. Generated via
  // `npx web-push generate-vapid-keys` if you want them ahead of time.
  VAPID_PUBLIC_KEY: z.string().default(""),
  VAPID_PRIVATE_KEY: z.string().default(""),
  // Contact mailto for VAPID's `aud` claim. Some push services (FCM,
  // Mozilla autopush) reject pushes without a valid contact.
  VAPID_CONTACT_EMAIL: z.string().default(""),

  // --- WARP-279: Claude-activity meta-observability dashboard ---
  // GitHub adapter — optional PAT. Repo defaults to the public droplet repo
  // and is documented under GITHUB_REPO_OWNER / GITHUB_REPO_NAME in
  // .env.example. We deliberately don't list those here: they're only read
  // by the GitHub adapter and never re-emitted as part of `config`.
  GITHUB_TOKEN: z.string().default(""),

  // Jira adapter — basic auth (email + API token) against an Atlassian
  // Cloud instance. All three are required for Jira data to populate; with
  // any one missing, the dashboard's "WARP-228 chain progress" and
  // "in-flight tickets" panels degrade to empty (with a banner), the rest
  // of the dashboard works normally. The host is the bare cloud subdomain
  // (e.g. `warp-lab.atlassian.net`, no scheme).
  JIRA_HOST: z.string().default(""),
  JIRA_EMAIL: z.string().default(""),
  JIRA_API_TOKEN: z.string().default(""),

  // --- WARP-615: fleet-analytics agent (device → droplet-analytics portal) ---
  // The on-device analytics agent (services/analytics/) is FAIL-OPEN and OFF
  // by default (decision D5): with ANALYTICS_ENABLED unset/false — or with no
  // URL, or neither an ingest token nor a provisioning code — the façade is a
  // pure no-op and the box behaves exactly as before.
  //
  // ENABLED — EXPLICIT string→bool (same idiom as DROPLET_CLAIM_GATE_ENABLED:
  //   z.coerce.boolean() would treat the non-empty strings "0"/"false" as true
  //   and silently turn telemetry ON). Only "1"/"true" enable.
  ANALYTICS_ENABLED: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.trim().toLowerCase() === "true"),
  // URL — portal base including the version path. Defaults to a LOCAL portal
  //   via the host gateway (same host.docker.internal rationale as
  //   ROUTING_SERVICE_URL); point at https://analytics.warp-lab.ai/api/v1 for
  //   the fleet portal. Plain string (not .url()): an operator-mangled value
  //   must degrade to the no-op façade, never crash the orchestrator boot.
  ANALYTICS_URL: z.string().default("http://host.docker.internal:3000/api/v1"),
  // INGEST_TOKEN — **SECRET** bearer (`dpl_<machineId>_<secret>`). Pre-set it
  //   to bypass registration entirely; otherwise WARP-616 mints one from the
  //   provisioning code and persists it. Lives ONLY in .env; never logged.
  ANALYTICS_INGEST_TOKEN: z.string().default(""),
  // PROVISIONING_CODE — **SECRET** single-use code generated in the portal's
  //   /settings/tokens, exchanged once at POST /agents/register (WARP-616).
  ANALYTICS_PROVISIONING_CODE: z.string().default(""),
  // MACHINE_TIER — portal registration tier (home | business | enterprise).
  //   Plain string, not an enum: a typo must not crash boot (fail-open);
  //   WARP-616 validates it when it builds the register payload.
  ANALYTICS_MACHINE_TIER: z.string().default("home"),
  // Cadences (seconds). Consumed by WARP-617 (buffer flush) and WARP-620
  //   (heartbeat) via cron-runtime — declared here with the skeleton so every
  //   ANALYTICS_* knob ships together. Defaults sit safely under the portal's
  //   per-machine rate limits (heartbeat 4/min, metrics 4/min, events 30/min,
  //   errors 60/min — agent-api.md §11).
  ANALYTICS_HEARTBEAT_INTERVAL_S: z.coerce.number().int().min(1).default(30),
  ANALYTICS_METRICS_FLUSH_S: z.coerce.number().int().min(1).default(60),
  ANALYTICS_EVENTS_FLUSH_S: z.coerce.number().int().min(1).default(5),
  ANALYTICS_ERROR_DEDUP_WINDOW_S: z.coerce.number().int().min(1).default(60),
});

// Backward-compat: storage.ts historically read `BRIDGE_URL`; screen-qr read
// `DEVICE_BRIDGE_URL`. We standardize on `DEVICE_BRIDGE_URL` (config key
// above) but honor a legacy `BRIDGE_URL` when the canonical key is unset, so
// an existing deployment that set `BRIDGE_URL` in .env isn't silently
// repointed at the default.
// Treat an empty/whitespace value as unset so a templated `.env` with a bare
// `DEVICE_BRIDGE_URL=` (or `BRIDGE_URL=`) line falls through to the alias and
// then the schema default, rather than parsing as an empty URL.
const firstNonEmpty = (...vals: (string | undefined)[]): string | undefined =>
  vals.find((v) => v !== undefined && v.trim() !== "");
const envForParse: NodeJS.ProcessEnv = {
  ...process.env,
  DEVICE_BRIDGE_URL: firstNonEmpty(
    process.env.DEVICE_BRIDGE_URL,
    process.env.BRIDGE_URL,
  ),
};

const parsed = envSchema.parse(envForParse);

// WARP-580 (part 2) — production boot dies loud, with an actionable message,
// when any required device/service secret is empty. Runs at config load (the
// first thing the orchestrator touches), so a misprovisioned box never gets
// as far as serving a request with an empty master key or empty service
// bearers. Non-production keeps the empty defaults (dev/test ergonomics).
if (parsed.NODE_ENV === "production") {
  const emptySecrets = findEmptyProductionSecrets(parsed);
  if (emptySecrets.length > 0) {
    throw new Error(
      "Production boot requires non-empty device/service secrets; " +
        `empty or placeholder: ${emptySecrets.join(", ")}. ` +
        "scripts/setup.sh generates these into .env (re-run setup.sh — " +
        "migrate_env backfills any keys added since this box was provisioned).",
    );
  }
}

// --- WARP-562: resolve the CORS origin allowlist ---
// Comma-separated → trimmed, empties dropped. When the operator hasn't set
// CORS_ALLOWED_ORIGINS, fall back to the appliance's own LAN dashboard origin
// (covered by the TLS cert SANs) plus the dev dashboard origin outside prod.
function resolveCorsAllowedOrigins(
  raw: string,
  nodeEnv: string,
  publicFqdn: string,
): string[] {
  const explicit = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  const origins =
    explicit.length > 0
      ? explicit
      : [
          "https://droplet-ai.local",
          // Dev dashboard origin: the Next.js dev server runs on :3001
          // (`apps/web-dashboard/package.json` → `next dev -p 3001`). :3000 is
          // the orchestrator's own PORT, so it would grant nothing useful here.
          ...(nodeEnv !== "production" ? ["http://localhost:3001"] : []),
        ];

  // ADR-023 (C4): the publicly-trusted per-device FQDN is a first-class
  // browser origin — the dashboard is served on it at home AND over the
  // tunnel. Add it whether the operator set an explicit allowlist or fell
  // through to the defaults, deduped, so credentialed CORS never rejects the
  // canonical address. Empty until first HQ contact.
  const fqdn = publicFqdn.trim();
  if (fqdn) {
    const fqdnOrigin = `https://${fqdn}`;
    if (!origins.includes(fqdnOrigin)) origins.push(fqdnOrigin);
  }

  // Fail-fast on wildcard + credentials, mirroring ai-gateway's guard
  // (services/ai-gateway/main.py:125-129). `credentials: true` is always on
  // for the orchestrator, so a `*` allowlist is never acceptable: the browser
  // would receive `Access-Control-Allow-Origin: *` with credentials, or — with
  // the `cors` package — silently reflect every origin. Die loud instead.
  if (origins.includes("*")) {
    throw new Error(
      "CORS_ALLOWED_ORIGINS contains a wildcard ('*'), which is not allowed " +
        "with credentialed CORS. Set an explicit, comma-separated origin list " +
        "(e.g. https://droplet-ai.local).",
    );
  }

  return origins;
}

export const config = {
  ...parsed,
  // WARP-580 — `AUTH_ENABLED` on the exported config is the EFFECTIVE,
  // fail-closed posture (resolved from the literal env string). Production
  // always resolves to true; non-production honours an explicit opt-out only.
  AUTH_ENABLED: resolveAuthEnabled(process.env.AUTH_ENABLED, parsed.NODE_ENV),
  corsAllowedOrigins: resolveCorsAllowedOrigins(
    parsed.CORS_ALLOWED_ORIGINS,
    parsed.NODE_ENV,
    parsed.DROPLET_PUBLIC_FQDN,
  ),
  // Image vision (chat). `model` is the preferred LOCAL vision model that image
  // turns auto-route to when the selected model can't see (and that
  // model-readiness pulls at startup); empty → no local vision (cloud vision is
  // still reachable by selecting a cloud vision model explicitly). `maxImages`
  // caps how many images are re-sent per request, bounding token cost.
  vision: {
    model: (process.env.VISION_MODEL ?? "").trim() || null,
    maxImages: (() => {
      const n = Number.parseInt(process.env.VISION_MAX_IMAGES ?? "", 10);
      return Number.isFinite(n) && n >= 1 && n <= 8 ? n : 3;
    })(),
  },
  agentMaxIter: resolveAgentIterLimits(
    parsed.AGENT_MAX_ITER_DEFAULT,
    parsed.AGENT_MAX_ITER_CAP,
  ),
};
export type Config = typeof config;
