"use client";

import { useCallback, useState } from "react";
import { Power } from "lucide-react";

import { brainIsOff, setBrainEnabled, type CoverageResult } from "./api";

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
 *
 * THE PANEL NEVER STATES A CAUSE IT WAS NOT TOLD. It takes a `CoverageResult`
 * rather than a `Coverage | null` for that reason: a null body used to mean
 * both "the brain is off" and "the box did not answer", and this component
 * turned the second into the first — telling an owner their box was pinned off
 * by an operator, with the env var named, because of a transient 500.
 * `reached: false` is now its own branch, and it says only what it knows.
 */
export function BrainSwitchPanel({
  result,
  onChanged,
}: {
  result: CoverageResult;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (!result.reached) {
    // The box did not answer. Say that, and nothing else — every other branch
    // below describes a state this one has no evidence for. `onChanged` is the
    // page's reload, which is exactly what a retry is.
    return (
      <div className="brief-switch brief-switch--unknown">
        <p>
          Could not check whether the brain is on — this box did not answer.
          Nothing has changed either way.
        </p>
        <button type="button" onClick={onChanged}>
          Try again
        </button>
      </div>
    );
  }

  // Everything below has an answer to reason from. Derived AFTER the guard so
  // the compiler knows it, rather than behind a `?.` that would let a future
  // edit read the unanswered case as data again.
  const coverage = result.coverage;
  const off = brainIsOff(coverage);
  // THREE values, not two. `true` is the owner's to give; `false` is a real
  // `BRAIN_ENABLED` pin, which is the only state that may be described as one;
  // `undefined` is an orchestrator older than this page, which has no settings
  // route at all — no button (it would 404) and no pin claim either.
  const canToggle = coverage.canToggle;

  if (!off) {
    // On. A quiet way back out, not a second call to action.
    return (
      <div className="brief-switch brief-switch--on">
        {canToggle === true ? (
          <button type="button" onClick={() => void flip(false)} disabled={busy}>
            <Power size={13} aria-hidden /> Turn the brain off
          </button>
        ) : canToggle === false ? (
          <p>Switched on by this box&rsquo;s operator, in its configuration.</p>
        ) : null}
        {error ? <p className="brief-switch-error">{error}</p> : null}
      </div>
    );
  }

  // The heading is the ACTION, not the state. `CoverageLine` directly above
  // already says "The brain is off. Nothing new is being read"; repeating it here
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
      {canToggle === true ? (
        <button type="button" onClick={() => void flip(true)} disabled={busy}>
          {busy ? "Turning on…" : "Turn the brain on"}
        </button>
      ) : canToggle === false ? (
        // Only when the box SAID so. This sentence names an env var and sends
        // the reader to their administrator; it has to be earned by an answer.
        <p className="brief-switch-pinned">
          This box is pinned off by its operator (<code>BRAIN_ENABLED</code> in
          its configuration). Ask whoever administers it to change that — it
          cannot be switched on from here.
        </p>
      ) : (
        // The field is not on the wire at all: this box's software predates the
        // switch. That is an update, not a pin, and saying "pinned" would send
        // somebody to change a variable that is not the reason.
        <p className="brief-switch-pinned">
          This box&rsquo;s software does not offer the switch yet. Updating it
          adds one.
        </p>
      )}
      {error ? <p className="brief-switch-error">{error}</p> : null}
    </section>
  );
}
