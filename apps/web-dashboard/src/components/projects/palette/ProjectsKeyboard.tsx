"use client";

// WARP-3537 — the keyboard layer of /projects: the document-level shortcuts, the
// `?` sheet and the ⌘K palette, wired to the page. One component so the page adds ONE
// element, and so the two dialogs and the handler that opens them cannot drift apart.
//
// It owns nothing but "is the palette open, is the sheet open". What a key DOES comes in:
// the table's own moves through `tableApi`, the page's through callbacks.

import { useMemo, useState, type JSX, type RefObject } from "react";
import type { TableApi } from "../table/TableView";
import { CommandPalette } from "./CommandPalette";
import type { PaletteContext } from "./commands";
import { ShortcutSheet } from "./ShortcutSheet";
import { useProjectShortcuts, type ShortcutActions } from "./useProjectShortcuts";

/** The filter bar's search box — the thing `/` focuses. Pinned by a test that renders the real FilterBar. */
export const SEARCH_SELECTOR = 'input[aria-label="Search work items"]';

export interface ProjectsKeyboardProps {
  enabled: boolean;
  /** The page's own modal (the drawer, New item) is up: nothing here acts. */
  blocked: boolean;
  readOnly: boolean;
  /** Where the table keys (j, k, x, e, a, s, p) are sent; null when no table is on screen. */
  tableApi: RefObject<TableApi | null> | null;
  /** `c`: create in the open project; null when there is none. */
  onCreate: (() => void) | null;
  selectionCount: number;
  onClearSelection: () => void;
  onOpenItem: (key: string) => void;
  palette: Omit<PaletteContext, "handlers"> & { handlers: Omit<PaletteContext["handlers"], "showShortcuts"> };
}

export function ProjectsKeyboard(p: ProjectsKeyboardProps): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const table = (act: (t: TableApi) => void) => (): boolean => {
    const t = p.tableApi?.current;
    if (!t) return false;
    act(t);
    return true;
  };

  const actions: ShortcutActions = {
    palette: () => {
      setSheetOpen(false);
      setPaletteOpen((o) => !o);
    },
    help: () => {
      setPaletteOpen(false);
      setSheetOpen((o) => !o);
    },
    create: () => {
      if (!p.onCreate) return false;
      p.onCreate();
    },
    search: () => {
      const input = document.querySelector<HTMLInputElement>(SEARCH_SELECTOR);
      if (!input) return false;
      input.focus();
      input.select();
    },
    next: table((t) => t.move(1)),
    prev: table((t) => t.move(-1)),
    select: table((t) => t.toggleSelect()),
    edit: table((t) => t.edit("name")),
    assign: table((t) => t.edit("assignees")),
    state: table((t) => t.edit("state")),
    priority: table((t) => t.edit("priority")),
    clear: () => {
      if (p.selectionCount === 0) return false;
      p.onClearSelection();
    },
  };
  useProjectShortcuts({ enabled: p.enabled, blocked: p.blocked, readOnly: p.readOnly, actions });

  const context: PaletteContext = useMemo(
    () => ({ ...p.palette, handlers: { ...p.palette.handlers, showShortcuts: () => setSheetOpen(true) } }),
    [p.palette],
  );

  return (
    <>
      <ShortcutSheet open={sheetOpen} readOnly={p.readOnly} onClose={() => setSheetOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} context={context} onOpenItem={p.onOpenItem} />
    </>
  );
}
