"use client";

// WARP-3537 — the command palette (`⌘K` / `Ctrl K`, brief §3.9): jump to a project or
// an item by key or title, create an item, switch view, and — with rows selected in the
// table — run a bulk action on them.
//
// What it offers is `commands.ts`'s (pure, tested); what it finds for a typed key or
// title is `useItemSearch`'s. This is the surface: the canonical `Dialog` (focus trap,
// Esc, scroll lock, focus back to where it was), and a combobox over a listbox — focus
// stays in the input, the highlighted option is `aria-activedescendant`, ↑ ↓ move it,
// Enter runs it, a click runs it. Closing happens BEFORE the command runs, so a command
// that navigates or opens another dialog is not fought by this one's focus return.

import "./palette.css";
import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Dialog } from "@/components/Dialog";
import type { PmProject } from "../types";
import { buildCommands, filterCommands, itemCommands, type CommandGroup, type PaletteCommand, type PaletteContext } from "./commands";
import { ITEM_SEARCH_MIN, useItemSearch } from "./useItemSearch";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  context: PaletteContext;
  /** Open the work item with this key — in whichever project it lives. */
  onOpenItem: (key: string) => void;
}

/** With nothing typed, the choices a person is most likely here for come first. */
const EMPTY_ORDER: CommandGroup[] = ["Selection", "Actions", "Views", "Projects", "Items"];

export function CommandPalette(p: CommandPaletteProps): JSX.Element | null {
  if (!p.open) return null;
  return <PaletteBody {...p} />;
}

function PaletteBody({ onClose, context, onOpenItem }: CommandPaletteProps): JSX.Element {
  const titleId = useId();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const search = useItemSearch(query, true);
  const results = useMemo<PaletteCommand[]>(() => {
    const all = buildCommands(context);
    const local = query.trim() === "" ? EMPTY_ORDER.flatMap((g) => all.filter((c) => c.group === g)) : filterCommands(all, query);
    const found = itemCommands(search.items, context.projects as PmProject[], (key) => onOpenItem(key));
    return [...local, ...found];
  }, [context, query, search.items, onOpenItem]);

  // A new query starts at the top.
  useEffect(() => setActive(0), [query]);
  // Keep the highlighted option in view as the arrow keys walk a long list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active, results]);

  const run = (c: PaletteCommand | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active]);
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  const empty = results.length === 0;
  const waiting = search.searching && query.trim().length >= ITEM_SEARCH_MIN;

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="lg" labelledBy={titleId} flush>
      <div className="pm-scope pm-cmdk">
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        <div className="pm-cmdk-search">
          <input
            className="pm-cmdk-input"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={empty ? undefined : optionId(active)}
            aria-label="Search projects, items and actions"
            placeholder="Search projects, items and actions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <ul ref={listRef} id={listId} role="listbox" aria-label="Results" className="pm-cmdk-list">
          {results.map((c, i) => (
            <li
              key={c.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={"pm-cmdk-item" + (i === active ? " active" : "")}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => run(c)}
            >
              {c.key && <span className="pm-mono pm-cmdk-key">{c.key}</span>}
              <span className="pm-cmdk-title">{c.title}</span>
              {c.hint && <span className="pm-cmdk-hint">{c.hint}</span>}
              <span className="pm-cmdk-right">
                {c.shortcut ? <kbd className="pm-kbd">{c.shortcut}</kbd> : <span className="pm-cmdk-group">{c.group}</span>}
              </span>
            </li>
          ))}
        </ul>
        {empty && (
          <div className="pm-cmdk-empty" role="status">
            {waiting ? "Searching…" : "Nothing matches that."}
          </div>
        )}
        {!empty && waiting && (
          <div className="pm-cmdk-empty" role="status">
            Searching items…
          </div>
        )}
        <div className="pm-cmdk-foot" aria-hidden>
          <span>
            <kbd className="pm-kbd">↑</kbd> <kbd className="pm-kbd">↓</kbd> to move
          </span>
          <span>
            <kbd className="pm-kbd">Enter</kbd> to run
          </span>
          <span>
            <kbd className="pm-kbd">Esc</kbd> to close
          </span>
        </div>
      </div>
    </Dialog>
  );
}
