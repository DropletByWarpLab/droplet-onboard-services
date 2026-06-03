/**
 * Canonical brand tokens shared between runtime CSS and server-evaluated
 * Next.js metadata.
 *
 * DASH-09: the PWA `themeColor` in `app/layout.tsx` is server-rendered metadata
 * and therefore can't read the `--color-accent` CSS custom property at build
 * time. To keep it from silently drifting out of sync with the design system,
 * the anchor accent lives here as the single source of truth. It must match
 * `--color-accent` (light theme) in `app/globals.css` and `droplet.700` in
 * `tailwind.config.ts` — a guard test pins this (see brand.theme-color.test.ts).
 */

/** Brand anchor accent — droplet-700 (violet ramp). */
export const ACCENT_HEX = "#6d28d9";

/** Browser chrome / PWA theme color. Driven from the brand accent token. */
export const THEME_COLOR = ACCENT_HEX;
