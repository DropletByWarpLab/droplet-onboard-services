/**
 * WARP-3904 — the descriptor behind "connect it from chat".
 *
 * `resolveConnectionProvider` turns what a person (or the model) typed —
 * "gmail", "our mail server", "QuickBooks" — into one of the five connection
 * families plus a provider key. `buildConnectCard` then describes HOW to add
 * that provider: which fields the form shows, where the browser posts, which
 * safety chip it wears, and what stops it (role, already connected, missing
 * app setup, not available).
 *
 * A card is a descriptor, never a credential and never a byte route. Every
 * path it names is one `parseConnectCard` allowlists, every secret field is
 * marked `secret` and carries no default, and nothing here talks to a vendor.
 * The form posts straight from the browser to the same route the Integrations
 * hub or Settings uses today, which enforces its own role guard.
 */
import type { PrismaClient } from "@prisma/client";
import {
  isSafeDashboardHref,
  providerDescriptor,
  providerDescriptors,
  setupGuideHrefFor,
  type ConnectCard,
  type ConnectCardBlocked,
  type ConnectField,
  type ConnectionFamily,
  type ConnectOption,
  type ConnectSafety,
  type CredentialFieldDef,
  type ProviderDescriptor,
} from "@droplet/shared-types";
import { getGoogleApp, getMicrosoftApp, validateGoogleRedirectUri } from "./account-provider-setup.service.js";
import { getGoogleConnectionView } from "./google/google-auth.service.js";
import { getConnectionView as getM365ConnectionView } from "./m365/m365-auth.service.js";
import { parseAppRegistration } from "./m365/state.js";
import {
  BOX_CONNECT_ROLES,
  CALENDAR_DISPLAY_NAME,
  GOOGLE_DISPLAY_NAME,
  M365_DISPLAY_NAME,
  MAILBOX_DISPLAY_NAME,
  MANAGE_HREF,
  PERSONAL_CONNECT_ROLES,
  connectInputFor,
  datasetNoun,
  isCatalogAvailable,
  type ConnectionsActor,
} from "./connections-overview.service.js";

export interface ConnectionTarget {
  family: ConnectionFamily;
  provider: string;
}

export class UnknownConnectionProviderError extends Error {
  constructor(provider: string) {
    super(`Unknown connection provider: ${provider}`);
    this.name = "UnknownConnectionProviderError";
  }
}

// ── Resolution ───────────────────────────────────────────────────────────

/** Words that add nothing to which provider a phrase names ("our mail server", "my email"). */
const FILLER_WORDS: ReadonlySet<string> = new Set(["our", "my", "the", "a", "an", "your", "own", "this", "that"]);

/** Longest phrase, in words, the fallback scan tries inside a longer sentence. */
const MAX_PHRASE_WORDS = 4;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** Case, whitespace and punctuation do not matter: "Cal.com", "cal com" and "CALCOM" are one key. */
function keyOf(tokens: readonly string[]): string {
  return tokens.join("");
}

const FAMILY_ALIASES: Record<"google" | "m365" | "mailbox" | "calendar", readonly string[]> = {
  google: [
    "google", "gmail", "google workspace", "g suite", "gsuite", "google mail", "google calendar", "google apps", "gmail calendar",
  ],
  m365: [
    "m365", "microsoft", "microsoft 365", "microsoft365", "office 365", "office365", "o365", "outlook",
    "microsoft outlook", "outlook calendar", "outlook mail", "microsoft calendar", "microsoft mail", "exchange", "onedrive",
    "sharepoint", "hotmail",
  ],
  mailbox: [
    "mailbox", "email", "e-mail", "imap", "smtp", "mail server", "own mail server", "work email",
    "support mailbox", "my email",
  ],
  calendar: ["calendar", "calendar feed", "caldav", "ics", "ical", "icloud calendar", "calendar subscription", "webcal"],
};

const INTEGRATION_ALIASES: Record<string, string> = {
  "patterson api": "eaglesoft-api",
  "patterson innovation connection": "eaglesoft-api",
  quickbooks: "quickbooks-online",
  qbo: "quickbooks-online",
  intuit: "quickbooks-online",
  "cal.com": "calcom",
  atlassian: "atlassian",
  jira: "atlassian",
  confluence: "atlassian",
};

let aliasIndex: Map<string, ConnectionTarget> | null = null;
let aliasIndexSize = -1;

/** Every key the resolver knows. Rebuilt when the provider registry grows (a runtime-registered descriptor). */
function index(): Map<string, ConnectionTarget> {
  const descriptors = providerDescriptors();
  if (aliasIndex && aliasIndexSize === descriptors.length) return aliasIndex;
  const map = new Map<string, ConnectionTarget>();
  const put = (name: string, target: ConnectionTarget): void => {
    const key = keyOf(words(name));
    if (key && !map.has(key)) map.set(key, target);
  };
  // Family aliases first: "outlook" is Microsoft, never a catalog provider's accident.
  for (const [family, names] of Object.entries(FAMILY_ALIASES) as Array<[keyof typeof FAMILY_ALIASES, readonly string[]]>) {
    put(family, { family, provider: family });
    for (const name of names) put(name, { family, provider: family });
  }
  for (const descriptor of descriptors) {
    const target: ConnectionTarget = { family: "integration", provider: descriptor.id };
    put(descriptor.id, target);
    put(descriptor.displayName, target);
  }
  for (const [alias, provider] of Object.entries(INTEGRATION_ALIASES)) {
    if (providerDescriptor(provider)) put(alias, { family: "integration", provider });
  }
  aliasIndex = map;
  aliasIndexSize = descriptors.length;
  return map;
}

function lookup(tokens: readonly string[]): ConnectionTarget | null {
  const map = index();
  const exact = map.get(keyOf(tokens));
  if (exact) return exact;
  const trimmed = tokens.filter((t) => !FILLER_WORDS.has(t));
  return trimmed.length > 0 ? (map.get(keyOf(trimmed)) ?? null) : null;
}

/**
 * The provider a phrase names, or null. Tries the whole phrase first; failing
 * that, the runs of words inside it that name a provider — "connect my Stripe
 * account" finds Stripe, "set up the calendar for Stripe" finds two and so
 * nothing. A short run inside a longer one that already matched ("outlook"
 * inside "outlook calendar") does not count as a second answer.
 */
export function resolveConnectionProvider(query: string): ConnectionTarget | null {
  const tokens = words(query);
  if (tokens.length === 0) return null;
  const whole = lookup(tokens);
  if (whole) return whole;
  const hits: Array<{ start: number; end: number; target: ConnectionTarget }> = [];
  for (let size = Math.min(MAX_PHRASE_WORDS, tokens.length - 1); size >= 1; size--) {
    for (let start = 0; start + size <= tokens.length; start++) {
      const end = start + size;
      if (hits.some((h) => start >= h.start && end <= h.end)) continue;
      const target = lookup(tokens.slice(start, end));
      if (target) hits.push({ start, end, target });
    }
  }
  const distinct = new Map(hits.map((h) => [`${h.target.family}:${h.target.provider}`, h.target]));
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}

export interface ConnectionSuggestion {
  provider: string;
  displayName: string;
}

const FAMILY_SUGGESTIONS: readonly ConnectionSuggestion[] = [
  { provider: "google", displayName: GOOGLE_DISPLAY_NAME },
  { provider: "m365", displayName: M365_DISPLAY_NAME },
  { provider: "mailbox", displayName: MAILBOX_DISPLAY_NAME },
  { provider: "calendar", displayName: CALENDAR_DISPLAY_NAME },
];

/** What to offer when nothing is close: the four connections everyone can ask for. */
export function defaultConnectionSuggestions(): ConnectionSuggestion[] {
  return [...FAMILY_SUGGESTIONS];
}

/**
 * Close matches by prefix, then substring, on the normalized names — for the
 * 404 body of an unknown provider. Never an alias table dump: only providers a
 * person could actually pick.
 */
export function suggestConnectionProviders(query: string, limit = 5): ConnectionSuggestion[] {
  const q = keyOf(words(query));
  if (q.length < 2) return [];
  const candidates: Array<ConnectionSuggestion & { names: string[] }> = [
    ...FAMILY_SUGGESTIONS.map((s) => ({ ...s, names: [s.provider, s.displayName, ...(FAMILY_ALIASES[s.provider as keyof typeof FAMILY_ALIASES] ?? [])] })),
    ...providerDescriptors()
      .filter((d) => isCatalogAvailable(d) && connectInputFor(d) !== null)
      .map((d) => ({ provider: d.id, displayName: d.displayName, names: [d.id, d.displayName] })),
  ];
  const scored: Array<{ suggestion: ConnectionSuggestion; score: number }> = [];
  for (const candidate of candidates) {
    let best = Infinity;
    for (const name of candidate.names) {
      const key = keyOf(words(name));
      if (!key) continue;
      if (key.startsWith(q)) best = Math.min(best, 0);
      else if (key.includes(q)) best = Math.min(best, 1);
      else if (key.length >= 4 && q.includes(key)) best = Math.min(best, 2);
    }
    if (best !== Infinity) scored.push({ suggestion: { provider: candidate.provider, displayName: candidate.displayName }, score: best });
  }
  scored.sort((a, b) => a.score - b.score || a.suggestion.displayName.localeCompare(b.suggestion.displayName));
  return scored.slice(0, limit).map((s) => s.suggestion);
}

/** The person-facing name for a target, for the disconnect result and blocked copy. */
export function connectionDisplayName(target: ConnectionTarget): string {
  switch (target.family) {
    case "google":
      return GOOGLE_DISPLAY_NAME;
    case "m365":
      return M365_DISPLAY_NAME;
    case "mailbox":
      return MAILBOX_DISPLAY_NAME;
    case "calendar":
      return CALENDAR_DISPLAY_NAME;
    case "integration":
      return providerDescriptor(target.provider)?.displayName ?? target.provider;
  }
}

// ── Cards ────────────────────────────────────────────────────────────────

export interface ConnectCardDeps {
  /** The box's Google OAuth app, or undefined when none is configured. */
  getGoogleApp: (prisma: PrismaClient) => Promise<unknown | undefined>;
  /** The box's Microsoft app registration, or undefined when none is configured. */
  getMicrosoftApp: (prisma: PrismaClient) => Promise<unknown | undefined>;
  /**
   * The callback URL Google would be given, when the caller knows it. Google
   * refuses `.lan` / IP callbacks, so a box on one cannot connect until the
   * owner finishes setup; absent, only the missing app is checked.
   */
  googleRedirectUri?: string;
}

const defaultDeps: ConnectCardDeps = { getGoogleApp, getMicrosoftApp };

const GOOGLE_OPTIONS: readonly ConnectOption[] = [
  { name: "mail", label: "Mail", help: "search, summarize, draft replies you approve", defaultChecked: true },
  { name: "calendar", label: "Calendar", help: "read your events, suggest times", defaultChecked: true },
];

/** `POST /api/m365/connect` takes `{ clientId, tenantId, returnTo }` and no feature flags: what Droplet reads is chosen in Settings after sign-in. */
const M365_OPTIONS: readonly ConnectOption[] = [];

/** Field names are `connectAccountBody` in routes/email.ts (TLS flags default to true there and are not shown). */
const MAILBOX_FIELDS: readonly ConnectField[] = [
  { name: "displayName", label: "Name", type: "text", required: true, secret: false, placeholder: "Front desk" },
  { name: "address", label: "Email address", type: "email", required: true, secret: false, placeholder: "Your email address" },
  { name: "imapHost", label: "Incoming server (IMAP)", type: "text", required: true, secret: false, placeholder: "Your mail server" },
  { name: "imapPort", label: "Incoming port", type: "number", required: true, secret: false, defaultValue: "993" },
  { name: "smtpHost", label: "Outgoing server (SMTP)", type: "text", required: true, secret: false, placeholder: "Your outgoing mail server" },
  { name: "smtpPort", label: "Outgoing port", type: "number", required: true, secret: false, defaultValue: "465" },
  { name: "username", label: "Username", type: "text", required: true, secret: false, help: "Often the same as the email address." },
  { name: "password", label: "Password", type: "password", required: true, secret: true, help: "Stored encrypted on this box. Droplet never shows it again." },
];

/** Field names are the subset of `sourceCreateSchema` in routes/calendar.ts a person types. */
const CALENDAR_FIELDS: readonly ConnectField[] = [
  { name: "name", label: "Name", type: "text", required: true, secret: false, placeholder: "Personal iCloud" },
  { name: "url", label: "Calendar address", type: "url", required: true, secret: false, placeholder: "https://", help: "A CalDAV calendar address or a public ICS link." },
  { name: "username", label: "Username", type: "text", required: false, secret: false, help: "Only for a calendar that asks you to sign in." },
  { name: "password", label: "Password", type: "password", required: false, secret: true },
];

const WIZARD_STEPS: readonly string[] = [
  "Find the server on your network",
  "Create Droplet's read-only database account",
  "Choose what Droplet may read",
  "Confirm and connect",
];

const GOOGLE_SETUP_MESSAGE = "An owner needs to set up the Google app first, in Settings under Account connection setup.";
const GOOGLE_CALLBACK_MESSAGE =
  "Google needs an HTTPS address on this Droplet's own domain before it can connect. An owner can finish that in Settings under Account connection setup.";
const M365_SETUP_MESSAGE = "An owner needs to set up the Microsoft app first, in Settings under Account connection setup.";

function boxRoleBlock(displayName: string): ConnectCardBlocked {
  return {
    reason: "role",
    message: `Only owners and admins can add box-wide connections like ${displayName}. You can still connect your own Google or Microsoft 365 account.`,
    requiredRole: "admin",
  };
}

function personalRoleBlock(displayName: string): ConnectCardBlocked {
  return { reason: "role", message: `Your account type cannot connect ${displayName}. Ask an owner or admin to change your access.` };
}

type FieldDef = Pick<CredentialFieldDef, "name" | "label" | "type" | "required" | "secret" | "pattern" | "help">;

function toConnectField(def: FieldDef): ConnectField {
  const field: ConnectField = {
    name: def.name,
    label: def.label,
    type: def.secret ? "password" : def.type === "positiveInteger" ? "number" : "text",
    required: def.required,
    secret: def.secret,
  };
  if (def.help) field.help = def.help.slice(0, 400);
  // Descriptors carry no default for any field, and a secret must never have one.
  if (def.pattern && def.type === "string") field.pattern = def.pattern;
  return field;
}

function sentence(text: string): string {
  const normalized = text.replace(/!/g, "").replace(/\s+/g, " ").trim();
  // Whitespace is collapsed to spaces. Scan the trailing dots and spaces, so
  // punctuation elsewhere cannot make an anchored regex retry each suffix.
  let end = normalized.length;
  while (end > 0 && (normalized[end - 1] === "." || normalized[end - 1] === " ")) end -= 1;
  return normalized.slice(0, end);
}

/** One line: what Droplet reads, and how. Sentence case, middle dots, no exclamation marks. */
function integrationSummary(descriptor: ProviderDescriptor): string {
  const nouns = descriptor.datasets.map(datasetNoun);
  if (nouns.length === 0) {
    const description = descriptor.track === "mcp" ? descriptor.description : descriptor.catalog?.description;
    return description ? sentence(description).slice(0, 400) : `Connects ${descriptor.displayName}`;
  }
  const posture = descriptor.track === "lan" || descriptor.track === "cloud" ? "read-only by default" : "read-only";
  return `Reads ${nouns.join(", ")} · ${posture}`;
}

function integrationHelpHref(descriptor: ProviderDescriptor): string {
  const guide = setupGuideHrefFor(descriptor);
  return guide && isSafeDashboardHref(guide) ? guide : `/help/connectors/${descriptor.id}`;
}

function safetyFor(descriptor: ProviderDescriptor): ConnectSafety {
  return descriptor.track === "lan" || descriptor.lanProvisioning ? "setup-lan" : "setup-internet";
}

/** A connection in these states already stands; a card would only offer to overwrite it. */
const STANDING_INTEGRATION_STATUSES: ReadonlySet<string> = new Set([
  "CONNECTED",
  "CAPABILITY_LIMITED",
  "PROVISIONING",
  "DEGRADED",
  "DRIFT_LOCKED",
]);

async function googleCard(prisma: PrismaClient, actor: ConnectionsActor, deps: ConnectCardDeps): Promise<ConnectCard> {
  const card: ConnectCard = {
    kind: "connect_card",
    mode: "oauth",
    provider: "google",
    family: "google",
    displayName: GOOGLE_DISPLAY_NAME,
    category: "Mail and calendar",
    scope: "personal",
    summary: "Mail and calendar · your account only",
    safety: "setup-internet",
    manageHref: MANAGE_HREF.google,
    options: GOOGLE_OPTIONS.map((o) => ({ ...o })),
    start: { path: "/api/google/connect" },
    providerLabel: "Google",
  };
  if (!PERSONAL_CONNECT_ROLES.includes(actor.role)) return { ...card, blocked: personalRoleBlock(GOOGLE_DISPLAY_NAME) };
  const view = await getGoogleConnectionView(prisma, actor.id);
  if (view.state === "CONNECTED") {
    const who = view.accountAddress ? ` as ${view.accountAddress}` : "";
    return { ...card, blocked: { reason: "already_connected", message: `Google is already connected${who}. Manage it in Settings under Connected accounts.` } };
  }
  if (!(await deps.getGoogleApp(prisma))) {
    return { ...card, blocked: { reason: "setup_required", message: GOOGLE_SETUP_MESSAGE, requiredRole: "owner" } };
  }
  if (deps.googleRedirectUri !== undefined && !validateGoogleRedirectUri(deps.googleRedirectUri)) {
    return { ...card, blocked: { reason: "setup_required", message: GOOGLE_CALLBACK_MESSAGE, requiredRole: "owner" } };
  }
  return card;
}

async function m365Card(prisma: PrismaClient, actor: ConnectionsActor, deps: ConnectCardDeps): Promise<ConnectCard> {
  const card: ConnectCard = {
    kind: "connect_card",
    mode: "oauth",
    provider: "m365",
    family: "m365",
    displayName: M365_DISPLAY_NAME,
    category: "Mail and calendar",
    scope: "personal",
    summary: "Mail, calendar and files · your account only · you choose what Droplet reads after sign-in",
    safety: "setup-internet",
    manageHref: MANAGE_HREF.m365,
    options: M365_OPTIONS.map((o) => ({ ...o })),
    start: { path: "/api/m365/connect" },
    providerLabel: "Microsoft",
  };
  if (!PERSONAL_CONNECT_ROLES.includes(actor.role)) return { ...card, blocked: personalRoleBlock(M365_DISPLAY_NAME) };
  const view = await getM365ConnectionView(prisma, actor.id);
  if (view.state === "CONNECTED") {
    const who = view.accountUpn ? ` as ${view.accountUpn}` : "";
    return { ...card, blocked: { reason: "already_connected", message: `Microsoft 365 is already connected${who}. Manage it in Settings under Connected accounts.` } };
  }
  // The person's own stored app wins; otherwise the box-wide one. Neither: the owner has not set it up.
  if (!parseAppRegistration(view.app ?? {}).ok && !(await deps.getMicrosoftApp(prisma))) {
    return { ...card, blocked: { reason: "setup_required", message: M365_SETUP_MESSAGE, requiredRole: "owner" } };
  }
  return card;
}

function mailboxCard(actor: ConnectionsActor): ConnectCard {
  const card: ConnectCard = {
    kind: "connect_card",
    mode: "mailbox",
    provider: "mailbox",
    family: "mailbox",
    displayName: MAILBOX_DISPLAY_NAME,
    category: "Mail",
    scope: "box",
    summary: "IMAP and SMTP · checked before saving · indexed on this box",
    safety: "setup-internet",
    manageHref: MANAGE_HREF.mailbox,
    fields: MAILBOX_FIELDS.map((f) => ({ ...f })),
    post: { path: "/api/email/accounts" },
  };
  return BOX_CONNECT_ROLES.includes(actor.role) ? card : { ...card, blocked: boxRoleBlock(MAILBOX_DISPLAY_NAME) };
}

function calendarCard(actor: ConnectionsActor): ConnectCard {
  const card: ConnectCard = {
    kind: "connect_card",
    mode: "calendar",
    provider: "calendar",
    family: "calendar",
    displayName: CALENDAR_DISPLAY_NAME,
    category: "Calendar",
    scope: "personal",
    summary: "CalDAV or ICS subscription · read-only · synced every 15 min",
    safety: "setup-internet",
    manageHref: MANAGE_HREF.calendar,
    fields: CALENDAR_FIELDS.map((f) => ({ ...f })),
    post: { path: "/api/calendar/sources" },
  };
  return PERSONAL_CONNECT_ROLES.includes(actor.role) ? card : { ...card, blocked: personalRoleBlock(CALENDAR_DISPLAY_NAME) };
}

async function integrationCard(prisma: PrismaClient, actor: ConnectionsActor, provider: string): Promise<ConnectCard> {
  const descriptor = providerDescriptor(provider);
  if (!descriptor) throw new UnknownConnectionProviderError(provider);
  const base = {
    kind: "connect_card" as const,
    provider: descriptor.id,
    family: "integration" as const,
    displayName: descriptor.displayName,
    category: descriptor.category,
    scope: "box" as const,
    summary: integrationSummary(descriptor),
    safety: safetyFor(descriptor),
    helpHref: integrationHelpHref(descriptor),
    manageHref: MANAGE_HREF.integration,
  };
  const input = connectInputFor(descriptor);

  let card: ConnectCard;
  let unavailable: ConnectCardBlocked | undefined;
  if (input === "credentials") {
    const variants = descriptor.credentialVariants ?? [];
    card = {
      ...base,
      mode: "credentials",
      // The base fields only: each variant lists the ones it adds.
      fields: descriptor.credentialFields.map(toConnectField),
      ...(variants.length > 0
        ? { variants: variants.map((v) => ({ id: v.id, label: v.label, ...(v.description ? { description: v.description } : {}), fields: v.fields.map(toConnectField) })) }
        : {}),
      post: { path: `/api/connectors/${descriptor.id}/connect` },
    };
  } else if (input === "lan_api") {
    card = {
      ...base,
      mode: "wizard",
      steps: [
        "Enter the server host and HTTPS port (9888 by default)",
        "Add your Patterson integration key and Provider login in the setup form",
        "Supply the route map from the server's /help page or Patterson SDK",
        "Add the server's CA certificate if needed, then test and connect read-only",
      ],
      wizardHref: `/connectors?connect=${descriptor.id}`,
    };
  } else if (input === "mcp") {
    card = {
      ...base,
      mode: "wizard",
      steps: ["Choose Connect and sign in with your account", "Approve the access Droplet asks for", "Droplet reads which site you picked and connects"],
      wizardHref: "/connectors/credentials",
    };
  } else {
    // LAN providers hand off to the hub wizard; a provider with no connect path
    // from chat gets a wizard-shaped card that only ever renders its message.
    card = {
      ...base,
      mode: "wizard",
      steps: input ? [...WIZARD_STEPS] : [],
      ...(input ? { estimate: "about 10 minutes" } : {}),
      wizardHref: input ? `/connectors?connect=${descriptor.id}` : MANAGE_HREF.integration,
    };
    if (!input) {
      unavailable = {
        reason: "unavailable",
        message: `${descriptor.displayName} isn't available to connect yet.`,
      };
    }
  }

  if (!BOX_CONNECT_ROLES.includes(actor.role)) return { ...card, blocked: boxRoleBlock(descriptor.displayName) };
  if (!isCatalogAvailable(descriptor)) return { ...card, blocked: { reason: "unavailable", message: `${descriptor.displayName} isn't available to connect yet.` } };
  if (unavailable) return { ...card, blocked: unavailable };

  const row = await prisma.integrationConnection.findFirst({ where: { provider: descriptor.id }, select: { status: true } });
  if (row && STANDING_INTEGRATION_STATUSES.has(row.status)) {
    const message =
      row.status === "PROVISIONING"
        ? `A ${descriptor.displayName} connection is already being set up. Check its status in Connectors.`
        : `${descriptor.displayName} is already connected. Manage it in Connectors.`;
    return { ...card, blocked: { reason: "already_connected", message } };
  }
  return card;
}

export async function buildConnectCard(
  prisma: PrismaClient,
  actor: ConnectionsActor,
  target: ConnectionTarget,
  deps: Partial<ConnectCardDeps> = {},
): Promise<ConnectCard> {
  const resolved: ConnectCardDeps = { ...defaultDeps, ...deps };
  switch (target.family) {
    case "google":
      return googleCard(prisma, actor, resolved);
    case "m365":
      return m365Card(prisma, actor, resolved);
    case "mailbox":
      return mailboxCard(actor);
    case "calendar":
      return calendarCard(actor);
    case "integration":
      return integrationCard(prisma, actor, target.provider);
  }
}
