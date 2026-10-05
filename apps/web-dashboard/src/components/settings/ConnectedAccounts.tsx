"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Microsoft365Card } from "./Microsoft365Card";
import { GoogleAccountCard } from "./GoogleAccountCard";
import { AccountProviderSetup } from "./AccountProviderSetup";

export function ConnectedAccounts() {
  const { user } = useAuth();
  const [setupRevision, setSetupRevision] = useState(0);
  if (user?.role !== "owner" && user?.role !== "admin" && user?.role !== "family") return null;

  return <section className="space-y-4" id="connected-accounts" aria-labelledby="connected-accounts-title">
    <h2 className="type-title-3" id="connected-accounts-title">Connected accounts</h2>
    <p className="type-caption-1">Link your mail or calendar for Droplet to use. You will sign in and approve permissions with your provider; this does not change how you sign in to Droplet. Google mail Droplet reads is copied and stored locally on your Droplet. Connected calendar events appear read-only in Calendar after their first sync when Calendar is enabled.</p>
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      <GoogleAccountCard key={`google-${setupRevision}`} />
      <Microsoft365Card key={`microsoft-${setupRevision}`} />
    </div>
    <AccountProviderSetup onSaved={() => setSetupRevision((current) => current + 1)} />
  </section>;
}
