"use client";

/**
 * WARP-3532 — `/integrations/work-notifications`, the owner/admin surface for
 * sending work updates to Slack, Teams, Discord, Google Chat or any webhook.
 *
 * A sibling of Integrations and Credentials rather than a card on the hub, for
 * the reason WARP-2968 gave for Credentials: a destination you can only reach by
 * guessing what it is behind is not in the nav. The page is a shell;
 * `WorkNotificationsSection` carries the admin gate.
 */

import { Webhook } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { WorkNotificationsSection } from "@/components/integrations/WorkNotificationsSection";

export default function WorkNotificationsPage() {
  return (
    <ShellPage
      icon={<Webhook size={15} />}
      label="Work notifications"
      title="Work notifications"
      sub="Send work updates to Slack, Teams, Discord, Google Chat or any address that can receive a webhook."
    >
      <WorkNotificationsSection />
    </ShellPage>
  );
}
