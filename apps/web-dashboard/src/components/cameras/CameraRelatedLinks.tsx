"use client";

import Link from "next/link";

/**
 * WARP-3511 — the way between a camera's recordings, its settings, the
 * notifications that fire from it and the system page that says what its
 * footage costs.
 *
 * These four answers sit on four pages and nothing pointed between them: the
 * "not saving" warning said "Settings" in plain text, and the empty Recordings
 * state sent you to "Settings" with no way to get there. One component, used
 * wherever a camera is the subject, so the set cannot drift page by page.
 *
 * `current` is the page it renders on (never linked to itself). Settings is
 * only offered to owners and admins — the page refuses everyone else, and a
 * link to a refusal is worse than no link.
 */
export type CameraRelatedPage = "detail" | "recordings" | "settings";

export function CameraRelatedLinks({
  camera,
  current,
  canManage,
  appearance = "card",
  className = "",
}: {
  camera: string;
  current: CameraRelatedPage;
  canManage: boolean;
  appearance?: "card" | "rail";
  className?: string;
}) {
  const name = encodeURIComponent(camera);
  const links: Array<{ key: string; href: string; label: string }> = [];
  if (current !== "recordings") {
    links.push({ key: "recordings", href: `/cameras/${name}/recordings`, label: "Recordings" });
  }
  if (current !== "settings" && canManage) {
    links.push({ key: "settings", href: `/cameras/${name}/settings`, label: "Settings" });
  }
  links.push({ key: "notifications", href: "/cameras/notifications", label: "Notifications" });
  links.push({ key: "system", href: "/cameras/system", label: "System" });

  const linkClass =
    appearance === "rail"
      ? "type-caption-1 text-white/70 hover:text-white underline underline-offset-2"
      : "type-caption-1 underline underline-offset-2";

  return (
    <nav
      aria-label="Related camera pages"
      data-testid="camera-related-links"
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}
    >
      {links.map((l, i) => (
        <span key={l.key} className="flex items-center gap-2">
          {i > 0 && (
            <span aria-hidden="true" className={appearance === "rail" ? "text-white/40" : ""} style={appearance === "rail" ? undefined : { color: "var(--text-faint)" }}>
              ·
            </span>
          )}
          <Link
            href={l.href}
            className={linkClass}
            style={appearance === "rail" ? undefined : { color: "var(--brand)" }}
          >
            {l.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
