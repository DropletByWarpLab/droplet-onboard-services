"use client";

/**
 * WARP-1548 — the Files-scoped layout.
 *
 * There was no `app/files/layout.tsx` at all: the only layout in the app tree
 * is `app/layout.tsx` (which mounts `<AuthGate>`), so all seven Files routes
 * independently imported and configured `<ShellPage>`, and the only thing
 * tying them together was a copy-pasted back-link. Five of them spent their
 * ENTIRE `actions` slot on that byte-identical "← Files" block.
 *
 * This owns the shared chrome for the five static sub-routes. Their pages now
 * render content and nothing else — no `ShellPage`, no back-link, no header
 * strings.
 *
 * Why a back-link disappears rather than moving here: it exists because the
 * sub-views are dead ends you have to reverse out of. The places rail
 * (design packet §2) makes every location reachable from every other one, so
 * a control whose whole job is "undo the navigation you just did" has no job
 * left. Removing it is the point, not a side effect.
 *
 * `/files` and `/files/devices` still own their own `ShellPage` — both compute
 * part of their header from page state. See `files-routes.ts` for why that
 * asymmetry is deliberate and where it goes.
 */

import { usePathname } from "next/navigation";
import { Clock, HardDrive, Share2, Star, Trash2, type LucideIcon } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { headerForPath, type FilesRouteIcon } from "./files-routes";

const ICONS: Record<FilesRouteIcon, LucideIcon> = {
  drives: HardDrive,
  favorites: Star,
  recents: Clock,
  shared: Share2,
  trash: Trash2,
};

export default function FilesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const header = headerForPath(pathname ?? "");

  // `/files` and `/files/devices` — the page brings its own ShellPage. Passing
  // children straight through is what keeps this a no-op for them; wrapping
  // them here would double-render the whole shell.
  if (!header) return <>{children}</>;

  const Icon = ICONS[header.icon];

  return (
    <ShellPage
      icon={<Icon size={15} />}
      label={header.label}
      title={header.title}
      sub={header.sub}
    >
      {children}
    </ShellPage>
  );
}
