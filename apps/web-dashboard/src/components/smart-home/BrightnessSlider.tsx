"use client";

import { useCallback, useRef, useState } from "react";

interface BrightnessSliderProps {
  /** Current brightness 0-100 percentage */
  brightness: number;
  /** Called with 0-100 percentage value */
  onBrightnessChange: (brightness: number) => void;
}

export function BrightnessSlider({
  brightness,
  onBrightnessChange,
}: BrightnessSliderProps) {
  const [localPct, setLocalPct] = useState(brightness);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newPct = Number(e.target.value);
      setLocalPct(newPct);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onBrightnessChange(newPct);
      }, 300);
    },
    [onBrightnessChange]
  );

  return (
    <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
      <input
        type="range"
        min={0}
        max={100}
        value={localPct}
        onChange={handleChange}
        aria-label="Brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={localPct}
        aria-valuetext={`${localPct}%`}
        className="flex-1 h-1.5 rounded-full appearance-none bg-[var(--inset)]
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4
          [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-[var(--brand)] [&::-webkit-slider-thumb]:cursor-pointer"
      />
      <span className="type-caption-1 w-8 text-right" style={{ color: "var(--text-muted)" }}>
        {localPct}%
      </span>
    </div>
  );
}
