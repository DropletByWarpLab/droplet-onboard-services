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

/**
 * Plane's dedicated TLS origin (spec WARP-498 OQ2 amendment). The vanilla
 * plane-frontend image is built with Next.js basePath:"" — its assets,
 * API calls, and client-side route pushes are all root-relative — so it
 * can never live under a /pm/ subpath (the first soft-nav inside the app
 * escapes the prefix, and /_next/* chunks 404 off the dashboard's Next
 * server: the black-iframe bug). The gateway serves it on its own port
 * with the same cert (docker/nginx.conf :8443 server block). Derived
 * from the page's own hostname so it works on any LAN name (mDNS or raw
 * IP) — same-site, so the dashboard session cookie story is unchanged.
 */
const PLANE_PORT = 8443;

/**
 * Romain PR #320 review §1 (amended for the cross-origin move): the
 * sentinel branch — `load` never fires within 5s — is the primary
 * blocked/network-failure signal. Plane is now a cross-origin frame
 * (different port), so its document is opaque to us: contentDocument
 * is null (or access throws) on a HEALTHY frame. The empty-document
 * heuristic from #320 only applies when the document is readable
 * (same-origin error placeholders); an opaque document after `load`
 * means the frame is fine.
 */
export default function ProjectsPage(): JSX.Element {
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const [planeUrl, setPlaneUrl] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loadFiredRef = useRef(false);

  useEffect(() => {
    // window is unavailable during prerender — derive the origin on mount.
    setPlaneUrl(`https://${window.location.hostname}:${PLANE_PORT}/`);
  }, []);

  const checkBlocked = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      if (doc === null) {
        // Opaque cross-origin document — the healthy case for Plane's
        // dedicated origin. `load` having fired is the success signal;
        // refused/unreachable frames are caught by the 5s sentinel.
        return;
      }
      // Readable document (same-origin placeholder): a refused frame is
      // a near-empty document — no <body> children. A real page has
      // dozens. Use `< 2` to be tolerant of a single `<noscript>` style
      // child some browsers inject.
      if (!doc.body || doc.body.childElementCount < 2) {
        setIframeBlocked(true);
      }
    } catch {
      // SecurityError — some browsers throw instead of returning null
      // for a cross-origin document. Same meaning as doc === null:
      // opaque and healthy-if-loaded.
      return;
    }
  }, []);

  useEffect(() => {
    // 5s fallback: if `load` never fires (network failure, infinite
    // redirect, upstream timeout, frame refused) flip the banner. Real
    // loads complete within a second. Armed only once the iframe exists
    // (planeUrl resolves on mount).
    if (!planeUrl) return;
    const timer = setTimeout(() => {
      if (!loadFiredRef.current) {
        setIframeBlocked(true);
      } else {
        checkBlocked();
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, [checkBlocked, planeUrl]);

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
          href={planeUrl ?? "#"}
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
      {planeUrl !== null && (
        <iframe
          ref={iframeRef}
          id="pm-iframe"
          src={planeUrl}
          title="Plane — Projects"
          className="h-full w-full border-0"
          onLoad={handleLoad}
          // sandbox not set — Plane needs full document permissions for
          // its own OIDC flow (popup, navigation). Tightening this is a
          // follow-up once we know Plane's exact CSP needs.
        />
      )}
    </div>
  );
}
