"use client";

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

/**
 * WARP-820 — the **single permitted inner-scroll surface** of the
 * viewport-locked setup wizard.
 *
 * The wizard shell is `h-dvh overflow-hidden` (StepShell) and — as of this
 * ticket — neither the rail nor the main panel scrolls. Steps are sized to fit.
 * The two places content is *inherently* unbounded — the team's pending-invite
 * list and the discovered-device list — can't be made to fit, so they get this
 * bounded scroller instead of pushing the title or CTA off-screen.
 *
 * Contract:
 *   - **Viewport-relative bound** (`max-h-[…dvh]`), not a fixed px cap, so the
 *     list shrinks on a short landscape phone instead of forcing page scroll.
 *     `dvh` (not `vh`) tracks the mobile URL-bar the same way the shell's
 *     `h-dvh` does, so the maths stay consistent.
 *   - `overflow-y-auto overscroll-contain` — scrolling is confined here; a
 *     flick at either end does NOT chain-scroll the locked shell behind it.
 *   - A **subtle fade mask** at the top and bottom edges so clipped rows fade
 *     out rather than hard-cut at the boundary — signals "more below" without a
 *     chrome scrollbar or a loud gradient. Alpha-only mask: no brand colour, no
 *     token needed, and it degrades to a plain clip where `mask-image` is
 *     unsupported.
 *   - `role="region"` + `tabIndex={0}` + a caller-supplied `aria-label`: a
 *     scrollable region with no focusable content is a WCAG 2.1.1 keyboard trap
 *     otherwise, so the region itself is focusable and announced.
 *
 * Title + CTA + everything else in the step stay pinned and scale with the
 * viewport (the wizard-scoped fluid `type-*` overrides); only what's inside a
 * ScrollRegion moves.
 *
 * Use ONLY for genuinely-unbounded lists. A fixed-content step that overflows
 * is a sign its spacing/type aren't fluid enough — fix that, don't reach for
 * this.
 */
export function ScrollRegion({
  children,
  className = "",
  "aria-label": ariaLabel,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  "aria-label": string;
} & HTMLAttributes<HTMLDivElement>) {
  // Symmetric top+bottom alpha fade. ~14px feather is enough to read as a soft
  // edge without eating a full row. Kept inline (alpha-only) so it adds no
  // colour token and no global CSS; identical for standard + WebKit masks.
  const fadeMask =
    "linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%)";
  const maskStyle: CSSProperties = {
    maskImage: fadeMask,
    WebkitMaskImage: fadeMask,
  };

  return (
    <div
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      style={maskStyle}
      className={[
        // Bounded, viewport-relative — shrinks on short viewports. `sm+` gets a
        // little more room on roomier displays.
        "max-h-[40dvh] sm:max-h-[44dvh]",
        // Scroll confined to this element.
        "overflow-y-auto overscroll-contain",
        // The fade mask clips at the very edge; a hair of inline padding keeps
        // focus rings on inner rows from being shaved by the mask.
        "px-px",
        // WARP-820 nit: the scroller clips inner content at its own corner
        // radius (overflow-y-auto computes overflow-x to a clipping value), so
        // its radius must MATCH the radius of the rounded inner content it
        // wraps. TeamStep's invite <ul> is `rounded-xl` (12px); a smaller
        // `rounded-[10px]` here squared off the <ul>'s corners against the clip.
        // Keep these in sync (12px).
        "rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
}
