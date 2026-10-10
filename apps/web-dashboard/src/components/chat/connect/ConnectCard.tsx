"use client";
/**
 * WARP-3904 — a connect card: how Ask AI adds a connection without sending a
 * secret through the chat.
 *
 * The assistant's tool returns a DESCRIPTOR (which fields, which chip, where
 * the browser posts); this component renders it as a form the person can act
 * on, and the form talks to the box directly. Nothing typed here is passed to
 * `onOutcome`, the SSE stream, the transcript or the model. The only thing that
 * ever leaves the card as a chat turn is a short sentence from
 * `connectOutcomeTurn`, sent once when a connection succeeds. A failure sends
 * nothing: the person is looking at the card and can try again, and the model
 * has no use for a vendor's refusal.
 *
 * `interactive` is true only for the newest assistant message of a live
 * conversation. Everywhere else (a reloaded transcript, an older turn) the card
 * is a compact row with a link, never a form, so a stale card can not be filled
 * in against a connection that has long since moved on. A card the person has
 * already resolved in this session keeps its connected state either way.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { AlertTriangle, BookOpen, Check, Info, Lock, ShieldCheck } from "lucide-react";
import {
  connectOutcomeTurn,
  type CalendarConnectCard,
  type ConnectCard as ConnectCardData,
  type ConnectField,
  type CredentialsConnectCard,
  type MailboxConnectCard,
  type OauthConnectCard,
  type WizardConnectCard,
} from "@droplet/shared-types";
import { SafetyChip } from "@/components/integrations/SafetyChip";
import { clearConnectReturn, safeSessionStorage, saveConnectReturn } from "./connect-return";
import {
  fieldProblem,
  fieldsFor,
  secretNamesOf,
  startOauth,
  submitCredentials,
  submitInline,
  type FieldValues,
} from "./connect-submit";
import "./connect-card.css";

export interface ConnectCardProps {
  card: ConnectCardData;
  /** True only for the newest assistant message of a live conversation. */
  interactive: boolean;
  /** The open conversation, stored with an OAuth round trip so the return can find its way back. */
  conversationId: string | null;
  /** Send a quiet follow-up user turn. Called with a fixed sentence, never with anything typed here. */
  onOutcome: (turn: string) => void;
  /** Leave for the provider's sign-in. Defaults to `window.location.assign`. */
  navigate?: (url: string) => void;
}

const LOCK_NOTE = "This form posts to the box directly. Nothing you type here enters the conversation.";

/** First letter of the name on a neutral tile: no vendor logos. */
function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

/** Where `href` lives, for link text: "Connectors", "Settings", or null. */
function placeOf(href: string): "Connectors" | "Settings" | null {
  if (href === "/integrations" || href.startsWith("/integrations/") || href.startsWith("/integrations?")) return "Connectors";
  if (href === "/settings" || href.startsWith("/settings/") || href.startsWith("/settings?") || href.startsWith("/settings#")) return "Settings";
  return null;
}

function manageText(href: string): string {
  const place = placeOf(href);
  return place ? `Manage in ${place}` : "Manage";
}

function LogoTile({ name, small }: { name: string; small?: boolean }) {
  return (
    <span className={`cc-logo${small ? " is-small" : ""}`} aria-hidden="true">
      {initialOf(name)}
    </span>
  );
}

// ── Compact row ──────────────────────────────────────────────────────────

/** A card that is not live: who, what, and where to manage it. No form. */
function CompactRow({ card }: { card: ConnectCardData }) {
  return (
    <section className="cc cc-compact" aria-label={`${card.displayName} connection`} data-testid="connect-card-compact" data-provider={card.provider}>
      <LogoTile name={card.displayName} small />
      <div className="cc-compact-main">
        <p className="cc-compact-name">{card.displayName}</p>
        <p className="cc-summary">{card.summary}</p>
      </div>
      <Link className="cc-link" href={card.manageHref}>
        {manageText(card.manageHref)}
      </Link>
    </section>
  );
}

// ── Connected ────────────────────────────────────────────────────────────

function ConnectedPanel({ card, note }: { card: ConnectCardData; note?: string }) {
  return (
    <section className="cc" aria-label={`${card.displayName} connection`} data-testid="connect-card-connected" data-provider={card.provider}>
      <div className="cc-head" role="status">
        <span className="cc-tile is-ok" aria-hidden="true">
          <Check size={18} strokeWidth={2} />
        </span>
        <div className="cc-titles">
          <p className="cc-title">Connected to {card.displayName}</p>
          <p className="cc-summary">{note ?? card.summary}</p>
        </div>
        <SafetyChip variant={card.safety === "setup-lan" ? "read-lan" : "read-internet"} className="cc-chip" />
      </div>
      <div className="cc-body">
        <div className="cc-actions is-start">
          <Link className="cc-btn is-ghost" href={card.manageHref}>
            {manageText(card.manageHref)}
          </Link>
        </div>
      </div>
    </section>
  );
}

// ── Blocked ──────────────────────────────────────────────────────────────

function blockedTitle(card: ConnectCardData): string {
  switch (card.blocked?.reason) {
    case "role":
      return "Ask an owner or admin";
    case "already_connected":
      return `${card.displayName} is already connected`;
    case "setup_required":
      return `Set up ${card.displayName} first`;
    case "unavailable":
    default:
      return `${card.displayName} isn't available yet`;
  }
}

function BlockedPanel({ card, onOutcome }: { card: ConnectCardData; onOutcome: (turn: string) => void }) {
  const [asked, setAsked] = useState(false);
  const place = placeOf(card.manageHref);
  const titleId = useId();
  // The one alternative the card can offer on its own: the person's own Google account.
  const offersOwnGoogle = card.blocked?.reason === "role" && card.family === "google";
  return (
    <section className="cc" aria-labelledby={titleId} data-testid="connect-card-blocked" data-reason={card.blocked?.reason} data-provider={card.provider}>
      <div className="cc-head">
        <span className="cc-tile is-info" aria-hidden="true">
          <Info size={18} strokeWidth={2} />
        </span>
        <div className="cc-titles">
          <p className="cc-title" id={titleId}>
            {blockedTitle(card)}
          </p>
          <p className="cc-summary">{card.blocked?.message}</p>
        </div>
      </div>
      <div className="cc-body">
        <div className="cc-actions is-start">
          <Link className="cc-btn" href={card.manageHref}>
            {place ? `Open ${place}` : `Open ${card.displayName}`}
          </Link>
          {offersOwnGoogle && (
            <button
              type="button"
              className="cc-btn primary"
              disabled={asked}
              onClick={() => {
                setAsked(true);
                // A normal user turn: the model answers it with a fresh card.
                onOutcome("Connect my Google account");
              }}
            >
              Connect my own Google instead
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ── Header ───────────────────────────────────────────────────────────────

function CardHeader({ card, titleId }: { card: ConnectCardData; titleId: string }) {
  return (
    <div className="cc-head">
      <LogoTile name={card.displayName} />
      <div className="cc-titles">
        <h3 className="cc-title" id={titleId}>
          Connect {card.displayName}
        </h3>
        <p className="cc-summary">{card.summary}</p>
      </div>
      <SafetyChip variant={card.safety === "setup-lan" ? "setup" : "setup-internet"} className="cc-chip" />
    </div>
  );
}

// ── Form pieces ──────────────────────────────────────────────────────────

function ErrorBlock({ title, message }: { title: string; message: string }) {
  return (
    <div className="cc-alert" role="alert" data-testid="connect-card-error">
      <AlertTriangle size={16} aria-hidden="true" className="cc-alert-icon" />
      <div>
        <p className="cc-alert-title">{title}</p>
        <p className="cc-alert-text">{message}</p>
      </div>
    </div>
  );
}

function inputType(field: ConnectField): "password" | "email" | "url" | "number" | "text" {
  if (field.secret) return "password";
  return field.type === "email" || field.type === "url" || field.type === "number" ? field.type : "text";
}

function FieldRow({
  id,
  field,
  value,
  showProblem,
  guideHref,
  wide,
  onChange,
  onBlur,
}: {
  id: string;
  field: ConnectField;
  value: string;
  showProblem: boolean;
  guideHref?: string;
  wide: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const problem = showProblem ? fieldProblem(field, value) === "pattern" : false;
  const helpId = `${id}-help`;
  const hasHelp = Boolean(field.help) || Boolean(guideHref) || problem;
  const type = inputType(field);
  return (
    <div className={`cc-field${wide ? " is-wide" : ""}`}>
      <label className="cc-label" htmlFor={id}>
        {field.label}
        {field.required && (
          <span className="cc-req" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      <input
        id={id}
        name={field.name}
        className="cc-input"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        // Never offer the operator's own saved credential for somebody else's account.
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode={type === "number" ? "numeric" : undefined}
        placeholder={field.placeholder}
        aria-required={field.required || undefined}
        aria-invalid={problem || undefined}
        aria-describedby={hasHelp ? helpId : undefined}
      />
      {hasHelp && (
        <p className={`cc-help${problem ? " is-error" : ""}`} id={helpId}>
          {problem ? "That doesn't look right. Check you copied the whole value." : field.help}
          {guideHref && (
            <>
              {field.help && !problem ? " " : ""}
              <a className="cc-link" href={guideHref} target="_blank" rel="noopener noreferrer">
                <BookOpen size={13} aria-hidden="true" /> Setup guide
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function defaultsOf(card: CredentialsConnectCard | MailboxConnectCard | CalendarConnectCard): FieldValues {
  const all = [...card.fields, ...(card.mode === "credentials" ? (card.variants ?? []).flatMap((v) => v.fields) : [])];
  const out: FieldValues = {};
  for (const f of all) {
    // A secret is never pre-filled, whatever the descriptor said.
    if (!f.secret && f.defaultValue !== undefined) out[f.name] = f.defaultValue;
  }
  return out;
}

const SUBMIT_LABEL = {
  credentials: { idle: (name: string) => `Connect ${name}`, busy: "Connecting…" },
  mailbox: { idle: () => "Check and save", busy: "Checking…" },
  calendar: { idle: () => "Add calendar", busy: "Adding…" },
} as const;

/** Mailbox and calendar lay out in two columns; a calendar's name and address span both. */
function isWide(card: CredentialsConnectCard | MailboxConnectCard | CalendarConnectCard, field: ConnectField, index: number): boolean {
  if (card.mode === "credentials") return true;
  if (card.mode === "calendar") return index === 0 || field.type === "url";
  return false;
}

// ── credentials · mailbox · calendar ─────────────────────────────────────

function FormPanel({
  card,
  onNotNow,
  onConnected,
}: {
  card: CredentialsConnectCard | MailboxConnectCard | CalendarConnectCard;
  onNotNow: () => void;
  onConnected: (note?: string) => void;
}) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const variants = card.mode === "credentials" ? (card.variants ?? []) : [];
  const [variantId, setVariantId] = useState<string | null>(variants[0]?.id ?? null);
  const [values, setValues] = useState<FieldValues>(() => defaultsOf(card));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ tone: "rejected" | "other"; message: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fields = fieldsFor(card, variantId);
  const ready = fields.length > 0 && fields.every((f) => fieldProblem(f, values[f.name]) === null);
  // The "Setup guide" link rides on the field a person is most likely to ask "where do I find this?" about.
  const guideField = fields.find((f) => f.secret) ?? fields[0];
  const idFor = (name: string) => `${uid}-${name}`;

  const clearSecrets = useCallback(
    (cur: FieldValues) => {
      const next = { ...cur };
      for (const name of secretNamesOf(card)) delete next[name];
      return next;
    },
    [card],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setFailure(null);
    const attempt = card.mode === "credentials" ? await submitCredentials(card, values, variantId) : await submitInline(card, values);
    if (!mounted.current) return;
    setBusy(false);
    // Whatever happened, the typed secrets have done their job: drop them.
    setValues(clearSecrets);
    if (attempt.ok) {
      onConnected(attempt.note);
      return;
    }
    setFailure({ tone: attempt.tone, message: attempt.message });
    const firstSecret = fields.find((f) => f.secret);
    if (firstSecret) requestAnimationFrame(() => document.getElementById(idFor(firstSecret.name))?.focus());
  };

  const name = card.displayName;
  const rejectedTitle = card.mode === "credentials" ? `${name} didn't accept that key` : `${name} didn't accept those details`;
  const labels = SUBMIT_LABEL[card.mode];
  const primary = busy ? labels.busy : failure ? "Try again" : labels.idle(name);

  return (
    <section className="cc" aria-labelledby={titleId} data-testid="connect-card" data-mode={card.mode} data-provider={card.provider}>
      <CardHeader card={card} titleId={titleId} />
      <form className="cc-body" onSubmit={submit} noValidate aria-busy={busy || undefined}>
        {failure && <ErrorBlock title={failure.tone === "rejected" ? rejectedTitle : `Couldn't connect to ${name}`} message={failure.message} />}

        {variants.length > 0 && (
          <fieldset className="cc-variants">
            <legend className="cc-label">{"How you'll connect"}</legend>
            {variants.map((v) => (
              <label key={v.id} className="cc-choice" data-checked={v.id === variantId}>
                <input
                  type="radio"
                  name={`${uid}-variant`}
                  value={v.id}
                  checked={v.id === variantId}
                  disabled={busy}
                  onChange={() => {
                    setVariantId(v.id);
                    setFailure(null);
                    // A key typed for one way of connecting must not ride along to another.
                    setValues(clearSecrets);
                  }}
                />
                <span>
                  <span className="cc-choice-label">{v.label}</span>
                  {v.description && <span className="cc-choice-help">{v.description}</span>}
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {fields.length === 0 ? (
          <p className="cc-help">This connector needs no credentials.</p>
        ) : (
          <div className={`cc-fields${card.mode === "credentials" ? "" : " is-grid"}`}>
            {fields.map((f, i) => (
              <FieldRow
                key={`${variantId ?? "base"}:${f.name}`}
                id={idFor(f.name)}
                field={f}
                value={values[f.name] ?? ""}
                showProblem={touched[f.name] === true}
                guideHref={f === guideField ? card.helpHref : undefined}
                wide={isWide(card, f, i)}
                onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))}
                onBlur={() => setTouched((cur) => ({ ...cur, [f.name]: true }))}
              />
            ))}
          </div>
        )}

        <div className="cc-lock">
          <Lock size={14} aria-hidden="true" className="cc-lock-icon" />
          <p>{LOCK_NOTE}</p>
        </div>

        <div className="cc-actions">
          <button type="button" className="cc-btn" onClick={onNotNow} disabled={busy}>
            Not now
          </button>
          <button type="submit" className="cc-btn primary" disabled={busy || !ready}>
            {primary}
          </button>
        </div>
      </form>
    </section>
  );
}

// ── oauth ────────────────────────────────────────────────────────────────

function OauthPanel({
  card,
  conversationId,
  onNotNow,
  navigate,
}: {
  card: OauthConnectCard;
  conversationId: string | null;
  onNotNow: () => void;
  navigate: (url: string) => void;
}) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const [picked, setPicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(card.options.map((o) => [o.name, o.defaultChecked])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const anyPicked = card.options.length === 0 || card.options.some((o) => picked[o.name]);

  const start = async () => {
    if (busy || !anyPicked) return;
    setBusy(true);
    setError(null);
    const storage = safeSessionStorage();
    // Written BEFORE leaving: the return trip is a fresh page load that has to find its way back here.
    saveConnectReturn(storage, {
      conversationId,
      provider: card.family,
      displayName: card.displayName,
      at: Date.now(),
    });
    const started = await startOauth(card, picked);
    if (!started.ok) {
      clearConnectReturn(storage);
      if (!mounted.current) return;
      setError(started.message);
      setBusy(false);
      return;
    }
    // Leaving the page: stay busy so a second click can not start a second sign-in.
    navigate(started.authorizeUrl);
  };

  return (
    <section className="cc" aria-labelledby={titleId} data-testid="connect-card" data-mode="oauth" data-provider={card.provider}>
      <CardHeader card={card} titleId={titleId} />
      <div className="cc-body">
        {error && <ErrorBlock title={`Couldn't start ${card.providerLabel} sign-in`} message={error} />}

        {card.options.length > 0 && (
          <fieldset className="cc-variants">
            <legend className="cc-label">Use this account for</legend>
            {card.options.map((o) => (
              <label key={o.name} className="cc-choice" data-checked={picked[o.name] === true}>
                <input
                  type="checkbox"
                  name={o.name}
                  checked={picked[o.name] === true}
                  disabled={busy}
                  onChange={(e) => setPicked((cur) => ({ ...cur, [o.name]: e.target.checked }))}
                />
                <span>
                  <span className="cc-choice-label">{o.label}</span>
                  {o.help && <span className="cc-choice-help">{o.help}</span>}
                </span>
              </label>
            ))}
            {!anyPicked && <p className="cc-help">Choose at least one to continue.</p>}
          </fieldset>
        )}

        <div className="cc-lock">
          <ShieldCheck size={14} aria-hidden="true" className="cc-lock-icon" />
          <p>{`Sign-in happens on ${card.providerLabel}'s site. Droplet never sees your password. Disconnecting deletes the token from the box.`}</p>
        </div>

        <div className="cc-actions">
          <button type="button" className="cc-btn" onClick={onNotNow} disabled={busy}>
            Not now
          </button>
          <button type="button" className="cc-btn primary" onClick={() => void start()} disabled={busy || !anyPicked}>
            {busy ? `Opening ${card.providerLabel}…` : `Continue with ${card.providerLabel}`}
          </button>
        </div>
      </div>
    </section>
  );
}

// ── wizard ───────────────────────────────────────────────────────────────

function WizardPanel({ card, onNotNow }: { card: WizardConnectCard; onNotNow: () => void }) {
  const titleId = useId();
  return (
    <section className="cc" aria-labelledby={titleId} data-testid="connect-card" data-mode="wizard" data-provider={card.provider}>
      <CardHeader card={card} titleId={titleId} />
      <div className="cc-body">
        {card.steps.length > 0 && (
          <ol className="cc-steps" aria-label="Steps">
            {card.steps.map((s, i) => (
              <li key={`${i}:${s}`}>{s}</li>
            ))}
          </ol>
        )}
        {card.estimate && <p className="cc-help">Takes {card.estimate}.</p>}
        <div className="cc-lock">
          <Info size={14} aria-hidden="true" className="cc-lock-icon" />
          <p>You will need access to the system you are connecting, or someone who has it. The wizard checks each step as you go.</p>
        </div>
        <div className="cc-actions">
          <button type="button" className="cc-btn" onClick={onNotNow}>
            Not now
          </button>
          <Link className="cc-btn primary" href={card.wizardHref}>
            Open the wizard
          </Link>
        </div>
      </div>
    </section>
  );
}

// ── The card ─────────────────────────────────────────────────────────────

export function ConnectCard({ card, interactive, conversationId, onOutcome, navigate }: ConnectCardProps) {
  const [phase, setPhase] = useState<"open" | "connected" | "dismissed">("open");
  const [note, setNote] = useState<string | undefined>(undefined);
  const sentRef = useRef(false);

  const handleConnected = (n?: string) => {
    setNote(n);
    setPhase("connected");
    // Once: the model hears "connected" a single time, however the card re-renders.
    if (!sentRef.current) {
      sentRef.current = true;
      onOutcome(connectOutcomeTurn(card.displayName, "connected"));
    }
  };
  const notNow = () => setPhase("dismissed");

  // A connection made here stays shown as made, even after the next turn makes this card "old".
  if (phase === "connected") return <ConnectedPanel card={card} note={note} />;
  if (!interactive) return <CompactRow card={card} />;
  if (card.blocked) return <BlockedPanel card={card} onOutcome={onOutcome} />;
  if (phase === "dismissed") return <CompactRow card={card} />;

  switch (card.mode) {
    case "credentials":
    case "mailbox":
    case "calendar":
      return <FormPanel card={card} onNotNow={notNow} onConnected={handleConnected} />;
    case "oauth":
      return (
        <OauthPanel
          card={card}
          conversationId={conversationId}
          onNotNow={notNow}
          navigate={navigate ?? ((url) => window.location.assign(url))}
        />
      );
    case "wizard":
      return <WizardPanel card={card} onNotNow={notNow} />;
    default:
      return <CompactRow card={card} />;
  }
}
