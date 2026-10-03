"use client";

/**
 * ADR-055 P4b — /doors: the doors this box knows about, what each last
 * reported and when, and a log of what happened at them.
 *
 * Read by owners and admins; added, changed and retired by the owner alone.
 *
 * SHIPS DARK, and dark means ABSENT (DOORS_ENABLED is off by default), so the
 * page decides for itself, in three steps, before any doors request is made:
 *
 *   · the module list has not answered → render NOTHING (no flash of a 404 on a
 *     box that has doors, and none of the page on a box that does not);
 *   · it answered and does not list doors as on for this person → a plain 404
 *     (`notFound()`), the same page any unknown route gets: no "isn't available"
 *     card, no "an owner or admin can turn it on" (untrue of a module only a
 *     flag switches on), no hint the product exists;
 *   · it lists doors → the page.
 *
 * `ModuleRouteGuard` steps aside for modules in `dark-modules.ts`, because a
 * `notFound()` thrown from the guard (in the layout) would not reach the
 * boundary. The nav entry is hidden by the same rule (`isModuleEffective`).
 *
 * If the box itself then refuses the read (404 module_disabled, or 403 — a
 * toggle raced the module list), the answer is the same 404, never an error
 * with a Retry that can't help.
 */
import { notFound } from "next/navigation";
import { DoorOpen } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { DoorEvents } from "@/components/doors/DoorEvents";
import { DoorsPanel, isRefusal } from "@/components/doors/DoorsPanel";
import { COPY } from "@/components/doors/door-copy";
import { useDoorEvents, useDoors } from "@/lib/hooks/useDoors";
import { useModuleGateState } from "@/lib/hooks/useModuleGate";

export default function DoorsPage() {
  const gate = useModuleGateState("doors");
  if (gate === "unresolved") return null;
  if (gate === "off") notFound();
  return <DoorsSurface />;
}

/** Only mounted once the module list has listed doors: nothing here runs, or asks the box anything, before. */
function DoorsSurface() {
  const doorsQ = useDoors();
  const eventsQ = useDoorEvents();
  if (!doorsQ.doors && isRefusal(doorsQ.error)) notFound();

  return (
    <ShellPage icon={<DoorOpen size={15} />} label="Doors" title={COPY.title} sub={COPY.sub} rhythm>
      <DoorsPanel q={doorsQ} />
      <DoorEvents
        events={eventsQ.events}
        isLoading={eventsQ.isLoading}
        error={eventsQ.error}
        hasMore={eventsQ.hasMore}
        isLoadingMore={eventsQ.isLoadingMore}
        onLoadMore={eventsQ.loadMore}
        onRetry={eventsQ.refresh}
      />
    </ShellPage>
  );
}
