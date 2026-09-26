"use client";

/**
 * WARP-2981 (ADR-059 P6, §3.8) — the two things /security/wall shows instead
 * of the wall. AuthGate renders them; neither asks Droplet for anything.
 *
 *   · `WallRefused` — D6 (Stefan: "Member wall, own cameras"): the wall runs
 *     on a Member account only. It says why, and what to do: sign in here
 *     with a Member account whose cameras are the ones to show. Signing out
 *     is its first action: an owner or admin reaches it as often from a
 *     laptop's "TV view" button as from a TV, so it names "this screen",
 *     never "this TV". An owner or admin manages people, so it also links to
 *     Users, where accounts are added and their cameras chosen, and advises
 *     an account just for the screen whose role (Roles & access, based on
 *     Member) sets Security to View: Member holds Security at Respond by
 *     default, and at View the server refuses the mode and acknowledging
 *     from the room's session. A guest
 *     can't see Security at all (every wall read is floored at Member on the
 *     server), so a guest is told that, and led back to the Overview.
 *   · `WallSignedOut` — the TV's sign-in ended (the 12 h limit, 30 min with
 *     no request, a fifth sign-in elsewhere, a revocation), or it never had
 *     one. It says so, and only a press opens the sign-in form: the screen
 *     never leads anyone into typing a password in front of the room by
 *     itself (authFetch and AuthGate do not navigate to /login from here).
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

export function WallRefused({ role }: { role: string | undefined }) {
  const { logout } = useAuth();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const signOut = async () => {
    setLeaving(true);
    await logout();
    router.push(SECURITY_WALL_SIGN_IN_HREF);
  };
  // A role this build doesn't know gets the owner/admin refusal: the wall can't vouch it is not an admin's.
  const guest = role === "guest";
  return (
    <Notice title={guest ? WALL_COPY.refusedGuestTitle : WALL_COPY.refusedTitle}>
      <p>{guest ? WALL_COPY.refusedGuestWhy : WALL_COPY.refusedWhy}</p>
      <p>{fill(WALL_COPY.refusedWhat, { tier: tierLabel("family") })}</p>
      {!guest && <p>{fill(WALL_COPY.refusedManage, { tier: tierLabel("family") })}</p>}
      <div className="sec-wall-notice-actions">
        <button type="button" className="btn primary" onClick={() => void signOut()} disabled={leaving}>
          {WALL_COPY.refusedSignOut}
        </button>
        {guest ? (
          <Link href="/" className="btn ghost">
            {WALL_COPY.refusedGuestLeave}
          </Link>
        ) : (
          <>
            <Link href="/users" className="btn">
              {WALL_COPY.refusedManageLink}
            </Link>
            <Link href="/security" className="btn ghost">
              {WALL_COPY.leave}
            </Link>
          </>
        )}
      </div>
    </Notice>
  );
}

export function WallSignedOut() {
  return (
    <Notice title={WALL_COPY.signedOutTitle}>
      <p>{WALL_COPY.signedOutBody}</p>
      <div className="sec-wall-notice-actions">
        <Link href={SECURITY_WALL_SIGN_IN_HREF} className="btn primary">
          {WALL_COPY.signedOutAction}
        </Link>
      </div>
    </Notice>
  );
}
