/**
 * WARP-1905 — passcode extraction for the Agenda view's join affordance.
 *
 * There is no stored passcode column: `meetingUrl` is the whole data model
 * (WARP-1874). When a provider embeds the passcode in the URL itself, the
 * agenda row surfaces it for members who join from another device (the room
 * TV, a phone dial-in) — the raw URL stays the href either way.
 */
import { describe, it, expect } from "vitest";
import { parseMeetingLink } from "@droplet/shared-types";
import { meetingPasscode } from "./meeting-passcode";

function linkOf(url: string) {
  const link = parseMeetingLink(url);
  if (!link) throw new Error(`fixture URL failed parseMeetingLink: ${url}`);
  return link;
}

describe("meetingPasscode", () => {
  it("extracts a Zoom pwd= param", () => {
    expect(
      meetingPasscode(linkOf("https://warplab.zoom.us/j/98765?pwd=Ab12Cd34")),
    ).toBe("Ab12Cd34");
  });

  it("extracts a Teams p= param (teams.live.com join links)", () => {
    expect(
      meetingPasscode(linkOf("https://teams.live.com/meet/9312345678901?p=XyZzy42")),
    ).toBe("XyZzy42");
  });

  it("extracts a generic passcode= param on any https provider", () => {
    expect(
      meetingPasscode(linkOf("https://meet.example.org/room-7?passcode=1234")),
    ).toBe("1234");
  });

  it("extracts a Webex pwd= param", () => {
    expect(
      meetingPasscode(linkOf("https://warplab.webex.com/warplab/j.php?MTID=m1&pwd=s3cret")),
    ).toBe("s3cret");
  });

  it("returns null when the URL carries no passcode (Google Meet shape)", () => {
    expect(meetingPasscode(linkOf("https://meet.google.com/abc-defg-hij"))).toBeNull();
  });

  it("does NOT read a bare p= param on a non-Teams provider", () => {
    // `p` is far too generic outside the Teams join-link shape — a video
    // platform's `?p=playlist` must not get badged as a meeting passcode.
    expect(meetingPasscode(linkOf("https://video.example.com/watch?p=road-trip"))).toBeNull();
  });

  it("returns null for an empty or whitespace-only param value", () => {
    expect(meetingPasscode(linkOf("https://warplab.zoom.us/j/98765?pwd="))).toBeNull();
    expect(meetingPasscode(linkOf("https://warplab.zoom.us/j/98765?pwd=%20%20"))).toBeNull();
  });
});
