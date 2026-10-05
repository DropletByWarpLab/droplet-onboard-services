/**
 * WARP-3509 — the event modal.
 *
 * Camera naming and the picture fallback, the same two fixes as the review
 * modal, and the reason events looked broken on Frigate 0.17: an event's clip
 * was played by pointing a <video> at Frigate's clip.mp4, a FRAGMENTED mp4 that
 * ffmpeg streams on the fly (duration 0 in its header, the index at the END, no
 * Content-Length, Range ignored). A browser cannot read a duration from that (a
 * 12 s clip showed 6.1 s), cannot seek it, and stalls on a long one. The clip
 * now plays as HLS through the same player the Recordings page uses, and
 * clip.mp4 stays for the Download button alone.
 *
 * `HlsPlayer` is stubbed: hls.js needs MediaSource, which jsdom does not have.
 * What is under test is what the modal hands it and what it does with its
 * failure. Everything else about this modal (retain, tag, regenerate) is
 * unchanged and out of scope here.
 *
 * The modal is built on <Dialog>, which portals to document.body: query
 * through `screen` / `document`, not the render container.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import React from "react";

const h = vi.hoisted(() => ({
  role: "owner",
  player: {
    props: null as null | { src: string; onError?: (message: string) => void },
    mounts: 0,
  },
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: h.role } }) }));
vi.mock("@/components/recordings/HlsPlayer", () => ({
  HlsPlayer: (props: { src: string; onError?: (message: string) => void }) => {
    h.player.props = props;
    React.useEffect(() => {
      h.player.mounts += 1;
    }, []);
    return <div data-testid="hls-player" data-src={props.src} />;
  },
}));

import { EventClipModal } from "./EventClipModal";
import type { EventDetail } from "@/lib/types";

beforeEach(() => {
  h.role = "owner";
  h.player.props = null;
  h.player.mounts = 0;
});
afterEach(() => cleanup());

const ID = "1791059989.433851-abc123";
const HLS = `/api/cameras/events/${ID}/playback.m3u8`;

function makeEvent(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    id: ID,
    camera: "warp_lab_office",
    label: "person",
    score: 0.91,
    startTime: 1_800_000_000,
    endTime: 1_800_000_060,
    thumbnail: `/api/cameras/events/${ID}/thumbnail`,
    hasClip: false,
    hasSnapshot: true,
    subLabel: null,
    subLabelScore: null,
    zones: [],
    retainIndefinitely: false,
    clipUrl: null,
    snapshotUrl: `/api/cameras/events/${ID}/snapshot`,
    description: null,
    ...overrides,
  };
}

/** An event with a clip: Frigate kept recordings for it. */
const withClip = (overrides: Partial<EventDetail> = {}) =>
  makeEvent({ hasClip: true, clipUrl: `/api/cameras/clips/event/${ID}`, ...overrides });

const PLAY_FAILED = "This clip can't be played right now. Try again in a moment.";
const IN_PROGRESS = "In progress — showing footage up to now.";

describe("EventClipModal camera name", () => {
  it("names the camera by its display name in the details line", () => {
    render(<EventClipModal event={makeEvent({ camera: "front_door" })} cameraName="Lobby" onClose={vi.fn()} />);

    expect(screen.getByText(/Lobby ·/)).toBeInTheDocument();
    expect(screen.queryByText(/front door/)).toBeNull();
  });

  it("falls back to the prettified key, never the raw lower-case key", () => {
    render(<EventClipModal event={makeEvent()} onClose={vi.fn()} />);

    expect(screen.getByText(/Warp Lab Office ·/)).toBeInTheDocument();
    expect(screen.queryByText(/warp lab office/)).toBeNull();
  });

  it("names the camera by its display name in the picture's alt text", () => {
    render(<EventClipModal event={makeEvent({ camera: "front_door" })} cameraName="Lobby" onClose={vi.fn()} />);

    expect(document.querySelector("img")!.getAttribute("alt")).toBe("person on Lobby");
  });

  it("still links to the camera by its key", () => {
    render(<EventClipModal event={makeEvent()} cameraName="Warp Lab Office" onClose={vi.fn()} />);

    expect(screen.getByRole("link", { name: /Open camera/ }).getAttribute("href")).toBe("/cameras/warp_lab_office");
  });
});

describe("EventClipModal picture failure", () => {
  it("a snapshot that fails to load becomes a placeholder, with no alt text left to print", () => {
    render(<EventClipModal event={makeEvent()} cameraName="Warp Lab Office" onClose={vi.fn()} />);

    fireEvent.error(document.querySelector("img")!);

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();
    expect(document.body.innerHTML).not.toContain("person on Warp Lab Office");
  });

  it("the thumbnail used when there is neither a clip nor a snapshot gets the same fallback", () => {
    render(<EventClipModal event={makeEvent({ snapshotUrl: null, hasSnapshot: false })} onClose={vi.fn()} />);

    expect(document.querySelector("img")!.getAttribute("src")).toBe(`/api/cameras/events/${ID}/thumbnail`);
    fireEvent.error(document.querySelector("img")!);

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();
  });
});

describe("EventClipModal clip playback (WARP-3509)", () => {
  it("plays the clip as HLS through the shared player, never a <video src> of the fragmented mp4", () => {
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);

    expect(screen.getByTestId("hls-player").getAttribute("data-src")).toBe(HLS);
    expect(document.querySelector("video")).toBeNull();
    // No picture while the clip plays; the player is the picture.
    expect(document.querySelector("img")).toBeNull();
  });

  it("an event without a clip shows its snapshot and starts no player", () => {
    render(<EventClipModal event={makeEvent()} onClose={vi.fn()} />);

    expect(screen.queryByTestId("hls-player")).toBeNull();
    expect(document.querySelector("img")).not.toBeNull();
  });

  it("a finished event offers neither the in-progress notice nor Refresh", () => {
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);

    expect(screen.queryByText(IN_PROGRESS)).toBeNull();
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
  });

  it("an event still in progress says so, and plays footage up to now", () => {
    render(<EventClipModal event={withClip({ endTime: null })} onClose={vi.fn()} />);

    expect(screen.getByText(IN_PROGRESS)).toBeInTheDocument();
    expect(screen.getByTestId("hls-player").getAttribute("data-src")).toBe(HLS);
  });

  it("Refresh asks for the playlist again, so an event in progress plays further", () => {
    render(<EventClipModal event={withClip({ endTime: null })} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(screen.getByTestId("hls-player").getAttribute("data-src")).toBe(`${HLS}?refresh=1`);

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(screen.getByTestId("hls-player").getAttribute("data-src")).toBe(`${HLS}?refresh=2`);
  });

  it("a clip that cannot play falls back to the snapshot, with a notice, instead of a black box", () => {
    render(<EventClipModal event={withClip()} cameraName="Warp Lab Office" onClose={vi.fn()} />);

    act(() => h.player.props!.onError!("We couldn't load that recording."));
    act(() => h.player.props!.onError!("We couldn't load that recording."));

    expect(screen.queryByTestId("hls-player")).toBeNull();
    expect(document.querySelector("img")!.getAttribute("src")).toBe(`/api/cameras/events/${ID}/snapshot`);
    expect(screen.getByText(PLAY_FAILED)).toBeInTheDocument();
  });

  it("the notice does not repeat the player's engineer-facing message", () => {
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);

    act(() => h.player.props!.onError!("manifestLoadError"));
    act(() => h.player.props!.onError!("manifestLoadError"));

    expect(screen.queryByText(/manifestLoadError/)).toBeNull();
    // And not the Recordings page's wording, which talks about segments.
    expect(screen.queryByText(/segment/i)).toBeNull();
  });

  it("the failure notice is an alert in the shell's error ink, not a quiet status line (WARP-3509)", () => {
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);

    act(() => h.player.props!.onError!("x"));
    act(() => h.player.props!.onError!("x"));

    // Something the person was waiting on just failed: announce it, and paint
    // it as the problem it is (--danger-ink clears 4.5:1 in both themes).
    const notice = screen.getByRole("alert");
    expect(notice.textContent).toBe(PLAY_FAILED);
    expect(notice.className).toContain("text-[color:var(--danger-ink)]");
    // The in-progress line, which is information, stays a status.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the failure notice says 'try again', so it offers Retry, which asks for the playlist again", () => {
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);
    act(() => h.player.props!.onError!("x"));
    act(() => h.player.props!.onError!("x"));
    expect(screen.queryByTestId("hls-player")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    // A new url, so a player that tears down on a changed `src` really does
    // load the playlist again; and the notice is gone while it does.
    expect(screen.getByTestId("hls-player").getAttribute("data-src")).toBe(`${HLS}?refresh=1`);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("a second failure offers Retry again, with yet another playlist request", () => {
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);
    act(() => h.player.props!.onError!("x"));
    act(() => h.player.props!.onError!("x"));
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    act(() => h.player.props!.onError!("x"));
    act(() => h.player.props!.onError!("x"));

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    expect(screen.getByTestId("hls-player").getAttribute("data-src")).toBe(`${HLS}?refresh=2`);
  });

  it("offers no Retry for an event with no clip: there is nothing to try", () => {
    render(<EventClipModal event={makeEvent()} onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the in-progress line is a status, not an alert: it is information, not a failure", () => {
    render(<EventClipModal event={withClip({ endTime: null })} onClose={vi.fn()} />);

    expect(screen.getByRole("status").textContent).toBe(IN_PROGRESS);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an unrelated state change does not restart playback", () => {
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);
    const onErrorBefore = h.player.props!.onError;
    const mountsBefore = h.player.mounts;

    // Opening the tag panel re-renders the modal. hls.js is torn down and rebuilt
    // whenever the player's `src` OR `onError` identity changes, which would
    // restart the clip from the beginning on every click.
    fireEvent.click(screen.getByRole("button", { name: /Tag person/ }));

    expect(h.player.props!.onError).toBe(onErrorBefore);
    expect(h.player.mounts).toBe(mountsBefore);
  });

  it("moving the modal to another event starts a fresh player, failure and refresh forgotten", () => {
    const { rerender } = render(<EventClipModal event={withClip({ endTime: null })} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    act(() => h.player.props!.onError!("x"));
    act(() => h.player.props!.onError!("x"));
    expect(screen.queryByTestId("hls-player")).toBeNull();

    const other = "1791070000.5-zzzzzz";
    rerender(
      <EventClipModal
        event={withClip({ id: other, clipUrl: `/api/cameras/clips/event/${other}` })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("hls-player").getAttribute("data-src")).toBe(
      `/api/cameras/events/${other}/playback.m3u8`,
    );
    expect(screen.queryByText(PLAY_FAILED)).toBeNull();
  });
});

describe("EventClipModal Download (WARP-3103, WARP-3509)", () => {
  it("saves the clip as a file through clip.mp4?download=1 for an owner", () => {
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);

    const link = screen.getByRole("link", { name: /Download/ });
    expect(link.getAttribute("href")).toBe(`/api/cameras/clips/event/${ID}?download=1`);
    expect(link.getAttribute("download")).toBe(`warp_lab_office-person-${ID}.mp4`);
  });

  it("is not offered to a member, who may watch but not save", () => {
    h.role = "family";
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);

    expect(screen.queryByRole("link", { name: /Download/ })).toBeNull();
    // Watching is theirs: the player still plays.
    expect(screen.getByTestId("hls-player")).toBeInTheDocument();
  });

  it("stays available when the clip cannot play: the file is the way to watch it elsewhere", () => {
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);

    act(() => h.player.props!.onError!("x"));
    act(() => h.player.props!.onError!("x"));

    expect(screen.getByRole("link", { name: /Download/ }).getAttribute("href")).toBe(
      `/api/cameras/clips/event/${ID}?download=1`,
    );
  });
});

describe("EventClipModal layout (WARP-3509)", () => {
  it("lets the actions wrap below the details when there is no room beside them, so the details never collapse to a sliver", () => {
    // jsdom has no layout, so this pins the mechanism. The row wraps; the
    // details ask for 16rem before anything may sit beside them. An owner's four
    // actions (Tag person, Save, Open camera, Download) are ~29rem with their
    // labels and ~11rem as bare icons: beside a 16rem column neither fits in the
    // 34rem body, and before this the details were left a ~37px column of text.
    render(<EventClipModal event={withClip({ zones: ["porch"] })} onClose={vi.fn()} />);

    const details = screen.getByText(/Warp Lab Office ·/).parentElement!;
    const row = details.parentElement!;
    expect(row.className).toContain("flex-wrap");
    expect(details.className).toContain("basis-[16rem]");
    expect(details.className).toContain("flex-1");
    // And on a screen narrower than 16rem it can still give way rather than overflow.
    expect(details.className).toContain("min-w-0");
  });

  it("keeps every action in one group, so they wrap together", () => {
    render(<EventClipModal event={withClip()} onClose={vi.fn()} />);

    const actions = screen.getByRole("link", { name: /Open camera/ }).parentElement!;
    expect(actions.contains(screen.getByRole("link", { name: /Download/ }))).toBe(true);
    expect(actions.contains(screen.getByRole("button", { name: /Tag person/ }))).toBe(true);
    expect(actions.className).toContain("flex-wrap");
  });
});
