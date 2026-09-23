"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, KeyRound, Pencil, Trash2 } from "lucide-react";
import { Sect } from "@/components/shell/primitives";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  describePasskeyError,
  isPasskeySupported,
  listPasskeys,
  passkeyErrorView,
  passkeyOriginProblem,
  registerPasskey,
  removePasskey,
  renamePasskey,
  type PasskeyErrorView,
  type PasskeyOriginProblem,
  type PasskeySummary,
} from "@/lib/webauthn";

/**
 * Settings → Passkeys.
 *
 * PR #377 added enrolment. WARP-1156 added honest DOMException copy.
 * WARP-1157 adds:
 *   - the address check runs FIRST: on plain http the browser hides WebAuthn
 *     entirely, so `isPasskeySupported()` is false there, and the old order
 *     blamed the browser for what is really the connection. A raw IP is also
 *     refused here, because an IP address is never a valid RP ID.
 *   - one shared error mapping (`describePasskeyError`) for browser and box
 *     failures, offering "try again" only where a retry can succeed.
 *   - the list of your own passkeys: name, the address it works at, when it
 *     was added and last used, rename and remove.
 *
 * Copy is sentence case with no exclamation marks. Inputs reuse the shared
 * `dp-input` class unchanged (WARP-1356 owns input focus styling).
 */

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function PasskeysSection() {
  const [supported, setSupported] = useState(false);
  // Assume the address is fine until mount proves otherwise, so SSR markup
  // doesn't flash the warning on https pages.
  const [originProblem, setOriginProblem] = useState<PasskeyOriginProblem | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PasskeyErrorView | null>(null);
  const [added, setAdded] = useState(false);

  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [removing, setRemoving] = useState<PasskeySummary | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPasskeys(await listPasskeys());
      setListError(null);
    } catch (err) {
      setListError(
        describePasskeyError(err).kind === "network"
          ? "We couldn't reach your Droplet to load your passkeys."
          : "Your passkeys couldn't be loaded right now.",
      );
    }
  }, []);

  // Capability + address checks after mount (window is undefined during SSR).
  useEffect(() => {
    setOriginProblem(passkeyOriginProblem());
    setSupported(isPasskeySupported());
    setHost(window.location?.hostname ?? null);
    void refresh();
  }, [refresh]);

  async function handleAdd() {
    setError(null);
    setAdded(false);
    setBusy(true);
    try {
      await registerPasskey();
      setAdded(true);
      await refresh();
    } catch (err) {
      setError(describePasskeyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(id: string) {
    const name = draftName.trim();
    if (!name) return;
    setError(null);
    try {
      await renamePasskey(id, name);
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError({ ...describePasskeyError(err), message: "That name couldn't be saved. Try again." });
    }
  }

  async function handleRemove(id: string) {
    setError(null);
    try {
      await removePasskey(id);
      await refresh();
    } catch (err) {
      setError({ ...describePasskeyError(err), message: "That passkey couldn't be removed. Try again." });
      throw err; // keep the dialog open
    }
  }

  const canAdd = originProblem === null && supported;

  return (
    <section className="mb-10">
      <Sect title="Passkeys" />
      <div className="card space-y-3">
        <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
          Sign in without a password using your device&apos;s fingerprint, face,
          or a security key. Passkeys stay on your devices and never leave your
          Droplet.
        </p>

        {canAdd ? (
          <button type="button" onClick={handleAdd} disabled={busy} className="btn">
            <KeyRound size={16} strokeWidth={1.5} />
            {busy ? "Waiting for passkey..." : "Add a passkey"}
          </button>
        ) : originProblem ? (
          // The browser would refuse every attempt here, so show the way
          // forward instead of a button that can't work.
          <p
            className="type-footnote bg-system-orange/10 rounded-sm px-3 py-2"
            style={{ color: "var(--text-muted)" }}
          >
            {passkeyErrorView(originProblem).message}
          </p>
        ) : (
          <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
            This browser doesn&apos;t support passkeys.
          </p>
        )}

        {added && (
          <p className="type-footnote text-system-green bg-system-green/10 rounded-sm px-3 py-2 flex items-center gap-2">
            <Check size={14} strokeWidth={2} className="flex-shrink-0" />
            Passkey added. You can use it to sign in next time.
          </p>
        )}

        {error && (
          <p role="alert" className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            {error.message}
          </p>
        )}

        {listError && (
          <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
            {listError}
          </p>
        )}

        {passkeys && passkeys.length > 0 && (
          <ul aria-label="Your passkeys" className="space-y-2 pt-1">
            {passkeys.map((pk) => {
              const label = pk.name ?? "Unnamed passkey";
              const addedOn = formatDate(pk.createdAt);
              const used = formatDate(pk.lastUsedAt);
              const elsewhere = pk.rpId !== null && host !== null && pk.rpId !== host;
              return (
                <li key={pk.id} className="flex items-start gap-3 rounded-sm px-3 py-2 bg-surface-secondary">
                  <KeyRound size={16} strokeWidth={1.5} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    {editingId === pk.id ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleRename(pk.id);
                        }}
                      >
                        <input
                          aria-label="Passkey name"
                          className="dp-input flex-1"
                          value={draftName}
                          maxLength={64}
                          autoFocus
                          onChange={(e) => setDraftName(e.target.value)}
                        />
                        <button type="submit" className="btn" disabled={!draftName.trim()}>
                          Save
                        </button>
                        <button type="button" className="btn" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <p className="type-subheadline truncate" style={{ color: "var(--text)" }}>
                        {label}
                      </p>
                    )}
                    <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                      {pk.rpId
                        ? `Works at ${pk.rpId}${elsewhere ? " (not this address)" : ""}`
                        : "Address not recorded"}
                      {addedOn ? ` · Added ${addedOn}` : ""}
                      {` · ${used ? `Last used ${used}` : "Not used yet"}`}
                    </p>
                  </div>
                  {editingId !== pk.id && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        className="btn"
                        aria-label={`Rename ${label}`}
                        onClick={() => {
                          setEditingId(pk.id);
                          setDraftName(pk.name ?? "");
                        }}
                      >
                        <Pencil size={14} strokeWidth={1.5} />
                      </button>
                      <button
                        type="button"
                        className="btn"
                        aria-label={`Remove ${label}`}
                        onClick={() => setRemoving(pk)}
                      >
                        <Trash2 size={14} strokeWidth={1.5} />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={removing !== null}
        title="Remove this passkey?"
        description="You won't be able to sign in with it any more. Your password still works, and you can add a new passkey at any time."
        confirmedIdentifier={removing ? (removing.name ?? "Unnamed passkey") : undefined}
        confirmLabel="Remove passkey"
        onConfirm={() => (removing ? handleRemove(removing.id) : undefined)}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}
