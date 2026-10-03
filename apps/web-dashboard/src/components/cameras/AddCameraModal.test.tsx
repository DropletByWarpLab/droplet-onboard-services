/**
 * WARP-1847 — "Add camera" has to answer "which camera?" first.
 *
 * The modal used to open on an empty RTSP form, which asked the operator for an
 * address and a vendor-specific stream path the appliance had already probed.
 * Now it opens on what discovery found, keeps the manual form as the second tab,
 * and a camera we can see but can't stream arrives there prefilled.
 *
 * WARP-3505 — typing a camera's own username/password, and the design-review
 * findings on that form (F1-F18): readable error ink, real dialog semantics and
 * focus, credentials that never leak between cameras, one submit that never
 * speaks for another view, a probe that says it is probing, a lockout that
 * cannot be hammered, and a camera NAME that is normalised as it is typed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import React from "react";
import type { DiscoveredCamera } from "@/lib/types";
import { packagePath } from "../../__tests__/helpers/test-paths";

const addCameraManual = vi.fn();
const addDiscoveredCameraWithCredentials = vi.fn();
vi.mock("@/lib/api", () => ({
  addCameraManual: (...args: unknown[]) => addCameraManual(...args),
  addDiscoveredCameraWithCredentials: (...args: unknown[]) =>
    addDiscoveredCameraWithCredentials(...args),
}));

// The modal-level tests read the message the API threw; the wire code -> copy
// chain (the REAL translateError) is pinned in
// lib/friendly-errors.camera-credentials.test.ts.
vi.mock("@/lib/friendly-errors", () => ({
  translateError: (err: unknown) => (err instanceof Error ? err.message : "Something went wrong"),
}));

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast, dismissAll: vi.fn() }),
}));

import { AddCameraModal } from "./AddCameraModal";

function camera(over: Partial<DiscoveredCamera> = {}): DiscoveredCamera {
  return {
    id: "mac:E4:30:22:50:2A:FD",
    name: "xnv_c8083r",
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

/** A second camera that also needs a sign-in, for the "next camera" tests. */
function lobby(over: Partial<DiscoveredCamera> = {}): DiscoveredCamera {
  return camera({
    id: "mac:AA:BB:CC:DD:EE:01",
    name: "lobby",
    displayName: "Lobby",
    ip: "192.168.9.50",
    mac: "AA:BB:CC:DD:EE:01",
    manufacturer: "Acme Optics",
    model: null,
    status: "needs_credentials",
    ...over,
  });
}

const needsSignIn = (over: Partial<DiscoveredCamera> = {}) => camera({ status: "needs_credentials", ...over });

/** An error as the api client throws it: the server's sentence plus a machine code. */
const coded = (code: string, message = "Server prose.") => Object.assign(new Error(message), { code });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const USERNAME = /^Username/;
const PASSWORD = /^Password/;
const typeCreds = (user: string, pw: string) => {
  fireEvent.change(screen.getByLabelText(USERNAME), { target: { value: user } });
  fireEvent.change(screen.getByLabelText(PASSWORD), { target: { value: pw } });
};
const rowFor = (label: string) => screen.getByText(label).closest("li") as HTMLElement;
const clickSetUp = (label: string) =>
  fireEvent.click(within(rowFor(label)).getByRole("button", { name: /Set up/ }));

/** The credentials form, opened the way a prefilled hand-off opens it. */
function renderCredentials(over: Partial<React.ComponentProps<typeof AddCameraModal>> = {}) {
  const props = {
    onClose: vi.fn(),
    onAdded: vi.fn(),
    cameras: [needsSignIn(), lobby()],
    prefill: needsSignIn(),
    ...over,
  };
  const utils = render(<AddCameraModal {...props} />);
  return { ...utils, props };
}

const submitCredentials = () => fireEvent.click(screen.getByRole("button", { name: /Add camera/ }));

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
        cameras={[needsSignIn()]}
        onAccept={vi.fn()}
      />,
    );

    clickSetUp("XNV C8083R");

    expect(screen.getByLabelText(USERNAME)).toBeTruthy();
    const pw = screen.getByLabelText(PASSWORD) as HTMLInputElement;
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
        cameras={[needsSignIn()]}
        onAccept={vi.fn()}
      />,
    );
    clickSetUp("XNV C8083R");

    const submit = screen.getByRole("button", { name: /Add camera/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // nothing typed yet

    typeCreds("admin", "s3cret!");
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
      coded("AUTH_FAILED", "The camera did not accept that username and password."),
    );
    const onClose = vi.fn();
    render(
      <AddCameraModal
        onClose={onClose}
        onAdded={vi.fn()}
        cameras={[needsSignIn()]}
        onAccept={vi.fn()}
      />,
    );
    clickSetUp("XNV C8083R");
    typeCreds("admin", "wrong");
    submitCredentials();

    expect(await screen.findByRole("alert")).toHaveTextContent(/did not accept/);
    expect(onClose).not.toHaveBeenCalled();
    // Still there to correct, not wiped.
    expect(screen.getByLabelText(USERNAME)).toHaveValue("admin");
  });

  it("lets the operator fall back to typing the stream address", () => {
    render(
      <AddCameraModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        cameras={[needsSignIn()]}
        onAccept={vi.fn()}
      />,
    );
    clickSetUp("XNV C8083R");
    fireEvent.click(screen.getByRole("button", { name: /Enter the stream address instead/ }));

    expect(screen.getByLabelText(/Camera name/)).toHaveValue("xnv_c8083r");
    // Prefilled with the manufacturer's known path, not the prober's /stream1 guess.
    expect(screen.getByLabelText(/Stream address/)).toHaveValue(
      "rtsp://192.168.9.219:554/profile2/media.smp",
    );
    expect(screen.getByLabelText(/Manufacturer/)).toHaveValue("Hanwha");
  });

  it("opens straight onto the credentials form when handed a live camera to set up", () => {
    render(
      <AddCameraModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        cameras={[needsSignIn()]}
        prefill={needsSignIn()}
      />,
    );
    expect(screen.getByLabelText(USERNAME)).toBeTruthy();
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
    expect(screen.getByLabelText(/Camera name/)).toHaveValue("xnv_c8083r");
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
      expect(screen.getByLabelText(USERNAME)).toBeTruthy();
      expect((screen.getByLabelText(PASSWORD) as HTMLInputElement).type).toBe("password");
    });

    it("submits them separately from the address so the server can merge and encode them", async () => {
      addCameraManual.mockResolvedValue(undefined);
      render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);

      fireEvent.change(screen.getByLabelText(/Camera name/), { target: { value: "front_door" } });
      fireEvent.change(screen.getByLabelText(/Stream address/), {
        target: { value: "rtsp://192.168.9.60:554/live" },
      });
      typeCreds("admin", "p@ss:w/rd");
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
      expect((screen.getByLabelText(/Stream address/) as HTMLInputElement).placeholder).not.toMatch(
        /stream1/,
      );
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

// ── F5 ──────────────────────────────────────────────────────────────────────
describe("dialog semantics and focus (F5)", () => {
  it("is a labelled modal dialog, not a bare div", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Add camera" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<AddCameraModal onClose={onClose} onAdded={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from the labelled Close button", () => {
    const onClose = vi.fn();
    render(<AddCameraModal onClose={onClose} onAdded={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens with focus on Username when it opens on the credentials form", async () => {
    renderCredentials();
    await waitFor(() => expect(screen.getByLabelText(USERNAME)).toHaveFocus());
  });

  it("opens with focus on the first field of the manual form", async () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/Camera name/)).toHaveFocus());
  });

  it("moves focus to Username when Set up opens the credentials form", async () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} cameras={[needsSignIn()]} />);
    clickSetUp("XNV C8083R");
    await waitFor(() => expect(screen.getByLabelText(USERNAME)).toHaveFocus());
  });

  it("moves focus into the manual form when the stream-address fallback opens it", async () => {
    renderCredentials();
    fireEvent.click(screen.getByRole("button", { name: /Enter the stream address instead/ }));
    await waitFor(() => expect(screen.getByLabelText(/Camera name/)).toHaveFocus());
  });

  it("does not drop focus on the page behind when Back removes the button that had it", async () => {
    renderCredentials();
    const back = screen.getByRole("button", { name: /^Back$/ });
    back.focus();
    fireEvent.click(back);
    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(document.body);
    });
  });

  it("keeps Tab inside the dialog", () => {
    renderCredentials();
    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusable.length).toBeGreaterThan(2);
    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
    expect(focusable[0]).toHaveFocus();
  });

  it("returns focus to whatever opened it when it goes away", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/Camera name/)).toHaveFocus());
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

// ── F1 ──────────────────────────────────────────────────────────────────────
describe("readable error and hint ink (F1)", () => {
  const tokens = readFileSync(packagePath("src/components/shell/indigo-tokens.css"), "utf8");
  const token = (selector: string, name: string): string => {
    const at = tokens.indexOf(selector);
    const block = tokens.slice(at, tokens.indexOf("}", at));
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    if (!m) throw new Error(`${name} not found under ${selector}`);
    return m[1]!;
  };
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it("never paints text in the --danger FILL token (1.65:1 on the dark card)", () => {
    const source = readFileSync(packagePath("src/components/cameras/AddCameraModal.tsx"), "utf8");
    expect(source).not.toContain("var(--danger)");
  });

  it("the failure alert is --danger-ink", async () => {
    addDiscoveredCameraWithCredentials.mockRejectedValue(coded("UNREACHABLE"));
    renderCredentials();
    typeCreds("admin", "s3cret!");
    submitCredentials();
    const alert = await screen.findByRole("alert");
    expect(alert.style.color).toBe("var(--danger-ink)");
  });

  it("the stream-address and username hints are --danger-ink", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Stream address/), { target: { value: "http://nope" } });
    fireEvent.change(screen.getByLabelText(PASSWORD), { target: { value: "pw-without-user" } });
    expect(screen.getByText(/Must start with rtsp/).style.color).toBe("var(--danger-ink)");
    expect(screen.getByText(/Enter the username that goes with this password/).style.color).toBe(
      "var(--danger-ink)",
    );
  });

  it.each([
    ["light", ".droplet-shell,"],
    ["dark", ".dark .droplet-shell,"],
  ])("--danger-ink clears 4.5:1 on the dialog's card in %s mode", (_theme, selector) => {
    expect(contrast(token(selector, "--danger-ink"), token(selector, "--card-bg"))).toBeGreaterThanOrEqual(4.5);
  });
});

// ── F2 ──────────────────────────────────────────────────────────────────────
describe("credentials do not leak between cameras (F2)", () => {
  it("a camera's username and password are gone when the next camera's form opens", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} cameras={[needsSignIn(), lobby()]} />);
    clickSetUp("XNV C8083R");
    typeCreds("admin", "s3cret!");
    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));

    clickSetUp("Lobby");

    expect(screen.getByLabelText(USERNAME)).toHaveValue("");
    expect(screen.getByLabelText(PASSWORD)).toHaveValue("");
  });

  it("clears the manual form's account when the operator leaves it by a tab", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} cameras={[camera()]} />);
    fireEvent.click(screen.getByRole("button", { name: /Enter details/ }));
    typeCreds("admin", "s3cret!");

    fireEvent.click(screen.getByRole("button", { name: /On your network/ }));
    fireEvent.click(screen.getByRole("button", { name: /Enter details/ }));

    expect(screen.getByLabelText(USERNAME)).toHaveValue("");
    expect(screen.getByLabelText(PASSWORD)).toHaveValue("");
  });

  it("carries them over ONLY to the stream-address fallback, and says so", () => {
    renderCredentials();
    typeCreds("admin", "s3cret!");
    expect(screen.queryByText(/kept the username and password/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Enter the stream address instead/ }));

    expect(screen.getByLabelText(USERNAME)).toHaveValue("admin");
    expect(screen.getByLabelText(PASSWORD)).toHaveValue("s3cret!");
    expect(screen.getByText(/kept the username and password you just entered/)).toBeTruthy();
  });

  it("does not keep carrying them once the operator moves on from the fallback", () => {
    renderCredentials();
    typeCreds("admin", "s3cret!");
    fireEvent.click(screen.getByRole("button", { name: /Enter the stream address instead/ }));

    fireEvent.click(screen.getByRole("button", { name: /On your network/ }));
    clickSetUp("Lobby");

    expect(screen.getByLabelText(USERNAME)).toHaveValue("");
    expect(screen.getByLabelText(PASSWORD)).toHaveValue("");
  });

  it("opens a camera that has to be set up by hand without anyone's credentials", () => {
    render(
      <AddCameraModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        cameras={[needsSignIn(), lobby({ id: "db-9", source: "database", status: "unverified" })]}
      />,
    );
    clickSetUp("XNV C8083R");
    typeCreds("admin", "s3cret!");
    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));

    clickSetUp("Lobby");

    expect(screen.getByLabelText(/Camera name/)).toHaveValue("lobby");
    expect(screen.getByLabelText(USERNAME)).toHaveValue("");
    expect(screen.getByLabelText(PASSWORD)).toHaveValue("");
    expect(screen.queryByText(/kept the username and password/)).toBeNull();
  });
});

// ── F3 ──────────────────────────────────────────────────────────────────────
describe("one submit never speaks for another view (F3)", () => {
  it("locks navigation while a submit is in flight, and frees it afterwards", async () => {
    const d = deferred();
    addDiscoveredCameraWithCredentials.mockReturnValue(d.promise);
    renderCredentials();
    typeCreds("admin", "s3cret!");
    submitCredentials();

    await waitFor(() => expect(screen.getByRole("button", { name: /^Back$/ })).toBeDisabled());
    expect(screen.getByRole("button", { name: /On your network/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Enter details/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Enter the stream address instead/ })).toBeDisabled();

    await act(async () => d.reject(coded("UNREACHABLE")));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Back$/ })).toBeEnabled());
    expect(screen.getByRole("button", { name: /On your network/ })).toBeEnabled();
  });

  it("ignores a click on the backdrop while a submit is in flight", async () => {
    const d = deferred();
    addDiscoveredCameraWithCredentials.mockReturnValue(d.promise);
    const { props } = renderCredentials();
    typeCreds("admin", "s3cret!");
    submitCredentials();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Back$/ })).toBeDisabled());

    fireEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(props.onClose).not.toHaveBeenCalled();

    await act(async () => d.resolve());
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it("a late failure for camera A never shows on camera B", async () => {
    const a = deferred();
    addDiscoveredCameraWithCredentials.mockReturnValue(a.promise);
    const { rerender, props } = renderCredentials();
    typeCreds("admin", "s3cret!");
    submitCredentials();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Checking the camera/));

    // The hand-off moves the modal to another camera while A is still being checked.
    rerender(<AddCameraModal {...props} prefill={lobby()} />);
    expect(screen.getByText(/192\.168\.9\.50/)).toBeTruthy();
    expect(screen.queryByText(/Checking the camera/)).toBeNull();
    expect(screen.getByLabelText(USERNAME)).toHaveValue("");
    expect(screen.getByRole("button", { name: /Add camera/ })).toBeDisabled(); // nothing typed for B

    await act(async () => a.reject(coded("AUTH_FAILED", "Camera A rejected it.")));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Camera A rejected it/)).toBeNull();
    expect(screen.queryByText(/Checking the camera/)).toBeNull();
    expect(screen.getByLabelText(USERNAME)).toBeEnabled();
  });

  it("a late success for camera A refreshes the list but never closes the window B is being typed in", async () => {
    const a = deferred();
    addDiscoveredCameraWithCredentials.mockReturnValue(a.promise);
    const { rerender, props } = renderCredentials();
    typeCreds("admin", "s3cret!");
    submitCredentials();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Checking the camera/));

    rerender(<AddCameraModal {...props} prefill={lobby()} />);
    fireEvent.change(screen.getByLabelText(USERNAME), { target: { value: "operator" } });

    await act(async () => a.resolve());

    expect(props.onAdded).toHaveBeenCalledTimes(1); // A IS in Frigate now
    expect(toast).toHaveBeenCalledWith("Added XNV C8083R.", "success");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(USERNAME)).toHaveValue("operator");
  });

  it("a list Add in flight locks the tabs, and a late finish does not close a form being typed in", async () => {
    const d = deferred();
    const onAccept = vi.fn().mockReturnValue(d.promise);
    const onClose = vi.fn();
    render(
      <AddCameraModal onClose={onClose} onAdded={vi.fn()} cameras={[camera()]} onAccept={onAccept} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    await waitFor(() => expect(onAccept).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /Enter details/ })).toBeDisabled();

    await act(async () => d.resolve());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("an error from one view is not shown on the next", async () => {
    addDiscoveredCameraWithCredentials.mockRejectedValue(coded("UNREACHABLE", "Down."));
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} cameras={[needsSignIn(), lobby()]} />);
    clickSetUp("XNV C8083R");
    typeCreds("admin", "s3cret!");
    submitCredentials();
    expect(await screen.findByRole("alert")).toHaveTextContent("Down.");

    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    clickSetUp("Lobby");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ── F4 ──────────────────────────────────────────────────────────────────────
describe("Enter details starts blank (F4)", () => {
  it("opens an empty form, not the last camera's, with no address in the placeholder", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} cameras={[needsSignIn()]} />);
    clickSetUp("XNV C8083R");
    fireEvent.click(screen.getByRole("button", { name: /Enter the stream address instead/ }));
    expect(screen.getByText(/We found/)).toBeTruthy(); // the hand-off DOES say so

    fireEvent.click(screen.getByRole("button", { name: /On your network/ }));
    fireEvent.click(screen.getByRole("button", { name: /Enter details/ }));

    expect(screen.queryByText(/We found/)).toBeNull();
    expect(screen.getByLabelText(/Camera name/)).toHaveValue("");
    expect(screen.getByLabelText(/Stream address/)).toHaveValue("");
    expect(screen.getByLabelText(/Manufacturer/)).toHaveValue("");
    expect(screen.getByLabelText(/Model/)).toHaveValue("");
    expect(screen.getByLabelText<HTMLInputElement>(/Stream address/).placeholder).not.toContain(
      "192.168.9.219",
    );
    expect(document.body.textContent ?? "").not.toContain("192.168.9.219");
  });

  it("does not wipe a form the operator is already typing in when they press its own tab", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} cameras={[camera()]} />);
    fireEvent.click(screen.getByRole("button", { name: /Enter details/ }));
    fireEvent.change(screen.getByLabelText(/Camera name/), { target: { value: "garage" } });

    fireEvent.click(screen.getByRole("button", { name: /Enter details/ }));

    expect(screen.getByLabelText(/Camera name/)).toHaveValue("garage");
  });
});

// ── F9 ──────────────────────────────────────────────────────────────────────
describe("errors are tied to the fields (F9)", () => {
  it("marks the starred fields required", () => {
    renderCredentials();
    expect(screen.getByLabelText(USERNAME)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(PASSWORD)).toHaveAttribute("aria-required", "true");
    fireEvent.click(screen.getByRole("button", { name: /Enter the stream address instead/ }));
    expect(screen.getByLabelText(/Camera name/)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/Stream address/)).toHaveAttribute("aria-required", "true");
    // The optional account on this form is not required.
    expect(screen.getByLabelText(USERNAME)).not.toHaveAttribute("aria-required");
  });

  it("a wrong password flags both fields, describes them by the alert, and selects the password", async () => {
    addDiscoveredCameraWithCredentials.mockRejectedValue(coded("AUTH_FAILED", "Wrong credentials."));
    renderCredentials();
    typeCreds("admin", "s3cret!");
    submitCredentials();

    const alert = await screen.findByRole("alert");
    expect(alert.id).toBeTruthy();
    for (const field of [screen.getByLabelText(USERNAME), screen.getByLabelText(PASSWORD)]) {
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAttribute("aria-describedby", alert.id);
    }
    const password = screen.getByLabelText(PASSWORD) as HTMLInputElement;
    await waitFor(() => expect(password).toHaveFocus());
    expect(password.selectionStart).toBe(0);
    expect(password.selectionEnd).toBe("s3cret!".length);
  });

  it.each(["INVALID_CREDENTIALS", "UNSUPPORTED_PASSWORD"])(
    "%s IS about the fields (the server refused them before touching the camera), so both are flagged",
    async (code) => {
      addDiscoveredCameraWithCredentials.mockRejectedValue(coded(code, "Refused."));
      renderCredentials();
      typeCreds("admin", "has space");
      submitCredentials();

      const alert = await screen.findByRole("alert");
      for (const field of [screen.getByLabelText(USERNAME), screen.getByLabelText(PASSWORD)]) {
        expect(field).toHaveAttribute("aria-invalid", "true");
        expect(field).toHaveAttribute("aria-describedby", alert.id);
      }
    },
  );

  it("an unsupported password puts focus on the password, selected, to be changed", async () => {
    addDiscoveredCameraWithCredentials.mockRejectedValue(coded("UNSUPPORTED_PASSWORD", "No spaces."));
    renderCredentials();
    typeCreds("admin", "has space");
    submitCredentials();

    const password = screen.getByLabelText(PASSWORD) as HTMLInputElement;
    await waitFor(() => expect(password).toHaveFocus());
    expect(password.selectionStart).toBe(0);
    expect(password.selectionEnd).toBe("has space".length);
  });

  it("the manual form flags its account fields and focuses the password for an unsupported password too", async () => {
    addCameraManual.mockRejectedValue(coded("UNSUPPORTED_PASSWORD", "No spaces."));
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Camera name/), { target: { value: "front_door" } });
    fireEvent.change(screen.getByLabelText(/Stream address/), {
      target: { value: "rtsp://192.168.9.60:554/live" },
    });
    typeCreds("admin", "has space");
    fireEvent.click(screen.getByRole("button", { name: /Add camera/ }));

    const alert = await screen.findByRole("alert");
    for (const field of [screen.getByLabelText(USERNAME), screen.getByLabelText(PASSWORD)]) {
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAttribute("aria-describedby", alert.id);
    }
    await waitFor(() => expect(screen.getByLabelText(PASSWORD)).toHaveFocus());
  });

  it("the manual form leaves its fields alone for a failure that is not about them", async () => {
    addCameraManual.mockRejectedValue(coded("UNREACHABLE", "Down."));
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Camera name/), { target: { value: "front_door" } });
    fireEvent.change(screen.getByLabelText(/Stream address/), {
      target: { value: "rtsp://192.168.9.60:554/live" },
    });
    typeCreds("admin", "pw");
    fireEvent.click(screen.getByRole("button", { name: /Add camera/ }));

    await screen.findByRole("alert");
    expect(screen.getByLabelText(PASSWORD)).not.toHaveAttribute("aria-invalid");
  });

  it.each(["UNREACHABLE", "LOCKED", "NO_STREAM_PATH", "TIMEOUT", "DISCOVERY_UNAVAILABLE"])(
    "%s is described by the alert but does NOT mark the fields invalid — they are not what is wrong",
    async (code) => {
      addDiscoveredCameraWithCredentials.mockRejectedValue(coded(code, "Not about the fields."));
      renderCredentials();
      typeCreds("admin", "s3cret!");
      submitCredentials();

      await screen.findByText("Not about the fields.");
      for (const field of [screen.getByLabelText(USERNAME), screen.getByLabelText(PASSWORD)]) {
        expect(field).not.toHaveAttribute("aria-invalid");
        expect(field).toHaveAttribute("aria-describedby", "add-camera-error");
      }
    },
  );

  it("puts focus on the message after a failure that is not about the password", async () => {
    addDiscoveredCameraWithCredentials.mockRejectedValue(coded("UNREACHABLE", "Camera is down."));
    renderCredentials();
    typeCreds("admin", "s3cret!");
    submitCredentials();

    const message = await screen.findByText("Camera is down.");
    await waitFor(() => expect(message).toHaveFocus());
  });

  it("fields are not described or invalid when nothing has failed", () => {
    renderCredentials();
    for (const field of [screen.getByLabelText(USERNAME), screen.getByLabelText(PASSWORD)]) {
      expect(field).not.toHaveAttribute("aria-invalid");
      expect(field).not.toHaveAttribute("aria-describedby");
    }
  });
});

// ── F7 ──────────────────────────────────────────────────────────────────────
describe("probing feedback (F7)", () => {
  it("disables the whole form while probing and says what is happening and how long", async () => {
    const d = deferred();
    addDiscoveredCameraWithCredentials.mockReturnValue(d.promise);
    renderCredentials();
    typeCreds("admin", "s3cret!");
    submitCredentials();

    const form = screen.getByLabelText(USERNAME).closest("form") as HTMLFormElement;
    await waitFor(() => expect(form).toHaveAttribute("aria-busy", "true"));
    expect(form.querySelector("fieldset")).toBeDisabled();
    expect(screen.getByLabelText(USERNAME)).toBeDisabled();
    expect(screen.getByLabelText(PASSWORD)).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking the camera. This can take up to a minute. Keep this window open.",
    );

    await act(async () => d.reject(coded("UNREACHABLE")));
    await waitFor(() => expect(form.querySelector("fieldset")).toBeEnabled());
    expect(form).not.toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("does not claim to be probing when nothing is in flight", () => {
    renderCredentials();
    expect(screen.queryByText(/Checking the camera/)).toBeNull();
    expect(screen.getByLabelText(USERNAME).closest("form")).not.toHaveAttribute("aria-busy", "true");
  });
});

// ── F8 ──────────────────────────────────────────────────────────────────────
describe("show / hide password (F8)", () => {
  it("reveals and re-masks the credentials password with an accessible toggle", () => {
    renderCredentials();
    const input = screen.getByLabelText(PASSWORD) as HTMLInputElement;
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(input.type).toBe("password");

    fireEvent.click(toggle);
    expect(input.type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input.type).toBe("password");
  });

  it("turns off Edge's own reveal eye so there are not two", () => {
    renderCredentials();
    expect(screen.getByLabelText(PASSWORD).className).toContain("[&::-ms-reveal]:hidden");
  });

  it("has the same toggle on the manual form's password", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    const input = screen.getByLabelText(PASSWORD) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.type).toBe("text");
    expect(input.className).toContain("[&::-ms-reveal]:hidden");
  });

  it("re-masks when the window loses focus (WARP-3135)", () => {
    renderCredentials();
    const input = screen.getByLabelText(PASSWORD) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.type).toBe("text");

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(input.type).toBe("password");
  });

  it("re-masks on every attempt, so a failed one never leaves it showing", async () => {
    const d = deferred();
    addDiscoveredCameraWithCredentials.mockReturnValue(d.promise);
    renderCredentials();
    typeCreds("admin", "s3cret!");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect((screen.getByLabelText(PASSWORD) as HTMLInputElement).type).toBe("text");

    submitCredentials();

    await waitFor(() => expect((screen.getByLabelText(PASSWORD) as HTMLInputElement).type).toBe("password"));
    await act(async () => d.reject(coded("AUTH_FAILED")));
  });

  it("does not reveal the next camera's password because the last one was shown", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} cameras={[needsSignIn(), lobby()]} />);
    clickSetUp("XNV C8083R");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
    clickSetUp("Lobby");
    expect((screen.getByLabelText(PASSWORD) as HTMLInputElement).type).toBe("password");
  });
});

// ── F10 ─────────────────────────────────────────────────────────────────────
describe("lockout cooldown (F10)", () => {
  beforeEach(() => {
    // setTimeout stays real (focus timers, Testing Library); only the countdown
    // clock is driven by hand.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function lockTheCamera() {
    addDiscoveredCameraWithCredentials.mockRejectedValue(
      coded("LOCKED", "The camera has locked its account."),
    );
    const utils = renderCredentials();
    typeCreds("admin", "s3cret!");
    await act(async () => {
      submitCredentials();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return utils;
  }

  it("keeps Add disabled for about a minute, counting down, then lets the operator try again", async () => {
    await lockTheCamera();

    const add = screen.getByRole("button", { name: /Add camera/ });
    expect(add).toBeDisabled();
    expect(screen.getByText(/The camera has locked its account\./)).toBeTruthy();
    expect(screen.getByText(/try again in 1:00/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByText(/try again in 0:45/)).toBeTruthy();
    expect(add).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(44_000);
    });
    expect(screen.getByText(/try again in 0:01/)).toBeTruthy();
    expect(add).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText(/try again in/)).toBeNull();
    expect(screen.queryByText(/The camera has locked its account\./)).toBeNull();
    expect(screen.getByRole("button", { name: /Add camera/ })).toBeEnabled();
  });

  it("announces the lockout once, in a polite live region, and not on every tick", async () => {
    await lockTheCamera();
    const region = screen.getByTestId("camera-lockout-announcement");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveClass("sr-only");
    const announced = region.textContent;
    expect(announced).toMatch(/[Cc]amera locked/);
    expect(announced).toMatch(/about 60 seconds/);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(region.textContent).toBe(announced);

    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    expect(region).toBeEmptyDOMElement();
  });

  it("the visible countdown is not itself a live region (it would re-announce every second)", async () => {
    await lockTheCamera();
    const countdown = screen.getByText(/try again in 1:00/);
    expect(countdown.closest("[aria-live]")).toBeNull();
    expect(countdown.closest("[role=alert]")).toBeNull();
  });

  it("does not hold a different camera's form hostage", async () => {
    await lockTheCamera();
    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
    clickSetUp("Lobby");
    typeCreds("admin", "another");
    expect(screen.getByRole("button", { name: /Add camera/ })).toBeEnabled();
    expect(screen.queryByText(/try again in/)).toBeNull();
  });

  it("still holds the SAME camera if the operator leaves and comes back inside the minute", async () => {
    await lockTheCamera();
    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    clickSetUp("XNV C8083R");
    typeCreds("admin", "s3cret!");
    expect(screen.getByRole("button", { name: /Add camera/ })).toBeDisabled();
    expect(screen.getByText(/try again in 0:40/)).toBeTruthy();
  });
});

// ── F18 ─────────────────────────────────────────────────────────────────────
describe("autofill (F18)", () => {
  it("never uses username/current-password, which would offer the Droplet login for the camera", () => {
    renderCredentials();
    expect(screen.getByLabelText(USERNAME)).toHaveAttribute("autocomplete", "off");
    expect(screen.getByLabelText(PASSWORD)).toHaveAttribute("autocomplete", "new-password");
    fireEvent.click(screen.getByRole("button", { name: /Enter the stream address instead/ }));
    expect(screen.getByLabelText(USERNAME)).toHaveAttribute("autocomplete", "off");
    expect(screen.getByLabelText(PASSWORD)).toHaveAttribute("autocomplete", "new-password");
  });

  it("explains why in the source, so nobody 'fixes' it", () => {
    const source = readFileSync(packagePath("src/components/cameras/AddCameraModal.tsx"), "utf8");
    expect(source).toMatch(/current-password/);
    expect(source).toMatch(/lock/i);
  });
});

// ── WARP-3506 ───────────────────────────────────────────────────────────────
describe("camera name is normalised as it is typed", () => {
  const nameField = () => screen.getByLabelText(/Camera name/) as HTMLInputElement;

  it("lowercases, turns spaces and hyphens into underscores and drops the rest", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(nameField(), { target: { value: "Front Door-1!" } });
    expect(nameField()).toHaveValue("front_door_1");
  });

  it("says what is allowed, and tells the keyboard not to capitalise or spell-check it", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(screen.getByText("Lowercase letters, numbers and underscores")).toBeTruthy();
    expect(nameField()).toHaveAttribute("autocapitalize", "none");
    expect(nameField()).toHaveAttribute("spellcheck", "false");
  });

  it("normalises a name that arrives prefilled, so it is submittable as it stands", async () => {
    addCameraManual.mockResolvedValue(undefined);
    render(
      <AddCameraModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        cameras={[]}
        prefill={camera({ id: "db-1", source: "database", status: "unverified", name: "XNV-C8083R" })}
      />,
    );
    expect(nameField()).toHaveValue("xnv_c8083r");
    expect(screen.getByRole("button", { name: /Add camera/ })).toBeEnabled();
  });

  it("is enabled for a normalised name, and disabled while it is empty", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Stream address/), {
      target: { value: "rtsp://192.168.9.60:554/live" },
    });
    expect(screen.getByRole("button", { name: /Add camera/ })).toBeDisabled();
    fireEvent.change(nameField(), { target: { value: "Garage" } });
    expect(screen.getByRole("button", { name: /Add camera/ })).toBeEnabled();
  });

  it("caps the name at 64 characters", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(nameField(), { target: { value: "a".repeat(100) } });
    expect(nameField().value).toHaveLength(64);
  });
});

// ── F6 ──────────────────────────────────────────────────────────────────────
describe("manual form layout (F6)", () => {
  it("groups the account fields with their note, with no negative margins", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(PASSWORD), { target: { value: "pw-without-user" } });

    const group = screen.getByLabelText(USERNAME).closest(".space-y-2") as HTMLElement;
    expect(group).not.toBeNull();
    expect(within(group).getByLabelText(PASSWORD)).toBeTruthy();
    const note = within(group).getByText(/Optional\. Only needed if the camera asks for a sign-in/);
    expect(note.className).toContain("type-caption-1");
    expect(within(group).getByText(/Enter the username that goes with this password/)).toBeTruthy();

    const dialog = screen.getByRole("dialog");
    for (const el of Array.from(dialog.querySelectorAll<HTMLElement>("[style]"))) {
      expect(el.style.marginTop, el.outerHTML.slice(0, 80)).not.toMatch(/^-/);
    }
  });
});

// ── F12 – F16 ───────────────────────────────────────────────────────────────
describe("smaller review points", () => {
  it("F12: confirms a credentials add with the same toast the list's Add gives", async () => {
    addDiscoveredCameraWithCredentials.mockResolvedValue(undefined);
    renderCredentials();
    typeCreds("admin", "s3cret!");
    submitCredentials();
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Added XNV C8083R.", "success"));
  });

  it("F14: names the matched vendor, not the raw ONVIF manufacturer, and stays short", () => {
    render(
      <AddCameraModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        cameras={[]}
        prefill={camera({
          id: "db-1",
          source: "database",
          status: "unverified",
          manufacturer: "Hanwha Techwin Co., Ltd.",
        })}
      />,
    );
    const paragraph = screen.getByText(/couldn't open its video/).closest("p") as HTMLElement;
    expect(paragraph.textContent).toContain("Hanwha cameras usually use");
    expect(paragraph.textContent).not.toContain("Techwin");
    expect(paragraph.textContent).not.toMatch(/If it asks for a sign-in/);
    expect(paragraph.textContent!.length).toBeLessThan(220);
  });

  it("F15: marks the active chip with aria-current, including while the credentials form is open", () => {
    render(<AddCameraModal onClose={vi.fn()} onAdded={vi.fn()} cameras={[needsSignIn()]} />);
    const list = () => screen.getByRole("button", { name: /On your network/ });
    const manual = () => screen.getByRole("button", { name: /Enter details/ });
    expect(list()).toHaveAttribute("aria-current", "true");
    expect(manual()).not.toHaveAttribute("aria-current");

    clickSetUp("XNV C8083R"); // the credentials form belongs to "On your network"
    expect(list()).toHaveAttribute("aria-current", "true");
    expect(list()).toHaveClass("on");
    expect(manual()).not.toHaveAttribute("aria-current");

    fireEvent.click(manual());
    expect(manual()).toHaveAttribute("aria-current", "true");
    expect(manual()).toHaveClass("on");
    expect(list()).not.toHaveAttribute("aria-current");
  });

  it("F16: does not suggest an 'admin' username (Hanwha has no default one)", () => {
    renderCredentials();
    expect(screen.getByLabelText<HTMLInputElement>(USERNAME).placeholder).not.toMatch(/admin/i);
    fireEvent.click(screen.getByRole("button", { name: /Enter the stream address instead/ }));
    expect(screen.getByLabelText<HTMLInputElement>(USERNAME).placeholder).not.toMatch(/admin/i);
  });
});
