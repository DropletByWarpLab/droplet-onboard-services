"use client";

/**
 * WARP-2567 (ADR-044 §3) — the practice block on a customer record.
 *
 * 🔴 The one section on this page that carries PHI, and the reason it is
 * fetched separately rather than arriving with the rest of the record: the
 * record route is cleared by the CRM's gate, which `family` passes. This
 * block is cleared by the ERP's own connector gate, server-side, and the
 * client cannot pre-judge it — `/reports` documents the same posture, and
 * denial is a 403.
 *
 * 🔴 On refusal this renders NOTHING. Not a lock, not a "you don't have
 * access" note, not a greyed placeholder. A lock announces that a patient
 * record exists for this customer, which is itself the disclosure the gate is
 * there to prevent — and it is indistinguishable, to the person reading the
 * page, from the ordinary case of a customer with no linked patient.
 *
 * The block is PHI-minimal even for a permitted reader: a name the customer
 * already carries, and the practice's own identifier. Chart detail lives on
 * /practice, behind the surface built for it.
 */

import useSWR from "swr";
import { type JSX } from "react";
import Link from "next/link";
import { Stethoscope } from "lucide-react";

import { authFetch } from "@/lib/auth";
import { partyNounForProviderKey } from "@/components/integrations/provider-descriptors";

interface PracticePatient {
  linkId: string;
  externalSystem: string;
  externalId: string;
  patient: { id: string; name: string; dob?: string; phone?: string } | null;
}

interface PracticePayload {
  patients: PracticePatient[];
  linked: boolean;
}

/**
 * Resolves to `null` on ANY refusal or absence.
 *
 * 403 (no connector grant), 404 (no ERP configured) and a network fault all
 * collapse to the same nothing, because the page must not be able to tell
 * them apart either — a component that rendered "temporarily unavailable" for
 * one and nothing for the other would leak the difference by omission.
 */
async function fetchPractice(url: string): Promise<PracticePayload | null> {
  const res = await authFetch(url);
  if (!res.ok) return null;
  return (await res.json()) as PracticePayload;
}

export function PracticeBlock({ companyId }: { companyId: string }): JSX.Element | null {
  const { data } = useSWR<PracticePayload | null>(
    `/api/erp/practice/by-company/${encodeURIComponent(companyId)}`,
    fetchPractice,
    {
      // A refusal is not a transient fault, and retrying it would put a
      // recurring 403 in the audit log for every record page a family member
      // opens.
      shouldRetryOnError: false,
    },
  );

  // Not yet resolved, refused, no connector, or no link: all nothing.
  if (!data || !data.linked || data.patients.length === 0) return null;

  // WARP-2568 — the vertical's own word, resolved from the connector that
  // actually answered rather than hardcoded. A dental box says "patient"; a
  // firm running the same surface over a different connector says "client".
  //
  // Read from the FIRST answering link, not from a box-wide setting: a box can
  // carry two connectors, and the noun belongs to the one whose record this
  // row is. The nav label deliberately does NOT do this — see the rule on
  // `partyNoun` in provider-descriptors.
  const noun = partyNounForProviderKey(data.patients[0].externalSystem);
  const heading = data.patients.length === 1 ? noun : `${noun}s`;

  return (
    <section className="pm-surface cr-section">
      <div className="pm-sect">
        <Stethoscope size={14} aria-hidden="true" /> Practice
        <span className="cr-count">
          {data.patients.length} {heading}
        </span>
      </div>
      <ul className="cr-list">
        {data.patients.map((p) => (
          <li key={p.linkId} className="cr-row">
            <span className="cr-row-k">{p.patient?.name ?? "—"}</span>
            <span className="cr-row-v">
              {/* The practice's own identifier, so a human can find the chart
                  in the system that owns it. Not a chart summary: this page
                  is the CRM's, and clinical detail belongs on /practice. */}
              <span className="cr-muted">#{p.externalId}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="cr-empty">
        Read live from the practice system.{" "}
        <Link className="cr-link" href="/practice">
          Open Practice
        </Link>
      </p>
    </section>
  );
}
