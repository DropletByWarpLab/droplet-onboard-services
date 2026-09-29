/**
 * WARP-3185 F — once a person has acknowledged or resolved an incident here,
 * its alert has no business staying in this device's notification tray.
 *
 * Security alerts are pushed with the tag `security-incident-<id>` (the
 * orchestrator's `incidentTag`, security-alerts.service.ts), so this closes
 * exactly this incident's notifications and no other.
 *
 * `getRegistration()`, not `serviceWorker.ready`: the dashboard registers its
 * service worker only when someone turns phone notifications on
 * (PushSubscriptionCard), and `ready` never settles without one — every
 * acknowledgement would leave a promise pending forever. `getRegistration()`
 * answers `undefined` instead, and then there is nothing to close.
 *
 * Best-effort and silent: a browser without service workers or the
 * notifications API, or a failure reading the tray, never touches the
 * acknowledgement itself.
 */

/** The tag an incident's alert is shown under. */
export function incidentNotificationTag(incidentId: string): string {
  return `security-incident-${incidentId}`;
}

/** Close this incident's notifications on this device. Resolves how many were closed; never rejects. */
export async function closeIncidentNotifications(incidentId: string): Promise<number> {
  const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  if (!container || typeof container.getRegistration !== "function") return 0;
  try {
    const registration = await container.getRegistration();
    if (!registration || typeof registration.getNotifications !== "function") return 0;
    const shown = await registration.getNotifications({ tag: incidentNotificationTag(incidentId) });
    for (const n of shown) n.close();
    return shown.length;
  } catch {
    return 0;
  }
}
