"use client";

import { useEffect, useState } from "react";
import { Check, KeyRound } from "lucide-react";
import { Sect } from "@/components/shell/primitives";
import { isPasskeySupported, registerPasskey } from "@/lib/webauthn";

/**
 * PR #377 (WARP-___) — Settings → Passkeys.
 *
 * The in-product home for enrolling a passkey. The AC allows the Account-step
 * OR settings; settings is the right fit because the setup wizard's AccountStep
 * auto-advances to the next step and passkey enrolment is optional — a forced
 * extra step there would fight the wizard flow. Here it's a calm, opt-in action
 * the owner can take any time after first sign-in.
 *
 * Scope is REGISTER only (per the AC: "register a passkey + sign in with a
 * passkey"). Listing and revoking enrolled passkeys is a follow-up — it needs
 * GET/DELETE credential endpoints not built in this PR.
 *
 * Matches the surrounding settings sections: a shell <Sect> header (sentence
 * case, WARP-1344) + a .card body. All copy is sentence case, no exclamation
 * marks (design copy rules). Motion comes from the .btn token (ease-smooth).
 */
// WARP-1156 — shown when the page isn't a secure context (plain-HTTP
// droplet.local) and on a SecurityError from the ceremony (origin/RP-ID
// mismatch). Both mean: this address can never mint a passkey; the fix is
// visiting the box's https address, not retrying here.
const SECURE_ADDRESS_COPY =
  "Passkeys need a secure connection, and this address doesn't have one. " +
  "Open your Droplet at its secure https address from setup, then add the passkey there.";

/** WARP-1156 — map the register failure to honest copy by the DOMException
 *  NAME only (never echo raw messages — they can carry transport detail).
 *  The old catch-all collapsed every cause into one dead-end "Try again",
 *  which on an insecure origin was a lie: no retry could ever succeed. */
function friendlyRegisterError(err: unknown): string {
  switch ((err as { name?: unknown })?.name) {
    case "NotAllowedError":
      // The spec deliberately folds dismiss / timeout / no-match into one.
      return "The passkey prompt was closed or timed out. Try again when you're ready.";
    case "InvalidStateError":
      return "This device already has a passkey for this Droplet. Try signing in with it instead.";
    case "SecurityError":
      return SECURE_ADDRESS_COPY;
    default:
      return "We couldn't add that passkey. Try again.";
  }
}

export function PasskeysSection() {
  const [supported, setSupported] = useState(false);
  // WARP-1156 — assume secure until mount proves otherwise so SSR markup
  // doesn't flash the warning on https pages.
  const [secure, setSecure] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  // Client-side capability check after mount (window is undefined during SSR).
  useEffect(() => {
    setSupported(isPasskeySupported());
    // WebAuthn only runs in a secure context; on plain HTTP the browser
    // rejects credentials.create() outright, so a button here would be a
    // dead-end (the WARP-1156 live report). isSecureContext is the same
    // signal the browser gates on.
    setSecure(window.isSecureContext !== false);
  }, []);

  async function handleAdd() {
    setError(null);
    setAdded(false);
    setBusy(true);
    try {
      await registerPasskey();
      setAdded(true);
    } catch (err) {
      setError(friendlyRegisterError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-10">
      <Sect title="Passkeys" />
      <div className="card space-y-3">
        <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
          Sign in without a password using your device&apos;s fingerprint, face,
          or a security key. Passkeys stay on your devices and never leave your
          Droplet.
        </p>

        {supported && secure ? (
          <button
            type="button"
            onClick={handleAdd}
            disabled={busy}
            className="btn"
          >
            <KeyRound size={16} strokeWidth={1.5} />
            {busy ? "Waiting for passkey..." : "Add a passkey"}
          </button>
        ) : supported ? (
          // WARP-1156 — insecure context: every create() would be refused by
          // the browser, so render the way forward instead of a doomed button.
          <p
            className="type-footnote bg-system-orange/10 rounded-sm px-3 py-2"
            style={{ color: "var(--text-muted)" }}
          >
            {SECURE_ADDRESS_COPY}
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
          <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
