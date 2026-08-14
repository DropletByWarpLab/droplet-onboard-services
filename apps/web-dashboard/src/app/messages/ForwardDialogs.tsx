"use client";

/**
 * WARP-1683 — the two forward pickers.
 *
 * ForwardFileDialog — minimal Files picker over the EXISTING helpers
 * (fetchFiles / searchFiles / fetchSpaces): a space selector, folder
 * navigation, and a search box. Only real files with a known `ncFileId`
 * are selectable — the id is what the orchestrator's space gate keys on,
 * so an entry without one (older orchestrator response) is shown disabled
 * rather than silently un-forwardable after the fact.
 *
 * ForwardChatDialog — the caller's AI conversations via the existing
 * listConversations helper, with its server-side search.
 */

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { CornerLeftUp, FileText, Folder, MessageSquare } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import {
  fetchFiles,
  fetchSpaces,
  listConversations,
  searchFiles,
  type ConversationSummary,
} from "@/lib/api";
import type {
  FileEntryInfo,
  FileSpace,
  FileSpaceId,
  FileSpacesResponse,
} from "@/lib/types";
// WARP-1808 — display-only "Workspace" mapping for the household space; the
// option VALUE stays the raw space id the files API expects.
import { spaceRenderName } from "@/lib/space-attribution";
// WARP-1934 — the same translation the Files page navigates with. Listing
// entries are HOME-relative; every path that travels next to a `space` has to
// be relative to THAT space's root.
import { toSpaceRelativePath } from "@/components/FileManager/search-target";

export interface PickedFile {
  ncFileId: number;
  name: string;
  path: string;
  /**
   * WARP-1898 — the space `path` is relative to. `undefined` when the pick
   * came from the SEARCH tab: that search spans every space the caller can
   * reach and the results carry no space of their own, so the selector's
   * current value would be a guess. Omitting it lets the server decide from
   * the file registry rather than recording something we don't know.
   */
  space?: FileSpaceId;
}

/**
 * UX review (WARP-1683): the composer's typed draft rides along as the
 * forward's caption — that used to be silent. Both pickers disclose it
 * right above the actions, so nothing sends that the user didn't see.
 */
function NoteFooter({ note }: { note?: string }) {
  if (!note || note.length === 0) return null;
  return (
    <p className="mx-quiet mt-3 truncate">
      Sends with your note: &ldquo;{note}&rdquo;
    </p>
  );
}

/** Both list fetches cap at 50 — say so instead of implying completeness. */
function CapNotice({ shown }: { shown: boolean }) {
  if (!shown) return null;
  return (
    <p className="mx-quiet px-3 py-2">Showing first 50 — refine your search.</p>
  );
}

export function ForwardFileDialog({
  open,
  onClose,
  onPick,
  note,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (file: PickedFile) => void;
  /** The composer draft that will send as this forward's caption. */
  note?: string;
}) {
  const [space, setSpace] = useState<string>("personal");
  const [path, setPath] = useState<string>("/");
  const [query, setQuery] = useState("");

  // Reset navigation whenever the dialog reopens.
  useEffect(() => {
    if (open) {
      setPath("/");
      setQuery("");
    }
  }, [open]);

  const { data: spacesResp } = useSWR<FileSpacesResponse>(
    open ? "/api/files/spaces" : null,
    fetchSpaces,
    { shouldRetryOnError: false },
  );

  const searching = query.trim().length > 0;
  const listKey = open
    ? searching
      ? ["team-chat-file-search", query.trim()]
      : ["team-chat-file-browse", space, path]
    : null;
  const { data: entries, isLoading, error } = useSWR<FileEntryInfo[]>(
    listKey,
    () =>
      searching
        ? searchFiles(query.trim(), { limit: 50 })
        : fetchFiles(path, space),
    { shouldRetryOnError: false },
  );

  // WARP-1934 — the pre-probe fallback is typed as a real FileSpace now that
  // `root` is read below; "/" is what the server sends for the personal space,
  // so the placeholder and the real payload agree.
  const spaces = useMemo<FileSpace[]>(
    () => spacesResp?.spaces ?? [{ id: "personal", name: "My Files", root: "/" }],
    [spacesResp],
  );

  // WARP-1934 — the active space's mount point ("/Household", "/Finance", …);
  // "/" for the personal space, which has no prefix to strip. Listing entries
  // come back HOME-relative, but `path` here is SPACE-relative: the files API
  // re-prefixes it server-side from `space` (`rootForSpace`). Feeding an entry
  // path straight back therefore asked for "/Household/Household/…" — the
  // WARP-1140 trap, which renders as a silently empty folder.
  const activeSpaceRoot = useMemo(
    () => spaces.find((s) => s.id === space)?.root ?? "/",
    [spaces, space],
  );

  function up() {
    const parent = path.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
    setPath(parent.length > 0 ? parent : "/");
  }

  return (
    <Dialog open={open} onClose={onClose} labelledBy="forward-file-title">
      <div>
        <h2 id="forward-file-title" className="mx-dlg-title">
          Forward a file
        </h2>
        <p className="mx-dlg-sub">
          The message links the file — access still follows Files permissions.
        </p>

        <div className="mt-3 flex gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files"
            aria-label="Search files"
            className="mx-field flex-1"
          />
          {!searching && spaces.length > 1 && (
            <select
              value={space}
              onChange={(e) => {
                setSpace(e.target.value);
                setPath("/");
              }}
              aria-label="Files space"
              className="mx-field w-36"
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {spaceRenderName(s)}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="mx-list mt-2 max-h-64">
          {!searching && path !== "/" && (
            <button type="button" onClick={up} className="mx-row items-center">
              <CornerLeftUp size={15} aria-hidden="true" />
              <span className="mx-row-preview">Up one folder</span>
            </button>
          )}

          {isLoading && (
            <p className="mx-quiet px-3 py-3">
              {searching ? "Searching…" : "Loading files…"}
            </p>
          )}
          {error != null && (
            <p className="mx-error px-3 py-3">
              Couldn&apos;t load files. Try again.
            </p>
          )}
          {entries && entries.length === 0 && (
            <p className="mx-quiet px-3 py-3">
              {searching ? "No files match that search." : "This folder is empty."}
            </p>
          )}

          {entries?.map((entry) => {
            if (entry.isDirectory) {
              return (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setPath(toSpaceRelativePath(entry.path, activeSpaceRoot));
                  }}
                  className="mx-row items-center"
                >
                  <Folder size={16} className="flex-shrink-0" aria-hidden="true" />
                  <span className="mx-row-name truncate">{entry.name}</span>
                </button>
              );
            }
            const pickable = typeof entry.ncFileId === "number";
            // UX review: an un-pickable row stays FOCUSABLE with
            // aria-disabled + a visible reason line — `disabled` + a title
            // tooltip is unreachable by keyboard and invisible to SRs.
            return (
              <button
                key={entry.path}
                type="button"
                aria-disabled={!pickable}
                onClick={() =>
                  pickable &&
                  onPick({
                    ncFileId: entry.ncFileId as number,
                    name: entry.name,
                    // WARP-1934 — the path's vocabulary has to match whether a
                    // space travels with it. Browsed pick: space-relative, to
                    // be re-prefixed from `space`. Searched pick: no space, so
                    // the raw HOME-relative path the registry resolves.
                    path: searching
                      ? entry.path
                      : toSpaceRelativePath(entry.path, activeSpaceRoot),
                    // Browsed pick → the selector IS the space. Searched
                    // pick → unknown, so say nothing (see PickedFile).
                    space: searching ? undefined : space,
                  })
                }
                className={`mx-row items-center ${pickable ? "" : "is-disabled"}`}
              >
                <FileText size={16} className="flex-shrink-0" aria-hidden="true" />
                <span className="flex-1 min-w-0">
                  <span className="mx-row-name block truncate">{entry.name}</span>
                  {pickable ? (
                    <span className="mx-row-preview block truncate">
                      {entry.path}
                    </span>
                  ) : (
                    <span className="mx-row-preview block">
                      Can&apos;t be forwarded yet
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          <CapNotice shown={searching && (entries?.length ?? 0) === 50} />
        </div>

        <NoteFooter note={note} />
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function ForwardChatDialog({
  open,
  onClose,
  onPick,
  note,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (conversation: ConversationSummary) => void;
  /** The composer draft that will send as this forward's caption. */
  note?: string;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const { data: conversations, isLoading, error } = useSWR<ConversationSummary[]>(
    open ? ["team-chat-conversation-pick", query.trim()] : null,
    () =>
      listConversations({
        limit: 50,
        offset: 0,
        ...(query.trim().length > 0 ? { q: query.trim() } : {}),
      }),
    { shouldRetryOnError: false },
  );

  return (
    <Dialog open={open} onClose={onClose} labelledBy="forward-chat-title">
      <div>
        <h2 id="forward-chat-title" className="mx-dlg-title">
          Forward an AI chat
        </h2>
        <p className="mx-dlg-sub">
          A snapshot of the conversation is shared — later edits or deletion
          won&apos;t change what they see.
        </p>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your conversations"
          aria-label="Search your conversations"
          className="mx-field mt-3"
        />

        <div className="mx-list mt-2 max-h-64">
          {isLoading && (
            <p className="mx-quiet px-3 py-3">Loading conversations…</p>
          )}
          {error != null && (
            <p className="mx-error px-3 py-3">
              Couldn&apos;t load conversations. Try again.
            </p>
          )}
          {conversations && conversations.length === 0 && (
            <p className="mx-quiet px-3 py-3">
              {query
                ? "No conversations match that search."
                : "No AI conversations yet."}
            </p>
          )}
          {conversations?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c)}
              className="mx-row items-center"
            >
              <MessageSquare
                size={16}
                className="flex-shrink-0"
                aria-hidden="true"
              />
              <span className="flex-1 min-w-0">
                <span className="mx-row-name block truncate">
                  {c.title ?? "Untitled conversation"}
                </span>
                <span className="mx-row-preview block">
                  {new Date(c.updatedAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </span>
            </button>
          ))}
          <CapNotice shown={(conversations?.length ?? 0) === 50} />
        </div>

        <NoteFooter note={note} />
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
