"use client";

// Create / edit a service desk — the canonical Dialog, laid out like the
// project modal. Owner and admin only: the page hides every way in otherwise.

import { useId, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { ErrorStrip, Field, ModalFooter } from "./form-bits";
import { supportActions } from "./useSupport";
import type { Desk } from "./types";
import { EmailChannelSettings } from "./EmailChannelSettings";

export function DeskModal({
  desk,
  onClose,
  onSaved,
}: {
  /** Present = edit; absent = create. */
  desk?: Desk;
  onClose: () => void;
  onSaved: (desk: Desk) => void;
}): JSX.Element {
  const titleId = useId();
  const { toast } = useToast();
  const [name, setName] = useState(desk?.name ?? "");
  const [identifier, setIdentifier] = useState("");
  const [description, setDescription] = useState(desk?.description ?? "");
  const [archived, setArchived] = useState(desk?.archived ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const keyOk = identifier === "" || /^[A-Za-z0-9]{1,10}$/.test(identifier);

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) {
      setNameError("Add a name.");
      return;
    }
    if (!keyOk) return;
    setBusy(true);
    setError(null);
    try {
      const actions = supportActions();
      const res = desk
        ? await actions.updateDesk(desk.id, {
            name: name.trim(),
            description: description.trim() ? description.trim() : null,
            archived,
          })
        : await actions.createDesk({
            name: name.trim(),
            ...(identifier ? { identifier } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
          });
      toast(desk ? "Desk saved" : `Desk ${res.desk.name} created`, "success");
      onSaved(res.desk);
      onClose();
    } catch (e) {
      setError(translateError(e, "support"));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>
          {desk ? "Desk settings" : "Set up a desk"}
        </h2>
        <ErrorStrip message={error} />
        <Field label="Name" htmlFor="desk-name" error={nameError}>
          <input
            id="desk-name"
            className="pm-input"
            placeholder="Support"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            autoFocus
          />
        </Field>
        {desk ? (
          <Field label="Key" hint="The key can't be changed once tickets use it.">
            <input className="pm-input pm-mono" value={desk.identifier} readOnly aria-readonly />
          </Field>
        ) : (
          <Field
            label="Key"
            htmlFor="desk-key"
            hint="Leave blank to make one from the name — for example SUP."
            error={keyOk ? null : "Use 1 to 10 letters or numbers."}
          >
            <input
              id="desk-key"
              className="pm-input pm-mono"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value.toUpperCase())}
              maxLength={10}
            />
          </Field>
        )}
        <Field label="Description" htmlFor="desk-desc">
          <textarea
            id="desk-desc"
            className="pm-input"
            rows={3}
            placeholder="What this desk is for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {desk && (
          <label className="pm-row" style={{ gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Archive this desk
          </label>
        )}
        {desk && (
          <div style={{ fontSize: 11.5, color: "var(--text-4)", marginTop: 4 }}>
            Archiving hides the desk and its tickets from the queues. You can restore it.
          </div>
        )}
        {desk && <EmailChannelSettings desk={desk} />}
        <ModalFooter onClose={onClose} onSubmit={() => void submit()} submitLabel={desk ? "Save" : "Create desk"} busy={busy} />
      </div>
    </Dialog>
  );
}
