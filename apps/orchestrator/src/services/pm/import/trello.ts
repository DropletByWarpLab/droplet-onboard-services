/**
 * WARP-3527 — a Trello board JSON export, flattened into the same
 * `ImportTable` the CSV presets read, so everything after parsing is shared.
 *
 * The export is one object: `lists`, `cards`, `labels`, `members`, `checklists`.
 * A card is one work item; the LIST it sits in is its status.
 *
 * Decisions, each of which would otherwise be a silent loss:
 *   - archived cards (`closed`) and cards in archived lists are NOT dropped
 *     here: they get `closed` / `listClosed` columns, and the normalizer skips
 *     them with the reason `archived_in_source`, so the summary counts them.
 *   - a label with no name is a colour swatch in Trello; its colour is its name.
 *   - checklists have no counterpart on a work item (sub-items are a follow-up),
 *     so each is appended to the description as `[x] done` / `[ ] open` lines
 *     rather than being lost.
 *   - the creation time is not in the export as a field, but a Trello id is a
 *     Mongo ObjectId whose first four bytes ARE the creation timestamp.
 *   - multi-value cells are joined with a newline, never a comma: names contain
 *     commas, and the Trello preset's list separator is a newline.
 */

import { IMPORT_MAX_ROWS, ImportParseError, assertImportSize } from "./csv.js";
import type { ImportTable } from "./types.js";

interface TrelloLabel {
  name?: string;
  color?: string | null;
}
interface TrelloCheckItem {
  name?: string;
  state?: string;
  pos?: number;
}
interface TrelloChecklist {
  idCard?: string;
  name?: string;
  pos?: number;
  checkItems?: TrelloCheckItem[];
}
interface TrelloCard {
  id?: string;
  name?: string;
  desc?: string;
  idList?: string;
  idMembers?: string[];
  labels?: TrelloLabel[];
  due?: string | null;
  start?: string | null;
  dueComplete?: boolean;
  closed?: boolean;
  dateLastActivity?: string | null;
  pos?: number;
}
interface TrelloBoard {
  lists?: Array<{ id?: string; name?: string; closed?: boolean; pos?: number }>;
  cards?: TrelloCard[];
  members?: Array<{ id?: string; fullName?: string; username?: string }>;
  checklists?: TrelloChecklist[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const objectRows = (value: unknown): boolean => Array.isArray(value) && value.every(
  (row) => row !== null && typeof row === "object" && !Array.isArray(row),
);

/** Creation time from a Trello card id (a Mongo ObjectId), or "". */
export function trelloCreatedFromId(id: string): string {
  if (!/^[0-9a-f]{24}$/i.test(id)) return "";
  const seconds = parseInt(id.slice(0, 8), 16);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : "";
}

function checklistText(lists: TrelloChecklist[]): string {
  return [...lists]
    .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
    .map((cl) => {
      const items = [...(cl.checkItems ?? [])]
        .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
        .map((it) => `${it.state === "complete" ? "[x]" : "[ ]"} ${str(it.name)}`);
      return [`Checklist: ${str(cl.name) || "Checklist"}`, ...items].join("\n");
    })
    .join("\n\n");
}

export function trelloToTable(buf: Buffer): ImportTable {
  assertImportSize(buf);
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let board: TrelloBoard;
  try {
    board = JSON.parse(text) as TrelloBoard;
  } catch {
    throw new ImportParseError("invalid_json", "This file isn't valid JSON.");
  }
  if (
    board === null ||
    typeof board !== "object" ||
    !Array.isArray(board.cards) ||
    !Array.isArray(board.lists)
  ) {
    throw new ImportParseError(
      "not_a_trello_export",
      "This JSON isn't a Trello board export (it needs both cards and lists).",
    );
  }
  if (
    !objectRows(board.cards) || !objectRows(board.lists) ||
    (board.members != null && !objectRows(board.members)) ||
    (board.checklists != null && !objectRows(board.checklists)) ||
    board.cards.some((card) =>
      (card.labels != null && !objectRows(card.labels)) ||
      (card.idMembers != null && (!Array.isArray(card.idMembers) || !card.idMembers.every((id) => typeof id === "string")))) ||
    (board.checklists ?? []).some((list) => list.checkItems != null && !objectRows(list.checkItems))
  ) {
    throw new ImportParseError("not_a_trello_export", "This JSON contains invalid Trello board entries.");
  }
  if (board.cards.length > IMPORT_MAX_ROWS) {
    throw new ImportParseError(
      "too_many_rows",
      `This board has more than ${IMPORT_MAX_ROWS.toLocaleString("en-US")} cards. Split it and import in parts.`,
      { max: IMPORT_MAX_ROWS },
    );
  }

  const lists = new Map(board.lists.map((l) => [str(l.id), l]));
  const members = new Map(
    (board.members ?? []).map((m) => [str(m.id), str(m.fullName) || str(m.username)]),
  );
  const checklistsByCard = new Map<string, TrelloChecklist[]>();
  for (const cl of board.checklists ?? []) {
    const id = str(cl.idCard);
    if (id) {
      const group = checklistsByCard.get(id);
      if (group) group.push(cl);
      else checklistsByCard.set(id, [cl]);
    }
  }

  const headers = [
    "id", "name", "desc", "list", "labels", "members", "due", "start",
    "created", "updated", "done", "closed", "listClosed",
  ];
  const rows = [...board.cards]
    .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
    .map((card) => {
      const id = str(card.id);
      const list = lists.get(str(card.idList));
      const desc = str(card.desc);
      const checks = checklistsByCard.get(id);
      const description =
        checks && checks.length > 0
          ? [desc, checklistText(checks)].filter((p) => p !== "").join("\n\n")
          : desc;
      return [
        id,
        str(card.name),
        description,
        str(list?.name),
        (card.labels ?? [])
          .map((l) => str(l.name).trim() || str(l.color))
          .filter((n) => n !== "")
          .join("\n"),
        (card.idMembers ?? [])
          .map((m) => members.get(m) ?? "")
          .filter((n) => n !== "")
          .join("\n"),
        str(card.due),
        str(card.start),
        trelloCreatedFromId(id),
        str(card.dateLastActivity),
        card.dueComplete === true ? "true" : "",
        card.closed === true ? "true" : "",
        list?.closed === true ? "true" : "",
      ];
    });
  return { headers, rows, delimiter: "json", warnings: [] };
}
