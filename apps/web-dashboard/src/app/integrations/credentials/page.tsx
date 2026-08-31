"use client";

/**
 * WARP-2275 — `/integrations/credentials`, the admin-only credential
 * configurator.
 *
 * Its own route rather than a card on the hub: the hub is a catalog every
 * owner/admin browses, while this is the one surface where a credential is
 * entered, and keeping them apart is what lets the nav gate be honest about
 * which of the two is admin-only.
 *
 * The page is a shell; `SaasCredentialsSection` carries the admin gate, so a
 * non-admin who reaches this URL directly gets the page chrome and no form —
 * and, more importantly, no admin-only request is issued on their behalf.
 */

import { KeyRound } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { SaasCredentialsSection } from "@/components/integrations/SaasCredentialsSection";

export default function IntegrationCredentialsPage() {
  return (
    <ShellPage
      icon={<KeyRound size={15} />}
      label="Credentials"
      title="Connector credentials"
      sub="Give Droplet the keys to the cloud services you already pay for."
    >
      <SaasCredentialsSection />
    </ShellPage>
  );
}
