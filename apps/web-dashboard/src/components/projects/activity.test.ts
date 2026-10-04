// Pure helpers behind the work-item Activity section (WARP-3519): the one
// sentence per activity verb, what the inline editor can round-trip, and the
// small reaction / mention-candidate transforms.

import { describe, it, expect } from "vitest";
import { PM_ACTIVITY_VERBS, PM_REACTION_EMOJI, type PmActivityVerbName } from "@droplet/shared-types";
import {
  ACTIVITY_FILTERS,
  applyReaction,
  describeActivity,
  emptyCopy,
  filterTimeline,
  isPlainEditable,
  mentionCandidatesFrom,
  reactionName,
  reactionTitle,
  type ActivityContext,
} from "./activity";
import type { PmActivity, PmComment, PmReaction, PmTimelineEntry, PmTimelineRefs } from "./types";

const NAMES: Record<string, string> = { u1: "Ada", u2: "Bea", u3: "Cy" };

const REFS: PmTimelineRefs = {
  states: { s2: "In Progress" },
  labels: { l1: { name: "bug", color: "#ef4444" } },
  workItems: { w2: { key: "INBOX-2", name: "Other item" } },
};

const ctx: ActivityContext = {
  name: (id) => (id ? (NAMES[id] ?? `User ${id}`) : "someone"),
  refs: REFS,
};

function act(verb: string, over: Partial<PmActivity> = {}): PmActivity {
  return {
    id: "a1",
    workItemId: "w1",
    actorId: "u1",
    verb: verb as PmActivityVerbName,
    field: null,
    oldValue: null,
    newValue: null,
    createdAt: "2026-06-22T21:16:00.000Z",
    ...over,
  };
}

describe("describeActivity — one sentence per verb", () => {
  it("renders a human sentence for EVERY verb the schema knows (never the raw snake_case token)", () => {
    for (const verb of PM_ACTIVITY_VERBS) {
      const sentence = describeActivity(act(verb, { oldValue: "u2", newValue: "u2" }), ctx);
      expect(sentence.length, verb).toBeGreaterThan(0);
      expect(sentence, verb).not.toBe(verb);
      expect(sentence, verb).not.toContain("_");
    }
  });

  const cases: Array<[string, PmActivity, string]> = [
    ["created", act("created"), "created this item"],
    ["updated · priority", act("updated", { field: "priority" }), "changed the priority"],
    ["updated · department", act("updated", { field: "department" }), "changed the department"],
    ["updated · startDate", act("updated", { field: "startDate" }), "changed the start date"],
    ["updated · legacy fields", act("updated", { field: "fields" }), "updated this item"],
    ["updated · no field", act("updated"), "updated this item"],
    ["state_changed", act("state_changed", { newValue: "s2" }), "moved this to In Progress"],
    ["state_changed · state gone", act("state_changed", { newValue: "gone" }), "moved this to another state"],
    ["assigned · other", act("assigned", { newValue: "u2" }), "assigned Bea"],
    ["assigned · self", act("assigned", { newValue: "u1" }), "assigned themselves"],
    ["assigned · by the AI (no actor)", act("assigned", { actorId: null, newValue: "u2" }), "assigned Bea"],
    ["unassigned · other", act("unassigned", { oldValue: "u2" }), "unassigned Bea"],
    ["unassigned · self", act("unassigned", { oldValue: "u1" }), "unassigned themselves"],
    ["priority_changed", act("priority_changed", { newValue: "high" }), "set the priority to High"],
    ["priority_changed · unknown value", act("priority_changed", { newValue: "wat" }), "changed the priority"],
    [
      "due_date_changed · set",
      act("due_date_changed", { newValue: "2026-07-01T00:00:00.000Z" }),
      "set the due date to 2026-07-01",
    ],
    ["due_date_changed · cleared", act("due_date_changed"), "removed the due date"],
    ["title_changed", act("title_changed", { newValue: "Ship it" }), 'renamed this to "Ship it"'],
    ["description_changed", act("description_changed"), "edited the description"],
    ["label_added", act("label_added", { newValue: "l1" }), "added the label bug"],
    ["label_added · label gone", act("label_added", { newValue: "gone" }), "added the label a label"],
    ["label_removed", act("label_removed", { oldValue: "l1" }), "removed the label bug"],
    ["label_removed · label gone", act("label_removed", { oldValue: "gone" }), "removed the label a label"],
    ["archived", act("archived"), "archived this item"],
    ["restored", act("restored"), "restored this item"],
    ["cycle_added", act("cycle_added"), "added this to a cycle"],
    ["cycle_removed", act("cycle_removed"), "removed this from a cycle"],
    ["module_added", act("module_added"), "added this to a module"],
    ["module_removed", act("module_removed"), "removed this from a module"],
    ["parent_removed", act("parent_removed"), "removed this item's parent"],
    ["relation_added · blocks", act("relation_added", { newValue: "BLOCKS:w2" }), "linked this with INBOX-2 (blocks)"],
    [
      "relation_added · relates",
      act("relation_added", { newValue: "RELATES:w2" }),
      "linked this with INBOX-2 (relates to)",
    ],
    [
      "relation_added · duplicates",
      act("relation_added", { newValue: "DUPLICATES:w2" }),
      "linked this with INBOX-2 (duplicates)",
    ],
    [
      "relation_added · item gone",
      act("relation_added", { newValue: "BLOCKS:gone" }),
      "linked this with another item (blocks)",
    ],
    [
      "relation_removed",
      act("relation_removed", { oldValue: "RELATES:w2" }),
      "unlinked this from INBOX-2 (relates to)",
    ],
    ["comment_edited", act("comment_edited"), "edited a comment"],
    ["comment_deleted", act("comment_deleted"), "deleted a comment"],
    ["commented", act("commented"), "added a comment"],
    ["mentioned", act("mentioned", { newValue: "u2" }), "mentioned Bea"],
    ["watcher_added · self", act("watcher_added", { newValue: "u1" }), "started watching this"],
    ["watcher_added · other", act("watcher_added", { newValue: "u2" }), "added Bea as a watcher"],
    ["watcher_removed · self", act("watcher_removed", { oldValue: "u1" }), "stopped watching this"],
    ["watcher_removed · other", act("watcher_removed", { oldValue: "u2" }), "removed Bea as a watcher"],
  ];

  it.each(cases)("%s", (_label, activity, expected) => {
    expect(describeActivity(activity, ctx)).toBe(expected);
  });

  it("does not read a missing value as 'themselves' just because the actor is also missing", () => {
    expect(describeActivity(act("watcher_added", { actorId: null, newValue: null }), ctx)).toBe(
      "added someone as a watcher",
    );
  });

  it("falls back to a safe generic sentence for a verb a newer server invented", () => {
    expect(describeActivity(act("teleported"), ctx)).toBe("did something");
  });
});

describe("isPlainEditable — only HTML the dashboard editor can round-trip", () => {
  it("accepts everything the toolbar can author", () => {
    expect(
      isPlainEditable(
        '<p>Hi <strong>there</strong> <em>you</em><br><a href="https://x.test">link</a> <code>x</code></p>' +
          "<ul><li>a</li></ul><ol><li>b</li></ol><pre><code>code</code></pre><blockquote><p>q</p></blockquote>",
      ),
    ).toBe(true);
  });

  it("accepts a mention span", () => {
    expect(isPlainEditable('<p><span data-mention-id="u1">@Ada</span> look</p>')).toBe(true);
  });

  it("refuses a span that is not a mention", () => {
    expect(isPlainEditable("<p><span>x</span></p>")).toBe(false);
  });

  it.each([
    ["a heading", "<h2>Title</h2>"],
    ["an image", '<p><img src="x.png"></p>'],
    ["a table", "<table><tbody><tr><td>x</td></tr></tbody></table>"],
    ["a div", "<div>x</div>"],
    ["underline", "<p><u>x</u></p>"],
    ["strikethrough", "<p><s>x</s></p>"],
    ["a rule", "<hr>"],
    ["a script hoisted into <head>", "<script>1</script><p>x</p>"],
  ])("refuses %s (Edit would silently drop it)", (_label, html) => {
    expect(isPlainEditable(html)).toBe(false);
  });

  it("treats plain text with no tags as editable", () => {
    expect(isPlainEditable("just words")).toBe(true);
  });
});

describe("reactionName / reactionTitle", () => {
  it("names every allowlisted emoji for its accessible label", () => {
    expect(PM_REACTION_EMOJI.map(reactionName)).toEqual([
      "thumbs up",
      "thumbs down",
      "smile",
      "party",
      "confused",
      "heart",
      "rocket",
      "eyes",
    ]);
  });

  it("falls back to the glyph itself for an emoji it does not know", () => {
    expect(reactionName("🦄")).toBe("🦄");
  });

  it("lists up to five names, then 'and N more'", () => {
    expect(reactionTitle(["A"])).toBe("A");
    expect(reactionTitle(["A", "B", "C", "D", "E"])).toBe("A, B, C, D, E");
    expect(reactionTitle(["A", "B", "C", "D", "E", "F"])).toBe("A, B, C, D, E and 1 more");
    expect(reactionTitle(["A", "B", "C", "D", "E", "F", "G", "H"])).toBe("A, B, C, D, E and 3 more");
  });
});

describe("applyReaction — the optimistic toggle", () => {
  const [UP, DOWN, , , , HEART] = PM_REACTION_EMOJI;
  const base: PmReaction[] = [{ emoji: UP, count: 1, userIds: ["u2"] }];

  it("adds the viewer to an existing reaction", () => {
    expect(applyReaction(base, UP, "u1", true)).toEqual([{ emoji: UP, count: 2, userIds: ["u2", "u1"] }]);
  });

  it("is idempotent when the viewer is already on it", () => {
    expect(applyReaction(base, UP, "u2", true)).toEqual(base);
  });

  it("starts a new reaction in allowlist order, not at the end", () => {
    const withHeart: PmReaction[] = [{ emoji: HEART, count: 1, userIds: ["u2"] }];
    expect(applyReaction(withHeart, DOWN, "u1", true).map((r) => r.emoji)).toEqual([DOWN, HEART]);
    expect(applyReaction(withHeart, UP, "u1", true).map((r) => r.emoji)).toEqual([UP, HEART]);
  });

  it("removes the viewer and keeps the others", () => {
    const two: PmReaction[] = [{ emoji: UP, count: 2, userIds: ["u1", "u2"] }];
    expect(applyReaction(two, UP, "u1", false)).toEqual([{ emoji: UP, count: 1, userIds: ["u2"] }]);
  });

  it("drops a reaction nobody is on any more", () => {
    expect(applyReaction([{ emoji: UP, count: 1, userIds: ["u1"] }], UP, "u1", false)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input: PmReaction[] = [{ emoji: UP, count: 1, userIds: ["u2"] }];
    applyReaction(input, UP, "u1", true);
    expect(input).toEqual([{ emoji: UP, count: 1, userIds: ["u2"] }]);
  });
});

describe("mentionCandidatesFrom", () => {
  it("is undefined while the directory is unavailable (the editor says so)", () => {
    expect(mentionCandidatesFrom(undefined)).toBeUndefined();
  });

  it("maps directory users to {id: local User.id, name}, skipping users with no local row", () => {
    expect(
      mentionCandidatesFrom([
        { userId: "u1", displayName: "Ada" },
        { userId: null, displayName: "No Row" },
        { displayName: "Also No Row" },
        { userId: "u2", displayName: "Bea" },
      ]),
    ).toEqual([
      { id: "u1", name: "Ada" },
      { id: "u2", name: "Bea" },
    ]);
  });

  it("is an empty list (not undefined) for a directory with nobody in it", () => {
    expect(mentionCandidatesFrom([])).toEqual([]);
  });
});

describe("filterTimeline / emptyCopy", () => {
  const comment = { id: "c1", authorId: "u1" } as PmComment;
  const entries: PmTimelineEntry[] = [
    { type: "comment", id: "c1", at: "2026-06-22T10:00:00.000Z", comment },
    { type: "activity", id: "a1", at: "2026-06-22T11:00:00.000Z", activity: act("created") },
    { type: "comment", id: "c2", at: "2026-06-22T12:00:00.000Z", comment: { ...comment, id: "c2" } },
  ];

  it("offers All / Comments / History, All first", () => {
    expect(ACTIVITY_FILTERS.map((f) => f.label)).toEqual(["All", "Comments", "History"]);
    expect(ACTIVITY_FILTERS[0].id).toBe("all");
  });

  it("keeps order and picks by entry type", () => {
    expect(filterTimeline(entries, "all").map((e) => e.id)).toEqual(["c1", "a1", "c2"]);
    expect(filterTimeline(entries, "comments").map((e) => e.id)).toEqual(["c1", "c2"]);
    expect(filterTimeline(entries, "history").map((e) => e.id)).toEqual(["a1"]);
  });

  it("says 'No comments yet.' for the comments filter and 'No activity yet.' otherwise", () => {
    expect(emptyCopy("comments")).toBe("No comments yet.");
    expect(emptyCopy("all")).toBe("No activity yet.");
    expect(emptyCopy("history")).toBe("No activity yet.");
  });
});
