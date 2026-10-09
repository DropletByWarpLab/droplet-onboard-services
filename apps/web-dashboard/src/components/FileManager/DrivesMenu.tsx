"use client";
/**
 * The Files toolbar's Drives menu: connect a network drive, or open the
 * box's own drives in Settings → Storage.
 *
 * Drives used to be a row in the Files side nav that redirected to
 * /settings/storage, so clicking it under Files swapped the sidebar to the
 * Settings panel. A side-nav row must stay in its own section. Storage keeps
 * its one home (WARP-2959). This menu leads there from the page instead, and
 * its caption names the destination so leaving Files is never a surprise.
 *
 * It replaces the toolbar's standalone "Connect drive" button, so the toolbar
 * keeps the same width.
 */
import { useRouter } from "next/navigation";
import { ChevronDown, HardDrive, Settings } from "lucide-react";
import { useMenuButton } from "@/components/ui/useMenuButton";
import "@/components/ui/pick-menu.css";

export function DrivesMenu({
  canConnect,
  onConnect,
}: {
  /** Show "Connect network drive…" (owner, admin, member). */
  canConnect: boolean;
  onConnect: () => void;
}) {
  const router = useRouter();
  const menu = useMenuButton();

  return (
    <div ref={menu.rootRef} className="relative inline-flex">
      <button
        ref={menu.buttonRef}
        type="button"
        className="btn ghost"
        aria-label="Drives"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menu.menuId : undefined}
        onClick={menu.onButtonClick}
        onKeyDown={menu.onButtonKeyDown}
      >
        <HardDrive size={14} />
        <span className="hidden sm:inline">Drives</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menu.open && (
        <div
          ref={menu.menuRef}
          id={menu.menuId}
          role="menu"
          aria-label="Drives"
          className="pick-menu"
          data-placement="below"
          data-align={menu.align}
          onKeyDown={menu.onMenuKeyDown}
        >
          {canConnect && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="pick-item"
              onClick={() => {
                menu.close(true);
                onConnect();
              }}
            >
              <HardDrive size={14} aria-hidden="true" />
              <span className="pick-item-text">
                <span className="pick-item-name">Connect network drive…</span>
              </span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="pick-item"
            onClick={() => {
              menu.close(false);
              router.push("/settings/storage");
            }}
          >
            <Settings size={14} aria-hidden="true" />
            <span className="pick-item-text">
              <span className="pick-item-name">Manage drives</span>
              <span className="pick-item-caption">In Settings → Storage</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
