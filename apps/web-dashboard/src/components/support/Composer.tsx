"use client";

// The composer: a public Reply or an Internal note, one toggle. In this slice a
// reply is RECORDED — nothing is emailed until a channel is connected — and the
// composer says so in words, so no agent believes a customer was told.

import { useState, type JSX, type KeyboardEvent } from "react";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { hasDeliveryChannel, textToHtml } from "./support-config";
import { supportActions } from "./useSupport";
import type { Desk, Ticket } from "./types";

type Mode = "reply" | "note";

export function Composer({
  ticket,
  desk,
  onSent,
}: {
  ticket: Ticket;
  desk: Desk | undefined;
  onSent: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("reply");
  const [text, setText] = useState("");
  const [thenState, setThenState] = useState("");
  const [busy, setBusy] = useState(false);

  const note = mode === "note";
  const bound = hasDeliveryChannel(desk?.channels ?? []);
  const empty = text.trim().length === 0;
  const hint = note
    ? "Only your team sees this note."
    : bound
      ? `Reply will be sent to ${ticket.requester.email ?? ticket.requester.name}.`
      : "Reply will be recorded — connect an email channel to send it.";

  const send = async () => {
    if (busy || empty) return;
    setBusy(true);
    try {
      const html = textToHtml(text);
      const state = thenState && thenState !== ticket.status.id ? thenState : undefined;
      const actions = supportActions();
      if (note) await actions.addNote(ticket.id, html, state);
      else await actions.sendReply(ticket.id, html, state);
      setText("");
      setThenState("");
      toast(note ? "Note added" : bound ? "Reply queued" : "Reply recorded", "success");
      onSent();
    } catch (e) {
      toast(translateError(e, "support"), "error");
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <section className={"pm-surface sp-composer" + (note ? " note" : "")} aria-label="Write a message">
      <div className="pm-pills" role="radiogroup" aria-label="Message type" style={{ alignSelf: "flex-start" }}>
        {(["reply", "note"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {m === "reply" ? "Reply" : "Internal note"}
          </button>
        ))}
      </div>
      <textarea
        className="pm-input"
        rows={4}
        aria-label={note ? "Internal note" : "Reply"}
        placeholder={note ? "Add a note for your team" : "Write a reply"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="sp-composer-foot">
        <span className="sp-hint" role="status">
          {hint}
        </span>
        <div className="pm-row" style={{ gap: 8, flexWrap: "wrap" }}>
          {desk && (
            <select
              className="pm-input"
              aria-label="Then set the status to"
              value={thenState}
              onChange={(e) => setThenState(e.target.value)}
              style={{ width: "auto", height: 34 }}
            >
              <option value="">Keep status</option>
              {desk.states.map((s) => (
                <option key={s.id} value={s.id}>
                  Set to {s.name}
                </option>
              ))}
            </select>
          )}
          <button className="pm-btn primary" type="button" onClick={() => void send()} disabled={busy || empty}>
            {busy ? "Working…" : note ? "Add note" : "Send reply"}
            <span className="pm-kbd" aria-hidden="true">⌘↵</span>
          </button>
        </div>
      </div>
    </section>
  );
}
