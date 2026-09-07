"use client";

/**
 * Customers — the CRM's own route (WARP-2558, ADR-044 slice 1).
 *
 * The CRM shipped as sub-tabs on /projects because it had nowhere else to
 * live: `navHrefs: []` and `requires: "projects"` in the module registry. That
 * cost three things this file exists to undo — a page whose header renamed
 * itself when a module flipped, a Projects tab that was a sibling of itself,
 * and a box that could not have Customers without also running PM.
 *
 * The page is thin on purpose. `CrmSurface` already owns the CRM's own state
 * and takes the section as a prop, so the route contributes the gate, the
 * chrome and the switch, and nothing else.
 */

import { useState, type JSX } from "react";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import { useAppCapabilities } from "@/lib/hooks/useAppCapabilities";
import { PmIcon } from "@/components/projects/icons";
import { canWrite } from "@/components/projects/types";
import { CrmTabs, type CrmTab } from "@/components/crm/CrmTabs";
import { CrmSurface } from "@/components/crm/CrmSurface";
import { CrmDisabled } from "@/components/crm/CrmDisabled";
import { FilingBanner } from "@/components/crm/FilingSurface";
import { stagePromptHandoff } from "@/lib/pin-handoff";
// The CRM renders inside the PM design scope (`pm-scope` / `pm-page` and the
// pill tablist). The stylesheet is imported here rather than duplicated —
// splitting it would let the two surfaces drift apart visually, which is the
// same reason CrmTabs is built on the ViewSwitcher tablist.
import "../projects/projects.css";
import "./filing/filing.css";

export default function CustomersPage(): JSX.Element {
  // The flag fails CLOSED (useAppCapabilities DEFAULTS), so an unresolved
  // probe renders the honest off-state rather than a surface whose every
  // request the module gate then 404s. The nav entry is hidden by the same
  // flag; this covers direct URLs and deep links.
  const { crm: crmEnabled } = useAppCapabilities();
  if (!crmEnabled) return <CrmDisabled />;
  return <CustomersWorkspace />;
}

function CustomersWorkspace(): JSX.Element {
  const { user } = useAuth();
  const readOnly = !canWrite(user?.role);

  const [tab, setTab] = useState<CrmTab>("customers");

  // Constant per route. The bug this replaces: /projects computed
  // `crmEnabled ? "CRM" : "Projects"`, so the sidebar and the page header
  // disagreed on a CRM-on box. A module turning on may ADD a destination; it
  // may never rebrand one.
  const title = tab === "customers" ? "Customers" : "Deals";

  return (
    <ShellPage
      icon={<Building2 size={15} />}
      label="Customers"
      title={title}
      actions={
        // The create actions live beside the content they create, where the
        // stage or column that decides where a record lands is visible. This
        // slot is for the one action that has no such context.
        // WARP-2582 — this action is LIST-scoped: there is no record here, so
        // there is no `ref` and nothing to pin. Seeding the composer is the
        // honest whole of what it can do, and it is strictly more than the
        // bare href it replaces, which handed the assistant nothing at all.
        // The per-record PIN lives on the record drawer (components/crm/
        // modals.tsx), where an id exists.
        <Link
          className="btn"
          href="/chat"
          onClick={() =>
            stagePromptHandoff("Customers", "About my customers: ")
          }
        >
          <PmIcon name="msg" size={14} /> Ask AI about your customers
        </Link>
      }
    >
      <div className="pm-scope">
        <div className="pm-page">
          {/* WARP-2730 — renders nothing at all when there is nothing waiting,
              when filing is off, or when the reader is not an owner or admin
              (the summary 403s for `family`, which is the ordinary answer and
              not a fault). A banner that is always there stops being read. */}
          <FilingBanner />
          <div style={{ marginBottom: 14 }}>
            <CrmTabs tab={tab} onTab={setTab} />
          </div>
          <CrmSurface tab={tab} readOnly={readOnly} />
        </div>
      </div>
    </ShellPage>
  );
}
