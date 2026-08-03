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
import type { FileEntryInfo, FileSpacesResponse } from "@/lib/types";

export interface PickedFile {
  ncFileId: number;
  name: string;
  path: string;
}

export function ForwardFileDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (file: PickedFile) => void;
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

  const spaces = useMemo(
    () => spacesResp?.spaces ?? [{ id: "personal", name: "My Files" }],
    [spacesResp],
  );

  function up() {
    const parent = path.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
    setPath(parent.length > 0 ? parent : "/");
  }

  return (
    <Dialog open={open} onClose={onClose} labelledBy="forward-file-title">
      <div>
        <h2 id="forward-file-title" className="type-headline text-label-primary">
          Forward a file
        </h2>
        <p className="mt-0.5 type-footnote text-label-tertiary">
          The message links the file — access still follows Files permissions.
        </p>

        <div className="mt-3 flex gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files"
            aria-label="Search files"
            className="dp-input flex-1"
          />
          {!searching && spaces.length > 1 && (
            <select
              value={space}
              onChange={(e) => {
                setSpace(e.target.value);
                setPath("/");
              }}
              aria-label="Files space"
              className="dp-input w-36"
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-separator divide-y divide-separator">
          {!searching && path !== "/" && (
            <button
              type="button"
              onClick={up}
              className="
                w-full flex items-center gap-2.5 px-3 py-2 text-left
                type-footnote text-label-secondary
                hover:bg-surface-secondary transition-colors duration-200 ease-smooth
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
              "
            >
              <CornerLeftUp size={15} aria-hidden="true" />
              Up one folder
            </button>
          )}

          {isLoading && (
            <p className="px-3 py-3 type-footnote text-label-tertiary">
              {searching ? "Searching…" : "Loading files…"}
            </p>
          )}
          {error != null && (
            <p className="px-3 py-3 type-footnote text-system-red">
              Couldn&apos;t load files. Try again.
            </p>
          )}
          {entries && entries.length === 0 && (
            <p className="px-3 py-3 type-footnote text-label-tertiary">
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
                    setPath(entry.path);
                  }}
                  className="
                    w-full flex items-center gap-2.5 px-3 py-2 text-left
                    hover:bg-surface-secondary transition-colors duration-200 ease-smooth
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                  "
                >
                  <Folder size={16} className="text-label-tertiary flex-shrink-0" aria-hidden="true" />
                  <span className="type-subheadline text-label-primary truncate">
                    {entry.name}
                  </span>
                </button>
              );
            }
            const pickable = typeof entry.ncFileId === "number";
            return (
              <button
                key={entry.path}
                type="button"
                disabled={!pickable}
                onClick={() =>
                  pickable &&
                  onPick({
                    ncFileId: entry.ncFileId as number,
                    name: entry.name,
                    path: entry.path,
                  })
                }
                title={pickable ? undefined : "This file can't be forwarded yet"}
                className="
                  w-full flex items-center gap-2.5 px-3 py-2 text-left
                  hover:bg-surface-secondary transition-colors duration-200 ease-smooth
                  disabled:opacity-50 disabled:hover:bg-transparent
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                "
              >
                <FileText size={16} className="text-label-tertiary flex-shrink-0" aria-hidden="true" />
                <span className="flex-1 min-w-0">
                  <span className="block type-subheadline text-label-primary truncate">
                    {entry.name}
                  </span>
                  <span className="block type-caption-2 text-label-tertiary truncate">
                    {entry.path}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="dp-btn-secondary">
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
}: {
  open: boolean;
  onClose: () => void;
  onPick: (conversation: ConversationSummary) => void;
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
        <h2 id="forward-chat-title" className="type-headline text-label-primary">
          Forward an AI chat
        </h2>
        <p className="mt-0.5 type-footnote text-label-tertiary">
          A snapshot of the conversation is shared — later edits or deletion
          won&apos;t change what they see.
        </p>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your conversations"
          aria-label="Search your conversations"
          className="dp-input w-full mt-3"
        />

        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-separator divide-y divide-separator">
          {isLoading && (
            <p className="px-3 py-3 type-footnote text-label-tertiary">
              Loading conversations…
            </p>
          )}
          {error != null && (
            <p className="px-3 py-3 type-footnote text-system-red">
              Couldn&apos;t load conversations. Try again.
            </p>
          )}
          {conversations && conversations.length === 0 && (
            <p className="px-3 py-3 type-footnote text-label-tertiary">
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
              className="
                w-full flex items-center gap-2.5 px-3 py-2 text-left
                hover:bg-surface-secondary transition-colors duration-200 ease-smooth
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
              "
            >
              <MessageSquare
                size={16}
                className="text-label-tertiary flex-shrink-0"
                aria-hidden="true"
              />
              <span className="flex-1 min-w-0">
                <span className="block type-subheadline text-label-primary truncate">
                  {c.title ?? "Untitled conversation"}
                </span>
                <span className="block type-caption-2 text-label-tertiary">
                  {new Date(c.updatedAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="dp-btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
