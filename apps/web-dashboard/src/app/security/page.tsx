"use client";

/**
 * WARP-2977 (ADR-059 §3.1) — /security, the command center's feed.
 *
 * One stream for what the cameras saw, when a camera stopped reporting, and
 * (for owners and admins) network and sign-in warnings. Gated on the
 * `security` module by the nav-derived route guard; the rows inside are
 * filtered server-side by the viewer's camera grants.
 *
 * P2 is read-only: zones, hours and modes are P2b, incidents and alerts P3.
 */
import { useMemo, useState } from "react";
import { Shield } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { SecurityFeed, kindsForView, type SecurityView } from "@/components/security/SecurityFeed";
import { useSecurityFeed, useSecurityHealth } from "@/lib/hooks/useSecurity";
import { useAuth } from "@/lib/auth";

const PAGE_SUB = "What your cameras saw, whether they're reporting, and network warnings, in one place.";

export default function SecurityPage() {
  const { user } = useAuth();
  const canSeeThreats = user?.role === "owner" || user?.role === "admin";
  const [view, setView] = useState<SecurityView>("all");
  const [includeLow, setIncludeLow] = useState(false);

  const filter = useMemo(
    () => ({ kinds: kindsForView(view, includeLow), includeLow, limit: 50 }),
    [view, includeLow],
  );
  const feed = useSecurityFeed(filter);
  const health = useSecurityHealth();

  return (
    <ShellPage icon={<Shield size={15} />} label="Security" title="Security" sub={PAGE_SUB}>
      <SecurityFeed
        sources={health.sources}
        healthError={health.error}
        events={feed.events}
        isLoading={feed.isLoading}
        error={feed.error}
        hasMore={feed.hasMore}
        isLoadingMore={feed.isLoadingMore}
        onLoadMore={feed.loadMore}
        onRetry={() => {
          feed.refresh();
          health.refresh();
        }}
        view={view}
        onViewChange={setView}
        includeLow={includeLow}
        onIncludeLowChange={setIncludeLow}
        canSeeThreats={canSeeThreats}
      />
    </ShellPage>
  );
}
