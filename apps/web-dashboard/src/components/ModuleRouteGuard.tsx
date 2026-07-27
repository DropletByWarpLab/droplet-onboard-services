"use client";

/**
 * WARP-1528 / ADR-032 §3(a) — nav-gate gap (c): the route-level guard.
 *
 * `useModuleGate` fails OPEN and that stays true — a probe blip must never
 * blank a shipping surface, and the orchestrator's `requireFeatureAccess` is
 * the actual boundary. But until now hiding the nav entry was the ONLY thing
 * the client did about a denied module, so a deep link, a bookmark, or the
 * Back button dropped you onto a fully rendered page shell that then failed
 * request by request — a surface that looks usable and isn't. This makes the
 * client stop pretending.
 *
 * It gates on POSITIVE denial only (the module resolves to off for this
 * viewer). Unresolved → render. No module claims the route → render. And the
 * always-on surfaces are structurally unreachable from here: `moduleForPath`
 * refuses to map `/`, `/chat` and `/settings` to any module at all (design §9
 * note (c) — self-integrity + self-lockout).
 *
 * The refusal is deliberately reason-free. The server makes a per-person denial
 * byte-identical to a box-wide toggle so it can't be used to enumerate what
 * other people can reach, and the client must not undo that by guessing out
 * loud — hence copy that covers both truthfully and points at the person who
 * can change it.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { moduleForPath } from "@/components/nav-config";
import { useModuleGate } from "@/lib/hooks/useModuleGate";

export function ModuleRouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isModuleOn = useModuleGate();

  const gated = moduleForPath(pathname);
  if (!gated || isModuleOn(gated.moduleId)) return <>{children}</>;

  const SectionIcon = gated.icon;
  return (
    <div className="px-7 py-20 flex justify-center">
      <div
        className="dp-tile p-10 flex flex-col items-center text-center gap-5 max-w-lg"
        data-testid="module-route-blocked"
      >
        {/* The SECTION's own glyph — it names where you are without a padlock.
            A lock would assert a reason ("you're barred"), and the server
            deliberately makes a per-person denial indistinguishable from a
            box-wide toggle; §13 also assigns Lock a specific meaning
            ("floor-blocked / off-box + reason"), so a padlock on a reason-free
            refusal contradicts itself on one card.
            Because this glyph carries the identification work a padlock would
            otherwise do, it must be READABLE: `label-secondary` is 5.56:1
            light / 9.57:1 dark, where `label-tertiary` computed to 1.71:1 — a
            ghost that undercut the very ruling it implements. Still on the
            neutral surface tint rather than EmptyState's accent treatment:
            this is a refusal, not an invitation. */}
        <span className="w-14 h-14 rounded-2xl bg-surface-secondary flex items-center justify-center">
          <SectionIcon size={24} strokeWidth={1.5} className="text-label-secondary" aria-hidden="true" />
        </span>
        <div className="space-y-2">
          <h1 className="type-title-2 text-label-primary font-semibold">
            {gated.label} isn&apos;t available
          </h1>
          <p className="type-body text-label-secondary">
            This feature is switched off for this Droplet, or it isn&apos;t part
            of your access. An owner or admin can turn it on.
          </p>
        </div>
        {/* The design system's own secondary button — quieter than the primary
            fill an empty state uses, because the useful action here is leaving,
            not converting. Carries the 44px target + the 200ms ease-smooth
            press feedback for free. */}
        <Link href="/" className="dp-btn-secondary">
          Back to Overview
          <ArrowRight size={14} strokeWidth={1.5} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
