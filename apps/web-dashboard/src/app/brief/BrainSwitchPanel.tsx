"use client";

import { useCallback, useState } from "react";
import { Power } from "lucide-react";

import { brainIsOff, setBrainEnabled, type Coverage } from "./api";

/**
 * WARP-2838 — the control the empty state used to describe.
 *
 * `/brief` shipped saying "Turn the brain on to start reading your business"
 * with nothing in the product that could: `BRAIN_ENABLED` was read in one place
 * and written nowhere. WARP-2733 had already fixed the identical shape for
 * auto-filing, by giving the off state its own door. This is that door, and it
 * is HERE rather than in Settings for the same reason: the person who reads the
 * sentence is the person who has to be able to act on it.
 *
 * THE CONSENT LANGUAGE IS THE POINT, not the button. ADR-051 §9 and WARP-2753
 * put this behind an informed decision, and an operator reading an env-var name
 * in a `.env.example` is not making one. It is stated at the moment of the
 * click, in the words below, and it is deliberately unflattering:
 *
 *   🔴 "reads with whichever model this box is set to use" — NOT "stays on the
 *   box". The corpus pass calls `DEFAULT_MODEL ?? LLM_MODEL` through the AI
 *   gateway, which routes cloud model names to cloud providers. On a box whose
 *   default is a cloud model, document text leaves. Saying otherwise would make
 *   this screen the most consequential false claim in the product.
 *
 *   "slow on purpose" — ~240 documents a day, sharing the box's single
 *   inference slot. An owner who expects their business read overnight stops
 *   trusting the feature by morning.
 *
 *   "what it has already written stays" — turning it off stops the passes; it
 *   does not delete digests. Implying otherwise would be a promise no code
 *   here keeps.
 */
export function BrainSwitchPanel({
  coverage,
  onChanged,
}: {
  coverage: Coverage | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const off = brainIsOff(coverage);
  // `undefined` means an orchestrator older than this page, which has no
  // settings route at all — treat it as "cannot toggle" so the button is
  // absent rather than present and 404ing.
  const canToggle = coverage?.canToggle === true;

  const flip = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setError(null);
      const res = await setBrainEnabled(next);
      setBusy(false);
      if (!res.ok) {
        setError(
          res.error === "brain_switch_pinned"
            ? "This box's brain setting is pinned by its operator and cannot be changed here."
            : "Could not change the setting.",
        );
        return;
      }
      onChanged();
    },
    [onChanged],
  );

  if (!off) {
    // On. A quiet way back out, not a second call to action.
    return (
      <div className="brief-switch brief-switch--on">
        {canToggle ? (
          <button type="button" onClick={() => void flip(false)} disabled={busy}>
            <Power size={13} aria-hidden /> Turn the brain off
          </button>
        ) : (
          <p>Switched on by this box&rsquo;s operator, in its configuration.</p>
        )}
        {error ? <p className="brief-switch-error">{error}</p> : null}
      </div>
    );
  }

  // The heading is the ACTION, not the state. `CoverageLine` directly above
  // already says "The brain is off. Nothing has been read"; repeating it here
  // would spend the one heading on this screen restating the line above it
  // instead of naming the thing the owner can now do.
  return (
    <section className="brief-switch brief-switch--off">
      <h2>Turn on the company brain</h2>
      <p>
        Turn it on and Droplet reads the documents already indexed on this box —
        one at a time, in the background — and keeps short notes on what it
        found, so it can tell you what needs attention.
      </p>
      <ul>
        <li>
          It reads with whichever model this box is set to use. If that is a
          cloud model, the text it reads is sent to that provider.
        </li>
        <li>Notes and findings are stored on this box, and shown to owners and admins.</li>
        <li>
          It works through a few hundred documents a day and shares the box&rsquo;s
          single AI slot, so it is slow on purpose.
        </li>
        <li>
          You can turn it off at any time. What it has already written stays
          until you delete it.
        </li>
      </ul>
      {canToggle ? (
        <button type="button" onClick={() => void flip(true)} disabled={busy}>
          {busy ? "Turning on…" : "Turn the brain on"}
        </button>
      ) : (
        <p className="brief-switch-pinned">
          This box is pinned off by its operator (<code>BRAIN_ENABLED</code> in
          its configuration). Ask whoever administers it to change that — it
          cannot be switched on from here.
        </p>
      )}
      {error ? <p className="brief-switch-error">{error}</p> : null}
    </section>
  );
}
