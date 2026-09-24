/**
 * WARP-2976 (ADR-059 §2.3) — who gets which department choices, and what is
 * active; WARP-2981 (P6 §6.1, DS-003) — the choice kept on the box.
 *
 *   · owner/admin: Whole business + every department; a stale slug falls back
 *     to Whole business.
 *   · everyone else: their member departments only; Whole business stays the
 *     default until they choose.
 *   · only DEPARTMENT rows that are not archived or archiving are choices —
 *     exactly the set the box checks (one fixture file, read by both suites).
 *   · visiting /d/<slug> makes that department active and remembers it.
 *   · the remembered choice is per user and forgotten on sign-out.
 *   · the box's answer wins once it arrives, but never over a local pick made
 *     after the read began or still on its way; a pick is PUT; a box without
 *     the route means P1's local-only behaviour.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import type { ReactNode } from "react";

import type { ActiveDepartmentResponse, Department } from "@/lib/types";
import { readRepoFile } from "../../__tests__/helpers/test-paths";

const listDepartmentsMock = vi.fn();
const getDepartmentProfileMock = vi.fn();
const getActiveDepartmentMock = vi.fn();
const putActiveDepartmentMock = vi.fn();
vi.mock("@/lib/api", () => ({
  listDepartments: (...a: unknown[]) => listDepartmentsMock(...a),
  getDepartmentProfile: (...a: unknown[]) => getDepartmentProfileMock(...a),
  getActiveDepartment: (...a: unknown[]) => getActiveDepartmentMock(...a),
  putActiveDepartment: (...a: unknown[]) => putActiveDepartmentMock(...a),
}));

const authRef: { current: { role: string; id?: string } | null } = { current: { role: "owner" } };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: authRef.current ? { id: "u1", username: "ada", ...authRef.current } : null }),
}));
// The signed-in user in these tests is "u1" unless a test overrides `id`.
const U1_KEY = "droplet-active-department:u1";
const U1_SYNCED = "droplet-active-department-synced:u1";

const pathRef = { current: "/" };
vi.mock("next/navigation", () => ({
  usePathname: () => pathRef.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import {
  ACTIVE_DEPARTMENT_KEY,
  ActiveDepartmentProvider,
  activeDepartmentStorageKey,
  activeDepartmentSyncedKey,
  departmentChoices,
  isMissingRoute,
  resolveActive,
  shouldAdoptServerChoice,
  switcherChoiceCount,
  useActiveDepartment,
} from "./active-department";

function dept(over: Partial<Department>): Department {
  return {
    id: over.slug ?? "d",
    name: "Dept",
    slug: "dept",
    kind: "DEPARTMENT",
    parentId: null,
    description: null,
    state: "active",
    provisionError: null,
    quotaBytes: null,
    aclVersion: 1,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    archivedAt: null,
    memberCount: 2,
    teamCount: 0,
    myRight: null,
    usedBytes: null,
    profile: null,
    ...over,
  };
}

const security = dept({ id: "sec", name: "Security", slug: "security" });
const sales = dept({ id: "sal", name: "Sales", slug: "sales" });

/** What the box answers for a department. */
const onBox = (d: Department): ActiveDepartmentResponse => ({
  department: { id: d.id, slug: d.slug, name: d.name, profile: null },
});
const WHOLE: ActiveDepartmentResponse = { department: null };

/** A typed error as `securityFetch` throws it. */
function httpError(status: number, code?: string): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, code });
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("departmentChoices", () => {
  it("keeps only live DEPARTMENT rows, sorted by name", () => {
    const rows = [
      sales,
      dept({ id: "h", name: "Household", slug: "household", kind: "HOUSEHOLD" }),
      dept({ id: "t", name: "Night shift", slug: "night", kind: "TEAM", parentId: "sec" }),
      dept({ id: "a", name: "Archive", slug: "archive", state: "archived" }),
      dept({ id: "b", name: "Leaving", slug: "leaving", state: "archiving" }),
      security,
    ];
    expect(departmentChoices(rows).map((d) => d.slug)).toEqual(["sales", "security"]);
    expect(departmentChoices(undefined)).toEqual([]);
  });
});

// WARP-2981 — the switcher offers exactly what the box accepts. The fixture is
// the orchestrator's own file (`isChoosableDepartment` runs the same rows in
// department-choice.test.ts), read here in place, so neither side can change
// the set without the other's suite going red.
describe("departmentChoices over GET /api/departments' scoping — the box's shared fixtures", () => {
  interface Fx {
    departments: Array<{ id: string; slug: string; name: string; kind: Department["kind"]; state: Department["state"] }>;
    viewers: Array<{ label: string; role: string; memberOf: string[]; choosable: string[] }>;
  }
  const FX = JSON.parse(
    readRepoFile("apps/orchestrator/src/services/department-choice.fixtures.json"),
  ) as Fx;

  /** GET /api/departments (routes/departments.ts): owner/admin see every row;
   *  everyone else the rows they are a member of, archived hidden. */
  function listFor(viewer: Fx["viewers"][number]): Department[] {
    const seesAll = viewer.role === "owner" || viewer.role === "admin";
    return FX.departments
      .filter((d) => seesAll || (viewer.memberOf.includes(d.slug) && d.state !== "archived"))
      .map((d) => dept({ id: d.id, slug: d.slug, name: d.name, kind: d.kind, state: d.state }));
  }

  it.each(FX.viewers.map((v) => [v.label, v] as const))("%s", (_label, viewer) => {
    expect(departmentChoices(listFor(viewer)).map((d) => d.slug)).toEqual(viewer.choosable);
  });
});

describe("resolveActive", () => {
  const choices = [sales, security];

  it("honours a stored slug the viewer can still see", () => {
    expect(resolveActive(choices, "security")).toBe(security);
  });

  it("a stale or absent slug is Whole business — for every role, never a first department", () => {
    expect(resolveActive(choices, "gone")).toBeNull();
    expect(resolveActive(choices, null)).toBeNull();
  });

  it("with no departments at all it is Whole business — today's nav", () => {
    expect(resolveActive([], "security")).toBeNull();
  });
});

describe("switcherChoiceCount", () => {
  it("always counts Whole business", () => {
    expect(switcherChoiceCount([security])).toBe(2);
    expect(switcherChoiceCount([])).toBe(1);
  });
});

describe("isMissingRoute", () => {
  it("a 404 that is not the route's own refusal means an older box", () => {
    expect(isMissingRoute(httpError(404))).toBe(true);
    expect(isMissingRoute(httpError(404, "UNKNOWN"))).toBe(true);
  });

  it("the route's refusal, other statuses and non-errors are not", () => {
    expect(isMissingRoute(httpError(404, "DEPARTMENT_NOT_AVAILABLE"))).toBe(false);
    expect(isMissingRoute(httpError(500))).toBe(false);
    expect(isMissingRoute(httpError(0, "NETWORK_ERROR"))).toBe(false);
    expect(isMissingRoute(null)).toBe(false);
  });
});

describe("shouldAdoptServerChoice", () => {
  const base = { pickedSince: false, synced: true, serverSlug: "security", localSlug: "sales" };

  it("the box wins once it answers", () => {
    expect(shouldAdoptServerChoice(base)).toBe(true);
    expect(shouldAdoptServerChoice({ ...base, serverSlug: null })).toBe(true);
  });

  it("never over a local pick made after the read began (or still on its way)", () => {
    expect(shouldAdoptServerChoice({ ...base, pickedSince: true })).toBe(false);
    expect(shouldAdoptServerChoice({ ...base, pickedSince: true, synced: false, serverSlug: null, localSlug: null })).toBe(false);
  });

  it("an unsynced browser keeps a P1 department against the box's Whole business — and only that", () => {
    expect(shouldAdoptServerChoice({ ...base, synced: false, serverSlug: null })).toBe(false);
    expect(shouldAdoptServerChoice({ ...base, synced: false, serverSlug: null, localSlug: null })).toBe(true);
    expect(shouldAdoptServerChoice({ ...base, synced: false })).toBe(true);
  });
});

function Probe() {
  const v = useActiveDepartment();
  const { mutate } = useSWRConfig();
  return (
    <div>
      <span data-testid="active">{v.active?.slug ?? "whole"}</span>
      <span data-testid="switcher">{String(v.showSwitcher)}</span>
      <span data-testid="count">{v.choices.length}</span>
      <button type="button" onClick={() => v.setActive(null)}>
        whole
      </button>
      <button type="button" onClick={() => v.setActive("sales")}>
        pick sales
      </button>
      <button type="button" onClick={() => v.setActive("security")}>
        pick security
      </button>
      <button type="button" onClick={() => void mutate([ACTIVE_DEPARTMENT_KEY, "u1"])}>
        reread
      </button>
    </div>
  );
}

const tree = (ui: ReactNode) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, focusThrottleInterval: 0 }}>
    <ActiveDepartmentProvider>{ui}</ActiveDepartmentProvider>
  </SWRConfig>
);
const wrap = (ui: ReactNode) => render(tree(ui));
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

describe("<ActiveDepartmentProvider>", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.clear();
    listDepartmentsMock.mockReset();
    getDepartmentProfileMock.mockReset();
    getActiveDepartmentMock.mockReset();
    putActiveDepartmentMock.mockReset();
    getDepartmentProfileMock.mockResolvedValue({ profile: null, inheritedFrom: null, canEdit: false });
    // The box has never been told anything: Whole business.
    getActiveDepartmentMock.mockResolvedValue(WHOLE);
    putActiveDepartmentMock.mockImplementation(async (id: string | null) =>
      id === null ? WHOLE : onBox([security, sales].find((d) => d.id === id)!),
    );
    authRef.current = { role: "owner" };
    pathRef.current = "/";
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("outside a provider: Whole business, no switcher", () => {
    render(<Probe />);
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
    expect(screen.getByTestId("switcher")).toHaveTextContent("false");
  });

  it("an owner with one department gets a switcher (Whole business + it)", async () => {
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(screen.getByTestId("switcher")).toHaveTextContent("true");
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("a member of one department gets the switcher but stays on Whole business until they choose", async () => {
    authRef.current = { role: "family" };
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(screen.getByTestId("switcher")).toHaveTextContent("true");
    // An owner setting up Security must not narrow this person's nav by itself.
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("a person in no department gets no switcher and today's nav", async () => {
    authRef.current = { role: "family" };
    listDepartmentsMock.mockResolvedValue({ departments: [] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
    expect(screen.getByTestId("switcher")).toHaveTextContent("false");
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("visiting /d/<slug> makes it active and remembers it", async () => {
    pathRef.current = "/d/security";
    listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));
    expect(localStorage.getItem(U1_KEY)).toBe("security");
  });

  it("picking Whole business while still on /d/<slug> sticks (the URL is not re-applied)", async () => {
    pathRef.current = "/d/security";
    listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));
    // The switcher sets the choice, then navigates; until the router moves,
    // the pathname still reads /d/security.
    await click("whole");
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
    expect(localStorage.getItem(U1_KEY)).toBeNull();
  });

  it("a remembered slug the viewer can no longer see falls back to Whole business", async () => {
    localStorage.setItem(U1_KEY, "gone");
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("does not persist a /d/<slug> the viewer cannot choose", async () => {
    pathRef.current = "/d/someone-elses";
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(localStorage.getItem(U1_KEY)).toBeNull();
    expect(putActiveDepartmentMock).not.toHaveBeenCalled();
  });

  it("keys the choice per user", () => {
    expect(activeDepartmentStorageKey("u1")).toBe(U1_KEY);
    expect(activeDepartmentSyncedKey("u1")).toBe(U1_SYNCED);
  });

  it("another user with the same slug stored lands on Whole business (shared browser)", async () => {
    // The owner (u1) picked Security on this browser; a family member (u2),
    // also in Security, signs in next.
    localStorage.setItem(U1_KEY, "security");
    authRef.current = { role: "family", id: "u2" };
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
  });

  it("the owner's own stored choice is still honoured", async () => {
    localStorage.setItem(U1_KEY, "security");
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));
  });

  it("switching accounts without a reload does not carry the choice over", async () => {
    localStorage.setItem(U1_KEY, "security");
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    const { rerender } = wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));

    authRef.current = { role: "family", id: "u2" };
    rerender(tree(<Probe />));
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("whole"));
    // u1's choice is untouched by u2 signing in.
    expect(localStorage.getItem(U1_KEY)).toBe("security");
  });

  it("signing out clears the signed-out user's choice (and this browser's sync mark), not the box's", async () => {
    localStorage.setItem(U1_KEY, "security");
    localStorage.setItem(U1_SYNCED, "1");
    getActiveDepartmentMock.mockResolvedValue(onBox(security));
    listDepartmentsMock.mockResolvedValue({ departments: [security] });
    const { rerender } = wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));

    authRef.current = null;
    rerender(tree(<Probe />));
    await waitFor(() => expect(localStorage.getItem(U1_KEY)).toBeNull());
    expect(localStorage.getItem(U1_SYNCED)).toBeNull();
    expect(screen.getByTestId("active")).toHaveTextContent("whole");
    // Nothing is written to the box on sign-out.
    expect(putActiveDepartmentMock).not.toHaveBeenCalled();
  });

  it("storage that throws means Whole business, not a crash", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      listDepartmentsMock.mockResolvedValue({ departments: [security] });
      wrap(<Probe />);
      await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
      expect(screen.getByTestId("active")).toHaveTextContent("whole");
    } finally {
      spy.mockRestore();
    }
  });

  // ── WARP-2981: the choice on the box ─────────────────────────────────────

  describe("the box's answer", () => {
    it("replaces this browser's copy — state AND localStorage (a switch made on another device)", async () => {
      localStorage.setItem(U1_KEY, "sales");
      localStorage.setItem(U1_SYNCED, "1");
      getActiveDepartmentMock.mockResolvedValue(onBox(security));
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));
      expect(localStorage.getItem(U1_KEY)).toBe("security");
      expect(localStorage.getItem(U1_SYNCED)).toBe("1");
      // Adopting is not a pick: nothing is echoed back.
      expect(putActiveDepartmentMock).not.toHaveBeenCalled();
    });

    it("Whole business on the box replaces a department here once this browser has synced", async () => {
      localStorage.setItem(U1_KEY, "security");
      localStorage.setItem(U1_SYNCED, "1");
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(localStorage.getItem(U1_KEY)).toBeNull());
      expect(screen.getByTestId("active")).toHaveTextContent("whole");
    });

    it("a P1 choice the box was never told about survives its Whole business, until the first pick here writes the row (§5)", async () => {
      localStorage.setItem(U1_KEY, "security");
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(getActiveDepartmentMock).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));
      expect(localStorage.getItem(U1_KEY)).toBe("security");
      expect(localStorage.getItem(U1_SYNCED)).toBeNull();

      await click("pick sales");
      await waitFor(() => expect(putActiveDepartmentMock).toHaveBeenCalledWith("sal"));
      await waitFor(() => expect(localStorage.getItem(U1_SYNCED)).toBe("1"));
    });

    it("is re-read on focus, so a switch on the phone reaches an open tab", async () => {
      localStorage.setItem(U1_SYNCED, "1");
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(getActiveDepartmentMock).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("active")).toHaveTextContent("whole");

      getActiveDepartmentMock.mockResolvedValue(onBox(sales));
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("sales"));
      expect(getActiveDepartmentMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("an answer to a read that began BEFORE a local pick does not overwrite it", async () => {
      localStorage.setItem(U1_SYNCED, "1");
      const read = deferred<ActiveDepartmentResponse>();
      getActiveDepartmentMock.mockReturnValue(read.promise);
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
      expect(getActiveDepartmentMock).toHaveBeenCalledTimes(1);

      await click("pick sales");
      await act(async () => {
        read.resolve(onBox(security));
      });
      expect(screen.getByTestId("active")).toHaveTextContent("sales");
      expect(localStorage.getItem(U1_KEY)).toBe("sales");
    });

    it("an answer to a read that began while a pick's PUT was still on its way does not overwrite it", async () => {
      localStorage.setItem(U1_SYNCED, "1");
      getActiveDepartmentMock.mockResolvedValue(WHOLE);
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(getActiveDepartmentMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));

      const write = deferred<ActiveDepartmentResponse>();
      putActiveDepartmentMock.mockReturnValue(write.promise);
      await click("pick sales");
      // A re-read starts now — after the pick, but before its PUT landed — and
      // the box still holds the old answer.
      await click("reread");
      await waitFor(() => expect(getActiveDepartmentMock).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("active")).toHaveTextContent("sales");

      await act(async () => {
        write.resolve(onBox(sales));
      });
      expect(screen.getByTestId("active")).toHaveTextContent("sales");
      expect(localStorage.getItem(U1_KEY)).toBe("sales");
    });

    it("another person's answer never lands on the person now signed in", async () => {
      const u1Read = deferred<ActiveDepartmentResponse>();
      getActiveDepartmentMock.mockReturnValueOnce(u1Read.promise).mockResolvedValue(WHOLE);
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      const { rerender } = wrap(<Probe />);
      await waitFor(() => expect(getActiveDepartmentMock).toHaveBeenCalledTimes(1));

      authRef.current = { role: "family", id: "u2" };
      rerender(tree(<Probe />));
      await act(async () => {
        u1Read.resolve(onBox(security));
      });
      await waitFor(() => expect(getActiveDepartmentMock).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("active")).toHaveTextContent("whole");
      expect(localStorage.getItem(activeDepartmentStorageKey("u2"))).toBeNull();
    });
  });

  describe("a pick is told to the box", () => {
    it("setActive PUTs the department's id, and null for Whole business", async () => {
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));

      await click("pick security");
      expect(screen.getByTestId("active")).toHaveTextContent("security");
      await waitFor(() => expect(putActiveDepartmentMock).toHaveBeenLastCalledWith("sec"));

      await click("whole");
      expect(screen.getByTestId("active")).toHaveTextContent("whole");
      await waitFor(() => expect(putActiveDepartmentMock).toHaveBeenLastCalledWith(null));
      expect(putActiveDepartmentMock).toHaveBeenCalledTimes(2);
    });

    it("arriving at /d/<slug> PUTs it", async () => {
      pathRef.current = "/d/sales";
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("sales"));
      await waitFor(() => expect(putActiveDepartmentMock).toHaveBeenCalledWith("sal"));
      expect(putActiveDepartmentMock).toHaveBeenCalledTimes(1);
    });

    it("a failed PUT keeps the local pick, and says so only in the console", async () => {
      localStorage.setItem(U1_SYNCED, "1");
      putActiveDepartmentMock.mockRejectedValue(httpError(500, "INTERNAL_ERROR"));
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(getActiveDepartmentMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));

      await click("pick sales");
      await waitFor(() => expect(warn).toHaveBeenCalled());
      expect(screen.getByTestId("active")).toHaveTextContent("sales");
      expect(localStorage.getItem(U1_KEY)).toBe("sales");
    });

    it("a PUT the box refuses (DEPARTMENT_NOT_AVAILABLE) keeps the local pick and the sync on", async () => {
      putActiveDepartmentMock.mockRejectedValue(httpError(404, "DEPARTMENT_NOT_AVAILABLE"));
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));

      await click("pick sales");
      await waitFor(() => expect(warn).toHaveBeenCalled());
      expect(screen.getByTestId("active")).toHaveTextContent("sales");
      await click("pick security");
      await waitFor(() => expect(putActiveDepartmentMock).toHaveBeenCalledTimes(2));
    });
  });

  describe("an orchestrator without the route (P1's behaviour)", () => {
    it("a 404 on the read turns the sync off: picks stay local, nothing is PUT, nothing re-read", async () => {
      getActiveDepartmentMock.mockRejectedValue(httpError(404));
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(getActiveDepartmentMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));

      await click("pick sales");
      expect(screen.getByTestId("active")).toHaveTextContent("sales");
      expect(localStorage.getItem(U1_KEY)).toBe("sales");
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await click("reread");
      expect(putActiveDepartmentMock).not.toHaveBeenCalled();
      expect(getActiveDepartmentMock).toHaveBeenCalledTimes(1);
    });

    it("a 404 route on the first PUT turns it off too", async () => {
      putActiveDepartmentMock.mockRejectedValue(httpError(404));
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));

      await click("pick sales");
      await waitFor(() => expect(putActiveDepartmentMock).toHaveBeenCalledTimes(1));
      await click("pick security");
      expect(screen.getByTestId("active")).toHaveTextContent("security");
      expect(putActiveDepartmentMock).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it("a read that fails otherwise (5xx, network) leaves this browser's choice as it is", async () => {
      localStorage.setItem(U1_KEY, "security");
      localStorage.setItem(U1_SYNCED, "1");
      getActiveDepartmentMock.mockRejectedValue(httpError(503, "UNKNOWN"));
      listDepartmentsMock.mockResolvedValue({ departments: [security, sales] });
      wrap(<Probe />);
      await waitFor(() => expect(getActiveDepartmentMock).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("security"));
      await click("pick sales");
      await waitFor(() => expect(putActiveDepartmentMock).toHaveBeenCalledWith("sal"));
    });
  });
});
