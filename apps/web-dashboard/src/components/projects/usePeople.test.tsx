// usePeople — who a PM user id names (WARP-3372, superseding WARP-947).
//
// The Projects activity feed, comment authors, leads, creators and assignees all
// reference the local `User.id` UUID. The names used to come from
// GET /api/auth/users, which is owner/admin-only: a member got a 403, the map
// stayed empty, and every colleague rendered as "User 1a2b". The hook now reads
// GET /api/pm/people — the PM-scoped {id, displayName, avatarUrl} projection of
// the active people on the box — which every role that can read the board may
// read. An id it does not know is "Former member"; until it has answered (or if
// it cannot) an id is a neutral label, never a fragment of the id.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { FORMER_MEMBER, usePeople } from "./usePm";

const SAM = "2f95a1c0-0000-4000-8000-000000000001";

let peopleStatus = 200;
const requested: string[] = [];

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string) => {
    requested.push(url);
    const respond = (status: number, body: unknown) =>
      Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
    // The admin-only roster: a member is refused. The hook must not depend on it.
    if (url.endsWith("/api/auth/users")) return respond(403, { error: "forbidden" });
    if (url.endsWith("/api/pm/people")) {
      return peopleStatus === 200
        ? respond(200, {
            people: [
              { id: SAM, displayName: "Sam Rubinchik", avatarUrl: null },
              { id: "u-pic", displayName: "Pia Picture", avatarUrl: "/img/pia.png" },
            ],
          })
        : respond(peopleStatus, { error: "boom" });
    }
    return respond(200, {});
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>{children}</SWRConfig>;
}

beforeEach(() => {
  peopleStatus = 200;
  requested.length = 0;
});

describe("usePeople — names for every role that can read the board (WARP-3372)", () => {
  it("resolves a known user id to the real display name, and never touches the admin-only roster", async () => {
    const { result } = renderHook(() => usePeople(), { wrapper });
    await waitFor(() => expect(result.current.people).toHaveLength(2));

    const sam = result.current.person(SAM);
    expect(sam.name).toBe("Sam Rubinchik");
    expect(sam.initials).toBe("SR");
    // Not the cryptic stub the ticket reported.
    expect(sam.name).not.toMatch(/^User /);

    expect(requested).toEqual(["/api/pm/people"]);
  });

  it("carries the avatar URL when the box has one, and none otherwise", async () => {
    const { result } = renderHook(() => usePeople(), { wrapper });
    await waitFor(() => expect(result.current.people).toBeDefined());
    expect(result.current.person("u-pic").avatarUrl).toBe("/img/pia.png");
    expect(result.current.person(SAM).avatarUrl).toBeUndefined();
  });

  it("an id the loaded list does not know is 'Former member' — never 'User dead'", async () => {
    const { result } = renderHook(() => usePeople(), { wrapper });
    await waitFor(() => expect(result.current.people).toBeDefined());

    const gone = result.current.person("deadbeef-cafe-4000-8000-000000000000");
    expect(gone.name).toBe(FORMER_MEMBER);
    expect(gone.name).toBe("Former member");
    expect(gone.initials).toBe("FM");
  });

  it("before the list has answered, an id is neutral — it is NOT 'Former member' (they may be on the list)", async () => {
    const { result } = renderHook(() => usePeople(), { wrapper });
    // First render: the request has not resolved yet.
    const pending = result.current.person(SAM);
    expect(pending.name).toBe("Team member");
    expect(pending.name).not.toBe(FORMER_MEMBER);
    expect(pending.name).not.toMatch(/^User |2f95/);

    await waitFor(() => expect(result.current.person(SAM).name).toBe("Sam Rubinchik"));
  });

  it("if the read fails, ids stay neutral rather than all turning into 'Former member'", async () => {
    peopleStatus = 500;
    const { result } = renderHook(() => usePeople(), { wrapper });
    await waitFor(() => expect(requested).toContain("/api/pm/people"));
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.person(SAM).name).toBe("Team member");
  });
});
