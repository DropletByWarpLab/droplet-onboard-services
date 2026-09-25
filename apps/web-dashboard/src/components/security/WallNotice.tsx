"use client";

/**
 * WARP-2981 (ADR-059 P6, §3.8) — what /security/wall shows instead of the
 * wall. AuthGate renders it; it asks Droplet for nothing.
 *
 *   · `WallRefused` — D6 (Stefan: "Member wall, own cameras"): an owner or
 *     admin session never runs the wall. It says why, and what to do: sign in
 *     on the TV with a Staff account whose cameras are the ones to show. The
 *     refused person manages people, so it links to Users, where accounts
 *     are added and their cameras chosen, and offers to sign out of the TV.
 *
 * Always dark and chromeless, like the wall (wall.css).
 */
import "@/components/shell/indigo-tokens.css";
import "@/components/shell/droplet-shell.css";
import "./wall.css";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { tierLabel } from "@/lib/access";
import { SECURITY_WALL_SIGN_IN_HREF } from "@/lib/routing";
import { fill } from "./ModeCard";
import { WALL_COPY } from "./wall-status";

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="dark">
      <main id="main" tabIndex={-1} className="droplet-shell sec-wall-notice" aria-labelledby="sec-wall-notice-h">
        <div className="sec-wall-notice-card">
          <h1 id="sec-wall-notice-h">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

export function WallRefused() {
  const { logout } = useAuth();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const signOut = async () => {
    setLeaving(true);
    await logout();
    router.push(SECURITY_WALL_SIGN_IN_HREF);
  };
  return (
    <Notice title={WALL_COPY.refusedTitle}>
      <p>{WALL_COPY.refusedWhy}</p>
      <p>{fill(WALL_COPY.refusedWhat, { tier: tierLabel("family") })}</p>
      <p>{WALL_COPY.refusedManage}</p>
      <div className="sec-wall-notice-actions">
        <Link href="/users" className="btn primary">
          {WALL_COPY.refusedManageLink}
        </Link>
        <button type="button" className="btn" onClick={() => void signOut()} disabled={leaving}>
          {WALL_COPY.refusedSignOut}
        </button>
        <Link href="/security" className="btn ghost">
          {WALL_COPY.leave}
        </Link>
      </div>
    </Notice>
  );
}
