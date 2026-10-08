import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mediaJobMedia, fileMediaFromPath } from "@droplet/shared-types";
import { MediaJobCard } from "./MediaJobCard";
vi.mock("./FileMediaCard", () => ({ FileMediaCard: ({ media }: { media: { name: string } }) => <div data-testid="saved-file">{media.name}</div> }));
const id = "e6451c31-5229-40a7-89bc-98d986531c5a";
const descriptor = mediaJobMedia(id);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
describe("media job card", () => {
  it("shows a saved result only from an owner-authorized terminal success", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ id, status: "succeeded", media: fileMediaFromPath("/image.png") })); vi.stubGlobal("fetch", fetch);
    render(<MediaJobCard media={descriptor} />);
    expect(await screen.findByTestId("saved-file")).toHaveProperty("textContent", "image.png");
    expect(fetch).toHaveBeenCalledWith(descriptor.statusUrl, expect.objectContaining({ credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal) }));
  });
  it("keeps pending destinations out of the saved-file UI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ id, status: "running", path: "/pending.png", media: descriptor })));
    render(<MediaJobCard media={descriptor} />);
    await waitFor(() => expect(screen.getByText("Creating your media…")).toBeTruthy());
    expect(screen.queryByTestId("saved-file")).toBeNull();
  });
  it.each([401, 404, 503])("shows actionable status failures without polling forever (%s)", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, status))); render(<MediaJobCard media={descriptor} />);
    expect(await screen.findByRole("alert")).toBeTruthy(); expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy(); expect(screen.queryByTestId("saved-file")).toBeNull();
  });
  it.each([{ id: "another", status: "succeeded", media: fileMediaFromPath("/wrong.png") }, { id, status: "succeeded" }, { id, status: "invented" }])("refuses a mismatched or invalid saved result", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body))); render(<MediaJobCard media={descriptor} />);
    await screen.findByRole("alert"); expect(screen.queryByTestId("saved-file")).toBeNull();
  });
  it("cancels only the descriptor's job and displays the terminal state", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ id, status: "running" })).mockResolvedValueOnce(response({ id, status: "cancelled" })).mockResolvedValue(response({ id, status: "cancelled" })); vi.stubGlobal("fetch", fetch);
    render(<MediaJobCard media={descriptor} />); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Media creation cancelled.")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(`${descriptor.statusUrl}/cancel`, expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
  it("unmount cancels an in-flight status request", async () => {
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", fetch);
    const view = render(<MediaJobCard media={descriptor} />); await waitFor(() => expect(fetch).toHaveBeenCalled());
    const signal = fetch.mock.calls[0][1].signal as AbortSignal; view.unmount(); expect(signal.aborted).toBe(true);
  });
});
