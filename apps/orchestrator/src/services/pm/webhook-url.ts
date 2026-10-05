/**
 * Sealing for the webhook destination URL. Chat-app URLs carry a posting
 * credential in their path, so the full value is encrypted at rest as well as
 * being kept out of API reads, audit rows and logs.
 */
import { decryptColumn, deriveSaasCredentialKey, encryptColumn } from "../column-crypto.service.js";

export function webhookUrlAad(webhookId: string): string {
  return `pm-webhook-url:${webhookId}`;
}

export function sealWebhookUrl(webhookId: string, url: string): string {
  return encryptColumn(deriveSaasCredentialKey(), url, webhookUrlAad(webhookId));
}

/** Throws when the blob is not this webhook's URL or the device key changed. */
export function openWebhookUrl(webhookId: string, blob: string): string {
  return decryptColumn(deriveSaasCredentialKey(), blob, webhookUrlAad(webhookId));
}
