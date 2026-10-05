"use client";

// Pick the customer a ticket is for: search the contacts the caller can see
// (their own, a customer's people, anyone who has already raised a ticket), or
// add a new person through the same address-book service the CRM uses.

import { useEffect, useId, useState, type JSX, type KeyboardEvent } from "react";
import { translateError } from "@/lib/friendly-errors";
import { ErrorStrip } from "./form-bits";
import { SupportRequestError, supportActions, useContactSearch } from "./useSupport";
import type { ContactCandidate } from "./types";

const VIA: Record<ContactCandidate["via"], string> = {
  yours: "Your contact",
  customer: "Customer",
  requester: "Has raised a ticket",
};

export function RequesterPicker({
  value,
  onChange,
}: {
  value: ContactCandidate | null;
  onChange: (c: ContactCandidate | null) => void;
}): JSX.Element {
  const listId = useId();
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState(false);
  const [fresh, setFresh] = useState({ name: "", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { contacts } = useContactSearch(term);

  // 250 ms after the last keystroke, so a name typed in full is one search.
  useEffect(() => {
    const t = setTimeout(() => setTerm(text), 250);
    return () => clearTimeout(t);
  }, [text]);

  const choose = (c: ContactCandidate) => {
    onChange(c);
    setOpen(false);
    setText("");
    setTerm("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return setOpen(false);
    if (!open || contacts.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % contacts.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + contacts.length) % contacts.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(contacts[Math.min(active, contacts.length - 1)]!);
    }
  };

  const add = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { contact } = await supportActions().createContact({
        displayName: fresh.name.trim() || undefined,
        email: fresh.email.trim() || undefined,
        phone: fresh.phone.trim() || undefined,
      });
      choose(contact);
      setAdding(false);
    } catch (e) {
      // The address is already in a contact the caller can see: use them rather
      // than fail, so one customer is never two.
      const existing = e instanceof SupportRequestError ? e.body.contactId : undefined;
      if (typeof existing === "string") {
        choose({ id: existing, name: fresh.name.trim() || fresh.email.trim(), email: fresh.email.trim() || null, organization: null, via: "yours" });
        setNote("That address is already in your contacts — using them.");
        setAdding(false);
      } else {
        setError(translateError(e, "support"));
      }
    } finally {
      setBusy(false);
    }
  };

  if (value) {
    return (
      <div className="pm-row" style={{ justifyContent: "space-between", gap: 8 }}>
        <div className="sp-kv">
          <span style={{ color: "var(--text)", fontWeight: 600 }}>{value.name}</span>
          {value.email && <span>{value.email}</span>}
          {note && <span role="status">{note}</span>}
        </div>
        <button className="pm-btn sm" type="button" onClick={() => { onChange(null); setNote(null); }}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="sp-picker">
      <input
        className="pm-input"
        role="combobox"
        aria-label="Search customers"
        aria-expanded={open && term.trim().length >= 2}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && contacts.length ? `${listId}-${active}` : undefined}
        placeholder="Search by name or email"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {open && term.trim().length >= 2 && (
        <ul id={listId} role="listbox" aria-label="Customers" className="sp-pick-list">
          {contacts.length === 0 ? (
            <li className="sp-pick-item" role="presentation" style={{ cursor: "default", color: "var(--text-3)" }}>
              No one found. Add them below.
            </li>
          ) : (
            contacts.map((c, i) => (
              <li
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="sp-pick-item"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(c)}
              >
                <span style={{ fontWeight: 600 }}>{c.name}</span>
                <span className="sub">
                  {[c.email, c.organization, VIA[c.via]].filter(Boolean).join(" · ")}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
      <div style={{ marginTop: 8 }}>
        <button className="pm-btn ghost sm" type="button" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
          Add a new person
        </button>
        {adding && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            <ErrorStrip message={error} />
            <input className="pm-input" aria-label="Name" placeholder="Name" value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} />
            <input className="pm-input" aria-label="Email" type="email" placeholder="Email" value={fresh.email} onChange={(e) => setFresh({ ...fresh, email: e.target.value })} />
            <input className="pm-input" aria-label="Phone" placeholder="Phone" value={fresh.phone} onChange={(e) => setFresh({ ...fresh, phone: e.target.value })} />
            <div>
              <button className="pm-btn sm primary" type="button" onClick={() => void add()} disabled={busy || (!fresh.name.trim() && !fresh.email.trim())}>
                {busy ? "Working…" : "Add person"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
