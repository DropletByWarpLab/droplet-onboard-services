/**
 * WARP-3532 — payload v1 and its chat-app renderings.
 *
 * The chat renderings are where an employee's words (a work item's title) land
 * inside another system's markup, so the rows that matter most here are the
 * hostile titles: a title is never allowed to ping a channel.
 */
import { describe, it, expect } from "vitest";
import {
  WEBHOOK_PAYLOAD_VERSION,
  buildTestPayload,
  buildWorkItemPayload,
  workItemUrl,
  type WebhookPayloadV1,
  type WorkItemPayloadInput,
} from "./webhook-payload.js";
import { cleanText, describeEvent, renderWebhookBody } from "./webhook-formats.js";

const ORIGIN = "https://droplet.example";

function input(over: Partial<WorkItemPayloadInput> = {}): WorkItemPayloadInput {
  return {
    eventId: "act-1",
    event: "work_item.state_changed",
    occurredAt: new Date("2026-10-04T12:00:00.000Z"),
    origin: ORIGIN,
    workspace: { id: "ws-1", slug: "home", name: "Home" },
    project: { id: "p-1", identifier: "ENG", name: "Engineering" },
    item: {
      id: "wi-1",
      sequenceId: 12,
      name: "Fix the login bug",
      priority: "high",
      startDate: null,
      dueDate: new Date("2026-10-10T00:00:00.000Z"),
      state: { id: "s-2", name: "In progress", group: "started" },
      assignees: [{ userId: "u-2" }],
    },
    actor: { id: "u-1", name: "Ana Cruz" },
    activity: { field: "state", oldValue: "s-1", newValue: "s-2" },
    userNames: new Map([["u-1", "Ana Cruz"], ["u-2", "Ben Ortiz"]]),
    stateNames: new Map([["s-1", "Todo"], ["s-2", "In progress"]]),
    ...over,
  };
}

describe("buildWorkItemPayload (v1)", () => {
  it("has the documented envelope", () => {
    const p = buildWorkItemPayload(input());
    expect(p).toEqual({
      version: 1,
      id: "act-1",
      event: "work_item.state_changed",
      occurredAt: "2026-10-04T12:00:00.000Z",
      workspace: { id: "ws-1", slug: "home", name: "Home" },
      project: { id: "p-1", identifier: "ENG", name: "Engineering" },
      workItem: {
        id: "wi-1",
        key: "ENG-12",
        name: "Fix the login bug",
        url: "https://droplet.example/projects?p=ENG&item=ENG-12",
        state: { id: "s-2", name: "In progress", group: "started" },
        priority: "high",
        assignees: [{ id: "u-2", name: "Ben Ortiz" }],
        startDate: null,
        dueDate: "2026-10-10",
      },
      actor: { kind: "user", id: "u-1", name: "Ana Cruz" },
      changes: [{ field: "state", from: "s-1", to: "s-2", fromLabel: "Todo", toLabel: "In progress" }],
    });
    expect(WEBHOOK_PAYLOAD_VERSION).toBe(1);
  });

  it("carries calendar dates, not instants, for the item and for a due-date change", () => {
    const p = buildWorkItemPayload(
      input({
        event: "work_item.updated",
        activity: {
          field: "dueDate",
          oldValue: "2026-10-01T00:00:00.000Z",
          newValue: null,
        },
      }),
    );
    expect(p.workItem?.dueDate).toBe("2026-10-10");
    expect(p.changes).toEqual([{ field: "dueDate", from: "2026-10-01", to: null }]);
  });

  it("names an assignee change by person", () => {
    const p = buildWorkItemPayload(
      input({
        event: "work_item.assigned",
        activity: { field: "assignees", oldValue: null, newValue: "u-2" },
      }),
    );
    expect(p.changes).toEqual([
      { field: "assignees", from: null, to: "u-2", fromLabel: null, toLabel: "Ben Ortiz" },
    ]);
  });

  it("reports a system actor when nobody did it (the assistant / a tool call)", () => {
    const p = buildWorkItemPayload(input({ actor: { id: null, name: null } }));
    expect(p.actor).toEqual({ kind: "system", id: null, name: null });
  });

  it("does not turn pm.service's opaque `fields` bucket into a change", () => {
    const p = buildWorkItemPayload(
      input({ event: "work_item.updated", activity: { field: "fields", oldValue: null, newValue: null } }),
    );
    expect(p.changes).toEqual([]);
  });

  it("reports no changes for an event with no diff", () => {
    const p = buildWorkItemPayload(
      input({ event: "work_item.created", activity: { field: null, oldValue: null, newValue: null } }),
    );
    expect(p.changes).toEqual([]);
  });

  it("leaves out what must not leave: comment text, description, emails, usernames", () => {
    const json = JSON.stringify(buildWorkItemPayload(input()));
    for (const leaked of ["description", "commentHtml", "email", "username"]) {
      expect(json).not.toContain(leaked);
    }
  });

  it("builds the deep link from the project identifier and the key", () => {
    expect(workItemUrl(ORIGIN, "ENG", "ENG-12")).toBe("https://droplet.example/projects?p=ENG&item=ENG-12");
    // An identifier is alphanumeric by validation, but the link must survive
    // one that is not.
    expect(workItemUrl(ORIGIN, "A&B", "A&B-1")).toBe("https://droplet.example/projects?p=A%26B&item=A%26B-1");
  });
});

describe("buildTestPayload", () => {
  it("is the same envelope with nothing in it", () => {
    const p = buildTestPayload({
      eventId: "evt-t",
      event: "webhook.test",
      occurredAt: new Date("2026-10-04T12:00:00.000Z"),
      workspace: { id: "ws-1", slug: "home", name: "Home" },
      actor: { id: "u-1", name: "Ana Cruz" },
    });
    expect(p).toMatchObject({ version: 1, event: "webhook.test", project: null, workItem: null, changes: [] });
    expect(p.actor).toEqual({ kind: "user", id: "u-1", name: "Ana Cruz" });
  });
});

// ── renderings ───────────────────────────────────────────────────────────────

const payload = (over: Partial<WorkItemPayloadInput> = {}): WebhookPayloadV1 => buildWorkItemPayload(input(over));
const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;

describe("renderWebhookBody", () => {
  it("JSON is the payload, verbatim", () => {
    const p = payload();
    expect(renderWebhookBody("JSON", p)).toBe(JSON.stringify(p));
  });

  it("renders the same event into each chat app's shape", () => {
    const p = payload();
    expect(parse(renderWebhookBody("SLACK", p))).toEqual({
      text: "*Ana Cruz* moved <https://droplet.example/projects?p=ENG&item=ENG-12|ENG-12 Fix the login bug> to In progress",
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(parse(renderWebhookBody("DISCORD", p))).toEqual({
      username: "Droplet",
      allowed_mentions: { parse: [] },
      content:
        "**Ana Cruz** moved [ENG-12 Fix the login bug](<https://droplet.example/projects?p=ENG&item=ENG-12>) to In progress",
    });
    const chat = parse(renderWebhookBody("GOOGLE_CHAT", p));
    expect(chat.text).toBe(
      "*Ana Cruz* moved <https://droplet.example/projects?p=ENG&item=ENG-12|ENG-12 Fix the login bug> to In progress",
    );
    const teams = parse(renderWebhookBody("TEAMS", p)) as {
      type: string;
      attachments: Array<{ contentType: string; content: { type: string; version: string; body: Array<{ text: string }> } }>;
    };
    expect(teams.type).toBe("message");
    expect(teams.attachments[0]?.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(teams.attachments[0]?.content).toMatchObject({ type: "AdaptiveCard", version: "1.4" });
    expect(teams.attachments[0]?.content.body[0]?.text).toContain("ENG-12");
  });

  it("puts the changes on a second line for a generic update", () => {
    const p = payload({
      event: "work_item.updated",
      activity: { field: "priority", oldValue: "none", newValue: "high" },
    });
    expect(parse(renderWebhookBody("SLACK", p)).text).toBe(
      "*Ana Cruz* updated <https://droplet.example/projects?p=ENG&item=ENG-12|ENG-12 Fix the login bug>\nPriority: none → high",
    );
  });

  it.each([
    ["work_item.created", "created"],
    ["work_item.commented", "commented on"],
    ["work_item.archived", "archived"],
  ] as const)("says what %s was", (event, lead) => {
    const d = describeEvent(payload({ event, activity: { field: null, oldValue: null, newValue: null } }));
    expect(d.lead).toBe(lead);
  });

  it("names who an assignment was to", () => {
    const d = describeEvent(
      payload({ event: "work_item.assigned", activity: { field: "assignees", oldValue: null, newValue: "u-2" } }),
    );
    expect(d.lead).toBe("assigned Ben Ortiz to");
  });

  it("calls a system actor Droplet", () => {
    expect(describeEvent(payload({ actor: { id: null, name: null } })).actor).toBe("Droplet");
  });

  it("renders a test message in every format, with no work item and no link", () => {
    const p = buildTestPayload({
      eventId: "evt-t",
      event: "webhook.test",
      occurredAt: new Date(),
      workspace: { id: "ws-1", slug: "home", name: "Home" },
      actor: { id: "u-1", name: "Ana Cruz" },
    });
    expect(parse(renderWebhookBody("SLACK", p)).text).toBe(
      "*Ana Cruz* sent a test message: Work notifications is connected",
    );
    for (const format of ["DISCORD", "GOOGLE_CHAT", "TEAMS"] as const) {
      expect(renderWebhookBody(format, p), format).toContain("Work notifications is connected");
    }
  });
});

describe("a hostile title never pings anybody", () => {
  const hostile = (name: string): WebhookPayloadV1 =>
    payload({ item: { ...input().item, name } });

  it("Slack: <!channel>, <!here>, <@U123> and links are entity-escaped, not interpreted", () => {
    const text = parse(renderWebhookBody("SLACK", hostile("<!channel> <!here> <@U123> <https://evil.example|click>"))).text as string;
    expect(text).not.toMatch(/<!channel>|<!here>|<@U123>|<https:\/\/evil/);
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&lt;@U123&gt;");
    // The only angle-bracketed thing left is OUR link.
    expect([...text.matchAll(/<[^&]/g)]).toHaveLength(1);
  });

  it("Slack: ampersands are escaped too", () => {
    expect(parse(renderWebhookBody("SLACK", hostile("R&D"))).text).toContain("R&amp;D");
  });

  it("Discord: @everyone and role pings are neutralised by allowed_mentions, whatever the text", () => {
    const body = parse(renderWebhookBody("DISCORD", hostile("@everyone @here <@&123>")));
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("Google Chat: <users/all> is broken so it no longer parses as a mention", () => {
    const text = parse(renderWebhookBody("GOOGLE_CHAT", hostile("<users/all>"))).text as string;
    expect(text).not.toContain("<users/all>");
    expect(text).toContain("<​users/all​>");
  });

  it("Teams: markdown control characters are escaped and no mention entity is set", () => {
    const body = renderWebhookBody("TEAMS", hostile("[click](https://evil.example) <at>All</at> *bold*"));
    expect(body).not.toContain("msteams");
    expect(body).not.toContain("entities");
    const text = (parse(body) as { attachments: Array<{ content: { body: Array<{ text: string }> } }> })
      .attachments[0]!.content.body[0]!.text;
    expect(text).not.toContain("[click](https://evil.example)");
    expect(text).toContain("\\[click\\]");
  });

  it("a title cannot forge a second line or a wall of text", () => {
    const text = parse(renderWebhookBody("SLACK", hostile(`first\n\n*second line*\r\n${"x".repeat(5000)}`))).text as string;
    expect(text.split("\n")).toHaveLength(1);
    expect(text.length).toBeLessThan(400);
  });
});

describe("cleanText", () => {
  it("collapses control characters and whitespace, trims, and truncates with an ellipsis", () => {
    expect(cleanText("  a\tb\u0000c\n\nd  ", 50)).toBe("a b c d");
    expect(cleanText("abcdefghij", 5)).toBe("abcd…");
    expect(cleanText("abcde", 5)).toBe("abcde");
  });
});
