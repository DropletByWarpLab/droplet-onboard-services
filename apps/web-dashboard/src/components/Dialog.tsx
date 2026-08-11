"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
// WARP-1079 — indigo ramp + shell primitives. The dialog is portal-mounted to
// document.body, OUTSIDE any `.droplet-shell` page scope (and outside
// `.droplet-home` / the chat frame), so it carries the `droplet-shell` scope
// class on its own backdrop and imports the token/primitive CSS itself
// (class-scoping pattern from WARP-1072). Dialogs then resolve the indigo
// tokens identically on shell pages, the home board, chat, and auth routes.
import "@/components/shell/indigo-tokens.css";
import "@/components/shell/droplet-shell.css";

/**
 * Canonical modal-dialog primitive for the dashboard (WARP-289).
 *
 * Folds the WARP-217 gold-standard pattern (see `app/users/page.tsx`)
 * into a single reusable component so every modal in the dashboard
 * gets full ARIA + focus management + scroll-lock for free:
 *
 *   - Portal-mounted to `document.body` (escapes overflow/transform
 *     traps in ancestor layouts).
 *   - Container has `role="dialog"`, `aria-modal="true"`,
 *     `aria-labelledby={labelledBy}`, optional `aria-describedby`.
 *   - On open: focuses `initialFocusRef.current` if provided, else
 *     the first focusable child (button/input/select/textarea/a[href]/
 *     [tabindex]:not([tabindex="-1"])).
 *   - Escape closes via a window-level keydown listener (only while
 *     `open === true` — leaving it always-on would steal Escape from
 *     other surfaces).
 *   - On close: focus returns to `triggerRef.current` so keyboard
 *     users land back where they came from.
 *   - Backdrop click closes when `closeOnBackdrop` (default true).
 *   - Body scroll is locked while open (`document.body.style.overflow
 *     = "hidden"`) and restored to its prior value on close.
 *   - Honors `useReducedMotion`: skip the framer-motion fade/scale
 *     transition when the user has reduce-motion preference on. The
 *     dialog still mounts/unmounts; only the animation is gated.
 *
 * Padding + overflow contract (WARP-1152/WARP-1153, supersedes the
 * WARP-945/949 "every consumer self-pads" contract): the PRIMITIVE owns the
 * body inset and the horizontal-overflow policy, so a dialog can't opt out
 * silently.
 *
 *   - By default children render inside the standard body region: `p-5`
 *     (20px, spacing scale) with, for centered modals, vertical-only
 *     scrolling (`max-h-[90vh] overflow-y-auto`). Horizontal overflow is
 *     clipped (`overflow-x-hidden`) so a too-wide row can neither sit flush
 *     against the card edge nor grow an internal horizontal scrollbar — the
 *     exact WARP-1152 regression on the calendar's New-event dialog.
 *   - Sectioned layouts (full-width headers / footers with `border-b` /
 *     `border-t` dividers spanning the surface, e.g. PairDialog and the
 *     right-edge detail panels) opt out EXPLICITLY with `flush` and then own
 *     per-section padding on the spacing scale (`p-5` / `px-4 py-3`; the
 *     Projects surfaces use their scoped `.pm-dialog-body`). `flush` is a
 *     padding opt-out only — centered modals keep the vertical-scroll +
 *     horizontal-clip body region either way, and side panels keep
 *     horizontal clipping on the panel itself.
 */
export interface DialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog requests to close (Escape, backdrop, custom). */
  onClose: () => void;
  /**
   * Element that originally opened the dialog. Focus returns here on
   * close so keyboard users don't lose their place. If your trigger
   * varies per row, capture `document.activeElement` at open time and
   * pass a ref pointing at it (see `users/page.tsx` `editTriggerRef`).
   */
  triggerRef?: RefObject<HTMLElement | null>;
  /** `id` of the element labeling the dialog (typically the `<h2>` heading). */
  labelledBy: string;
  /** Optional `id` of an element describing the dialog (subtitle / body copy). */
  describedBy?: string;
  /**
   * Max width of the modal container. `md` is the default and matches
   * every existing dashboard modal. Sizes map to Tailwind `max-w-*`.
   * `2xl` (720px) exists for the voice calibration wizard's modal
   * contract (WARP-1055, design brief §4).
   */
  maxWidth?: "sm" | "md" | "lg" | "xl" | "2xl";
  /**
   * Where the dialog sits on screen.
   *
   *   - `center` (default): a centered modal card. Used for forms /
   *     confirms / sharing surfaces.
   *   - `right`: a full-height right-edge side panel. Used for
   *     detail panels (smart-home device, network device, paired
   *     client) that the user keeps open while scanning context.
   *
   * Side panels skip the centered card radius + max-width and instead
   * render edge-to-edge against the right border.
   */
  placement?: "center" | "right";
  /**
   * Width of a `placement="right"` side panel. Every existing side panel
   * keeps the legacy `max-w-md` default — this is an EXPLICIT opt-in
   * (honoring `maxWidth` for side panels instead would silently widen
   * callers that already pass it, e.g. the projects detail panel).
   *
   *   - `default`: `max-w-md` (448px) — the shipped side-panel width.
   *   - `sheet`:   `max-w-[520px]` — the Access & Roles builder sheet
   *     (WARP-1532; the design packet locks `min(520px, 100vw)`, so the
   *     panel still goes full-width under small viewports via `w-full`).
   *
   * Ignored for centered dialogs.
   */
  sideWidth?: "default" | "sheet";
  /** Close on backdrop click. Default `true`. */
  closeOnBackdrop?: boolean;
  /**
   * Override the auto-focus target. If absent, the first focusable
   * descendant of the dialog gets focus on open.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Opt out of the default `p-5` body inset for sectioned layouts that
   * render full-width `border-b` / `border-t` dividers and own per-section
   * padding (see the padding + overflow contract above). Never an overflow
   * opt-out: horizontal clipping and the centered scroll region stay on.
   */
  flush?: boolean;
  /** Dialog body. The heading element referenced by `labelledBy` must be inside. */
  children: ReactNode;
}

const MAX_WIDTH_CLASS: Record<NonNullable<DialogProps["maxWidth"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  // 720px — the voice calibration wizard (WARP-1055, brief §4).
  "2xl": "max-w-[720px]",
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// Module-level stack of OPEN dialogs (WARP-1532 review F1). Every open
// Dialog registers its own window keydown listener, and stopPropagation
// cannot suppress OTHER listeners on the same target — so with nested
// dialogs (e.g. the role-builder sheet + its cloud confirm, or the
// smart-home nested surfaces) a single Escape used to close BOTH layers,
// discarding the underlying draft. Each dialog pushes a token while open;
// only the TOPMOST token's dialog may act on Escape.
const openDialogStack: symbol[] = [];

export function Dialog({
  open,
  onClose,
  triggerRef,
  labelledBy,
  describedBy,
  maxWidth = "md",
  placement = "center",
  sideWidth = "default",
  closeOnBackdrop = true,
  initialFocusRef,
  flush = false,
  children,
}: DialogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Capture the element that had focus *before* the dialog opened so we
  // can restore it on close even if no explicit `triggerRef` was passed.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const prefersReducedMotion = useReducedMotion();
  // Stable identity on the open-dialog stack (F1). A ref, not state — the
  // token never changes for this component instance.
  const stackTokenRef = useRef<symbol>();
  if (stackTokenRef.current === undefined) stackTokenRef.current = Symbol("dialog");

  // Register on the open-dialog stack while open. Nested dialogs mount
  // after their parents, so the innermost open dialog is always topmost;
  // closing it pops the stack and hands Escape back to the layer below.
  useEffect(() => {
    if (!open) return;
    const token = stackTokenRef.current!;
    openDialogStack.push(token);
    return () => {
      const index = openDialogStack.lastIndexOf(token);
      if (index !== -1) openDialogStack.splice(index, 1);
    };
  }, [open]);

  // Escape close — only while open, so background surfaces keep their
  // own Escape semantics, and only for the TOPMOST open dialog:
  // stopPropagation cannot suppress sibling window-level listeners, so
  // without the stack check a nested confirm's Escape would also close
  // the sheet underneath it and discard the draft (F1).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openDialogStack[openDialogStack.length - 1] !== stackTokenRef.current) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Body scroll-lock. Capture the prior value so multiple dialogs
  // mounted in sequence don't permanently clobber a custom value
  // some other surface had set.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Capture focus origin on open and restore on close.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;
      // Focus the requested target or the first focusable child. Defer
      // one tick so the portal subtree is in the DOM.
      const focusTimer = window.setTimeout(() => {
        const target =
          initialFocusRef?.current ??
          (containerRef.current?.querySelector(
            FOCUSABLE_SELECTOR,
          ) as HTMLElement | null);
        target?.focus();
      }, 0);
      return () => window.clearTimeout(focusTimer);
    } else {
      // Restore. Prefer the explicit triggerRef; fall back to whatever
      // had focus when we opened.
      const restoreTimer = window.setTimeout(() => {
        const target = triggerRef?.current ?? restoreFocusRef.current;
        target?.focus?.();
      }, 0);
      return () => window.clearTimeout(restoreTimer);
    }
    // We intentionally only re-run when `open` toggles. Capturing a
    // stable triggerRef/initialFocusRef is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!closeOnBackdrop) return;
      if (e.target === e.currentTarget) onClose();
    },
    [closeOnBackdrop, onClose],
  );

  // Focus trap — keep Tab/Shift-Tab cycling inside the dialog so the
  // `aria-modal="true"` claim is truthful (ARIA Authoring Practices for
  // `dialog`). Without this, keyboard users tab past the last focusable
  // child straight into background page chrome and lose the modal
  // context entirely.
  //
  // Edge cases worth flagging:
  //   - No focusable children: bail without preventDefault, letting the
  //     browser do its native thing (Tab moves focus to the document
  //     body / next document chrome). Should be rare in practice — every
  //     real dialog has at least a close button.
  //   - Iframes / portals nested inside the dialog: anything within
  //     `containerRef.current.querySelectorAll(FOCUSABLE_SELECTOR)` is
  //     considered in-scope. iframe focus is opaque to this trap; we
  //     don't currently render any so this is acceptable for now.
  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!open) return;
      if (e.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (el) => !(el as HTMLButtonElement | HTMLInputElement).disabled,
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !root.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [open],
  );

  // SSR / pre-hydration guard. `document` is not defined during
  // Next.js server rendering, and we can't portal until it is.
  if (typeof document === "undefined") return null;

  const widthClass = MAX_WIDTH_CLASS[maxWidth];

  // When reduce-motion is on, skip the framer-motion transition by
  // setting initial/animate/exit to the same identity values.
  const motionProps = prefersReducedMotion
    ? {
        initial: { opacity: 1 },
        animate: { opacity: 1 },
        exit: { opacity: 1 },
      }
    : {
        initial: { opacity: 0, scale: 0.98 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.98 },
        transition: { duration: 0.15 },
      };

  const isSide = placement === "right";

  // Backdrop: the indigo `var(--scrim)` for both placements (WARP-1066
  // token mapping). Centered modals keep the blur; side panels stay
  // blur-free so the user can still scan the underlying list while the
  // panel is open. The `droplet-shell` class ON the backdrop is what makes
  // every `--scrim` / `--card-*` / `.btn` reference inside the dialog
  // resolve regardless of which page the portal escapes from.
  const backdropClass = isSide
    ? "droplet-shell fixed inset-0 z-50 flex justify-end"
    : "droplet-shell fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm p-6";

  // Inline `position: fixed` + scrim: `.droplet-shell` declares
  // `position: relative` and `background: var(--bg)` at the same
  // specificity as the Tailwind utilities, and component-CSS bundle order
  // is not guaranteed — inline wins deterministically.
  const backdropStyle: React.CSSProperties = {
    position: "fixed",
    background: "var(--scrim)",
  };

  // `dlg-side` / `dlg-side-panel` are hooks for the shell's phone layer, not
  // styling of their own — see the phone-sheet block in `droplet-shell.css`.
  // `max-w-md` is 448px, so a right panel stays a desktop drawer at every
  // width above it: measured in Chrome at a 700px viewport the switch
  // port-detail panel covered 64% of the screen and left the Network page
  // visible-but-dead beside it — Sam's "~60% of the screen width"
  // (WARP-1787). Below the shell's own 720px breakpoint the default panel
  // drops its cap and becomes a full-width sheet. The 520px `sheet` variant
  // keeps its cap: its packet already specifies `min(520px, 100vw)`, which is
  // exactly what `w-full max-w-[520px]` expresses.
  const sideWidthClass =
    sideWidth === "sheet" ? "max-w-[520px] dlg-side" : "max-w-md dlg-side dlg-side-panel";
  const containerClass = isSide
    ? `relative w-full ${sideWidthClass} h-full overflow-y-auto overflow-x-hidden`
    : `${widthClass} w-full overflow-hidden`;

  // Body region (padding + overflow contract, see the component doc):
  //   - centered: ALWAYS a vertical-only scroll region that clips horizontal
  //     overflow; `flush` only drops the `p-5` inset.
  //   - side: the container above is already the (horizontally clipped)
  //     scroll region; `flush` renders children directly so full-height
  //     `h-full` section layouts keep working, the default adds the `p-5`
  //     inset.
  const centeredBodyClass = flush
    ? "max-h-[90vh] overflow-y-auto overflow-x-hidden"
    : "max-h-[90vh] overflow-y-auto overflow-x-hidden p-5";
  const body = isSide ? (
    flush ? (
      children
    ) : (
      <div className="p-5">{children}</div>
    )
  ) : (
    <div className={centeredBodyClass}>{children}</div>
  );

  // Indigo card chrome (WARP-1066 modal idiom: card surface + card border
  // + card radius + `--lift` shadow). Side panels swap the full border for
  // a left edge against `var(--border)`.
  const containerStyle: React.CSSProperties = isSide
    ? {
        background: "var(--card-bg)",
        borderLeft: "1px solid var(--border)",
        boxShadow: "var(--lift)",
      }
    : {
        background: "var(--card-bg)",
        border: "1px solid var(--card-bd)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--lift)",
      };

  // Side panels slide in from the right when motion is allowed; the
  // centered variant gets the existing fade+scale.
  const sideMotion = prefersReducedMotion
    ? {
        initial: { opacity: 1, x: 0 },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 1, x: 0 },
      }
    : {
        initial: { opacity: 0, x: 24 },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: 24 },
        transition: { duration: 0.18 },
      };

  const panelMotion = isSide ? sideMotion : motionProps;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: prefersReducedMotion ? 1 : 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: prefersReducedMotion ? 1 : 0 }}
          transition={{ duration: prefersReducedMotion ? 0 : 0.12 }}
          className={backdropClass}
          style={backdropStyle}
          onClick={handleBackdropClick}
        >
          <motion.div
            ref={containerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            className={containerClass}
            style={containerStyle}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleContainerKeyDown}
            {...panelMotion}
          >
            {body}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
