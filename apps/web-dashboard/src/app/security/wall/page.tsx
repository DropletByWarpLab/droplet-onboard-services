"use client";

/**
 * WARP-2981 (ADR-059 P6, §3.8) — /security/wall, a read-only Security page
 * for a TV: the viewer's own camera tiles above a status strip. AuthGate
 * renders it with no shell (no sidebar, tabs or help launcher) but keeps the
 * module route guard, and refuses an owner or admin session outright (D6);
 * the page draws its own <main id="main">. Linked from /security's
 * header, not from the nav: it is a way to show Security, not a place to work.
 */
import { SecurityWall } from "@/components/security/SecurityWall";

export default function SecurityWallPage() {
  return <SecurityWall />;
}
