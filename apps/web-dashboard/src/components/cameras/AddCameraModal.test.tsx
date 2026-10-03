/**
 * WARP-1847 — "Add camera" has to answer "which camera?" first.
 *
 * The modal used to open on an empty RTSP form, which asked the operator for an
 * address and a vendor-specific stream path the appliance had already probed.
 * Now it opens on what discovery found, keeps the manual form as the second tab,
 * and a camera we can see but can't stream arrives there prefilled.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import type { DiscoveredCamera } from "@/lib/types";

const addCameraManual = vi.fn();
const addDiscoveredCameraWithCredentials = vi.fn();
vi.mock("@/lib/api", () => ({
  addCameraManual: (...args: unknown[]) => addCameraManual(...args),
  addDiscoveredCameraWithCredentials: (...args: unknown[]) =>
    addDiscoveredCameraWithCredentials(...args),
}));

vi.mock("@/lib/friendly-errors", () => ({
  translateError: (err: unknown) => (err instanceof Error ? err.message : "Something went wrong"),
}));

import { AddCameraModal } from "./AddCameraModal";

function camera(over: Partial<DiscoveredCamera> = {}): DiscoveredCamera {
  return {
    id: "mac:E4:30:22:50:2A:FD",
    name: "XNV_C8083R",
    displayName: "XNV C8083R",
    ip: "192.168.9.219",
    mac: "E4:30:22:50:2A:FD",
    manufacturer: "Hanwha",
    model: "XNV-C8083R",
    status: "ready",
    discoveredAt: null,
    source: "live",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AddCameraModal", () => {
  it("opens on the discovered list when there is something to pick", () => {
    render(
      <AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} cameras={[camera()]} onAccept={vi.fn()} />,
    );
    expect(screen.getByText("XNV C8083R")).toBeTruthy();
    expect(screen.getByRole("button", { name: /On your network \(1\)/ })).toBeTruthy();
    // The RTSP field is behind the second tab, not the first thing asked for.
    expect(screen.queryByLabelText(/Stream address/)).toBeNull();
  });

  it("adds a ready camera through onAccept and closes", async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <AddCameraModal onClose={onClose} onAdded={vi.fn()} cameras={[camera()]} onAccept={onAccept} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
    expect(onAccept.mock.calls[0][0].id).toBe("mac:E4:30:22:50:2A:FD");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(addCameraManual).not.toHaveBeenCalled();
  });

  it("keeps the modal open and shows why when the stream does not verify", async () => {
    const onAccept = vi
      .fn()
      .mockRejectedValue(new Error("Camera stream did not verify — credentials are likely wrong."));
    const onClose = vi.fn();
    render(
      <AddCameraModal onClose={onClose} onAdded={vi.fn()} cameras={[camera()]} onAccept={onAccept} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/did not verify/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens a username/password form for a needs-sign-in camera", () => {
    render(
      <AddCameraModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        cameras={[camera({ status: "needs_credentials" })]}
        onAccept={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Set up/ }));

    expect(screen.getByLabelText(/Username/)).toBeTruthy();
    const pw = screen.getByLabelText(/Password/) as HTMLInputElement;
    expect(pw.type).toBe("password");
    // The appliance already knows the address, so it is not asked for again.
    expect(screen.queryByLabelText(/Stream address/)).toBeNull();
    expect(screen.getByText(/192\.168\.9\.219/)).toBeTruthy();
  });

  it("submits the typed credentials for the discovered camera and closes", async () => {
    addDiscoveredCameraWithCredentials.mockResolvedValue(undefined);
    const onAdded = vi.fn();
    const onClose = vi.fn();
    render(
      <AddCameraModal
        onClose={onClose}
        onAdded={onAdded}
        cameras={[camera({ status: "needs_credentials" })]}
        onAccept={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Set up/ }));

    const submit = screen.getByRole("button", { name: /Add camera/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // nothing typed yet

    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "s3cret!" } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(addDiscoveredCameraWithCredentials).toHaveBeenCalledWith(
        "mac:E4:30:22:50:2A:FD",
        "admin",
        "s3cret!",
      ),
    );
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(addCameraManual).not.toHaveBeenCalled();
  });

  it("keeps the form open and shows the reason when the camera rejects the credentials", async () => {
    addDiscoveredCameraWithCredentials.mockRejectedValue(
      new Error("The camera did not accept that username and password."),
    );
    const onClose = vi.fn();
    render(
      <AddCameraModal
        onClose={onClose}
        onAdded={vi.fn()}
        cameras={[camera({ status: "needs_credentials" })]}
        onAccept={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Set up/ }));
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /Add camera/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/did not accept/);
    expect(onClose).not.toHaveBeenCalled();
    // Still there to correct, not wiped.
    expect((screen.getByLabelText(/Username/) as HTMLInputElement).value).toBe("admin");
  });

  it("lets the operator fall back to typing the stream address", () => {
    render(
      <AddCameraModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        cameras={[camera({ status: "needs_credentials" })]}
        onAccept={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Set up/ }));
    fireEvent.click(screen.getByRole("button", { name: /Enter the stream address instead/ }));

    expect((screen.getByLabelText(/Camera name/) as HTMLInputElement).value).toBe("XNV_C8083R");
    // Prefilled with the manufacturer's known path, not the prober's /stream1 guess.
    expect((screen.getByLabelText(/Stream address/) as HTMLInputElement).value).toBe(
      "rtsp://192.168.9.219:554/profile2/media.smp",
    );
    expect((screen.getByLabelText(/Manufacturer/) as HTMLInputElement).value).toBe("Hanwha");
  });

  it("opens straight onto the credentials form when handed a live camera to set up", () => {
    render(
      <AddCameraModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        cameras={[camera({ status: "needs_credentials" })]}
        prefill={camera({ status: "needs_credentials" })}
      />,
    );
    expect(screen.getByLabelText(/Username/)).toBeTruthy();
    expect(screen.queryByLabelText(/Camera name/)).toBeNull();
  });

  it("opens the manual form prefilled for a camera discovery cannot probe (no live record)", () => {
    render(
      <AddCameraModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        cameras={[]}
        prefill={camera({ id: "db-1", source: "database", status: "unverified" })}
      />,
    );
    expect((screen.getByLabelText(/Camera name/) as HTMLInputElement).value).toBe("XNV_C8083R");
    // Tells the operator what the appliance already knows and what is missing.
    expect(screen.getByText(/couldn't open its video/)).toBeTruthy();
  });

  it("submits the manual form and reports the add", async () => {
    addCameraManual.mockResolvedValue(undefined);
    const onAdded = vi.fn();
    const onClose = vi.fn();
    render(<AddCameraModal onClose={onClose} onAdded={onAdded} />);

    fireEvent.change(screen.getByLabelText(/Camera name/), { target: { value: "front_door" } });
    fireEvent.change(screen.getByLabelText(/Stream address/), {
      target: { value: "rtsp://192.168.9.60:554/stream1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add camera/ }));

    await waitFor(() =>
      expect(addCameraManual).toHaveBeenCalledWith(
        "front_door",
        "rtsp://192.168.9.60:554/stream1",
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    );
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("offers a scan from the manual form when nothing has been found yet", () => {
    const onScan = vi.fn();
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} cameras={[]} onScan={onScan} />);

    fireEvent.click(screen.getByRole("button", { name: /Scan/ }));
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it("does not offer a scan when discovery isn't running", () => {
    render(
      <AddCameraModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        cameras={[]}
        onScan={vi.fn()}
        discoveryOnline={false}
      />,
    );
    expect(screen.getByText(/discovery isn't running/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Scan$/ })).toBeNull();
  });

  describe("manual form credentials and hint (WARP-3505)", () => {
    it("has optional Username and Password fields, password masked", () => {
      render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
      expect(screen.getByLabelText(/Username/)).toBeTruthy();
      expect((screen.getByLabelText(/Password/) as HTMLInputElement).type).toBe("password");
    });

    it("submits them separately from the address so the server can merge and encode them", async () => {
      addCameraManual.mockResolvedValue(undefined);
      render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);

      fireEvent.change(screen.getByLabelText(/Camera name/), { target: { value: "front_door" } });
      fireEvent.change(screen.getByLabelText(/Stream address/), {
        target: { value: "rtsp://192.168.9.60:554/live" },
      });
      fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "admin" } });
      fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "p@ss:w/rd" } });
      fireEvent.click(screen.getByRole("button", { name: /Add camera/ }));

      await waitFor(() =>
        expect(addCameraManual).toHaveBeenCalledWith(
          "front_door",
          "rtsp://192.168.9.60:554/live",
          undefined,
          undefined,
          "admin",
          "p@ss:w/rd",
        ),
      );
    });

    it("shows the detected manufacturer's real stream path, never user:password@ or /stream1", () => {
      render(
        <AddCameraModal
          onClose={vi.fn()}
          onAdded={vi.fn()}
          cameras={[]}
          prefill={camera({ id: "db-1", source: "database", status: "unverified" })}
        />,
      );
      const text = document.body.textContent ?? "";
      expect(text).toContain("rtsp://192.168.9.219:554/profile2/media.smp");
      expect(text).not.toMatch(/user:password@/);
      expect(text).not.toMatch(/stream1/);
      expect(
        (screen.getByLabelText(/Stream address/) as HTMLInputElement).placeholder,
      ).not.toMatch(/stream1/);
    });

    it("does not imply a stream path for an unknown manufacturer", () => {
      render(
        <AddCameraModal
          onClose={vi.fn()}
          onAdded={vi.fn()}
          cameras={[]}
          prefill={camera({
            id: "db-1",
            source: "database",
            status: "unverified",
            manufacturer: "Acme Optics",
          })}
        />,
      );
      expect(document.body.textContent ?? "").not.toMatch(/stream1|profile2/);
    });
  });
});
