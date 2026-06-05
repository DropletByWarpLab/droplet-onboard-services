"use client";

/**
 * Ambient decorative layer for the Home surface:
 *  · slowly drifting indigo background blobs (+ one faint amber complement)
 *  · a faceted droplet pinned bottom-right that animates while the page
 *    settles, then fades out — a calm "load" indicator.
 *
 * Purely decorative (pointer-events: none, aria-hidden) and fully scoped
 * under `.droplet-home`, so it never interferes with the rest of the app.
 * Respects prefers-reduced-motion via CSS.
 */

import { useEffect, useState } from "react";

export function AmbientLayer() {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // The droplet reads as a load indicator: let it bob briefly after mount,
    // then fade. Two frames + a short delay so it's visible on fast loads too.
    const t = window.setTimeout(() => setLoaded(true), 900);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <>
      <div className="dh-ambient" aria-hidden>
        <span className="blob b1" />
        <span className="blob b2" />
        <span className="blob b3" />
        <span className="blob b4" />
      </div>
      <div className={"dh-drop" + (loaded ? " dh-drop--done" : "")} aria-hidden>
        <span className="ripple" />
        <span className="ripple ripple2" />
        <svg viewBox="0 0 52 60" xmlns="http://www.w3.org/2000/svg">
          <polygon points="26,2 44,28 36,48 16,48 8,28" fill="#818cf8" />
          <polygon points="26,2 44,28 26,36" fill="#a5b4fc" />
          <polygon points="26,2 8,28 26,36" fill="#6366f1" opacity="0.6" />
        </svg>
      </div>
    </>
  );
}
