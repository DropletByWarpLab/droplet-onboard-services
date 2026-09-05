"use client";

/**
 * WARP-2731 (ADR-048) — "Stop filing this here", on the record itself.
 *
 * ── Why this control lives on the CUSTOMER and not only in the review queue ─
 *
 * Because that is where the mistake is discovered. The review card is where an
 * owner decides; the customer record is where they later notice that mail from
 * a supplier has been landing on the wrong account for three weeks. Making them
 * find the original card to correct it means most corrections never get made,
 * and the ones that do get made late.
 *
 * ── Why it writes NOT_SAME and nothing else ────────────────────────────────
 *
 * 🔴 The route this calls accepts only `NOT_SAME`, and the test asserts that a
 * body carrying `verdict` is REFUSED. `ALWAYS_HERE` is the strongest thing in
 * this feature — it forces every future document matching a key onto one
 * customer, ahead of the matcher's own search — and it must not be reachable
 * from a one-click chip on a drawer. Teaching Droplet where something DOES go
 * is a decision; telling it where something does NOT go is a correction, and
 * only the second belongs here.
 *
 * The control is owner/admin only, like every other filing surface: the rule it
 * writes is read by a background job that touches every document on the box.
 */

import { useState, type JSX } from "react";

import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { authFetch, useAuth } from "@/lib/auth";

export function StopFilingHere({
  companyId,
  /** The domain or address the owner keeps seeing filed here. */
  suggestion,
}: {
  companyId: string;
  suggestion?: string | null;
}): JSX.Element | null {
  const { user } = useAuth();
  const { toast } = useToast();
  const [value, setValue] = useState(suggestion ?? "");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Same gate as the rest of filing. Rendering it for `family` and refusing on
  // click would be a control that exists to say no.
  if (user?.role !== "owner" && user?.role !== "admin") return null;

  if (!open) {
    return (
      <button className="pm-btn sm ghost" onClick={() => setOpen(true)}>
        Stop filing things here
      </button>
    );
  }

  const submit = async (): Promise<void> => {
    const keyValue = value.trim().replace(/^@/, "").toLowerCase();
    if (!keyValue || busy) return;
    setBusy(true);
    try {
      const res = await authFetch("/api/crm/filing/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // An address if it has an `@` left after the leading one is stripped,
          // a domain otherwise. Guessing here rather than asking is the whole
          // point of the control being one line.
          keyKind: keyValue.includes("@") ? "EMAIL_ADDRESS" : "EMAIL_DOMAIN",
          keyValue,
          companyId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw Object.assign(new Error(body.error ?? "failed"), {
          status: res.status,
          code: body.error,
        });
      }
      toast("Noted — Droplet will not file that here again", "success");
      setOpen(false);
      setValue("");
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="filing-stop">
      <label htmlFor="filing-stop-input">
        Which sender or website should Droplet stop filing here?
      </label>
      <div className="filing-stop-row">
        <input
          id="filing-stop-input"
          className="pm-input"
          value={value}
          placeholder="acme-dental.example"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") setOpen(false);
          }}
        />
        <button className="pm-btn primary sm" disabled={busy || !value.trim()} onClick={submit}>
          Save
        </button>
        <button className="pm-btn sm ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <p className="filing-note">
        Droplet will keep this customer exactly as it is — it just won&apos;t put anything new
        here from that sender.
      </p>
    </div>
  );
}
