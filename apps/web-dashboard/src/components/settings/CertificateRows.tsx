"use client";

/** The installed HTTPS certificate and key fingerprint, visible to owners
 * and admins. Expiry and hostname coverage describe the served leaf. */
import { useEffect, useState } from "react";
import { fetchTlsCertificate, type TlsCertificate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { KeyFingerprint } from "@/components/KeyFingerprint";

/** Certificate remediation for the internal DNS deployment. */
export const CERTIFICATE_ACTION =
  "Ask your administrator to replace the certificate with one that covers the internal DNS hostname, and install its trust on your device if needed.";

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/** Certificate status text and guidance from installed leaf metadata. */
export function certificateCopy(c: TlsCertificate): { value: string; warning: string | null; note: string | null } {
  if (c.state !== "LOCAL_CERTIFICATE") {
    return {
      value: "Certificate information unavailable",
      warning: null,
      note: "The Droplet couldn't read its installed HTTPS certificate. Ask your administrator to check the certificate files before trusting this connection.",
    };
  }

  const name = c.fqdn ?? "this Droplet";
  const value = c.daysLeft === null
    ? `${name} · expiry unavailable`
    : c.daysLeft < 0
      ? `${name} · expired ${days(-c.daysLeft)} ago`
      : c.daysLeft === 0
        ? `${name} · expires today`
        : `${name} · valid for ${days(c.daysLeft)} more`;
  const warnings: string[] = [];
  if (c.coversInternalHostname === false) {
    warnings.push("The installed certificate does not cover the internal DNS hostname.");
  }
  if (c.daysLeft !== null && c.daysLeft < 0) {
    warnings.push("The installed certificate has expired; browsers will warn.");
  } else if (c.expiringSoon && c.daysLeft !== null) {
    warnings.push(c.daysLeft === 0 ? "The installed certificate expires today." : `Expires in ${days(c.daysLeft)}.`);
  }
  const note = "Your device may need to trust the Droplet's certificate. Verify its fingerprint with your Droplet before trusting it on this device.";
  return {
    value,
    warning: warnings.length ? `${warnings.join(" ")} ${CERTIFICATE_ACTION}` : null,
    note: c.coversInternalHostname === null
      ? `Hostname coverage could not be verified. Check that the certificate covers the internal DNS hostname. ${note}`
      : note,
  };
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
      {cert?.fingerprint && <KeyFingerprint fingerprint={cert.fingerprint} />}
    </>
  );
}
