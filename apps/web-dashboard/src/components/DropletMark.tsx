/**
 * Droplet brand mark — faceted polygon drop.
 * Uses the official brand SVG geometry from the logoKit.
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
      viewBox="0 0 52 60"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={labeled ? "img" : undefined}
      aria-label={labeled ? ariaLabel : undefined}
      aria-hidden={labeled ? undefined : true}
    >
      {/* Left face: primary indigo */}
      <polygon points="26,0 44,28 36,48 16,48 8,28" fill="currentColor" />
      {/* Right highlight face: lighter */}
      <polygon points="26,0 44,28 26,36" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
