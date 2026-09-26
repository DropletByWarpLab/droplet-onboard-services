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
 * email. Same gate: parseMeetingLink, https only. (WARP-3101: the tools write
 * through the calendar route, which gates it again; this pins that a hostile
 * link never even leaves the tool.)
 *
 * The read tier matters as much as the write tier: a field the model can
 * only ever set is a field it can never answer questions about. Asked
 * "what's the link to my 3pm standup?", a model whose only view of the
 * event omits meeting_url has two bad options — say there is no link, or
 * invent one. So list_events and search_calendar_events project it too.
 */
import { describe, it, expect } from "vitest";
import createEvent from "../../../src/handlers/calendar/create-event.js";
import listEvents from "../../../src/handlers/calendar/list-events.js";
import searchEvents from "../../../src/handlers/calendar/search-events.js";
import updateEvent from "../../../src/handlers/calendar/update-event.js";
import { json, orchestratorCtx } from "../../helpers/orchestrator-ctx.js";

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

function created() {
  const o = orchestratorCtx();
  o.post.mockResolvedValue(json(201, { event: { id: "evt1", title: "x", startsAt: STARTS } }));
  return o;
}

function patched() {
  const o = orchestratorCtx();
  o.patch.mockResolvedValue(json(200, { event: { id: "evt1" } }));
  return o;
}

const bodyOf = (m: { mock: { calls: Array<unknown[]> } }) => m.mock.calls[0]![1] as Record<string, unknown>;

describe("create_event — meeting_url", () => {
  it("advertises meeting_url on the tool schema so the model can reach it", () => {
    const props = (createEvent.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.meeting_url).toBeDefined();
  });

  it("sends an https link alongside the physical location", async () => {
    const o = created();
    const r = await createEvent.handler(
      { title: "Sprint sync", location: "Living Room", meeting_url: ZOOM, starts_at: STARTS, ends_at: ENDS },
      o.ctx,
    );
    expect(r.ok).toBe(true);
    expect(bodyOf(o.post)).toMatchObject({ location: "Living Room", meetingUrl: ZOOM });
  });

  it.each(HOSTILE)("refuses %s without writing", async (hostile) => {
    const o = created();
    const r = await createEvent.handler({ title: "x", meeting_url: hostile, starts_at: STARTS, ends_at: ENDS }, o.ctx);
    expect(r.ok).toBe(false);
    expect(o.post).not.toHaveBeenCalled();
  });

  it("accepts an unrecognized https URL", async () => {
    const o = created();
    const r = await createEvent.handler(
      { title: "x", meeting_url: "https://vc.warp-lab.ai/room/kitchen", starts_at: STARTS, ends_at: ENDS },
      o.ctx,
    );
    expect(r.ok).toBe(true);
    expect(bodyOf(o.post).meetingUrl).toBe("https://vc.warp-lab.ai/room/kitchen");
  });

  it("sends no link when the model omits it", async () => {
    const o = created();
    await createEvent.handler({ title: "x", starts_at: STARTS, ends_at: ENDS }, o.ctx);
    expect("meetingUrl" in bodyOf(o.post)).toBe(false);
  });
});

describe("update_event — meeting_url", () => {
  it("advertises meeting_url on the tool schema", () => {
    const props = (updateEvent.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.meeting_url).toBeDefined();
  });

  it("sets the link", async () => {
    const o = patched();
    const r = await updateEvent.handler({ id: "evt1", meeting_url: ZOOM }, o.ctx);
    expect(r.ok).toBe(true);
    expect(bodyOf(o.patch).meetingUrl).toBe(ZOOM);
  });

  it("clears the link when the model passes an empty string", async () => {
    // The model has no way to send JSON null through most tool-call
    // encodings, so "" is the removal verb — and it is unambiguous,
    // because "" is never a valid link.
    const o = patched();
    const r = await updateEvent.handler({ id: "evt1", meeting_url: "" }, o.ctx);
    expect(r.ok).toBe(true);
    expect(bodyOf(o.patch).meetingUrl).toBeNull();
  });

  it("leaves the column untouched when meeting_url is absent", async () => {
    const o = patched();
    await updateEvent.handler({ id: "evt1", title: "Renamed" }, o.ctx);
    expect("meetingUrl" in bodyOf(o.patch)).toBe(false);
  });

  it.each(HOSTILE)("refuses %s without writing", async (hostile) => {
    const o = patched();
    const r = await updateEvent.handler({ id: "evt1", meeting_url: hostile }, o.ctx);
    expect(r.ok).toBe(false);
    expect(o.patch).not.toHaveBeenCalled();
  });
});

// ── the read tier ──────────────────────────────────────────────────────────

function row(meetingUrl: string | null) {
  return {
    id: "e1",
    title: "Daily standup",
    startsAt: STARTS,
    endsAt: ENDS,
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
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { events: [row(ZOOM)] }));
    const r = await tool.handler(args, o.ctx);
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
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { events: [row(null)] }));
    const r = await tool.handler(args, o.ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { events: Array<Record<string, unknown>> };
      expect("meeting_url" in data.events[0]).toBe(true);
      expect(data.events[0].meeting_url).toBeNull();
    }
  });
});
