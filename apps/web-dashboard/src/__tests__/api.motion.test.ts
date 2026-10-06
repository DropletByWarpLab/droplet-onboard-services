import { beforeEach, expect, it, vi } from "vitest";
import { fetchMotionActivity } from "@/lib/api";
import { authFetch } from "@/lib/auth";
vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }));
beforeEach(() => vi.mocked(authFetch).mockReset());

it("keeps the motion window fixed and passes a separate pagination cursor and hours scope", async () => {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ activity: [], nextCursor: null, coverage: { after: 100, before: 1000, partial: true, cameras: [] } })));
  await fetchMotionActivity({ after: 100, before: 1000, cursor: 600, cameras: ["office"], businessHours: "outside" });
  const params = new URL(String(vi.mocked(authFetch).mock.calls[0][0]), "http://droplet.local").searchParams;
  expect(params.get("after")).toBe("100");
  expect(params.get("before")).toBe("1000");
  expect(params.get("cursor")).toBe("600");
  expect(params.get("businessHours")).toBe("outside");
  expect(params.get("cameras")).toBe("office");
  expect(params.has("reviewed")).toBe(false);
});
