/**
 * Droplet brand mark — faceted polygon drop.
 *
 * Geometry is the design system's 512x512 viewBox, in which the mark is
 * exactly centred — so a square render centres it, which the previous 52x60
 * box did not (the glyph filled only the top 48 units, leaving 20% dead
 * space underneath and the drop sitting high). This is the canonical mark;
 * it is mirrored in droplet-android ui/theme/DropletMark.kt and
 * droplet-ios DesignSystem/DropletMark.swift (WARP-2853).
 *
 * A11y (WARP-298): SVG defaults to `aria-hidden="true"` because in most
 * callsites it sits next to the visible "Droplet" wordmark and announcing
 * it would just duplicate the label. Callers who need it announced
 * (standalone use, e.g. login / welcome screens) can pass an `aria-label`
 * (and we'll flip role to "img" + drop aria-hidden).
 */
interface DropletMarkProps {
  size?: number;
  className?: string;
  /** When provided, the mark is announced with this label (role=img). */
  "aria-label"?: string;
}

export function DropletMark({
  size = 32,
  className,
  "aria-label": ariaLabel,
}: DropletMarkProps) {
  const labeled = typeof ariaLabel === "string" && ariaLabel.length > 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={labeled ? "img" : undefined}
      aria-label={labeled ? ariaLabel : undefined}
      aria-hidden={labeled ? undefined : true}
    >
      {/* Left face: primary indigo */}
      <polygon points="256,72 420,308 352,440 160,440 92,308" fill="currentColor" />
      {/* Right highlight face: lighter */}
      <polygon points="256,72 420,308 256,368" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
