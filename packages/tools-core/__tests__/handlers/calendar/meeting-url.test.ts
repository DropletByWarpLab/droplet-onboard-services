/**
 * WARP-1874 — `meeting_url` on the LLM calendar tools.
 *
 * The tool surface gets the field for the same reason the HTTP routes did:
 * without it, the model's only place to put "here's the Zoom link" is
 * `location`, which is precisely the free-text-URL bug this ticket exists
 * to fix. A model that helpfully writes a URL into `location` would be
 * recreating it through the back door.
 *
 * The value the model supplies is no more trusted than the one a person
 * pastes — arguably less, since it can be echoed out of a summarized
 * email. Same gate: parseMeetingLink, https only.
 *
 * The read tier matters as much as the write tier: a field the model can
 * only ever set is a field it can never answer questions about. Asked
 * "what's the link to my 3pm standup?", a model whose only view of the
 * event omits meeting_url has two bad options — say there is no link, or
 * invent one. So list_events and search_calendar_events project it too.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import createEvent from "../../../src/handlers/calendar/create-event.js";
import listEvents from "../../../src/handlers/calendar/list-events.js";
import searchEvents from "../../../src/handlers/calendar/search-events.js";
import updateEvent from "../../../src/handlers/calendar/update-event.js";
import type { ToolContext } from "../../../src/types.js";

const STARTS = "2026-09-01T12:00:00Z";
const ENDS = "2026-09-01T13:00:00Z";
const ZOOM = "https://warplab.zoom.us/j/98765?pwd=abc";

const HOSTILE = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "java\nscript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "http://zoom.us/j/1",
  "//evil.example/j/1",
  "the kitchen",
];

function createCtx(create: Mock): ToolContext {
  return {
    prisma: { calendarEvent: { create } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    signal: new AbortController().signal,
  };
}

function updateCtx(update: Mock): ToolContext {
  const findUnique = vi.fn().mockResolvedValue({
    userId: "alice",
    source: "local",
    startsAt: new Date(STARTS),
    endsAt: new Date(ENDS),
  });
  return {
    prisma: {
      calendarEvent: { findUnique, update },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    signal: new AbortController().signal,
  };
}

describe("create_event — meeting_url", () => {
  it("advertises meeting_url on the tool schema so the model can reach it", () => {
    const props = (createEvent.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(props.meeting_url).toBeDefined();
  });

  it("persists an https link alongside the physical location", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "evt1",
      title: "Sprint sync",
      startsAt: new Date(STARTS),
    });
    const r = await createEvent.handler(
      {
        title: "Sprint sync",
        location: "Living Room",
        meeting_url: ZOOM,
        starts_at: STARTS,
        ends_at: ENDS,
      },
      createCtx(create),
    );
    expect(r.ok).toBe(true);
    expect(create.mock.calls[0][0].data).toMatchObject({
      location: "Living Room",
      meetingUrl: ZOOM,
    });
  });

  it.each(HOSTILE)("refuses %s without writing", async (hostile) => {
    const create = vi.fn();
    const r = await createEvent.handler(
      { title: "x", meeting_url: hostile, starts_at: STARTS, ends_at: ENDS },
      createCtx(create),
    );
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts an unrecognized https URL", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: "evt1", title: "x", startsAt: new Date(STARTS) });
    const r = await createEvent.handler(
      {
        title: "x",
        meeting_url: "https://vc.warp-lab.ai/room/kitchen",
        starts_at: STARTS,
        ends_at: ENDS,
      },
      createCtx(create),
    );
    expect(r.ok).toBe(true);
    expect(create.mock.calls[0][0].data.meetingUrl).toBe(
      "https://vc.warp-lab.ai/room/kitchen",
    );
  });

  it("writes null when the model omits it", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: "evt1", title: "x", startsAt: new Date(STARTS) });
    await createEvent.handler(
      { title: "x", starts_at: STARTS, ends_at: ENDS },
      createCtx(create),
    );
    expect(create.mock.calls[0][0].data.meetingUrl).toBeNull();
  });
});

describe("update_event — meeting_url", () => {
  it("advertises meeting_url on the tool schema", () => {
    const props = (updateEvent.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(props.meeting_url).toBeDefined();
  });

  it("sets the link", async () => {
    const update = vi.fn().mockResolvedValue({ id: "evt1" });
    const r = await updateEvent.handler(
      { id: "evt1", meeting_url: ZOOM },
      updateCtx(update),
    );
    expect(r.ok).toBe(true);
    expect(update.mock.calls[0][0].data.meetingUrl).toBe(ZOOM);
  });

  it("clears the link when the model passes an empty string", async () => {
    // The model has no way to send JSON null through most tool-call
    // encodings, so "" is the removal verb — and it is unambiguous,
    // because "" is never a valid link.
    const update = vi.fn().mockResolvedValue({ id: "evt1" });
    const r = await updateEvent.handler(
      { id: "evt1", meeting_url: "" },
      updateCtx(update),
    );
    expect(r.ok).toBe(true);
    expect(update.mock.calls[0][0].data.meetingUrl).toBeNull();
  });

  it("leaves the column untouched when meeting_url is absent", async () => {
    const update = vi.fn().mockResolvedValue({ id: "evt1" });
    await updateEvent.handler({ id: "evt1", title: "Renamed" }, updateCtx(update));
    expect("meetingUrl" in update.mock.calls[0][0].data).toBe(false);
  });

  it.each(HOSTILE)("refuses %s without writing", async (hostile) => {
    const update = vi.fn();
    const r = await updateEvent.handler(
      { id: "evt1", meeting_url: hostile },
      updateCtx(update),
    );
    expect(r.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});

// ── the read tier ────────────────────────────────────────────────────

function readCtx(findMany: Mock): ToolContext {
  return {
    prisma: { calendarEvent: { findMany } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    signal: new AbortController().signal,
  };
}

function row(meetingUrl: string | null) {
  return {
    id: "e1",
    title: "Daily standup",
    startsAt: new Date(STARTS),
    endsAt: new Date(ENDS),
    allDay: false,
    location: "Living Room",
    meetingUrl,
    source: "local",
  };
}

describe.each([
  ["list_events", listEvents, {} as Record<string, unknown>],
  ["search_calendar_events", searchEvents, { query: "standup" }],
])("%s — meeting_url read-back", (_name, tool, args) => {
  it("returns the link so the model can answer 'what's the link?'", async () => {
    const findMany = vi.fn().mockResolvedValue([row(ZOOM)]);
    const r = await tool.handler(args, readCtx(findMany));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { events: Array<Record<string, unknown>> };
      expect(data.events[0].meeting_url).toBe(ZOOM);
      // Separate from the room, exactly as it is on the write side.
      expect(data.events[0].location).toBe("Living Room");
    }
  });

  it("returns null rather than omitting the key when there is no link", async () => {
    // An absent key reads as "unknown" to a model; an explicit null is the
    // answer "this meeting has no video call".
    const findMany = vi.fn().mockResolvedValue([row(null)]);
    const r = await tool.handler(args, readCtx(findMany));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { events: Array<Record<string, unknown>> };
      expect("meeting_url" in data.events[0]).toBe(true);
      expect(data.events[0].meeting_url).toBeNull();
    }
  });
});
