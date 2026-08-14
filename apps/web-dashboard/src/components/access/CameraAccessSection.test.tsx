/**
 * WARP-1976 — the screen behind the per-camera access endpoints.
 *
 * WARP-1962 shipped the model, the enforcement and the endpoints. Until
 * this existed the feature was enforced and unusable: a family member saw
 * nothing (the safe default) and no owner could grant them anything from
 * the product.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { CameraAccessSection } from "./CameraAccessSection";
import type { CameraInfo } from "@/lib/types";

const CAMS = [
  { name: "front_door", displayName: "Front Door" },
  { name: "driveway", displayName: "Driveway" },
  { name: "bedroom", displayName: "Bedroom" },
] as CameraInfo[];

function setup(
  over: Partial<React.ComponentProps<typeof CameraAccessSection>> = {},
  grants: string[] = [],
) {
  const saveGrants = vi.fn(async (_u: string, cameras: string[]) => ({
    granted: cameras,
    unknown: [] as string[],
  }));
  const props = {
    userId: "u-sam",
    tier: "family" as const,
    displayName: "Sam Rubinchik",
    loadCameras: vi.fn(async () => CAMS),
    loadGrants: vi.fn(async () => grants),
    saveGrants,
    ...over,
  };
  render(<CameraAccessSection {...props} />);
  return { ...props, saveGrants };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("owners and admins are not given a misleading checklist", () => {
  it.each(["owner", "admin"] as const)("%s renders as unrestricted", async (tier) => {
    setup({ tier });
    // Their access does not come from the grant table at all — ticking
    // boxes for them would change nothing.
    expect(await screen.findByTestId("camera-access-unrestricted")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("does not even fetch grants for an unrestricted person", async () => {
    const { loadGrants } = setup({ tier: "owner" });
    await waitFor(() => expect(screen.getByTestId("camera-access-unrestricted")).toBeTruthy());
    expect(loadGrants).not.toHaveBeenCalled();
  });
});

describe("a person with no grants", () => {
  it("says so instead of showing a bare list that looks like a loading bug", async () => {
    setup({}, []);
    const empty = await screen.findByTestId("camera-access-empty");
    expect(empty.textContent).toMatch(/can't see any cameras yet/i);
    // Named, so it reads as a statement about a person rather than an error.
    expect(empty.textContent).toMatch(/^Sam/);
  });

  it("still lists every camera so there is something to tick", async () => {
    setup({}, []);
    await screen.findByTestId("camera-access-empty");
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });
});

describe("granting", () => {
  it("pre-ticks what they already have", async () => {
    setup({}, ["driveway"]);
    const driveway = (await screen.findByLabelText("Driveway")) as HTMLInputElement;
    const bedroom = screen.getByLabelText("Bedroom") as HTMLInputElement;
    expect(driveway.checked).toBe(true);
    expect(bedroom.checked).toBe(false);
  });

  it("sends the WHOLE set, not a diff", async () => {
    const { saveGrants } = setup({}, ["driveway"]);
    fireEvent.click(await screen.findByLabelText("Front Door"));
    fireEvent.click(screen.getByRole("button", { name: /save camera access/i }));

    // Set semantics match the endpoint. A client-computed delta would race
    // a second admin editing the same person.
    await waitFor(() => expect(saveGrants).toHaveBeenCalledTimes(1));
    const [, sent] = saveGrants.mock.calls[0];
    expect([...(sent as string[])].sort()).toEqual(["driveway", "front_door"]);
  });

  it("can take every camera away", async () => {
    const { saveGrants } = setup({}, ["driveway"]);
    fireEvent.click(await screen.findByLabelText("Driveway"));
    fireEvent.click(screen.getByRole("button", { name: /save camera access/i }));

    await waitFor(() => expect(saveGrants).toHaveBeenCalledWith("u-sam", []));
    expect((await screen.findByTestId("camera-access-note")).textContent).toMatch(
      /no longer see any cameras/i,
    );
  });

  it("confirms what changed in words, naming the person", async () => {
    setup({}, []);
    fireEvent.click(await screen.findByLabelText("Front Door"));
    fireEvent.click(screen.getByRole("button", { name: /save camera access/i }));
    expect((await screen.findByTestId("camera-access-note")).textContent).toMatch(
      /Sam can now see 1 camera\./i,
    );
  });
});

describe("names the server did not recognise", () => {
  it("surfaces them instead of dropping them", async () => {
    const saveGrants = vi.fn(async () => ({
      granted: ["front_door"],
      unknown: ["frontdoor"],
    }));
    setup({ saveGrants }, ["front_door"]);
    fireEvent.click(await screen.findByLabelText("Bedroom"));
    fireEvent.click(screen.getByRole("button", { name: /save camera access/i }));

    // A typo that silently grants nothing looks exactly like success.
    const warn = await screen.findByTestId("camera-access-unknown");
    expect(warn.textContent).toMatch(/frontdoor/);
  });

  it("re-syncs the ticks to what the server actually granted", async () => {
    const saveGrants = vi.fn(async () => ({ granted: ["front_door"], unknown: ["bedroom"] }));
    setup({ saveGrants }, []);
    fireEvent.click(await screen.findByLabelText("Front Door"));
    fireEvent.click(screen.getByLabelText("Bedroom"));
    fireEvent.click(screen.getByRole("button", { name: /save camera access/i }));

    await waitFor(() =>
      expect((screen.getByLabelText("Bedroom") as HTMLInputElement).checked).toBe(false),
    );
    expect((screen.getByLabelText("Front Door") as HTMLInputElement).checked).toBe(true);
  });
});

describe("degraded states are honest", () => {
  it("offers a retry when the load fails", async () => {
    setup({ loadGrants: vi.fn(async () => { throw new Error("nope"); }) });
    expect(await screen.findByTestId("camera-access-error")).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("says nothing changed when the save fails", async () => {
    const saveGrants = vi.fn(async () => { throw new Error("nope"); });
    setup({ saveGrants }, []);
    fireEvent.click(await screen.findByLabelText("Front Door"));
    fireEvent.click(screen.getByRole("button", { name: /save camera access/i }));
    expect((await screen.findByTestId("camera-access-note")).textContent).toMatch(
      /nothing changed/i,
    );
  });

  it("explains a person who has never signed in", async () => {
    setup({ userId: null });
    expect(await screen.findByText(/hasn't signed in yet/i)).toBeTruthy();
  });
});

describe("mobile", () => {
  it("gives every row a 44px target", async () => {
    setup({}, []);
    const label = (await screen.findByLabelText("Front Door")).closest("label")!;
    // A checkbox row is the easiest thing in a settings screen to
    // under-size, and this list is used on a phone.
    expect(label.style.minHeight).toBe("44px");
  });
});
