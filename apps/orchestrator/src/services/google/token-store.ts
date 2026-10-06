import { decryptColumn, deriveGoogleOAuthKey, encryptColumn } from "../column-crypto.service.js";
import type { GoogleApp } from "./google-client.js";
import { DEFAULT_GOOGLE_FEATURES, scopesForGoogleFeatures, type GoogleFeatures } from "./scopes.js";
import { accountConnectReturnTo, type AccountConnectReturnTo } from "../account-connect-return.js";

export interface StoredGoogleGrant extends GoogleApp {
  refreshToken: string;
  scopes: string[];
}

export interface PendingGoogleFlow extends GoogleApp, GoogleFeatures {
  codeVerifier: string;
  redirectUri: string;
  returnTo?: AccountConnectReturnTo;
  prior?: PriorGoogleConnection;
}

export interface PriorGoogleConnection extends GoogleFeatures {
  state: "DISCONNECTED" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";
  calendarSyncState: "DISCONNECTED" | "WAITING" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";
  connectedAt: string | null;
  lastRefreshOkAt: string | null;
  lastError: string | null;
}

function seal(userId: string, purpose: string, value: unknown): string {
  return encryptColumn(deriveGoogleOAuthKey(), JSON.stringify(value), `${userId}:google:${purpose}`);
}

function open(userId: string, purpose: string, blob: string): Record<string, unknown> {
  const value: unknown = JSON.parse(decryptColumn(deriveGoogleOAuthKey(), blob, `${userId}:google:${purpose}`));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored Google connection.");
  return value as Record<string, unknown>;
}

function required(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !value[key]) throw new Error("Invalid stored Google connection.");
  return value[key] as string;
}

export function sealGoogleGrant(userId: string, grant: StoredGoogleGrant): string {
  return seal(userId, "grant", grant);
}

export function openGoogleGrant(userId: string, blob: string): StoredGoogleGrant {
  const value = open(userId, "grant", blob);
  const scopes = value.scopes;
  if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string" && scope))) {
    throw new Error("Invalid stored Google connection.");
  }
  return { clientId: required(value, "clientId"), clientSecret: required(value, "clientSecret"), refreshToken: required(value, "refreshToken"),
    scopes: scopes === undefined ? scopesForGoogleFeatures(DEFAULT_GOOGLE_FEATURES) : scopes as string[] };
}

export function sealGoogleFlow(userId: string, flow: PendingGoogleFlow): string {
  return seal(userId, "pending-flow", flow);
}

export function openGoogleFlow(userId: string, blob: string): PendingGoogleFlow {
  const value = open(userId, "pending-flow", blob);
  if ((value.mail !== undefined && typeof value.mail !== "boolean") ||
      (value.calendar !== undefined && typeof value.calendar !== "boolean")) throw new Error("Invalid stored Google connection.");
  let prior: PriorGoogleConnection | undefined;
  if (value.prior !== undefined) {
    if (!value.prior || typeof value.prior !== "object" || Array.isArray(value.prior)) throw new Error("Invalid stored Google connection.");
    const snapshot = value.prior as Record<string, unknown>;
    const date = (entry: unknown) => entry === null || typeof entry === "string" && Number.isFinite(new Date(entry).getTime());
    if (!["DISCONNECTED", "CONNECTED", "NEEDS_RECONNECT", "ERROR"].includes(String(snapshot.state)) ||
        !["DISCONNECTED", "WAITING", "CONNECTED", "NEEDS_RECONNECT", "ERROR"].includes(String(snapshot.calendarSyncState)) ||
        typeof snapshot.mail !== "boolean" || typeof snapshot.calendar !== "boolean" ||
        !date(snapshot.connectedAt) || !date(snapshot.lastRefreshOkAt) ||
        snapshot.lastError !== null && typeof snapshot.lastError !== "string") throw new Error("Invalid stored Google connection.");
    prior = snapshot as unknown as PriorGoogleConnection;
  }
  return {
    clientId: required(value, "clientId"), clientSecret: required(value, "clientSecret"),
    codeVerifier: required(value, "codeVerifier"), redirectUri: required(value, "redirectUri"),
    returnTo: accountConnectReturnTo(value.returnTo),
    mail: value.mail === undefined ? true : value.mail as boolean,
    calendar: value.calendar === undefined ? false : value.calendar as boolean,
    ...(prior ? { prior } : {}),
  };
}
