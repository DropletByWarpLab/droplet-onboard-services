/**
 * Shared error-handler helper for the `/network/*` route modules.
 *
 * `DeviceRegistryError` carries an HTTP status and a `toJSON()` payload
 * — surface it directly to the client. Anything else falls through to
 * the default Express error pipeline.
 */

import { DeviceRegistryError } from "../types/device-registry-error.js";

export function handleRegistryError(err: unknown, res: any, next: any): void {
  if (err instanceof DeviceRegistryError) {
    res.status(err.status ?? 400).json({ error: err.toJSON() });
    return;
  }
  next(err);
}
