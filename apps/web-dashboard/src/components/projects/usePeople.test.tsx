// usePeople — actor/assignee/author id resolution (WARP-947).
//
// The Projects activity feed, comment authors, and assignees all reference the
// local `User.id` UUID (WARP-485 invariant). The directory endpoint
// (/api/auth/users) keys each entry's `id` on the Nextcloud username but also
// carries the local `userId` UUID (WARP-947 backend fix). usePeople must key its
// resolution map on that UUID so `person(actorId)` returns the signed-in user's
// real display name — not the cryptic "User <first4>" stub that appeared when
// the UUID-keyed lookup missed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { usePeople } from "./usePm";

const directoryRows = [
  {
    id: "sarubinchik", // Nextcloud username
    userId: "2f95a1c0-0000-4000-8000-000000000001", // local User.id UUID
    username: "sarubinchik",
    displayName: "Sam Rubinchik",
  },
];

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string) => {
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    if (url.endsWith("/users")) return json({ users: directoryRows });
    return json({});
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePeople — resolves a UUID actor id to the real display name (WARP-947)", () => {
  it("returns the user's real name when resolving by the local User.id UUID", async () => {
    const { result } = renderHook(() => usePeople(), { wrapper });

    await waitFor(() => {
      expect(result.current.users).toHaveLength(1);
    });

    // The activity feed hands person() the actor's UUID, not the NC username.
    const person = result.current.person("2f95a1c0-0000-4000-8000-000000000001");
    expect(person.name).toBe("Sam Rubinchik");
    // Must NOT degrade to the cryptic stub the ticket reported.
    expect(person.name).not.toMatch(/^User /);
  });

  it("still falls back to the short stub for a genuinely unknown id", async () => {
    const { result } = renderHook(() => usePeople(), { wrapper });

    await waitFor(() => {
      expect(result.current.users).toHaveLength(1);
    });

    const unknown = result.current.person("deadbeef-cafe-4000-8000-000000000000");
    expect(unknown.name).toBe("User dead");
  });
});
