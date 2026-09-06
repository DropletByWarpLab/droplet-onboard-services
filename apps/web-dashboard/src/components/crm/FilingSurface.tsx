"use client";

/**
 * WARP-2730 (ADR-048) — "Needs a look": the things Droplet read out of your
 * files and would like your say on.
 *
 * ── The voice ──────────────────────────────────────────────────────────────
 *
 * ADR-002. The words on this surface are FILE, CUSTOMER, LOOK and UNDO. They
 * are never PROPOSAL, EXTRACTION, ENTITY or CONFIDENCE. That is not a style
 * preference: those four words describe the machine's internal state, and a
 * person deciding whether ACME is a customer does not need to model the
 * machine to answer. `filing-surface.test.tsx` asserts the absence.
 *
 * The numeric confidence is deliberately NOT rendered anywhere. A percentage
 * invites the reader to calibrate against a scale nobody has explained, and the
 * honest signal — WHY this is being asked rather than done — is already a
 * sentence on the card (`policyReason`).
 *
 * ── The two panels ─────────────────────────────────────────────────────────
 *
 * Left: what Droplet would do, in one line, with the fields it would write.
 * Right: WHERE IT READ THAT — the quotes, and a link to the document itself.
 *
 * The right panel is the whole reason this surface is trustworthy. Without it
 * the owner is being asked to approve an assertion; with it they are being
 * asked to check a citation. On a document that mentions patients the quotes
 * are already gone by the time they reach here (locator only), and the panel
 * says so in words rather than rendering an empty box.
 */

import { useState, type JSX } from "react";
import Link from "next/link";

import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "@/components/projects/icons";
import { EmptyBlock } from "@/components/projects/bits";

import {
  useFilingActions,
  useFilingProposals,
  useFilingSummary,
  type FilingProposal,
} from "./useFiling";
import {
  FilingTabList,
  HealthRow,
  RecentlyFiled,
  RulesTab,
  SkippedTab,
  type FilingTab,
} from "./FilingTabs";

/** One line saying what would happen, in the owner's words. */
export function headlineFor(p: FilingProposal): string {
  const d = p.payload ?? {};
  switch (p.kind) {
    case "CREATE_CUSTOMER":
      return `Add ${d.name ?? "this business"} as a customer`;
    case "LINK_FILE":
      return `File this document under ${d.companyName ?? "this customer"}`;
    case "MATCH_REVIEW":
      return `Which customer is ${d.extractedName ?? "this"}?`;
    case "CREATE_CONTACT":
      return `Add ${d.displayName ?? "this person"} to your address book`;
    case "CREATE_PROJECT":
      return `Start a project called ${d.name ?? "this"}`;
    case "SET_PROJECT_CUSTOMER":
      return `Set ${d.companyName ?? "this customer"} as the customer for this project`;
    case "LOG_EMAIL_ACTIVITY":
      return `Add this email to ${d.companyName ?? "this customer"}'s history`;
    case "CREATE_MONEY_DOC":
      // The one card that is showing rather than asking.
      return `${d.kind === "INVOICE" ? "Invoice" : "Document"} ${d.number ?? ""} · ${
        d.currency ?? ""
      } ${d.total ?? ""}`.replace(/\s+/g, " ").trim();
    default:
      return "Something Droplet read";
  }
}

/** The filename, shown only here and only to a reviewer. */
function fileNameOf(p: FilingProposal): string | null {
  const path = p.payload?.file?.filePath;
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function Fields({ p }: { p: FilingProposal }): JSX.Element | null {
  const d = p.payload;
  if (!d) return null;
  const rows: [string, string][] = [];
  if (d.domain) rows.push(["Website", d.domain]);
  if (d.phone) rows.push(["Phone", d.phone]);
  if (d.address) rows.push(["Address", d.address]);
  if (d.email) rows.push(["Email", d.email]);
  if (d.organization) rows.push(["Works at", d.organization]);
  if (d.roleTitle) rows.push(["Role", d.roleTitle]);
  if (d.summary) rows.push(["About", d.summary]);
  if (d.counterpartyName) rows.push(["From", d.counterpartyName]);
  if (rows.length === 0) return null;
  return (
    <dl className="filing-fields">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Evidence({ p }: { p: FilingProposal }): JSX.Element {
  const quotes = p.evidence.filter((e) => e.quote.trim().length > 0);

  if (p.phiVerdict === "MENTIONS") {
    return (
      <p className="filing-note">
        This document mentions patients, so Droplet did not keep any of its wording.
        Open the file to check it yourself.
      </p>
    );
  }
  if (quotes.length === 0) {
    return <p className="filing-note">Open the file to check it yourself.</p>;
  }
  return (
    <ul className="filing-quotes">
      {quotes.map((q, i) => (
        <li key={i}>“{q.quote}”</li>
      ))}
    </ul>
  );
}

export function FilingCard({
  p,
  busy,
  onApply,
  onReject,
  onNotSame,
}: {
  p: FilingProposal;
  busy: boolean;
  onApply: (chooseCompanyId?: string) => void;
  onReject: () => void;
  onNotSame: (companyId: string) => void;
}): JSX.Element {
  const [choice, setChoice] = useState<string>("");
  const fileName = fileNameOf(p);
  const blocked = p.policyClass === "NEVER";

  if (!p.readable) {
    // Shown rather than hidden. A card an owner cannot see is a card they
    // cannot clear, and a queue with a permanent invisible member stops being
    // something anyone finishes.
    return (
      <article className="pm-surface filing-card">
        <h3>Droplet could not read this one back</h3>
        <p className="filing-note">
          Something Droplet noted earlier no longer makes sense. Clearing it is safe.
        </p>
        <div className="filing-actions">
          <button className="pm-btn" onClick={onReject} disabled={busy}>
            Clear it
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="pm-surface filing-card">
      <div className="filing-panes">
        <div className="filing-what">
          <h3>{headlineFor(p)}</h3>
          <Fields p={p} />
          {p.policyReason ? <p className="filing-why">{p.policyReason}</p> : null}

          {p.kind === "MATCH_REVIEW" && p.payload?.candidates ? (
            <div className="filing-choices" role="radiogroup" aria-label="Which customer">
              {p.payload.candidates.map((c) => (
                <label key={c.companyId}>
                  <input
                    type="radio"
                    name={`choice-${p.id}`}
                    value={c.companyId}
                    checked={choice === c.companyId}
                    onChange={() => setChoice(c.companyId)}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          ) : null}
        </div>

        <div className="filing-where">
          <h4>Where Droplet read that</h4>
          <Evidence p={p} />
          {fileName ? (
            <Link className="pm-btn sm ghost" href="/files">
              <PmIcon name="doc" size={13} /> {fileName}
            </Link>
          ) : null}
        </div>
      </div>

      <div className="filing-actions">
        {blocked ? (
          <span className="filing-note">Nothing to do here yet — this is just so you know.</span>
        ) : (
          <>
            <button
              className="pm-btn primary"
              onClick={() => onApply(choice || undefined)}
              disabled={busy || (p.kind === "MATCH_REVIEW" && !choice)}
            >
              Yes, file it
            </button>
            <button className="pm-btn" onClick={onReject} disabled={busy}>
              No thanks
            </button>
            {p.payload?.companyId ? (
              <button
                className="pm-btn ghost"
                onClick={() => onNotSame(p.payload!.companyId!)}
                disabled={busy}
              >
                Not this customer
              </button>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

export function FilingSurface(): JSX.Element {
  const { toast } = useToast();
  const { summary, mutate: mutateSummary } = useFilingSummary();
  const { proposals, error, isLoading, mutate } = useFilingProposals("pending");
  const actions = useFilingActions();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<FilingTab>("review");

  const run = async (id: string, fn: () => Promise<void>, done: string) => {
    setBusyId(id);
    try {
      await fn();
      toast(done, "success");
      await Promise.all([mutate(), mutateSummary()]);
    } catch (e) {
      // A 409 means somebody else already decided it — usually a second tab.
      // Refresh rather than leaving a card that cannot be acted on.
      toast(translateError(e, "projects"), "error");
      await mutate();
    } finally {
      setBusyId(null);
    }
  };

  if (summary && !summary.enabled) {
    return (
      <EmptyBlock
        icon="inbox"
        heading="Droplet is not reading your files yet"
        body="Turn this on and Droplet will read new documents as they arrive and suggest which customer each one belongs to. Nothing is filed without you saying so."
        cta={
          <button
            className="pm-btn primary"
            onClick={() =>
              run("settings", async () => {
                await actions.setMode("propose");
              }, "Droplet will start reading new files")
            }
          >
            Start reading new files
          </button>
        }
      />
    );
  }

  if (error) {
    return (
      <EmptyBlock
        icon="alert"
        tone="error"
        heading="Could not load this"
        body={translateError(error, "projects")}
      />
    );
  }

  const chrome = (body: JSX.Element) => (
    <>
      {/* WARP-2731 — the Health row sits ABOVE the tabs, because the state it
          reports ("Droplet has not read a new file in three days") explains an
          empty list on every one of them. Below the tabs it would read as a
          note about the review queue alone. */}
      <HealthRow health={summary?.health} />
      <FilingTabList tab={tab} onTab={setTab} pending={summary?.pending ?? 0} />
      {body}
    </>
  );

  if (tab === "rules") return chrome(<RulesTab />);
  if (tab === "skipped") return chrome(<SkippedTab />);

  if (isLoading) return chrome(<div className="pm-skel" style={{ height: 160 }} />);

  if (!proposals || proposals.length === 0) {
    // The undo strip renders here too. An empty queue is exactly when an owner
    // is looking BACK at what was filed rather than forward at what is waiting.
    return chrome(
      <>
        <RecentlyFiled
          busyId={busyId}
          onUndo={(id) => run(id, () => actions.undo(id), "Taken back")}
        />
        <EmptyBlock
          icon="check"
          heading="Nothing needs a look"
          body="Droplet is reading new files as they arrive. Anything it is unsure about will show up here."
        />
      </>,
    );
  }

  const undoStrip = (
    <RecentlyFiled
      busyId={busyId}
      onUndo={(id) =>
        run(id, () => actions.undo(id), "Taken back")
      }
    />
  );

  return chrome(
    <div className="filing-list">
      {undoStrip}
      {proposals.map((p) => (
        <FilingCard
          key={p.id}
          p={p}
          busy={busyId === p.id}
          onApply={(choice) =>
            run(p.id, () => actions.apply(p.id, choice), "Filed")
          }
          onReject={() => run(p.id, () => actions.reject(p.id), "Cleared")}
          onNotSame={(companyId) =>
            run(
              p.id,
              () => actions.notSame(p.id, companyId),
              "Noted — Droplet will not suggest that one again",
            )
          }
        />
      ))}
    </div>,
  );
}

/**
 * The banner on `/customers`.
 *
 * Renders nothing at all when there is nothing waiting, when filing is off, or
 * when the reader is not an owner or admin (the summary 403s, which is the
 * ordinary answer for a `family` member and not a fault). A banner that is
 * always there stops being read.
 */
export function FilingBanner(): JSX.Element | null {
  const { summary } = useFilingSummary();
  if (!summary || !summary.enabled || summary.pending === 0) return null;
  return (
    <Link className="filing-banner" href="/customers/filing">
      <PmIcon name="inbox" size={14} />
      <span>
        {summary.pending === 1
          ? "Droplet read something in your files and needs a look"
          : `Droplet read ${summary.pending} things in your files that need a look`}
      </span>
      <span className="filing-banner-go">Take a look</span>
    </Link>
  );
}
