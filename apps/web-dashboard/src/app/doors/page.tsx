"use client";

/**
 * ADR-055 P4b — /doors: the doors this box knows about, what each last
 * reported and when, and a log of what happened at them.
 *
 * Read by owners and admins; added, changed and retired by the owner alone.
 * Gated by the `doors` module through `nav-config` (`moduleForPath`), so with
 * Doors off there is no nav entry and `ModuleRouteGuard` shows its standard
 * "isn't available" card in this page's place. The module ships dark
 * (DOORS_ENABLED, off by default): when it is off it is ABSENT, not empty.
 *
 * If the box itself refuses the read (404 module_disabled, or 403), the page
 * shows the same card rather than an error with a Retry that can't help.
 */
import { DoorOpen } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { DoorEvents } from "@/components/doors/DoorEvents";
import { DoorsNotAvailable } from "@/components/doors/DoorsNotAvailable";
import { DoorsPanel, isRefusal } from "@/components/doors/DoorsPanel";
import { COPY } from "@/components/doors/door-copy";
import { useDoorEvents, useDoors } from "@/lib/hooks/useDoors";

export default function DoorsPage() {
  const doorsQ = useDoors();
  const eventsQ = useDoorEvents();
  const notAvailable = !doorsQ.doors && isRefusal(doorsQ.error);

  return (
    <ShellPage icon={<DoorOpen size={15} />} label="Doors" title={COPY.title} sub={COPY.sub} rhythm>
      {notAvailable ? (
        <DoorsNotAvailable />
      ) : (
        <>
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
        </>
      )}
    </ShellPage>
  );
}
