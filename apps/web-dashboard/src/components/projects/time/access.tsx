"use client";

// Who is asking, for the time surface (WARP-3526): may they write, which entries
// are theirs, may they manage everyone's.
//
// A context rather than a prop, so the work-item drawer gains its Time section
// with one line and no change to the signature of `DetailDrawer` or
// `DetailBody`, which other slices are editing at the same moment. The
// Projects page provides it once, from the session it already holds.
//
// The DEFAULT is read-only: a time surface rendered without a provider shows
// the entries and offers no way to change them, never the other way round. The
// orchestrator enforces the same rules (a member edits their own entries, an
// owner or admin anyone's, a guest nothing), so this only decides which controls
// are drawn — the design brief hides writes from read-only roles rather than
// disabling them.

import { createContext, useContext, useMemo, type JSX, type ReactNode } from "react";
import { canWrite } from "../types";

export interface TimeAccess {
  canWrite: boolean;
  /** The signed-in person's id (`User.id`), whose entries are theirs. */
  userId: string | undefined;
  /** Owner or admin: may edit and delete anybody's entries. */
  canManageAll: boolean;
}

const READ_ONLY: TimeAccess = { canWrite: false, userId: undefined, canManageAll: false };

const TimeAccessContext = createContext<TimeAccess>(READ_ONLY);

export const useTimeAccess = (): TimeAccess => useContext(TimeAccessContext);

export function TimeAccessProvider({
  user,
  children,
}: {
  user: { id: string; role?: string } | null | undefined;
  children: ReactNode;
}): JSX.Element {
  const id = user?.id;
  const role = user?.role;
  const value = useMemo<TimeAccess>(
    () =>
      id === undefined
        ? READ_ONLY
        : { canWrite: canWrite(role), userId: id, canManageAll: role === "owner" || role === "admin" },
    [id, role],
  );
  return <TimeAccessContext.Provider value={value}>{children}</TimeAccessContext.Provider>;
}
