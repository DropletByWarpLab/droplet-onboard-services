"use client";
import { useRef } from "react";
import * as Icons from "lucide-react";

export const DEVICE_ICONS = [
  "Tv","Smartphone","Laptop","Tablet","Router","Speaker","Camera","Lightbulb","Gamepad",
  "Monitor","Printer","Watch","Thermometer","Lock","Headphones","Mouse","Keyboard","Radio","Disc","HelpCircle",
] as const;

export type DeviceIconName = typeof DEVICE_ICONS[number];

interface Props {
  value: string | null;
  onSelect: (icon: DeviceIconName) => void;
}

export function IconPicker({ value, onSelect }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);

  function handleKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-icon]");
    if (!buttons) return;
    const idx = Array.from(buttons).findIndex((b) => b === document.activeElement);
    if (idx < 0) return;
    const cols = 5; // 20 icons / 5 cols = 4 rows
    let next = idx;
    if (e.key === "ArrowRight") next = Math.min(buttons.length - 1, idx + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, idx - 1);
    else if (e.key === "ArrowDown") next = Math.min(buttons.length - 1, idx + cols);
    else if (e.key === "ArrowUp") next = Math.max(0, idx - cols);
    else return;
    e.preventDefault();
    buttons[next].focus();
  }

  return (
    <div
      ref={gridRef}
      role="radiogroup"
      aria-label="Device icon"
      onKeyDown={handleKey}
      className="grid grid-cols-5 gap-2"
    >
      {DEVICE_ICONS.map((name) => {
        const IconComp = (Icons as unknown as Record<string, typeof Icons.HelpCircle>)[name];
        const selected = value === name;
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={name}
            data-icon={name}
            onClick={() => onSelect(name)}
            className={`p-2 rounded-lg transition ${selected ? "ring-2 ring-[var(--brand)]" : "hover:bg-[var(--hover)]"}`}
          >
            <IconComp className="w-6 h-6 text-[color:var(--text)] mx-auto" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
