"use client";

/**
 * WARP-3532 — add or edit a work webhook.
 *
 * The preset is the format: picking Slack, Teams, Discord or Google Chat only
 * changes how the message is shaped and what the help line says. The address is
 * whatever the person pastes; the box checks it when it is saved and again every
 * time it sends. No host is written here and none is required — a chat app can
 * be self-hosted, and "which hosts are real chat apps" is not something a form
 * should decide.
 *
 * Editing never shows the current address (the box does not return it: for a
 * chat app the address is the credential). The field stays empty and says that
 * leaving it empty keeps the one on file.
 */
import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import type {
  WorkEventInfo,
  WorkWebhook,
  WorkWebhookFormat,
  WorkWebhookPatch,
} from "@/lib/api.work-webhooks";
import { FORMAT_OPTIONS } from "./work-notifications-copy";

export interface WebhookFormValue extends WorkWebhookPatch {
  name: string;
  format: WorkWebhookFormat;
  events: string[];
  projectId: string | null;
}

interface Props {
  mode: "create" | "edit";
  initial?: WorkWebhook;
  events: WorkEventInfo[];
  projects: Array<{ id: string; name: string; identifier: string }>;
  /** Rejects with an Error whose message is the sentence to show. */
  onSubmit: (value: WebhookFormValue) => Promise<void>;
  onCancel: () => void;
}

const inputClass =
  "w-full px-3 py-2 type-footnote focus:outline-none focus:ring-2 focus:ring-[var(--brand)] placeholder:text-[var(--text-faint)] transition-shadow";
const inputStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-input)",
  color: "var(--text)",
};

export function WebhookForm({ mode, initial, events, projects, onSubmit, onCancel }: Props) {
  const [format, setFormat] = useState<WorkWebhookFormat>(initial?.format ?? "SLACK");
  const [name, setName] = useState(initial?.name ?? "Slack");
  const [nameTouched, setNameTouched] = useState(mode === "edit");
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<string[]>(initial?.events ?? events.map((e) => e.name));
  const [projectId, setProjectId] = useState<string | null>(initial?.projectId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = FORMAT_OPTIONS.find((o) => o.value === format);

  function pickFormat(next: WorkWebhookFormat) {
    setFormat(next);
    if (!nameTouched) setName(FORMAT_OPTIONS.find((o) => o.value === next)?.defaultName ?? "Webhook");
  }

  function toggleEvent(eventName: string) {
    setSelected((cur) => (cur.includes(eventName) ? cur.filter((e) => e !== eventName) : [...cur, eventName]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim() === "") return setError("Give this webhook a name.");
    if (mode === "create" && url.trim() === "") return setError("Paste the address to send to.");
    if (selected.length === 0) return setError("Pick at least one event.");
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        format,
        events: selected,
        projectId,
        ...(url.trim() !== "" ? { url: url.trim() } : {}),
      });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn’t save that. Try again.");
      setBusy(false);
    }
  }

  return (
    <form className="card space-y-4" onSubmit={submit} aria-label={mode === "create" ? "Add a webhook" : "Edit webhook"}>
      <fieldset className="space-y-2">
        <legend className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          Send to
        </legend>
        <div className="flex flex-wrap gap-2">
          {FORMAT_OPTIONS.map((o) => (
            <label
              key={o.value}
              className="type-footnote flex items-center gap-1.5 px-3 py-1.5 cursor-pointer"
              style={{
                border: `1px solid ${format === o.value ? "var(--brand)" : "var(--border)"}`,
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            >
              <input
                type="radio"
                name="webhook-format"
                value={o.value}
                checked={format === o.value}
                onChange={() => pickFormat(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
        {preset && (
          <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>
            {preset.help}
          </p>
        )}
      </fieldset>

      <div className="space-y-1">
        <label className="type-caption-1 block" style={{ color: "var(--text-muted)" }} htmlFor="webhook-name">
          Name
        </label>
        <input
          id="webhook-name"
          className={inputClass}
          style={inputStyle}
          value={name}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
        />
      </div>

      <div className="space-y-1">
        <label className="type-caption-1 block" style={{ color: "var(--text-muted)" }} htmlFor="webhook-url">
          Address
        </label>
        <input
          id="webhook-url"
          type="text"
          inputMode="url"
          className={inputClass}
          style={inputStyle}
          autoComplete="off"
          spellCheck={false}
          placeholder={mode === "edit" ? "Leave empty to keep the current address" : "Paste the address here"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>
          {mode === "edit"
            ? `Sending to ${initial?.destination ?? "the current address"}. Droplet keeps the rest of the address private, so paste a new one only to change it.`
            : "Droplet keeps this address private once it is saved: for a chat app it works like a password."}
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          Send me
        </legend>
        {events.map((ev) => (
          <label key={ev.name} className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.includes(ev.name)}
              onChange={() => toggleEvent(ev.name)}
            />
            <span className="min-w-0">
              <span className="type-footnote block" style={{ color: "var(--text)" }}>
                {ev.label}
              </span>
              <span className="type-caption-2 block" style={{ color: "var(--text-faint)" }}>
                {ev.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {projects.length > 0 && (
        <div className="space-y-1">
          <label className="type-caption-1 block" style={{ color: "var(--text-muted)" }} htmlFor="webhook-project">
            Which work
          </label>
          <select
            id="webhook-project"
            className={inputClass}
            style={inputStyle}
            value={projectId ?? ""}
            onChange={(e) => setProjectId(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">Every project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.identifier})
              </option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <p className="type-footnote text-system-red" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {busy ? "Saving…" : mode === "create" ? "Add webhook" : "Save changes"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
