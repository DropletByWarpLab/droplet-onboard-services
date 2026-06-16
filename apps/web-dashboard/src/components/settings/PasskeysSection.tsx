"use client";

import { useEffect, useState } from "react";
import { Check, KeyRound } from "lucide-react";
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
 * Matches the surrounding settings sections: uppercase type-footnote header +
 * a dp-card body. All copy is sentence case, no exclamation marks
 * (design copy rules). Motion comes from the dp-btn token (ease-smooth).
 */
export function PasskeysSection() {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  // Client-side capability check after mount (window is undefined during SSR).
  useEffect(() => {
    setSupported(isPasskeySupported());
  }, []);

  async function handleAdd() {
    setError(null);
    setAdded(false);
    setBusy(true);
    try {
      await registerPasskey();
      setAdded(true);
    } catch {
      // Never surface the raw ceremony error — it can carry transport detail.
      setError("We couldn't add that passkey. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="type-footnote text-label-secondary uppercase tracking-wider px-1 mb-2">
        Passkeys
      </h2>
      <div className="dp-card p-4 space-y-3">
        <p className="type-subheadline text-label-secondary">
          Sign in without a password using your device&apos;s fingerprint, face,
          or a security key. Passkeys stay on your devices and never leave your
          Droplet.
        </p>

        {supported ? (
          <button
            type="button"
            onClick={handleAdd}
            disabled={busy}
            className="dp-btn-secondary"
          >
            <KeyRound size={16} strokeWidth={1.5} />
            {busy ? "Waiting for passkey..." : "Add a passkey"}
          </button>
        ) : (
          <p className="type-footnote text-label-tertiary">
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
