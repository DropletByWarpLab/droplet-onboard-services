import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate.test:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { fetchHlsPlaylist } from "../services/frigate.client.js";

afterEach(() => vi.restoreAllMocks());

describe("Frigate HLS redirect boundary", () => {
  it.each([302, 307, 308])("refuses upstream redirect %s to another host", async (status) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status,
      headers: { location: "http://outside.invalid/private.m3u8" },
    }));

    await expect(fetchHlsPlaylist("http://frigate.test:5000/vod/front/start/1/end/2/master.m3u8"))
      .rejects.toThrow(`HLS playlist: ${status}`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });
});
