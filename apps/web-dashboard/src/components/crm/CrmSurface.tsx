"use client";

/**
 * WARP-2545 — the Customers and Deals halves of the CRM, as one component the
 * Projects page swaps in when its sub-tab is not "projects".
 *
 * Kept out of `app/projects/page.tsx` on purpose: that file already carries the
 * whole PM workspace, and folding two more surfaces into it would make the one
 * file nobody wants to open. The page owns the tab and the chrome; this owns
 * the CRM's own state.
 */

import { useState, type JSX } from "react";

import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "@/components/projects/icons";
import { EmptyBlock } from "@/components/projects/bits";

import { CustomersView, DealBoard, Timeline, type CrmDomain } from "./views";
import { NewCompanyModal, NewDealModal, RecordDrawer } from "./modals";
import { useCompanies, useCrmActions, useCrmSummary, useDeals, usePipelines } from "./useCrm";
import type { CrmCompany, CrmDeal } from "./types";

export function CrmSurface({
  tab,
  readOnly,
}: {
  tab: "customers" | "deals";
  readOnly: boolean;
}): JSX.Element {
  const { toast } = useToast();
  const actions = useCrmActions();

  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [drawer, setDrawer] = useState<
    { kind: "company"; company: CrmCompany } | { kind: "deal"; deal: CrmDeal } | null
  >(null);
  const [modal, setModal] = useState<{ kind: "company" } | { kind: "deal"; stageId: string } | null>(
    null,
  );

  const { pipelines, error: pipeErr, isLoading: pipeLoading } = usePipelines();
  // The default pipeline is the board. A pipeline switcher is deliberately not
  // in v1: one pipeline is the shape almost every box has, and a switcher that
  // shows one option is noise.
  const pipeline = pipelines?.find((p) => p.isDefault) ?? pipelines?.[0] ?? null;

  const {
    companies,
    error: compErr,
    isLoading: compLoading,
    mutate: mutateCompanies,
  } = useCompanies(q, showArchived);
  const { deals, error: dealErr, isLoading: dealLoading, mutate: mutateDeals } = useDeals(
    pipeline?.id ?? null,
  );
  const { stages: summary, mutate: mutateSummary } = useCrmSummary(pipeline?.id ?? null);

  function domainFor(
    loading: boolean,
    error: unknown,
    rows: unknown[] | undefined,
    filtered: boolean,
  ): CrmDomain {
    if (error) return "error";
    if (loading && !rows) return "loading";
    if (!rows || rows.length === 0) return filtered ? "filtered" : "empty";
    return "populated";
  }

  async function onMove(deal: CrmDeal, stageId: string): Promise<void> {
    try {
      await actions.moveDeal(deal.id, stageId);
      mutateDeals();
      mutateSummary();
    } catch (e) {
      // Never render the wire code: `invalid_stage` in a toast is the WARP-1154
      // leak. The board also re-reads, so a rejected move snaps back rather
      // than leaving the card in a stage the box did not accept.
      toast(translateError(e, "projects"), "error");
      mutateDeals();
    }
  }

  if (tab === "customers") {
    return (
      <>
        <div
          className="pm-row"
          style={{ gap: 10, flexWrap: "wrap", justifyContent: "space-between", marginBottom: 12 }}
        >
          <div className="pm-search" style={{ minWidth: 240 }}>
            <PmIcon name="search" size={14} />
            <input
              placeholder="Search customers"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search customers"
            />
          </div>
          <div className="pm-row" style={{ gap: 8 }}>
            <button
              type="button"
              className={"pm-chip" + (showArchived ? " on" : "")}
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
            >
              Show archived
            </button>
            {!readOnly && (
              <button className="pm-btn primary" type="button" onClick={() => setModal({ kind: "company" })}>
                <PmIcon name="plus" size={14} /> New customer
              </button>
            )}
          </div>
        </div>

        <CustomersView
          companies={companies ?? []}
          domain={domainFor(compLoading, compErr, companies, q.trim().length > 0)}
          readOnly={readOnly}
          onOpen={(company) => setDrawer({ kind: "company", company })}
          onNew={() => setModal({ kind: "company" })}
        />

        {drawer?.kind === "company" && (
          <RecordDrawer
            title={drawer.company.name}
            subject={{ type: "COMPANY", id: drawer.company.id }}
            readOnly={readOnly}
            onClose={() => setDrawer(null)}
          />
        )}
        {modal?.kind === "company" && (
          <NewCompanyModal
            onClose={() => setModal(null)}
            onCreated={() => {
              setModal(null);
              mutateCompanies();
            }}
          />
        )}
      </>
    );
  }

  // ── Deals ──

  if (pipeErr) {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="alert"
          tone="error"
          heading="Couldn't load the pipeline."
          body="Check the appliance connection and try again."
        />
      </div>
    );
  }

  return (
    <>
      <DealBoard
        stages={pipeline?.stages ?? []}
        deals={deals ?? []}
        summary={summary}
        domain={domainFor(pipeLoading || dealLoading, dealErr, deals, false)}
        readOnly={readOnly}
        onOpen={(deal) => setDrawer({ kind: "deal", deal })}
        onMove={(deal, stageId) => void onMove(deal, stageId)}
        onNew={(stageId) => setModal({ kind: "deal", stageId })}
      />

      {drawer?.kind === "deal" && (
        <RecordDrawer
          title={drawer.deal.title}
          subject={{ type: "DEAL", id: drawer.deal.id }}
          readOnly={readOnly}
          onClose={() => setDrawer(null)}
        />
      )}
      {modal?.kind === "deal" && pipeline && (
        <NewDealModal
          pipelineId={pipeline.id}
          stageId={modal.kind === "deal" ? modal.stageId : undefined}
          onClose={() => setModal(null)}
          onCreated={() => {
            setModal(null);
            mutateDeals();
            mutateSummary();
          }}
        />
      )}
    </>
  );
}

export { Timeline };
