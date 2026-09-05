"use client";

/**
 * `/customers/filing` — "Needs a look" (WARP-2730, ADR-048).
 *
 * A SUB-ROUTE of the CRM's existing destination, which is why `nav-config.ts`
 * and its module-vocabulary tests are untouched: the module registry's
 * `navHrefs` already claims `/customers`, and a route beneath it inherits the
 * entry rather than adding a second one. A new top-level nav item for a review
 * queue would also be wrong on its own terms — it is a thing you visit when the
 * banner tells you to, not a place you live.
 *
 * The page is thin, like `/customers` itself: it contributes the module gate,
 * the chrome and the role check, and `FilingSurface` owns everything else.
 */

import type { JSX } from "react";
import Link from "next/link";
import { Building2 } from "lucide-react";

import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import { useAppCapabilities } from "@/lib/hooks/useAppCapabilities";
import { CrmDisabled } from "@/components/crm/CrmDisabled";
import { FilingSurface } from "@/components/crm/FilingSurface";
import { EmptyBlock } from "@/components/projects/bits";
import "../../projects/projects.css";
import "./filing.css";

export default function CustomersFilingPage(): JSX.Element {
  // Fails CLOSED, like `/customers`: an unresolved capability probe renders the
  // honest off-state rather than a surface whose every request the module gate
  // then 404s.
  const { crm: crmEnabled } = useAppCapabilities();
  if (!crmEnabled) return <CrmDisabled />;
  return <FilingWorkspace />;
}

function FilingWorkspace(): JSX.Element {
  const { user } = useAuth();
  // Owner and admin only, matching the route's own `requireRole`. Checked here
  // too so a `family` member who follows a deep link gets an explanation
  // instead of an empty page full of failed requests.
  const allowed = user?.role === "owner" || user?.role === "admin";

  return (
    <ShellPage
      icon={<Building2 size={15} />}
      label="Customers"
      title="Needs a look"
      actions={
        <Link className="btn" href="/customers">
          Back to customers
        </Link>
      }
    >
      <div className="pm-scope">
        <div className="pm-page">
          {allowed ? (
            <FilingSurface />
          ) : (
            <EmptyBlock
              icon="shield"
              heading="Only the box's owner can see this"
              body="These suggestions quote from documents, so they are kept to the people who manage this box."
            />
          )}
        </div>
      </div>
    </ShellPage>
  );
}
