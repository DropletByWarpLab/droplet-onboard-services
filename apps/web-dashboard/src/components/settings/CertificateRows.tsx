"use client";

/**
 * WARP-2944 (ADR-058 slice 7) — the certificate lifecycle, visible to the
 * owner in Settings → Device information.
 *
 * Until now the daily renewal tick told only the log: a box that could not
 * reach the certificate service kept serving its current certificate
 * (LE_RENEW_FAILED), then fell back to its self-signed one when that expired
 * — and the first an owner heard of it was a browser warning. These rows sit
 * in the existing Device information card and say, from the state row the
 * tick already maintains (no new polling): what certificate the box serves,
 * how long it has, when it renews, and — only when it matters — the one
 * thing that helps. Read-only, owner/admin (the route refuses everyone else,
 * and the rows render nothing for them).
 *
 * The copy is honest about the two audiences: the Droplet APPS pair by the
 * box's own key (WARP-2953/2954) and keep working whatever the certificate's
 * state; BROWSERS need the public certificate for a padlock. A self-signed
 * box is not "broken" — it is what a box without HQ, or an air-gapped box,
 * looks like by design.
 */
import { useEffect, useState } from "react";
import { fetchTlsCertificate, type TlsCertificate } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** The one action that helps. Kept word-for-word with the notification
 *  (tls-notify.service.ts TLS_RENEW_ACTION) so the card and the toast never
 *  disagree about what to do. */
export const RENEW_ACTION =
  "Make sure the Droplet has a working internet connection — it renews on its own once it can reach the certificate service. " +
  "A Droplet needs outbound internet at least once every 60 days to keep its padlock.";

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/** The value for the "Certificate" row, and an optional warning line. Pure,
 *  so every state is pinned by a test without rendering. */
export function certificateCopy(c: TlsCertificate): { value: string; warning: string | null; note: string | null } {
  const name = c.fqdn ?? "this Droplet";
  switch (c.state) {
    case "LE_ISSUED": {
      if (c.daysLeft === null) return { value: `${name} · publicly trusted`, warning: null, note: null };
      if (c.daysLeft < 0) {
        return {
          value: `${name} · expired ${days(-c.daysLeft)} ago`,
          warning: `The public certificate has expired, so browsers will warn until it is renewed. ${RENEW_ACTION}`,
          note: null,
        };
      }
      const value =
        c.renewsInDays && c.renewsInDays > 0
          ? `${name} · renews in ${days(c.renewsInDays)}`
          : `${name} · renewing (${days(c.daysLeft)} left)`;
      return {
        value,
        warning: c.expiringSoon
          ? `Expires in ${days(c.daysLeft)} and has not been renewed yet. ${RENEW_ACTION}`
          : null,
        note: null,
      };
    }
    case "LE_RENEWING":
      return {
        value: `${name} · renewing now`,
        warning: null,
        note: c.daysLeft !== null ? `${days(Math.max(0, c.daysLeft))} left on the current certificate.` : null,
      };
    case "LE_RENEW_FAILED": {
      const left =
        c.daysLeft === null
          ? "The Droplet is still serving its current certificate."
          : c.daysLeft < 0
            ? `The public certificate expired ${days(-c.daysLeft)} ago; browsers will warn until this is fixed. The Droplet apps keep working through their pairing.`
            : `The Droplet is still serving its current certificate, valid for ${days(c.daysLeft)} more.`;
      return {
        value: `${name} · renewal failing`,
        warning: `The last renewal attempt could not reach the certificate service. ${left} ${RENEW_ACTION}`,
        note: null,
      };
    }
    default:
      // BOOTSTRAP_SELF_SIGNED and anything unknown: the box's own certificate.
      return {
        value: "Self-signed (the Droplet's own key)",
        warning: null,
        note: c.hqConfigured
          ? "The Droplet apps pair by this key — scan the pairing QR on the screen or on Devices → Pair. Browsers show a warning until the Droplet's public certificate is issued; that happens on its own once it can reach the certificate service."
          : "The Droplet apps pair by this key — scan the pairing QR on the screen or on Devices → Pair. This Droplet is not set up for a public certificate, so browsers show a warning; the apps do not.",
      };
  }
}

export function CertificateRows() {
  const { user } = useAuth();
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const [cert, setCert] = useState<TlsCertificate | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await fetchTlsCertificate();
        if (!cancelled) setCert(c);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin) return null;

  const copy = cert ? certificateCopy(cert) : null;
  return (
    <>
      <div className="lrow" style={{ padding: "12px 16px" }} data-testid="certificate-row">
        <span className="rt">
          <span className="nm" style={{ color: "var(--text-muted)", fontWeight: 400 }}>Certificate</span>
        </span>
        <span className="rmeta mono">{copy ? copy.value : failed ? "—" : "Loading..."}</span>
      </div>
      {copy?.warning && (
        <div
          role="alert"
          data-testid="certificate-warning"
          className="mx-4 mb-3 p-2 rounded type-caption-1 bg-system-orange/10 text-system-orange"
        >
          {copy.warning}
        </div>
      )}
      {copy?.note && (
        <div className="mx-4 mb-3 type-caption-1" style={{ color: "var(--text-muted)" }} data-testid="certificate-note">
          {copy.note}
        </div>
      )}
    </>
  );
}
