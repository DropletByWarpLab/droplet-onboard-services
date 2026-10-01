"use client";

/**
 * WARP-3168 — links on company files that reach outside the company and were
 * made by someone who is not an owner or admin: before WARP-3053 made that
 * owner/admin only, or in Nextcloud directly. Listed for review only; nothing
 * here revokes anything.
 */
import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { fetchCompanyPublicLinks } from "@/lib/api";
import type { CompanyPublicLink } from "@/lib/types";

const PERM_SHARE = 16;

export function linkKindLabel(link: Pick<CompanyPublicLink, "shareType" | "permissions">): string {
  if (link.shareType === 3) return "Public link";
  if (link.shareType === 4) return "Email link";
  if ((link.shareType === 0 || link.shareType === 1) && link.permissions & PERM_SHARE) {
    return "Can re-share";
  }
  return "External share";
}

export function roleLabel(role: CompanyPublicLink["createdBy"]["role"]): string {
  if (role === "family") return "Member";
  if (role === "guest") return "External guest";
  return role ?? "Not a Droplet account";
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function CompanyPublicLinks() {
  const [links, setLinks] = useState<CompanyPublicLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchCompanyPublicLinks()
      .then((l) => alive && setLinks(l))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <div className="sect">
        <h2>Links made by members</h2>
      </div>
      <p className="type-footnote" style={{ marginBottom: 10, maxWidth: "70ch" }}>
        Links to company files that reach people outside the company, made by someone who
        isn&apos;t an owner or admin. Only owners and admins can make these now; these are
        older, or were made in Nextcloud directly. Nothing is removed automatically: ask the
        person, who can remove it from Shared by me.
      </p>
      <div className="card">
        {error ? (
          <div className="empty" role="alert">
            {error}. The list is unavailable, which does not mean there are none.
          </div>
        ) : links === null ? (
          <div className="empty">Loading links…</div>
        ) : links.length === 0 ? (
          <div className="empty">
            <span className="ei">
              <Link2 size={24} aria-hidden="true" />
            </span>
            <span className="eh">No member-made links to company files</span>
          </div>
        ) : (
          <div className="rows">
            {links.map((l) => (
              <div key={l.shareId} className="lrow">
                <span className="rt">
                  <span className="nm">
                    {l.library}
                    {l.path === "/" ? "" : l.path}
                  </span>
                  <span className="sub">
                    {l.createdBy.name} · {roleLabel(l.createdBy.role)}
                  </span>
                </span>
                <span className="rmeta">{linkKindLabel(l)}</span>
                <span className="rmeta mono" title="Created">
                  {day(l.createdAt)}
                </span>
                <span className="rmeta mono" title="Expires">
                  {l.expiresAt ? `until ${day(l.expiresAt)}` : "no expiry"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
