"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Globe } from "lucide-react";
import { fetchVpnStatus } from "@/lib/api";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/** Show the configured internal DNS name without claiming a public domain. */
export function AddressStep({ onComplete, onSkip }: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [hostname, setHostname] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const status = await fetchVpnStatus();
      setHostname(status.internalHostname?.trim() || null);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <StepShell
      current="address"
      title="Your internal web address"
      subtitle="Reach your Droplet through your office DNS or a WireGuard connection."
      primary={{ label: "Continue", onClick: onComplete, showArrow: true }}
      skip={{ label: "Skip — I'll do this later", onClick: onSkip }}
    >
      <div className="dp-card !p-4 flex items-start gap-3">
        <Globe size={22} className="text-accent flex-none" aria-hidden="true" />
        <div className="min-w-0">
          <p className="type-subheadline text-label-primary mb-1">Internal DNS address</p>
          <p className="type-footnote text-label-secondary font-mono break-all" role="status">
            {loading ? "Checking…" : hostname ? `https://${hostname}` : failed ? "Couldn't check the internal address." : "Internal DNS name is not configured."}
          </p>
          {!loading && !hostname && (
            <p className="type-footnote text-label-secondary mt-2">
              Set the Droplet's internal hostname and point your office DNS at its LAN address, then check again.
            </p>
          )}
          {!loading && (
            <button type="button" onClick={() => void load()} className="type-footnote text-accent hover:underline mt-2">
              Check again
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-start gap-2 type-footnote text-label-secondary">
        <AlertCircle size={16} className="flex-none mt-0.5" aria-hidden="true" />
        <p>HTTPS uses your Droplet's certificate. Your device may need to trust it, and the certificate must cover the internal hostname.</p>
      </div>
      <LearnMoreCard title="How the address works" helpAnchor="internet">
        <p>Your internal DNS keeps this name on your network. The WireGuard configuration sends DNS requests to the Droplet so you can use the same name through the tunnel.</p>
        <p>For away-from-office access, configure a reachable direct WireGuard endpoint and allow its UDP port through your router. The Remote Access page creates separate office and away configurations.</p>
      </LearnMoreCard>
    </StepShell>
  );
}
