"use client";

// The project "⋯" menu (WARP-3527): Import work items, Export as CSV / JSON.
// It lives in the page header, beside Refresh, so it draws with the shell
// `.btn` and the shell tokens (import.css). Keyboard: Enter/Space/ArrowDown
// open it, Arrow keys / Home / End move, Escape closes and returns focus to
// the button, Tab leaves it.

import { useCallback, useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Download, FileJson, Upload } from "lucide-react";
import { useToast } from "@/components/Toast";
import { PmIcon } from "../icons";
import { downloadExport, ImportRequestError } from "./useImport";
import "./import.css";

export function ProjectMenu({
  projectId,
  canImport,
  onImport,
}: {
  projectId: string;
  /** Owner, admin, or this project's lead (the server enforces it again). */
  canImport: boolean;
  onImport: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"csv" | "json" | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const menuItems = (): HTMLButtonElement[] =>
    Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  // outside click closes
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // focus the first item on open
  useEffect(() => {
    if (open) menuItems()[0]?.focus();
  }, [open]);

  const move = (to: number | "first" | "last") => {
    const els = menuItems();
    if (els.length === 0) return;
    const at = els.indexOf(document.activeElement as HTMLButtonElement);
    const next = to === "first" ? 0 : to === "last" ? els.length - 1 : (at + to + els.length) % els.length;
    els[next].focus();
  };

  const onMenuKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        move("first");
        break;
      case "End":
        e.preventDefault();
        move("last");
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
    }
  };

  const doExport = async (format: "csv" | "json") => {
    if (busy) return;
    close(true);
    setBusy(format);
    try {
      await downloadExport(projectId, format);
      toast(`Export ready — the ${format.toUpperCase()} file is in your downloads`, "success");
    } catch (e) {
      toast(e instanceof ImportRequestError ? e.message : "Couldn't export this project. Try again.", "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pm-import-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        className="btn"
        type="button"
        aria-label="Project actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <PmIcon name="more" size={15} />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="pm-import-menu__panel"
          id={menuId}
          role="menu"
          aria-label="Project actions"
          onKeyDown={onMenuKey}
        >
          {canImport && (
            <>
              <button
                className="pm-import-menu__item"
                role="menuitem"
                type="button"
                onClick={() => {
                  close(false);
                  onImport();
                }}
              >
                <Upload size={15} aria-hidden /> Import work items…
              </button>
              <div className="pm-import-menu__sep" role="separator" />
            </>
          )}
          <button
            className="pm-import-menu__item"
            role="menuitem"
            type="button"
            aria-disabled={busy !== null}
            onClick={() => void doExport("csv")}
          >
            <Download size={15} aria-hidden /> Export as CSV
          </button>
          <button
            className="pm-import-menu__item"
            role="menuitem"
            type="button"
            aria-disabled={busy !== null}
            onClick={() => void doExport("json")}
          >
            <FileJson size={15} aria-hidden /> Export as JSON
          </button>
        </div>
      )}
    </div>
  );
}
