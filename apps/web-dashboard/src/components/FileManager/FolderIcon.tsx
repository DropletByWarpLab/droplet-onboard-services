import { Folder } from "lucide-react";
import type { FolderColor } from "@/lib/types";
import { folderColorCss } from "./folder-colors";

/**
 * A folder glyph. Uncoloured folders keep the brand outline; a coloured one is
 * tinted and lightly filled, so the colour reads at a glance in a long list.
 */
export function FolderIcon({
  size,
  color,
  className,
}: {
  size: number;
  color?: FolderColor;
  className?: string;
}) {
  const css = folderColorCss(color);
  return (
    <Folder
      size={size}
      className={className}
      data-folder-color={color}
      style={{ color: css ?? "var(--brand)" }}
      fill={css ? css : "none"}
      fillOpacity={css ? 0.28 : undefined}
      aria-hidden="true"
    />
  );
}
