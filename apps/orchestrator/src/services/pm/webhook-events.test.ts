/**
 * WARP-3532 — the event vocabulary and the verb → event partition.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SLA_EVENTS,
  SUBSCRIBABLE_EVENTS,
  TICKET_EVENTS,
  WEBHOOK_TEST_EVENT,
  WORK_EVENT_CATALOG,
  WORK_ITEM_EVENTS,
  eventForVerb,
  isSubscribableEvent,
} from "./webhook-events.js";

/** Members of `enum PmActivityVerb`, from the schema: the unit lane mocks the
 *  Prisma client, so its enum objects are not the real ones. */
function schemaVerbs(): string[] {
  const schema = readFileSync(path.resolve(__dirname, "../../../prisma/schema.prisma"), "utf8");
  const body = /enum PmActivityVerb \{([\s\S]*?)\n\}/.exec(schema)?.[1];
  if (!body) throw new Error("enum PmActivityVerb not found");
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//"));
}

describe("eventForVerb", () => {
  const verbs = schemaVerbs();

  it("reads the whole verb enum (guards the parser, so the rows below are not vacuous)", () => {
    expect(verbs.length).toBeGreaterThanOrEqual(21);
    expect(verbs).toContain("relation_removed");
  });

  it.each(verbs)("maps %s to exactly one subscribable work_item event", (verb) => {
    const event = eventForVerb(verb as never);
    expect(WORK_ITEM_EVENTS).toContain(event);
    expect(isSubscribableEvent(event)).toBe(true);
  });

  it.each([
    ["created", "work_item.created"],
    ["state_changed", "work_item.state_changed"],
    ["assigned", "work_item.assigned"],
    ["commented", "work_item.commented"],
    ["archived", "work_item.archived"],
    ["updated", "work_item.updated"],
  ])("%s → %s", (verb, event) => {
    expect(eventForVerb(verb as never)).toBe(event);
  });

  it("keeps `unassigned` out of `assigned`: an event named assigned never means someone was removed", () => {
    expect(eventForVerb("unassigned" as never)).toBe("work_item.updated");
  });

  it("sends every field-level verb through `updated`", () => {
    for (const verb of [
      "priority_changed", "due_date_changed", "title_changed", "description_changed",
      "label_added", "label_removed", "restored", "cycle_added", "cycle_removed",
      "parent_removed", "module_added", "module_removed", "relation_added", "relation_removed",
      "comment_edited", "comment_deleted", "watcher_added", "watcher_removed", "mentioned",
      "time_logged", "time_log_updated", "time_log_removed",
    ]) {
      expect(eventForVerb(verb as never), verb).toBe("work_item.updated");
    }
  });
});

describe("the vocabulary", () => {
  it("lets a webhook subscribe to the work-item events and nothing else", () => {
    expect([...SUBSCRIBABLE_EVENTS].sort()).toEqual([...WORK_ITEM_EVENTS].sort());
  });

  it("reserves sla.* and ticket.*: named, documented, not subscribable until something emits them", () => {
    expect(SLA_EVENTS).toEqual(["sla.at_risk", "sla.breached"]);
    expect(TICKET_EVENTS).toEqual(["ticket.created", "ticket.replied", "ticket.solved"]);
    for (const name of [...SLA_EVENTS, ...TICKET_EVENTS, WEBHOOK_TEST_EVENT, "work_item.deleted", "", "*"]) {
      expect(isSubscribableEvent(name), name).toBe(false);
    }
  });

  it("describes every subscribable event once, in plain words", () => {
    expect(WORK_EVENT_CATALOG.map((e) => e.name).sort()).toEqual([...WORK_ITEM_EVENTS].sort());
    for (const entry of WORK_EVENT_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.endsWith(".")).toBe(true);
      expect(entry.description + entry.label).not.toMatch(/!/);
    }
  });
});
