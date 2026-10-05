/**
 * Sealing a webhook's signing secret at rest (WARP-3532, ADR-069 §9, ADR-042).
 *
 * The same sealing `IntegrationConnection.providerTokensEnc` uses — AES-256-GCM
 * through column-crypto, under `deriveSaasCredentialKey()` — bound to ITS row by
 * the AAD `pm-webhook-secret:<webhook id>`. Two properties follow from the AAD,
 * and both fail closed:
 *
 *   - a blob moved to another webhook row does not open there;
 *   - a webhook's blob cannot be opened as a connection credential (those carry
 *     the AAD `saas-credential:<connection id>`), nor the reverse.
 *
 * The plaintext exists in exactly two places: the response to the request that
 * created or rotated the secret (shown once), and the memory of the delivery
 * worker for the length of one signing call. It is never logged, never in an
 * audit row, never returned by a read.
 */
import { decryptColumn, deriveSaasCredentialKey, encryptColumn } from "../column-crypto.service.js";

export function webhookSecretAad(webhookId: string): string {
  return `pm-webhook-secret:${webhookId}`;
}

export function sealWebhookSecret(webhookId: string, secret: string): string {
  return encryptColumn(deriveSaasCredentialKey(), secret, webhookSecretAad(webhookId));
}

/** Throws when the blob is not this webhook's or the device key has changed. */
export function openWebhookSecret(webhookId: string, blob: string): string {
  return decryptColumn(deriveSaasCredentialKey(), blob, webhookSecretAad(webhookId));
}
