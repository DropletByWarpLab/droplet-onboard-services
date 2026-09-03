"use client";

// WARP-2545 — new customer / new deal, and the record drawer that shows a
// timeline and logs to it. Same `Dialog` + `pm-*` vocabulary as the Projects
// modals so the two halves of this page are one surface.

import { useId, useState, type JSX } from "react";
import Link from "next/link";

import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { SafetyChip } from "@/components/projects/bits";
import { PmIcon } from "@/components/projects/icons";
import { translateError } from "@/lib/friendly-errors";

import { Timeline } from "./views";
import { useCompanies, useCrmActions, useTimeline } from "./useCrm";
import type { CrmSubject } from "./types";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="pm-field" style={{ marginBottom: 14 }}>
      <label>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: "var(--text-4)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Footer({
  onClose,
  onSubmit,
  submitLabel,
  busy,
  disabled,
}: {
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div
      className="pm-row"
      style={{
        justifyContent: "space-between",
        gap: 8,
        padding: "14px 0 0",
        borderTop: "1px solid var(--border)",
        marginTop: 16,
      }}
    >
      <SafetyChip tier="write" />
      <div className="pm-row" style={{ gap: 8 }}>
        <button className="pm-btn" type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="pm-btn primary" type="button" onClick={onSubmit} disabled={busy || disabled}>
          {busy ? "Working…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

export function NewCompanyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const titleId = useId();
  const { toast } = useToast();
  const actions = useCrmActions();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [industry, setIndustry] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await actions.createCompany({
        name: name.trim(),
        domain: domain.trim() || null,
        industry: industry.trim() || null,
      });
      toast("Customer added", "success");
      onCreated();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>
          New customer
        </h2>
        <Field label="Name">
          <input
            className="pm-input"
            placeholder="Who are they?"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field
          label="Website"
          hint="Used to spot the same customer arriving twice — paste the address bar, it gets tidied up."
        >
          <input
            className="pm-input"
            placeholder="example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </Field>
        <Field label="Industry">
          <input
            className="pm-input"
            placeholder="Optional"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
          />
        </Field>
        <Footer
          onClose={onClose}
          onSubmit={() => void submit()}
          submitLabel="Add customer"
          busy={busy}
          disabled={!name.trim()}
        />
      </div>
    </Dialog>
  );
}

/**
 * Amount is entered in MAJOR units (what a human types) and converted to the
 * minor-unit string the API takes. The conversion is string arithmetic on
 * purpose: `Math.round(Number(x) * 100)` is wrong for values a real pipeline
 * contains, and this is the one place a typed figure becomes the stored one.
 */
export function toMinorUnits(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = /^(-)?(\d+)(?:[.,](\d{0,2}))?$/.exec(trimmed.replace(/[\s,](?=\d{3}\b)/g, ""));
  if (!m) return null;
  const [, sign, whole, frac = ""] = m;
  return `${sign ?? ""}${whole}${frac.padEnd(2, "0")}`;
}

export function NewDealModal({
  pipelineId,
  stageId,
  onClose,
  onCreated,
}: {
  pipelineId: string;
  stageId?: string;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const titleId = useId();
  const { toast } = useToast();
  const actions = useCrmActions();
  const { companies } = useCompanies("", false);

  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [closeOn, setCloseOn] = useState("");
  const [busy, setBusy] = useState(false);

  const amountMinor = toMinorUnits(amount);
  const amountInvalid = amount.trim().length > 0 && amountMinor === null;

  const submit = async (): Promise<void> => {
    if (!title.trim() || busy || amountInvalid) return;
    setBusy(true);
    try {
      await actions.createDeal({
        title: title.trim(),
        pipelineId,
        stageId,
        companyId: companyId || null,
        // Currency travels only when there is an amount: the box refuses one
        // without the other, and sending a lone currency would be a 422 the
        // customer did not cause.
        amountMinor,
        currency: amountMinor === null ? null : currency,
        expectedCloseOn: closeOn ? new Date(closeOn).toISOString() : null,
      });
      toast("Deal created", "success");
      onCreated();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>
          New deal
        </h2>
        <Field label="What are you selling?">
          <input
            className="pm-input"
            placeholder="e.g. Annual service contract"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Customer">
          <select className="pm-input" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">No customer yet</option>
            {(companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="pm-row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 2 }}>
            <Field label="Value" hint={amountInvalid ? "Enter an amount like 2500 or 2500.00" : undefined}>
              <input
                className="pm-input pm-mono"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={amountInvalid || undefined}
              />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Currency">
              <input
                className="pm-input pm-mono"
                value={currency}
                maxLength={3}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                aria-label="Currency code"
              />
            </Field>
          </div>
          <div style={{ flex: 2 }}>
            <Field label="Expected close">
              <input
                className="pm-input pm-mono"
                type="date"
                value={closeOn}
                onChange={(e) => setCloseOn(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <Footer
          onClose={onClose}
          onSubmit={() => void submit()}
          submitLabel="Create deal"
          busy={busy}
          disabled={!title.trim() || amountInvalid}
        />
      </div>
    </Dialog>
  );
}

/**
 * The record page, as a side drawer: the timeline, and the one write that
 * populates it. Deliberately read-mostly in v1 — editing a customer's fields
 * belongs with the field-level provenance work, not with the first surface.
 */
export function RecordDrawer({
  title,
  subject,
  readOnly,
  onClose,
}: {
  title: string;
  subject: { type: CrmSubject; id: string };
  readOnly: boolean;
  onClose: () => void;
}): JSX.Element {
  const titleId = useId();
  const { toast } = useToast();
  const actions = useCrmActions();
  const { activities, isLoading, mutate } = useTimeline(subject);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const log = async (): Promise<void> => {
    if (!note.trim() || busy) return;
    setBusy(true);
    try {
      await actions.logActivity({
        subjectType: subject.type,
        companyId: subject.type === "COMPANY" ? subject.id : null,
        dealId: subject.type === "DEAL" ? subject.id : null,
        contactId: subject.type === "CONTACT" ? subject.id : null,
        kind: "NOTE",
        summary: note.trim(),
      });
      setNote("");
      mutate();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="right" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body" style={{ display: "grid", gap: 14 }}>
        <div className="pm-row" style={{ justifyContent: "space-between", gap: 10 }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
            {title}
          </h2>
          <div className="pm-row" style={{ gap: 8 }}>
            {/* WARP-2563 — the way into the full record.
                The drawer stays what it is: a quick look and a place to log a
                note without losing your place in the list. The record page is
                the other question — people, projects, the timeline and the
                upstreams this customer is linked to — and it needs a page.
                Deals and contacts have no record page, so the link is only
                offered where it leads somewhere. */}
            {subject.type === "COMPANY" && (
              <Link className="pm-btn ghost sm" href={`/customers/${subject.id}`}>
                <PmIcon name="board" size={14} /> Full record
              </Link>
            )}
            <button className="pm-btn ghost sm" type="button" onClick={onClose} aria-label="Close">
              <PmIcon name="x" size={14} />
            </button>
          </div>
        </div>

        {!readOnly && (
          <div className="pm-row" style={{ gap: 8 }}>
            <input
              className="pm-input"
              placeholder="Log a call or a note…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void log();
                }
              }}
              aria-label="Log an activity"
            />
            <button
              className="pm-btn primary"
              type="button"
              onClick={() => void log()}
              disabled={busy || !note.trim()}
            >
              {busy ? "Saving…" : "Log"}
            </button>
          </div>
        )}

        <Timeline activities={activities} isLoading={isLoading} />
      </div>
    </Dialog>
  );
}
