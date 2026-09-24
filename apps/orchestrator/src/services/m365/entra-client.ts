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
 *   3. **The customer's own app, on its own tenant (WARP-2705).** Every
 *      operation takes the connection's app registration and builds its
 *      authority as `${M365_AUTHORITY_HOST}/${tenantId}`. There is no box-wide
 *      client id and no `/organizations` authority: a Warp-Lab multitenant app
 *      is the PARTNER_GATED shape ADR-042 §3 rules out, and it would pool
 *      Graph's per-app throttling ceiling across every customer we ship.
 *
 * The primary interactive flow is the authorization code with PKCE
 * (WARP-2704). Device code remains as a fallback only: every Entra tenant
 * created since 2026-07-01 blocks it through security defaults.
 */
import {
  PublicClientApplication,
  type AuthenticationResult,
  type Configuration,
  type TokenCacheContext,
} from "@azure/msal-node";

import { config } from "../../config.js";
import type { DeviceCodeInfo, EntraAuthResult, EntraClient } from "./m365-auth.service.js";
import type { EntraAppRegistration } from "./state.js";

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

function buildApp(registration: EntraAppRegistration, seed: string | null) {
  const cache = inMemoryCache(seed);
  const msalConfig: Configuration = {
    auth: {
      clientId: registration.clientId,
      // The customer's own tenant. A single-tenant registration only issues
      // tokens here — `/organizations` would refuse it (AADSTS50194) — and it
      // also rules out personal accounts: a Droplet connects a business's
      // Microsoft 365, not someone's Xbox login. `tenantId` is validated as a
      // GUID or hostname before it gets this far (parseAppRegistration).
      authority: `${config.M365_AUTHORITY_HOST}/${registration.tenantId}`,
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

export function createEntraClient(): EntraClient {
  return {
    async getAuthCodeUrl(registration, { redirectUri, state, nonce, codeChallenge }) {
      const { app } = buildApp(registration, null);
      return await app.getAuthCodeUrl({
        scopes: [...M365_SCOPES],
        redirectUri,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod: "S256",
        // Let the person pick the work account even when their browser is
        // already signed in to another one — linking the wrong mailbox is
        // worse than one extra click.
        prompt: "select_account",
      });
    },

    async acquireByAuthorizationCode(
      registration,
      { code, redirectUri, codeVerifier, nonce },
    ): Promise<EntraAuthResult> {
      const { app, cache } = buildApp(registration, null);
      // Same scopes and byte-identical redirect URI as the authorize leg, or
      // Entra refuses the redemption. The nonce makes MSAL check the ID token
      // echoes it; the verifier is what makes an intercepted code worthless.
      const result = await app.acquireTokenByCode({
        scopes: [...M365_SCOPES],
        code,
        redirectUri,
        codeVerifier,
        nonce,
      });
      if (!result) throw new Error("Microsoft returned no result for the sign-in.");
      return toAuthResult(result, cache.read());
    },

    async acquireByDeviceCode(registration, { onCode }): Promise<EntraAuthResult> {
      const { app, cache } = buildApp(registration, null);

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

    async acquireSilent(registration, serializedCache, homeAccountId): Promise<EntraAuthResult> {
      const { app, cache } = buildApp(registration, serializedCache);

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
