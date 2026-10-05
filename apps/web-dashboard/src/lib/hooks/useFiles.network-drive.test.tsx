import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { fetchFiles } from "@/lib/api";
import type { FileEntryInfo, FileSpaceId } from "@/lib/types";
import { useFiles } from "./useFiles";

vi.mock("@/lib/api", () => ({ fetchFiles: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

const PDF: FileEntryInfo = {
  name: "Data flow.pdf",
  path: "/Droplet/Data flow.pdf",
  isDirectory: false,
  size: 512,
  mimeType: "application/pdf",
  modifiedAt: "2026-10-05T12:00:00Z",
};

let visibility: DocumentVisibilityState;
let visibilityDescriptor: PropertyDescriptor | undefined;

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  visibility = "visible";
  visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  vi.mocked(fetchFiles).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (visibilityDescriptor) {
    Object.defineProperty(document, "visibilityState", visibilityDescriptor);
  } else {
    delete (document as { visibilityState?: unknown }).visibilityState;
  }
});

describe("useFiles — desktop writes into the shared Droplet folder", () => {
  it.each(["/Droplet", "/Droplet/Projects", "/Computers", "/Computers/desktop/Documents"])(
    "updates %s without a dashboard write or MQTT event after the listing cache expires",
    async (path) => {
      vi.mocked(fetchFiles).mockResolvedValueOnce([]).mockResolvedValue([PDF]);
      const { result } = renderHook(() => useFiles(path), { wrapper });
      await advance(1);
      expect(result.current.files).toEqual([]);
      expect(fetchFiles).toHaveBeenCalledTimes(1);

      // The server retains listings for 10s. Avoid useless polls within that TTL.
      await advance(10_000);
      expect(fetchFiles).toHaveBeenCalledTimes(1);
      await advance(5_000);
      expect(fetchFiles).toHaveBeenCalledTimes(2);
      expect(result.current.files).toEqual([PDF]);
      expect(fetchFiles).toHaveBeenLastCalledWith(path, "personal");
    },
  );

  it("discovers a shared folder registered after My Files was opened", async () => {
    const folder: FileEntryInfo = {
      ...PDF, name: "Droplet", path: "/Droplet", isDirectory: true,
      size: 0, mimeType: null,
    };
    vi.mocked(fetchFiles).mockResolvedValueOnce([]).mockResolvedValue([folder]);
    const { result } = renderHook(() => useFiles("/"), { wrapper });
    await advance(1);
    expect(result.current.files).toEqual([]);
    await advance(15_000);
    expect(result.current.files).toEqual([folder]);
  });

  it("pauses requests in a hidden tab and resumes when it is visible", async () => {
    const { result } = renderHook(() => useFiles("/Droplet"), { wrapper });
    await advance(1);
    expect(fetchFiles).toHaveBeenCalledTimes(1);
    visibility = "hidden";
    vi.mocked(fetchFiles).mockResolvedValue([PDF]);
    await advance(45_000);
    expect(fetchFiles).toHaveBeenCalledTimes(1);
    expect(result.current.files).toEqual([]);

    visibility = "visible";
    await advance(15_000);
    expect(fetchFiles).toHaveBeenCalledTimes(2);
    expect(result.current.files).toEqual([PDF]);
  });

  it.each<[string, FileSpaceId]>([
    ["/Documents", "personal"],
    ["/Droplet archive", "personal"],
    ["/Computers archive", "personal"],
    ["/", "shared"],
    ["/Droplet", "shared"],
    ["/Droplet", "dept:marketing"],
  ])("does not poll unrelated folder %s in %s", async (path, space) => {
    renderHook(() => useFiles(path, space), { wrapper });
    await advance(1);
    expect(fetchFiles).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(fetchFiles).toHaveBeenCalledTimes(1);
  });

  it("stops polling when navigation leaves the network folder", async () => {
    const { rerender } = renderHook(({ path }) => useFiles(path), {
      wrapper, initialProps: { path: "/Droplet" },
    });
    await advance(15_001);
    expect(fetchFiles).toHaveBeenCalledTimes(2);
    rerender({ path: "/Documents" });
    await advance(20);
    expect(fetchFiles).toHaveBeenCalledTimes(3);
    await advance(60_000);
    expect(fetchFiles).toHaveBeenCalledTimes(3);
  });
});
