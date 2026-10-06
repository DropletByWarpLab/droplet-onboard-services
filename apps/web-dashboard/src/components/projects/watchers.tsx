"use client";

// Who hears about this work item (WARP-3519): the Watch toggle and the
// watchers' faces, in the drawer header.

import { useRef, useState, type JSX } from "react";
import { Eye } from "lucide-react";
import { useToast } from "@/components/Toast";
import { AvatarStack, usePerson } from "./bits";
import { pmActions, useWatchers } from "./usePm";
import { canWrite } from "./types";

const ASSIGNEE_REASON = "You're assigned to this item, so you always get updates.";

/** Watch / Watching, and who else is watching.
 *
 *  Subscribing is automatic — creating the item, being assigned to it,
 *  commenting on it, being mentioned in it — so this is mostly how somebody who
 *  did none of those opts in, and how a commenter who has had enough opts out.
 *  An assignee cannot opt out: they are always told about their own work (the
 *  server keeps them on the list), so for them the control is shown, pressed and
 *  disabled, with the reason, instead of being a switch that quietly does
 *  nothing. A read-only role sees the faces and no control. */
export function WatchControl({
  itemId,
  viewerId,
  role,
  assignees,
}: {
  itemId: string;
  viewerId: string | undefined;
  role: string | undefined;
  assignees: readonly string[];
}): JSX.Element | null {
  const person = usePerson();
  const { toast } = useToast();
  const { watchers, mutate } = useWatchers(itemId);
  // What the viewer just chose, until the server has answered and the list has
  // been re-read; null = show what the server says.
  const [pending, setPending] = useState<boolean | null>(null);
  const busy = useRef(false);

  const isAssignee = viewerId !== undefined && assignees.includes(viewerId);
  const serverWatching = viewerId !== undefined && (watchers ?? []).some((w) => w.userId === viewerId);
  const watching = isAssignee || (pending ?? serverWatching);
  const ids = (watchers ?? []).map((w) => w.userId);

  const toggle = async () => {
    if (viewerId === undefined || busy.current || isAssignee) return;
    busy.current = true;
    setPending(!watching);
    let saved = false;
    try {
      if (watching) await pmActions().unwatch(itemId);
      else await pmActions().watch(itemId);
      saved = true;
    } catch {
      toast("Couldn't update watching — try again.", "error");
    }
    try {
      if (saved) await mutate();
    } finally {
      setPending(null);
      busy.current = false;
    }
  };

  const showToggle = canWrite(role) && viewerId !== undefined;
  if (!showToggle && ids.length === 0) return null;

  return (
    <span className="pm-watch">
      {showToggle && (
        <button
          type="button"
          className="pm-btn sm pm-watch-btn"
          aria-pressed={watching}
          disabled={isAssignee}
          title={isAssignee ? ASSIGNEE_REASON : undefined}
          onClick={() => void toggle()}
        >
          <Eye size={13} strokeWidth={1.6} aria-hidden />
          {watching ? "Watching" : "Watch"}
        </button>
      )}
      {ids.length > 0 && (
        <span role="group" aria-label={`Watchers: ${ids.map((id) => person(id).name).join(", ")}`}>
          <AvatarStack ids={ids} size={22} />
        </span>
      )}
    </span>
  );
}
