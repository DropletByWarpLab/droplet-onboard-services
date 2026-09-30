import type { FolderColor } from "@/lib/types";

/**
 * The folder palette, in menu order. Values are the Finder-tag hues; they are
 * fixed (not theme tokens) on purpose — a "red" folder must read as red in
 * both themes — and each is mid-luminance so it holds up on light and dark
 * surfaces.
 */
export const FOLDER_COLORS: ReadonlyArray<{
  value: FolderColor;
  label: string;
  css: string;
}> = [
  { value: "red", label: "Red", css: "#ff3b30" },
  { value: "orange", label: "Orange", css: "#ff9500" },
  { value: "yellow", label: "Yellow", css: "#ffcc00" },
  { value: "green", label: "Green", css: "#34c759" },
  { value: "blue", label: "Blue", css: "#007aff" },
  { value: "purple", label: "Purple", css: "#af52de" },
  { value: "gray", label: "Gray", css: "#8e8e93" },
];

export function folderColorCss(color: FolderColor | undefined): string | undefined {
  return FOLDER_COLORS.find((c) => c.value === color)?.css;
}
