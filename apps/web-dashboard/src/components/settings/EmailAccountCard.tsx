"use client";

/**
 * WARP-2734 — "Connect a mailbox".
 *
 * ── This form is the whole reason the IMAP subsystem exists ────────────────
 *
 * Before it, nothing anywhere created an `EmailAccount` row: no route, no
 * form, no seed, no script. `EmailWorkspace`'s empty state told people to "go
 * to Settings", and Settings owned only the outbound SMTP relay — a different
 * thing entirely. The instruction pointed at a door that was not there.
 *
 * ── Next to `EmailChannelSection`, deliberately ────────────────────────────
 *
 * They are the two halves of mail and people confuse them constantly, so they
 * sit together and say which is which: this card is the mailbox Droplet READS,
 * that one is the relay Droplet SENDS THROUGH. A box can have either, both, or
 * neither.
 *
 * ── The password field ─────────────────────────────────────────────────────
 *
 * 🔴 Write-only, and never populated from the server. There is no endpoint
 * that returns a stored mailbox password — not masked, not truncated — so
 * there is nothing this component could render even if it tried. `autoComplete
 * ="new-password"` keeps a browser from offering the operator's own saved
 * credentials for a third-party mailbox.
 *
 * ── No example hostnames ───────────────────────────────────────────────────
 *
 * 🔴 The placeholders say "your mail server", not "imap.gmail.com". The
 * `egress-gate` CI check reads STRING LITERALS in source and denies anything
 * host-shaped, so a helpful example here is a failed build — the repo learned
 * this once already when a free-mail denylist read as twenty outbound
 * destinations.
 */

import { useCallback, useEffect, useState, type JSX } from "react";

import { authFetch } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { translateError } from "@/lib/friendly-errors";

interface MailboxAccount {
  id: string;
  address: string;
  displayName: string;
  imapStatus: string;
}

/** Default ports, offered rather than assumed — implicit TLS on both. */
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;

export function EmailAccountCard(): JSX.Element {
  const [accounts, setAccounts] = useState<MailboxAccount[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** The mailbox awaiting a disconnect confirmation, or null. */
  const [pendingDisconnect, setPendingDisconnect] = useState<MailboxAccount | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [address, setAddress] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(DEFAULT_IMAP_PORT);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(DEFAULT_SMTP_PORT);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await authFetch("/api/email/accounts");
      if (!res.ok) return; // a 403 for a family member is the ordinary answer
      const data = (await res.json()) as { accounts?: MailboxAccount[] };
      setAccounts(data.accounts ?? []);
    } catch {
      // A failed list is not worth an error banner on a settings page; the
      // form still works and the connect call reports its own failures.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reset = () => {
    setDisplayName("");
    setAddress("");
    setImapHost("");
    setImapPort(DEFAULT_IMAP_PORT);
    setSmtpHost("");
    setSmtpPort(DEFAULT_SMTP_PORT);
    setUsername("");
    setPassword("");
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch("/api/email/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          address,
          imapHost,
          imapPort,
          imapTls: true,
          smtpHost,
          smtpPort,
          smtpTls: true,
          username,
          password,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw Object.assign(new Error(body.error ?? "connect_failed"), {
          code: body.error,
          status: res.status,
        });
      }
      // 🔴 Cleared on success, and the password is cleared on FAILURE too —
      // see below. A form that keeps a live credential in a React state tree
      // after the page has moved on is a credential sitting in memory for no
      // reason.
      reset();
      setOpen(false);
      setSavedAt(Date.now());
      await load();
    } catch (err) {
      setError(translateError(err, "email"));
      // Everything else is kept so the owner can fix one field, but never
      // this one.
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  /**
   * 🔴 Confirmed through `<ConfirmDialog>`, because it is not reversible.
   *
   * `EmailThread`, `EmailMessage` and `EmailDraft` all cascade on `accountId`,
   * so disconnecting deletes the entire stored archive for that mailbox — and
   * a security review pointed out this was one unconfirmed click sitting next
   * to a "Connected" label. The mail itself still exists on the mail server;
   * what is destroyed is everything Droplet had indexed about it, which is the
   * part search and the customer timeline read.
   *
   * The repo's own primitive rather than `window.confirm`, which
   * `check-native-dialogs.sh` bans (WARP-291) — a native dialog cannot carry
   * the mailbox address as a verifiable identifier, cannot be styled to say
   * this is destructive, and traps focus outside the app.
   */
  const disconnect = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`/api/email/accounts/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) throw new Error("disconnect_failed");
      await load();
    } catch (err) {
      setError(translateError(err, "email"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-4">
      <h2 className="type-title-3">Mailboxes Droplet reads</h2>
      <p className="type-caption-1">
        Connect a mailbox and Droplet keeps a copy of its mail on this Droplet, so you
        can search it and see it beside your customers. This is separate from the
        outbound relay below, which is how Droplet <em>sends</em>.
      </p>

      {accounts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2">
              <span>
                {a.displayName} · {a.address}
              </span>
              <span className="type-caption-1 text-system-green">
                {a.imapStatus === "idle" ? "Connected" : a.imapStatus}
              </span>
              <button
                className="btn"
                disabled={busy}
                onClick={() => setPendingDisconnect(a)}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}

      {!open ? (
        <button className="btn primary type-subheadline" onClick={() => setOpen(true)}>
          Connect a mailbox
        </button>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            Name it
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Front desk"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            Email address
            <input
              type="email"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            Incoming mail server
            <input
              value={imapHost}
              onChange={(e) => setImapHost(e.target.value)}
              placeholder="your mail server"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            Incoming port
            <input
              type="number"
              value={imapPort}
              onChange={(e) => setImapPort(Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            Outgoing mail server
            <input
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              placeholder="your mail server"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            Outgoing port
            <input
              type="number"
              value={smtpPort}
              onChange={(e) => setSmtpPort(Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              // 🔴 Never `current-password`: that invites the browser to fill
              // the operator's OWN saved credential into a form for somebody
              // else's mailbox.
              autoComplete="new-password"
            />
          </label>
          <p className="type-caption-1 px-0.5 sm:col-span-2">
            Droplet checks the mailbox before saving anything. The password is stored
            encrypted on this Droplet and is never shown again.
          </p>
          <div className="flex items-center gap-2 pt-1 sm:col-span-2">
            <button className="btn primary type-subheadline" disabled={busy} onClick={() => void connect()}>
              {busy ? "Checking…" : "Connect"}
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                reset();
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2" role="alert">
          {error}
        </p>
      )}
      {savedAt !== null && !error && (
        <p className="type-footnote text-system-green flex items-center gap-1" role="status">
          Mailbox connected.
        </p>
      )}

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title="Disconnect this mailbox?"
        // Says what is DESTROYED and what SURVIVES. "Are you sure?" about an
        // unnamed thing is not a confirmation, it is a speed bump.
        description={
          "Droplet will delete its copy of this mailbox's mail, including anything " +
          "shown on your customers' timelines. The mail itself stays on your mail " +
          "server and is not touched."
        }
        // The address, so the person can check they are removing the one they
        // meant before they do it.
        confirmedIdentifier={pendingDisconnect?.address}
        confirmLabel="Disconnect"
        variant="destructive"
        onCancel={() => setPendingDisconnect(null)}
        onConfirm={async () => {
          const target = pendingDisconnect;
          setPendingDisconnect(null);
          if (target) await disconnect(target.id);
        }}
      />
    </section>
  );
}
