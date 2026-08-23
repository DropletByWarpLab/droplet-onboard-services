/**
 * WARP-2115 / ADR-041 — the MSAL-backed implementation of the Entra port.
 *
 * `@azure/msal-node` (MIT) is the official client and is what ADR-041 names.
 * Everything Droplet-specific lives behind the `EntraClient` interface in
 * `m365-auth.service.ts`, so the lifecycle is testable without a network and
 * the SDK stays swappable.
 *
 * Two choices worth stating, because both are security-relevant:
 *
 *   1. **A fresh `PublicClientApplication` per operation, with an in-memory
 *      cache seeded from the caller's blob.** MSAL's token cache pools every
 *      account it has seen; a single long-lived instance shared across users
 *      would put every connected mailbox's refresh token in one cache and make
 *      cross-user selection a one-line mistake. Per-call construction makes
 *      that impossible by construction rather than by discipline.
 *   2. **Public client, no secret.** Delegated device-code and auth-code flows
 *      need no client secret, which sidesteps the Entra app-management
 *      policies that increasingly forbid long-lived secrets outright — and
 *      means the box holds no credential that would authenticate *as the app*.
 */
import {
  PublicClientApplication,
  type AuthenticationResult,
  type Configuration,
  type TokenCacheContext,
} from "@azure/msal-node";

import { config } from "../../config.js";
import type { DeviceCodeInfo, EntraAuthResult, EntraClient } from "./m365-auth.service.js";

/**
 * Scopes requested for a Microsoft 365 link (ADR-041 / WARP-2115 v1).
 *
 * `offline_access` is what earns a refresh token — without it the link dies at
 * the first access-token expiry. No Teams scopes: bulk chat read is
 * application-permission-only protected-API territory and is out of scope.
 */
export const M365_SCOPES: readonly string[] = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Contacts.ReadWrite",
  "Files.ReadWrite.All",
];

/**
 * Identifies this client to Microsoft. Microsoft asks integrators to send a
 * recognisable product token; it also makes support escalations tractable.
 */
const CLIENT_NAME = "Droplet";

/** A cache plugin backed by one string, for one operation, for one user. */
function inMemoryCache(seed: string | null) {
  let current = seed;
  return {
    plugin: {
      async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
        if (current) ctx.tokenCache.deserialize(current);
      },
      async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
        if (ctx.cacheHasChanged) current = ctx.tokenCache.serialize();
      },
    },
    read: () => current,
  };
}

function buildApp(seed: string | null) {
  const cache = inMemoryCache(seed);
  const msalConfig: Configuration = {
    auth: {
      clientId: config.M365_CLIENT_ID,
      // "organizations" = any work/school tenant, no personal accounts. A
      // Droplet connects a business's Microsoft 365, not someone's Xbox login.
      authority: `${config.M365_AUTHORITY_HOST}/organizations`,
      clientCapabilities: ["CP1"], // advertise CAE support
    },
    cache: { cachePlugin: cache.plugin },
    system: {
      loggerOptions: {
        // MSAL's logger can emit token material at Verbose/Trace. Left off
        // deliberately: nothing about this flow should reach a log.
        loggerCallback: () => {},
        piiLoggingEnabled: false,
      },
    },
  };
  return { app: new PublicClientApplication(msalConfig), cache };
}

function toAuthResult(
  result: AuthenticationResult,
  serializedCache: string | null,
): EntraAuthResult {
  const account = result.account;
  return {
    homeAccountId: account?.homeAccountId ?? "",
    tenantId: account?.tenantId ?? null,
    // `username` is the UPN (e.g. sam@practice.com) — shown so the owner can
    // see which account is connected. Not a secret.
    accountUpn: account?.username ?? null,
    grantedScopes: (result.scopes ?? []).join(" "),
    serializedCache: serializedCache ?? "",
    accessToken: result.accessToken,
  };
}

/** True when the app is configured well enough to attempt a sign-in. */
export function isM365Configured(): boolean {
  return Boolean(config.M365_CLIENT_ID);
}

/** Thrown when a connect is attempted on a box with no client id configured. */
export class M365NotConfiguredError extends Error {
  constructor() {
    super(
      "Microsoft 365 is not configured on this device (M365_CLIENT_ID is unset). " +
        "This is a device configuration task, not something signing in again will fix.",
    );
    this.name = "M365NotConfiguredError";
  }
}

export function createEntraClient(): EntraClient {
  return {
    async acquireByDeviceCode({ onCode }): Promise<EntraAuthResult> {
      if (!isM365Configured()) throw new M365NotConfiguredError();
      const { app, cache } = buildApp(null);

      const result = await app.acquireTokenByDeviceCode({
        scopes: [...M365_SCOPES],
        deviceCodeCallback: (response) => {
          const info: DeviceCodeInfo = {
            userCode: response.userCode,
            verificationUri: response.verificationUri,
            expiresAt: new Date(Date.now() + response.expiresIn * 1000),
            // Microsoft's own text, localized by the service — shown verbatim
            // rather than reworded, so the instructions match what the person
            // sees on the Microsoft page.
            message: response.message,
          };
          onCode(info);
        },
      });

      if (!result) throw new Error("Microsoft returned no result for the device-code sign-in.");
      return toAuthResult(result, cache.read());
    },

    async acquireSilent(serializedCache, homeAccountId): Promise<EntraAuthResult> {
      if (!isM365Configured()) throw new M365NotConfiguredError();
      const { app, cache } = buildApp(serializedCache);

      const account = await app.getTokenCache().getAccountByHomeId(homeAccountId);
      if (!account) {
        // The cache decrypted but no longer holds this account. Shaped like an
        // Entra interaction error so the service classifies it as a reconnect
        // rather than a misconfiguration.
        throw {
          errorCode: "interaction_required",
          errorMessage: "The stored Microsoft sign-in no longer contains this account.",
        };
      }

      const result = await app.acquireTokenSilent({
        account,
        scopes: [...M365_SCOPES],
      });

      if (!result) throw new Error("Microsoft returned no result for the silent refresh.");
      return toAuthResult(result, cache.read() ?? serializedCache);
    },
  };
}

export { CLIENT_NAME };
