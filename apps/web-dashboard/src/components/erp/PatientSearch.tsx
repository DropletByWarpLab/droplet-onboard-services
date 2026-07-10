"use client";

/**
 * Find a patient (design brief §4.4) — the highest-traffic read. Debounced
 * search against the Eaglesoft database; results are name · DOB · phone ·
 * balance (all mono), a row opens the patient peek. Guard copy states the
 * search stays local. Renders inside ShellPage.
 */

import { useEffect, useState } from "react";
import { Search, ChevronRight } from "lucide-react";
import { Sect } from "@/components/shell/primitives";
import { searchPatients } from "@/lib/api.erp";
import type { PatientResult } from "@/lib/erp-types";
import type { TypedError } from "@/lib/hooks/apiFetch";
import { formatDate, formatUsd } from "@/lib/erp-format";

const mono: React.CSSProperties = { fontFamily: "var(--font-mono, ui-monospace, monospace)" };

export function PatientSearch({ onSelect }: { onSelect: (p: PatientResult) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PatientResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setStatus("idle");
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus("loading");
      try {
        const r = await searchPatients(query, { signal: ctrl.signal });
        setResults(r);
        setStatus("done");
      } catch (err) {
        if ((err as TypedError)?.code !== "ABORTED") {
          setResults([]);
          setStatus("error");
        }
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  return (
    <>
      <Sect title="Find a patient" />
      <div className="card">
        <div className="search" style={{ maxWidth: "none" }}>
          <Search size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, phone, or chart number"
            aria-label="Search patients"
          />
        </div>

        {status === "done" && results.length > 0 && (
          <div className="rows" style={{ marginTop: 8 }}>
            {results.map((p) => (
              <button
                key={p.id}
                type="button"
                className="lrow ev-row"
                style={{ width: "100%", textAlign: "left", background: "transparent", border: 0, cursor: "pointer" }}
                onClick={() => onSelect(p)}
              >
                <span className="rt">
                  <span className="nm">{p.name}</span>
                  <span className="sub mono">{formatDate(p.dob)} · {p.phone}</span>
                </span>
                <span className="rval" style={mono}>{formatUsd(p.balanceCents, { cents: true })}</span>
                <ChevronRight size={16} className="text-label-tertiary" />
              </button>
            ))}
          </div>
        )}

        {status === "done" && results.length === 0 && (
          <p className="type-footnote text-label-tertiary" style={{ marginTop: 12 }}>
            No patients match &ldquo;{q.trim()}&rdquo;.
          </p>
        )}
        {status === "error" && (
          <p className="type-footnote text-label-tertiary" style={{ marginTop: 12 }}>
            Couldn&rsquo;t search right now — Droplet may be reconnecting to Eaglesoft.
          </p>
        )}

        <p className="type-caption-1 text-label-tertiary" style={{ marginTop: 12 }}>
          Searches your Eaglesoft database directly — results never leave your network.
        </p>
      </div>
    </>
  );
}
