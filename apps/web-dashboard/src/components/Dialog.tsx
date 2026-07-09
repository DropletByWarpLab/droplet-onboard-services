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
 * Padding contract (WARP-945 / WARP-949): the dialog CONTAINER is
 * intentionally padding-free for BOTH placements. Centered modals get the
 * indigo card chrome (card surface/border/radius + lift shadow) and side
 * panels get an edge-to-edge surface — neither insets the content. This is deliberate so consumers can
 * render full-width headers / footers with `border-b` / `border-t` dividers
 * that span the whole surface. The flip side: every consumer MUST pad its
 * own body — wrap children in a div with the dashboard spacing tokens
 * (`p-5` ≈ 20px for centered bodies, `p-5` / `px-4 py-3` per section for side
 * panels; the Projects surface uses its scoped `.pm-dialog-body`). A bare,
 * unpadded child renders flush against the edge — the exact regression
 * WARP-945 fixed on the Projects surfaces. Do NOT add padding to the
 * container here: it would double-pad the ~18 consumers that already self-pad.
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
  /** Close on backdrop click. Default `true`. */
  closeOnBackdrop?: boolean;
  /**
   * Override the auto-focus target. If absent, the first focusable
   * descendant of the dialog gets focus on open.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
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

export function Dialog({
  open,
  onClose,
  triggerRef,
  labelledBy,
  describedBy,
  maxWidth = "md",
  placement = "center",
  closeOnBackdrop = true,
  initialFocusRef,
  children,
}: DialogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Capture the element that had focus *before* the dialog opened so we
  // can restore it on close even if no explicit `triggerRef` was passed.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const prefersReducedMotion = useReducedMotion();

  // Escape close — only while open, so background surfaces keep their
  // own Escape semantics.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
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

  const containerClass = isSide
    ? "relative w-full max-w-md h-full overflow-y-auto"
    : `${widthClass} w-full overflow-hidden`;

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
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
