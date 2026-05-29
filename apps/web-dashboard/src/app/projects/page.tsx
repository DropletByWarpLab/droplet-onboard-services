"use client";

/**
 * Projects page — embedded Plane PM stack.
 *
 * WARP-512 — per spec WARP-498 OQ6 (resolved 2026-05-28), Plane SSO is
 * OIDC: Plane is the relying party, the orchestrator is the IdP. From
 * the dashboard's point of view, all we do is bounce the user to Plane.
 * Plane sees an unauthenticated request, redirects to its `/auth/oidc/`
 * endpoint, which redirects to the orchestrator's
 * `/api/pm/oidc/authorize` (WARP-505), which sees the dashboard session
 * cookie and round-trips an ID token back. The user lands in Plane
 * already authenticated with no second login.
 *
 * Per spec OQ2: iframe at `/pm/` keeps the Droplet chrome. The nginx
 * `/pm/` location block lands via WARP-502 (#303); the SSO bridge that
 * makes Plane actually authenticate lands via WARP-505 (#307). Until
 * both are deployed the iframe will surface upstream errors — the
 * "Open in new tab" link below the iframe is always visible so the
 * user has an explicit escape hatch independent of any CSP detector.
 *
 * Per architecture-guard rule 6: dashboard UI ships from
 * apps/web-dashboard/. droplet-windows Tauri shell loads this same UI.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const PLANE_URL = "/pm/";

/**
 * Romain PR #320 review §1: `iframe.contentDocument !== null` is
 * always true for a same-origin frame even when CSP `frame-ancestors`
 * blocks the load — the browser renders an error page INSIDE the
 * iframe but leaves contentDocument accessible. The catch-on-
 * SecurityError branch never fired either (same-origin throws no
 * SecurityError). Replaced the broken detector with two independent
 * signals that both work for same-origin blocks:
 *
 *   1. `load` never fires within the 5s timeout (sentinel branch)
 *   2. `load` fires but the resulting document is empty (no <body>
 *      content) — the browser-error placeholder browsers paint when
 *      framing was refused has childElementCount === 0
 *
 * Either signal flips `iframeBlocked` so the inline error card shows.
 * Cross-origin frames (when we eventually iframe a customer-installed
 * Plane on a different host) still set `iframeBlocked` via the SecurityError
 * branch on contentDocument access.
 */
export default function ProjectsPage(): JSX.Element {
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loadFiredRef = useRef(false);

  const checkBlocked = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      // Browser-painted error page for a CSP-blocked frame is a near-
      // empty document — no <body> children. A real Plane page has
      // dozens. Use `< 2` as the threshold to be tolerant of a single
      // `<noscript>` style child some browsers inject.
      if (!doc || !doc.body || doc.body.childElementCount < 2) {
        setIframeBlocked(true);
      }
    } catch {
      // SecurityError — cross-origin block. Treat as "blocked".
      setIframeBlocked(true);
    }
  }, []);

  useEffect(() => {
    // 5s fallback: if `load` never fires (network failure, infinite
    // redirect, upstream timeout) flip the banner. Real loads complete
    // within a second.
    const timer = setTimeout(() => {
      if (!loadFiredRef.current) {
        setIframeBlocked(true);
      } else {
        checkBlocked();
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, [checkBlocked]);

  const handleLoad = useCallback(() => {
    loadFiredRef.current = true;
    // Run the empty-document check on the next tick — some browsers
    // fire `load` before the error placeholder is fully painted.
    setTimeout(checkBlocked, 50);
  }, [checkBlocked]);

  // Romain PR #320 review §4: AuthGate already wraps every page in a
  // <main id="main">. A second <main> here is a duplicate ARIA
  // landmark and announces incorrectly in screen readers. Use a <div>
  // matching every other page in this app (cameras, network,
  // remote-access, knowledge).
  if (iframeBlocked) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <h1 className="type-title-2 text-label-primary">Open Projects</h1>
        <p className="type-subheadline text-label-secondary">
          The embedded view didn&apos;t load. Open Plane in a new tab:
        </p>
        <a
          href={PLANE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="dp-btn-primary"
        >
          Open Plane →
        </a>
      </div>
    );
  }

  return (
    // Romain PR #320 review §3: `h-full` on the iframe collapses to
    // 0px because the parent's height resolves to `auto`. AuthGate's
    // <main> uses `min-h-dvh` (a MIN, not a fixed height). Use the
    // same fixed-height context the chat page uses so the iframe has
    // a parent with a real `height` value to fill — account for the
    // dashboard top bar (56px) and iOS bottom safe area.
    //
    // Romain PR #320 review §4: <div> root, not <main>. See above.
    <div className="h-[calc(100dvh-56px-env(safe-area-inset-bottom))] lg:h-dvh">
      <iframe
        ref={iframeRef}
        id="pm-iframe"
        src={PLANE_URL}
        title="Plane — Projects"
        className="h-full w-full border-0"
        onLoad={handleLoad}
        // sandbox not set — Plane needs full document permissions for
        // its own OIDC flow (popup, navigation). Tightening this is a
        // follow-up once we know Plane's exact CSP needs.
      />
    </div>
  );
}
