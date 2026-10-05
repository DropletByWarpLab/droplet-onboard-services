import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCameraBusinessHours, fetchEventsFiltered, fetchReviewsFiltered, saveCameraBusinessHours, searchEventsSemantic } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import type { CameraBusinessHours } from "@/lib/types";

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }));
const fetchMock = vi.mocked(authFetch);
beforeEach(() => fetchMock.mockReset());

describe("business hours API", () => {
  it("keeps camera and status scope on after-hours detection reviews", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ reviews: [], nextCursor: null })));
    await fetchReviewsFiltered({ severity: ["detection"], cameras: ["office"], reviewed: false, businessHours: "outside" });
    const params = new URL(String(fetchMock.mock.calls[0][0]), "http://droplet.local").searchParams;
    expect(params.get("severity")).toBe("detection");
    expect(params.get("cameras")).toBe("office");
    expect(params.get("reviewed")).toBe("0");
    expect(params.get("businessHours")).toBe("outside");
  });

  it.each([
    ["events", () => fetchEventsFiltered({ cameras: ["office"], businessHours: "outside" })],
    ["reviews", () => fetchReviewsFiltered({ severity: ["alert"], businessHours: "outside" })],
    ["semantic search", () => searchEventsSemantic("person", { businessHours: "outside" })],
  ] as const)("sends the outside-hours filter for %s", async (_label, call) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ events: [], reviews: [], nextCursor: null })));
    await call();
    expect(new URL(String(fetchMock.mock.calls[0][0]), "http://droplet.local").searchParams.get("businessHours")).toBe("outside");
  });

  it("uses the saved box schedule and sends a complete PUT without activating defaults", async () => {
    const schedule: CameraBusinessHours = { configured: false, timezone: "UTC", days: { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(schedule)));
    await expect(fetchCameraBusinessHours()).resolves.toEqual(schedule);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(schedule)));
    await expect(saveCameraBusinessHours(schedule)).resolves.toEqual(schedule);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/cameras/business-hours", expect.objectContaining({ method: "PUT", body: JSON.stringify(schedule) }));
  });
});
