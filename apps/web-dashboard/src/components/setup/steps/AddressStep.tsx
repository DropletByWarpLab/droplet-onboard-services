"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Globe, Lock, ShieldCheck, Wifi } from "lucide-react";
import { fetchVpnStatus } from "@/lib/api";
import type { VpnStatusInfo } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — "Your box has its own web address" (Onboarding-Flow redesign,
 * WIFI-ADDRESS-THEME-HANDOFF §1b). The web-address half of the old combined
 * "Internet" step, now its own step after `wifi`.
 *
 * ADR-023 / ADR-025 — remote access is automatic now. The box already carries
 * its own publicly-trusted web address (the name you gave it, like
 * `home.droplet-us.com`) and reaches you through an OUTBOUND relay tunnel — no
 * dynamic-DNS account, no subdomain or token to paste, no port-forwarding to
 * open. So this step is purely INFORMATIONAL: it shows the box's address (or a
 * generic description until the box has learned it from HQ) and explains that
 * away from home you just flip the Droplet app's Connect toggle to reach the
 * SAME address with a green padlock. There is nothing to configure here.
 *
 * We read the address best-effort from GET /api/vpn/status (`publicFqdn`). A
 * failed or still-empty fetch is fine — we describe the address generically
 * rather than block the customer. The step never writes anything and always
 * advances via the ordinary Back/Continue flow.
 */

/** One node in the "what this is for" chain diagram. */
function ChainNode({
  icon: Icon,
  label,
  caption,
  hot,
}: {
  icon: typeof Globe;
  label: string;
  caption: string;
  hot?: boolean;
}) {
  return (
    <div
      className={`flex-1 min-w-0 rounded-xl px-3 py-2.5 text-center border ${
        hot
          ? "border-accent/30 bg-accent-subtle"
          : "border-separator bg-surface-secondary"
      }`}
    >
      <Icon
        size={17}
        className={`mx-auto ${hot ? "text-accent" : "text-label-tertiary"}`}
        aria-hidden="true"
      />
      <div
        className={`type-caption-1 font-semibold mt-1.5 ${
          hot ? "text-accent" : "text-label-secondary"
        }`}
      >
        {label}
      </div>
      <div className="type-caption-2 text-label-tertiary mt-0.5">{caption}</div>
    </div>
  );
}

export function AddressStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  // The box's publicly-trusted web address (the name the owner gave it). Best-
  // effort — null until the box learns it from HQ, in which case we describe it
  // generically. This step never writes anything, so there's no error state.
  const [address, setAddress] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const status: VpnStatusInfo = await fetchVpnStatus();
      setAddress(status.publicFqdn?.trim() || null);
    } catch {
      // Non-fatal — describe the address generically.
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <StepShell
      current="address"
      title="Your box has its own web address"
      subtitle="Nothing to set up here — your Droplet already has a secure web address, and remote access turns on with one tap in the app."
      primary={{
        label: "Continue",
        onClick: onComplete,
        showArrow: true,
      }}
      skip={{ label: "Skip", onClick: onSkip }}
    >
      {/* Fixed-content body (chain diagram, address card, help card) — NOT an
          unbounded list, so it is NOT wrapped in a <ScrollRegion>. The StepShell
          panel is scroll-when-needed instead. */}
      <>
        {/* The chain, in plain terms — why this step exists. */}
        <div
          className="flex items-stretch gap-2 mb-4"
          role="img"
          aria-label="Home Wi-Fi, then Web address (this step), then Remote access"
        >
          <ChainNode icon={Wifi} label="Home Wi-Fi" caption="on your network" />
          <ArrowRight
            size={14}
            className="self-center flex-none text-label-tertiary"
            aria-hidden="true"
          />
          <ChainNode icon={Globe} label="Web address" caption="this step" hot />
          <ArrowRight
            size={14}
            className="self-center flex-none text-label-tertiary"
            aria-hidden="true"
          />
          <ChainNode
            icon={ShieldCheck}
            label="Remote access"
            caption="reach it away"
          />
        </div>

        {/* The box's own address — the same one at home and away. */}
        <div className="dp-card !p-4 flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent-subtle flex items-center justify-center flex-shrink-0">
            <Lock size={16} className="text-accent" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="type-subheadline text-label-primary">
              Your Droplet&rsquo;s web address
            </p>
            {address ? (
              <p className="type-footnote text-label-secondary mt-1">
                Reach your box at{" "}
                <span className="font-mono break-all text-label-primary">
                  {address}
                </span>{" "}
                — the same secure address at home and away, with a padlock and
                nothing to install.
              </p>
            ) : (
              <p className="type-footnote text-label-secondary mt-1">
                Your box gets its own secure web address from the name you gave
                it during setup. It&rsquo;s the same address at home and away,
                with a padlock and nothing to install.
              </p>
            )}
          </div>
        </div>

        <LearnMoreCard helpAnchor="internet">
          <p>
            Remote access is automatic. Your box already has its own web
            address, so there&rsquo;s nothing to sign up for and no address to
            type in here.
          </p>
          <p>
            When you&rsquo;re away from home, open the Droplet app and turn on{" "}
            <strong>Connect</strong>. Your phone links securely to the box and
            you open the <em>same</em> web address you use at home — a real
            padlock, no warnings, nothing to install on each device.
          </p>
          <p>
            No dynamic-DNS account, no subdomain or token, and no changes to
            your home router. Just tap Connect when you need it.
          </p>
        </LearnMoreCard>
      </>
    </StepShell>
  );
}
