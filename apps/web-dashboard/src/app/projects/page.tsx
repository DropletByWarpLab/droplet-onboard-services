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
 * Per spec OQ2: iframe at `/pm/` keeps the Droplet chrome. If Plane's
 * CSP frame-ancestors blocks same-origin framing, fallback to a full
 * redirect is one-line.
 *
 * Per architecture-guard rule 6: dashboard UI ships from
 * apps/web-dashboard/. droplet-windows Tauri shell loads this same UI.
 */

import { useEffect, useState } from "react";

const PLANE_URL = "/pm/";

export default function ProjectsPage(): JSX.Element {
  const [iframeBlocked, setIframeBlocked] = useState(false);

  // Detect frame-ancestors block — if the iframe fails to load within
  // 5s, fall back to a redirect prompt so the user isn't stuck on a
  // blank panel.
  useEffect(() => {
    const timer = setTimeout(() => {
      const iframe = document.getElementById("pm-iframe") as HTMLIFrameElement | null;
      if (!iframe) return;
      try {
        // Same-origin so this should succeed if Plane allowed framing.
        const ok = iframe.contentDocument !== null;
        if (!ok) setIframeBlocked(true);
      } catch {
        setIframeBlocked(true);
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  if (iframeBlocked) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <h1 className="text-xl font-semibold">Open Projects</h1>
        <p className="text-sm text-gray-600">
          Your browser blocked the embedded view. Open Plane in a new tab:
        </p>
        <a
          href={PLANE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Open Plane →
        </a>
      </main>
    );
  }

  return (
    <main className="h-full">
      <iframe
        id="pm-iframe"
        src={PLANE_URL}
        title="Plane — Projects"
        className="h-full w-full border-0"
        // sandbox not set — Plane needs full document permissions for
        // its own OIDC flow (popup, navigation). Tightening this is a
        // follow-up once we know Plane's exact CSP needs.
      />
    </main>
  );
}
