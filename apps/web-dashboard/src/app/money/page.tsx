"use client";

/**
 * Money — what the business is owed and what it owes (WARP-2581, ADR-044).
 *
 * The only money in the product before this was one number: an
 * accounts-receivable tile on /reports, read live from the practice's server
 * every time somebody looked at it. It could not say by whom, since when, or
 * what the business owes, and it disappeared whenever that server was off.
 *
 * Three rules this page holds, all of them about not lying with a number:
 *
 * 🔴 **A total is per LEDGER.** A document's currency is usually unknown —
 * `invoice` and `bill` are exempt from the money-needs-a-currency rule because
 * a company file has ONE home currency and its export carries no per-row
 * column — so two ledgers are not addable. Where they cannot be added the
 * figure is WITHHELD and the ledgers are listed. Never a `0`, never a
 * converted figure, never the biggest one with the rest in a footnote.
 *
 * 🔴 **Every figure here is a BALANCE, not an amount.** An invoice part-paid
 * still carries its original amount, and summing amounts where you meant
 * balances overstates receivables.
 *
 * 🔴 **"Read 4 min ago", never "up to date".** Xero's modification timestamp
 * does not fire on a due-date edit or a send-to-contact, and Stripe does not
 * guarantee event order, so freshness is a claim this box is not entitled to
 * make. It may say when it last read.
 *
 * A failed read does NOT empty the ledger. Landed documents are at-rest data
 * and the whole reason for landing them is that this surface survives the
 * vendor being unreachable — the error sits above the table, and the table
 * still renders.
 */

import { useState, type JSX } from "react";
import { ArrowDownLeft, ArrowUpRight, Wallet } from "lucide-react";

import { ShellPage } from "@/components/shell/ShellPage";
// One date formatter and one "time ago" for every connected-system surface.
// `formatDate` reads a UTC-midnight ledger date as the calendar date it is;
// rolling a private copy is how `/money` came to render due dates a day early.
import { formatDate, syncedAgo } from "@/lib/erp-format";
import { formatFigure, statusClassFor, STALE_AFTER_MS } from "@/components/money/format";
import {
  useMoneyDocuments,
  useMoneySummary,
  type MoneyDocument,
  type MoneyKind,
  type MoneyLedgerTotal,
  type MoneySide,
  type MoneySummary,
} from "./useMoney";
import "./money.css";

type Filter = "ALL" | MoneyKind;

export default function MoneyPage(): JSX.Element {
  const [filter, setFilter] = useState<Filter>("ALL");
  const { summary, error: summaryError, isLoading } = useMoneySummary();
  const { documents, error: documentsError } = useMoneyDocuments(filter);
  const error = summaryError ?? documentsError;

  // 404 is the module gate, and a module-level refusal renders as ABSENT: a
  // page the viewer may not open must not advertise itself. 403 is a person
  // without the grant, which is a locked state and says so.
  if (error?.status === 404) return <MoneyUnavailable />;
  if (error?.status === 403) return <MoneyLocked />;

  return (
    <ShellPage
      icon={<Wallet size={15} />}
      label="Money"
      title="Money"
      sub="What you&rsquo;re owed and what you owe, read from your accounting systems."
    >
      <div className="money-scope">
        <HeaderBand summary={summary} isLoading={isLoading} />
        {error ? <ReadFailed summary={summary} /> : null}
        <div className="money-filter" role="tablist" aria-label="Which direction">
          <FilterTab current={filter} value="ALL" label="All" onPick={setFilter} />
          <FilterTab current={filter} value="RECEIVABLE" label="Owed to you" onPick={setFilter} />
          <FilterTab current={filter} value="PAYABLE" label="You owe" onPick={setFilter} />
        </div>
        <Ledger documents={documents} isLoading={isLoading && documents === undefined} />
      </div>
    </ShellPage>
  );
}

// ── header band ─────────────────────────────────────────────────────────────

function HeaderBand({
  summary,
  isLoading,
}: {
  summary: MoneySummary | undefined;
  isLoading: boolean;
}): JSX.Element {
  if (summary === undefined) {
    return (
      <div className="money-band">
        {/* Never a 0 while loading. A zero that turns into a number is a lie
            the reader has already acted on. */}
        <div className="money-stat money-stat--hero">
          <span className="money-stat__label">Owed to you</span>
          <div className="money-skeleton money-skeleton--figure" aria-hidden="true" />
        </div>
        <div className="money-stat">
          <span className="money-stat__label">You owe</span>
          <div className="money-skeleton money-skeleton--figure" aria-hidden="true" />
        </div>
        <span className="money-band__read">{isLoading ? "Reading…" : ""}</span>
      </div>
    );
  }

  const overdueCount = summary.receivable.overdueCount + summary.payable.overdueCount;

  return (
    <div className="money-band">
      <Stat
        hero
        label="Owed to you"
        side={summary.receivable}
        noun="open invoices"
        pick={(ledger) => ledger.balance}
      />
      <Stat
        label="You owe"
        side={summary.payable}
        noun="open bills"
        pick={(ledger) => ledger.balance}
      />
      <div className={`money-stat${overdueCount > 0 ? " money-stat--alert" : ""}`}>
        <span className="money-stat__label">Overdue</span>
        <span className="money-stat__figure">{overdueCount}</span>
        <span className="money-stat__sub">{overdueCount === 1 ? "1 past due" : `${overdueCount} past due`}</span>
      </div>
      <StalenessChip lastReadAt={summary.lastReadAt} />
    </div>
  );
}

/**
 * One figure — or, where the ledgers cannot be added, the list of what could
 * not be added.
 *
 * A single ledger has a real total. Two do not: their currencies are unknown
 * (a ledger's home currency is not on the row) or genuinely different, and
 * both cases behave the same way. Unknown IS mixed.
 */
function Stat({
  label,
  side,
  noun,
  hero = false,
  pick,
}: {
  label: string;
  side: MoneySide;
  noun: string;
  hero?: boolean;
  pick: (ledger: MoneyLedgerTotal) => string;
}): JSX.Element {
  const sub = `${side.documentCount} ${noun}`;
  return (
    <div className={`money-stat${hero ? " money-stat--hero" : ""}`}>
      <span className="money-stat__label">{label}</span>
      {side.ledgers.length === 1 ? (
        <span className="money-stat__figure" title="Unpaid balance, not the invoiced total.">
          {formatFigure(pick(side.ledgers[0]), side.ledgers[0].currency)}
        </span>
      ) : side.ledgers.length === 0 ? (
        <span className="money-stat__figure" title="Unpaid balance, not the invoiced total.">
          —
        </span>
      ) : (
        <>
          <span className="money-stat__withheld">
            {side.ledgers.map((ledger) => ledger.currency ?? ledger.provider).join(" · ")}
          </span>
          <span className="money-stat__sub">Totals aren&rsquo;t shown across ledgers.</span>
        </>
      )}
      {side.ledgers.length <= 1 ? <span className="money-stat__sub">{sub}</span> : null}
    </div>
  );
}

function StalenessChip({ lastReadAt }: { lastReadAt: string | null }): JSX.Element | null {
  // A claim about age renders only when the age is known.
  if (lastReadAt === null) return null;
  const ageMs = Date.now() - new Date(lastReadAt).getTime();
  if (Number.isNaN(ageMs)) return null;
  const stale = ageMs > STALE_AFTER_MS;
  return (
    <span className={`money-band__read${stale ? " money-band__read--stale" : ""}`}>
      {stale ? `Last read ${syncedAgo(lastReadAt)}` : `Read ${syncedAgo(lastReadAt)}`}
    </span>
  );
}

// ── ledger ──────────────────────────────────────────────────────────────────

function Ledger({
  documents,
  isLoading,
}: {
  documents: MoneyDocument[] | undefined;
  isLoading: boolean;
}): JSX.Element {
  if (isLoading) {
    return (
      <div className="money-table-wrap" aria-busy="true">
        {[0, 1, 2, 3, 4].map((row) => (
          <div className="money-skeleton" key={row} />
        ))}
      </div>
    );
  }

  if (documents === undefined || documents.length === 0) {
    return (
      <div className="money-empty">
        <Wallet size={40} className="money-empty__icon" aria-hidden="true" />
        <span className="money-empty__title">No open documents</span>
        <span className="money-empty__body">
          Nothing outstanding in the ledgers this box has read.
        </span>
      </div>
    );
  }

  return (
    <div className="money-table-wrap">
      <table className="money-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Direction</span>
            </th>
            <th scope="col">Document</th>
            <th scope="col">Counterparty</th>
            <th scope="col">Issued</th>
            <th scope="col">Due</th>
            <th scope="col">Amount</th>
            <th scope="col">Balance</th>
            <th scope="col">Status</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => (
            <Row doc={doc} key={doc.id} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ doc }: { doc: MoneyDocument }): JSX.Element {
  const receivable = doc.kind === "RECEIVABLE";
  return (
    <tr>
      <td>
        <span
          className="money-dir"
          aria-label={receivable ? "Owed to you" : "You owe"}
          title={receivable ? "Owed to you" : "You owe"}
        >
          {receivable ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
        </span>
      </td>
      <td className="money-cell--mono">{doc.externalId}</td>
      <td>{doc.counterparty.name ?? doc.counterparty.externalId ?? "—"}</td>
      <td className="money-cell--mono">{formatDate(doc.issuedAt)}</td>
      <td className={`money-cell--mono${doc.isOverdue ? " money-cell--overdue" : ""}`}>
        {formatDate(doc.dueAt)}
      </td>
      <td className="money-cell--num">{formatFigure(doc.amount, doc.currency)}</td>
      <td className="money-cell--balance">{formatFigure(doc.balance, doc.currency)}</td>
      <td>
        <StatusChip doc={doc} />
      </td>
      <td className="money-source">{doc.externalSystem}</td>
    </tr>
  );
}

/**
 * The vendor's own word, in one of four classes.
 *
 * 🔴 An unrecognised status renders VERBATIM in the neutral class. A vendor
 * word this map has not met is information, not an error — and mapping it to
 * "open" by inventing a rule ("no paid date means open") would render a
 * workflow-closed document as outstanding forever.
 */
function StatusChip({ doc }: { doc: MoneyDocument }): JSX.Element {
  const word = doc.status?.trim() ?? "";
  const cls = statusClassFor(doc.status, doc.isOverdue);
  return (
    <span className={`money-chip${cls === "open" ? "" : ` money-chip--${cls}`}`}>
      {word === "" ? (doc.isOverdue ? "Overdue" : "Open") : word}
    </span>
  );
}

// ── states ──────────────────────────────────────────────────────────────────

function ReadFailed({ summary }: { summary: MoneySummary | undefined }): JSX.Element {
  return (
    <div className="money-empty" role="status">
      <span className="money-empty__title">Couldn&rsquo;t read from your accounting system</span>
      <span className="money-empty__body">
        {summary?.lastReadAt
          ? `Last successful read ${syncedAgo(summary.lastReadAt)}. What was read before is below.`
          : "What was read before is below."}
      </span>
    </div>
  );
}

function MoneyLocked(): JSX.Element {
  // No figures, no counts, no row shells: a locked state that leaks the row
  // count has leaked the data.
  return (
    <ShellPage icon={<Wallet size={15} />} label="Money" title="Money">
      <div className="money-empty">
        <Wallet size={40} className="money-empty__icon" aria-hidden="true" />
        <span className="money-empty__title">You don&rsquo;t have access to money</span>
        <span className="money-empty__body">An owner can grant this in Access and roles.</span>
      </div>
    </ShellPage>
  );
}

function MoneyUnavailable(): JSX.Element {
  return (
    <ShellPage icon={<Wallet size={15} />} label="Money" title="Money">
      <div className="money-empty">
        <Wallet size={40} className="money-empty__icon" aria-hidden="true" />
        <span className="money-empty__title">No accounting system connected</span>
        <span className="money-empty__body">
          Connect Xero, QuickBooks or Stripe and your invoices and bills will appear here.
        </span>
        <a className="btn" href="/integrations">
          Go to Integrations
        </a>
      </div>
    </ShellPage>
  );
}

// ── the one local component the table's filter needs ─────────────────────

function FilterTab({
  current,
  value,
  label,
  onPick,
}: {
  current: Filter;
  value: Filter;
  label: string;
  onPick: (value: Filter) => void;
}): JSX.Element {
  const selected = current === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={`btn${selected ? " btn--active" : ""}`}
      onClick={() => onPick(value)}
    >
      {label}
    </button>
  );
}
