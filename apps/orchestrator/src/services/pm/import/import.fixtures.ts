/**
 * WARP-3527 — one realistic export per source, as the tool writes it.
 *
 * Used by the unit tests (the parse -> normalize -> plan pipeline) and by the
 * pg suite (end-to-end through the real service). They are code, not .csv
 * files, so the awkward bytes — BOM, CRLF, a quoted multi-line description, a
 * repeated `Labels` header — are visible and cannot be "fixed" by an editor.
 */

import { createHash } from "node:crypto";

export const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");

const csv = (lines: string[], eol = "\r\n", bom = false): Buffer =>
  Buffer.from((bom ? "\ufeff" : "") + lines.join(eol) + eol, "utf8");

/** Jira Cloud "Export CSV (all fields)": BOM, CRLF, quoted multi-line
 *  description, one `Labels` column PER label, `d/MMM/yy h:mm a` dates. */
export const JIRA_CSV = csv(
  [
    "Summary,Issue key,Issue id,Issue Type,Status,Status Category,Priority,Assignee,Reporter,Created,Updated,Resolved,Due date,Labels,Labels,Labels,Description,Parent id",
    '"Checkout revamp",PAY-1,10001,Epic,In Progress,In Progress,High,Dana Ortiz,Sam Lee,12/Mar/24 9:41 AM,14/Mar/24 10:00 AM,,31/Mar/24,frontend,,,"Rework the checkout flow.\r\n\r\nSee the design, then ""ship"" it.",',
    '"Add Apple Pay",PAY-2,10002,Story,To Do,To Do,Highest,Pat Nobody,Sam Lee,13/Mar/24 8:00 AM,13/Mar/24 8:00 AM,,,backend,payments,,"Wallet support.",10001',
    '"Crash when cart is empty",PAY-3,10003,Bug,Done,Done,Medium,Dana Ortiz,Dana Ortiz,10/Mar/24 1:15 PM,15/Mar/24 4:00 PM,15/Mar/24 4:00 PM,,bug,,,"Null deref in cart.",',
    '"Review gift-card copy",PAY-4,10004,Task,In Review,In Progress,Low,Sam Lee,Sam Lee,14/Mar/24 2:30 PM,14/Mar/24 2:30 PM,,15/Mar/24,,,,,10001',
    ",PAY-5,10005,Task,To Do,To Do,Low,,,14/Mar/24 2:30 PM,14/Mar/24 2:30 PM,,,,,,,",
  ],
  "\r\n",
  true,
);

/** Asana project CSV. Parent is by NAME; a sub-task follows its parent. */
export const ASANA_CSV = csv([
  "Task ID,Created At,Completed At,Last Modified,Name,Section/Column,Assignee,Assignee Email,Start Date,Due Date,Tags,Notes,Projects,Parent task",
  '1001,2024-03-01,,2024-03-05,Plan launch,Doing,Dana Ortiz,dana@example.com,2024-03-04,2024-04-01,"launch, marketing","Kick-off notes",Launch,',
  '1002,2024-03-02,,2024-03-05,Draft press release,To do,,sam@example.com,,2024-03-20,launch,"Two paragraphs",Launch,Plan launch',
  "1003,2024-03-02,2024-03-06,2024-03-06,Book venue,Done,Dana Ortiz,dana@example.com,,2024-03-10,,,Launch,",
]);

/** Linear CSV: Canceled / Completed timestamps, comma-separated Labels, API-style parent. */
export const LINEAR_CSV = csv([
  "ID,Team,Title,Description,Status,Estimate,Priority,Project,Creator,Assignee,Labels,Created,Updated,Started,Completed,Canceled,Archived,Due Date,Parent issue",
  'ENG-1,Engineering,Ship v2,"Release plan",In Progress,3,Urgent,Roadmap,Sam Lee,Dana Ortiz,"Bug, Customer",2024-03-01T10:00:00.000Z,2024-03-05T10:00:00.000Z,2024-03-02T10:00:00.000Z,,,,2024-04-15,',
  "ENG-2,Engineering,Fix login,,Canceled,,No priority,Roadmap,Sam Lee,,,2024-03-01T10:00:00.000Z,2024-03-05T10:00:00.000Z,,,2024-03-04T10:00:00.000Z,,,ENG-1",
  "ENG-3,Engineering,Write docs,,Done,,Low,Roadmap,Dana Ortiz,Dana Ortiz,Docs,2024-03-01T10:00:00.000Z,2024-03-05T10:00:00.000Z,,2024-03-05T10:00:00.000Z,,,,ENG-1",
]);

/** A GitHub issues CSV: lists of logins and labels, an open and a closed issue. */
export const GITHUB_CSV = csv([
  "number,title,state,labels,assignees,milestone,body",
  '12,Crash on start,open,"bug,help wanted","octocat,jdoe",v1.0,"Steps:\n1. open the app\n2. crash"',
  "13,Docs typo,closed,documentation,octocat,,",
]);

/** Generic spreadsheet, semicolon-delimited (a non-US Excel). */
export const GENERIC_SEMICOLON_CSV = csv(
  [
    "Title;Status;Assignee;Due;Tags;Priority",
    "Order paper;Open;dana@example.com;31/03/2024;office;Low",
    "Fix the lock;Closed;Sam Lee;04/04/2024;facilities;High",
  ],
  "\n",
);

/** A Trello board export: lists (one archived), cards, labels, members, checklists. */
export const TRELLO_JSON = Buffer.from(
  JSON.stringify({
    id: "65f0a0a0a0a0a0a0a0a0a0a0",
    name: "Launch board",
    lists: [
      { id: "l1", name: "To Do", closed: false, pos: 1 },
      { id: "l2", name: "Doing", closed: false, pos: 2 },
      { id: "l3", name: "Done", closed: false, pos: 3 },
      { id: "l4", name: "Old ideas", closed: true, pos: 4 },
    ],
    members: [
      { id: "m1", fullName: "Dana Ortiz", username: "dana" },
      { id: "m2", fullName: "", username: "samlee" },
    ],
    labels: [],
    checklists: [
      {
        idCard: "65f1b1b1b1b1b1b1b1b1b1b1",
        name: "Before launch",
        pos: 1,
        checkItems: [
          { name: "Proof the copy", state: "complete", pos: 1 },
          { name: "Brief support", state: "incomplete", pos: 2 },
        ],
      },
    ],
    cards: [
      {
        id: "65f1b1b1b1b1b1b1b1b1b1b1",
        name: "Write launch post",
        desc: "Draft, then review.",
        idList: "l2",
        idMembers: ["m1", "m2"],
        labels: [{ name: "Marketing", color: "green" }, { name: "", color: "purple" }],
        due: "2024-03-20T17:00:00.000Z",
        start: null,
        dueComplete: false,
        closed: false,
        pos: 1,
        dateLastActivity: "2024-03-10T10:00:00.000Z",
      },
      {
        id: "65f2c2c2c2c2c2c2c2c2c2c2",
        name: "Pick a date",
        desc: "",
        idList: "l3",
        idMembers: [],
        labels: [],
        due: "2024-03-01T12:00:00.000Z",
        dueComplete: true,
        closed: false,
        pos: 2,
      },
      {
        id: "65f3d3d3d3d3d3d3d3d3d3d3",
        name: "Archived card",
        desc: "",
        idList: "l1",
        idMembers: [],
        labels: [],
        closed: true,
        pos: 3,
      },
      {
        id: "65f4e4e4e4e4e4e4e4e4e4e4",
        name: "Idea in a closed list",
        desc: "",
        idList: "l4",
        idMembers: [],
        labels: [],
        closed: false,
        pos: 4,
      },
    ],
  }),
  "utf8",
);
