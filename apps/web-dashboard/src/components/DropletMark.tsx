/**
 * Droplet brand mark — faceted polygon drop.
 * Uses the official brand SVG geometry from the logoKit.
 */
interface DropletMarkProps {
  size?: number;
  className?: string;
}

export function DropletMark({ size = 32, className }: DropletMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 52 60"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Left face: primary indigo */}
      <polygon points="26,0 44,28 36,48 16,48 8,28" fill="currentColor" />
      {/* Right highlight face: lighter */}
      <polygon points="26,0 44,28 26,36" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
