import { isIP } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { decryptColumn, deriveAccountProviderSetupKey, encryptColumn } from "./column-crypto.service.js";
import { parseAppRegistration, type EntraAppRegistration } from "./m365/state.js";

/** Customer-owned registrations configured once per appliance. No default fleet app. */
export async function getMicrosoftApp(prisma: PrismaClient): Promise<EntraAppRegistration | undefined> {
  const row = await prisma.cloudOAuthApp.findUnique({ where: { provider: "MICROSOFT" } });
  if (!row) return undefined;
  const parsed = parseAppRegistration({ clientId: row.clientId, tenantId: row.tenantId });
  return parsed.ok ? parsed.app : undefined;
}

export function sealGoogleAppSecret(secret: string): string {
  return encryptColumn(deriveAccountProviderSetupKey(), secret, "account-provider-setup:GOOGLE");
}

export async function getGoogleApp(prisma: PrismaClient): Promise<{ clientId: string; clientSecret: string } | undefined> {
  const row = await prisma.cloudOAuthApp.findUnique({ where: { provider: "GOOGLE" } });
  if (!row?.clientId || !row.clientSecretEnc) return undefined;
  try {
    const clientSecret = decryptColumn(deriveAccountProviderSetupKey(), row.clientSecretEnc, "account-provider-setup:GOOGLE");
    return clientSecret ? { clientId: row.clientId, clientSecret } : undefined;
  } catch {
    // A restore/reset with another key requires setup again; no ciphertext reaches the UI.
    return undefined;
  }
}

/** Reject callback forms Google explicitly excludes. Google validates registration and public suffixes. */
export function validateGoogleRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search
      && !isIP(host.replace(/^\[|\]$/g, "")) && host.includes(".")
      && !/\.(local|localhost|internal|lan|home|invalid|test|example)$/.test(host);
  } catch {
    return false;
  }
}
