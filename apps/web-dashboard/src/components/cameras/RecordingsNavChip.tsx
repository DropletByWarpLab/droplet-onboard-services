"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, Film } from "lucide-react";
import type { CameraInfo } from "@/lib/types";

interface RecordingsNavChipProps {
  cameras: ReadonlyArray<Pick<CameraInfo, "name" | "displayName">>;
}

const recordingsHref = (name: string) => `/cameras/${encodeURIComponent(name)}/recordings`;

/**
 * "Recordings" in the Cameras sub-nav. Recordings are kept per camera, so the
 * chip's job is to get you to the right one:
 *   · no cameras   → disabled, and says why
 *   · one camera   → a plain link straight to its recordings
 *   · several      → a small menu of cameras; picking one opens its recordings
 *
 * The menu is `position: fixed` under the chip: the chip row scrolls sideways
 * (`overflow-x: auto`), which would clip an absolutely positioned popover.
 */
export function RecordingsNavChip({ cameras }: RecordingsNavChipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (cameras.length === 0) {
    return (
      <button
        type="button"
        className="chip"
        disabled
        aria-disabled="true"
        title="Add a camera to see recordings"
      >
        <Film size={14} strokeWidth={1.5} />
        <span>Recordings</span>
      </button>
    );
  }

  if (cameras.length === 1) {
    const only = cameras[0];
    return (
      <Link
        href={recordingsHref(only.name)}
        className="chip"
        title={`Recordings from ${only.displayName}`}
      >
        <Film size={14} strokeWidth={1.5} />
        <span>Recordings</span>
      </Link>
    );
  }

  const toggle = () => {
    if (!open) {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={"chip" + (open ? " on" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Pick a camera to see its recordings"
        onClick={toggle}
      >
        <Film size={14} strokeWidth={1.5} />
        <span>Recordings</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Recordings by camera"
          className="card fixed z-50"
          style={{
            top: pos.top,
            left: pos.left,
            padding: 4,
            minWidth: 200,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {cameras.map((cam) => (
            <Link
              key={cam.name}
              href={recordingsHref(cam.name)}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="type-footnote block truncate rounded px-3 py-2 hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              style={{ color: "var(--text)" }}
            >
              {cam.displayName}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
