"use client";

/**
 * WARP-2563 (ADR-044) — the customer record.
 *
 * The page the epic exists for. Before it, `CrmDeal.projectId → PmProject` sat
 * in the schema commented "a won deal becomes the job that delivers it" with
 * nothing that walked it in either direction, and `CrmActivity` — whose own
 * doc comment calls it "the thing the local model reads when asked about a
 * customer" — had no human reader at all.
 *
 * ONE fetch. The orchestrator composes the sections where the joins are cheap,
 * so there is one loading state and one failure state rather than five that
 * resolve in network order and reflow the layout while someone is reading it.
 *
 * 🔴 Nothing on this page is PHI. The practice block is WARP-2564 and hangs
 * off a server-side connector check — a person who may read a customer must
 * not thereby read a patient (ADR-044 §3).
 */

import { useParams } from "next/navigation";
import { type JSX } from "react";
import Link from "next/link";
import { Building2 } from "lucide-react";

import { ShellPage } from "@/components/shell/ShellPage";
import { useAppCapabilities } from "@/lib/hooks/useAppCapabilities";
import { PmIcon } from "@/components/projects/icons";
import { CrmDisabled } from "@/components/crm/CrmDisabled";
import { useCustomerRecord } from "@/components/crm/useCrm";
import { CrmRequestError } from "@/components/crm/useCrm";

import { Deals, Links, People, Projects, Section, Timeline } from "./sections";
import { PracticeBlock } from "./PracticeBlock";
import "../../projects/projects.css";
import "./record.css";

export default function CustomerRecordPage(): JSX.Element {
  // Fails CLOSED, like /customers itself: an unresolved probe renders the
  // honest off-state rather than a surface whose every request 404s.
  const { crm: crmEnabled } = useAppCapabilities();
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : null;

  if (!crmEnabled) return <CrmDisabled />;
  return <Record id={id} />;
}

function Record({ id }: { id: string | null }): JSX.Element {
  const { record, error, isLoading } = useCustomerRecord(id);

  const notFound = error instanceof CrmRequestError && error.status === 404;

  return (
    <ShellPage
      icon={<Building2 size={15} />}
      label="Customers"
      title={record?.company.name ?? "Customer"}
      sub={record?.company.domain ?? undefined}
      actions={
        <>
          <Link className="btn" href="/customers">
            <PmIcon name="chevL" size={14} /> All customers
          </Link>
          <Link className="btn" href="/chat">
            <PmIcon name="msg" size={14} /> Ask AI about this customer
          </Link>
        </>
      }
    >
      <div className="pm-scope">
        <div className="pm-page">
          {notFound ? (
            // A deleted or mistyped customer, said plainly. Not an error
            // toast over an empty skeleton, which reads as "still loading".
            <div className="pm-surface cr-section">
              <p className="cr-empty">
                That customer isn&rsquo;t here — it may have been deleted.{" "}
                <Link className="cr-link" href="/customers">
                  Back to all customers
                </Link>
              </p>
            </div>
          ) : error ? (
            <div className="pm-surface cr-section">
              <p className="cr-empty" role="status">
                Couldn&rsquo;t load this customer just now.
              </p>
            </div>
          ) : isLoading || !record ? (
            // One skeleton for the page, because there is one fetch. Five
            // section skeletons would promise five independent arrivals.
            <div className="pm-surface cr-section">
              <div className="cr-skel" aria-hidden="true" />
            </div>
          ) : (
            <div className="cr-grid">
              <Section title="People" count={record.people.length}>
                <People people={record.people} />
              </Section>

              <Section title="Open deals" count={record.openDeals.length}>
                <Deals
                  deals={record.openDeals}
                  projects={record.projects}
                  emptyText="No open deals."
                />
              </Section>

              <Section title="Projects" count={record.projects.length}>
                <Projects projects={record.projects} />
              </Section>

              {record.closedDeals.length > 0 ? (
                <Section title="Closed deals" count={record.closedDeals.length}>
                  <Deals
                    deals={record.closedDeals}
                    projects={record.projects}
                    emptyText="No closed deals."
                  />
                </Section>
              ) : null}

              {record.links.length > 0 ? (
                <Section title="Linked systems" count={record.links.length}>
                  <Links links={record.links} />
                </Section>
              ) : null}

              {/* WARP-2567 — fetched separately, behind the ERP's own
                  connector gate, and rendering NOTHING when that gate refuses.
                  It is not a section of the record response: that response is
                  cleared by the CRM's gate, which `family` passes, and one
                  more field on it would put a patient on a page the front desk
                  can open. */}
              {record.company.id ? <PracticeBlock companyId={record.company.id} /> : null}

              <Section title="Timeline">
                <Timeline entries={record.timeline} />
              </Section>
            </div>
          )}
        </div>
      </div>
    </ShellPage>
  );
}
