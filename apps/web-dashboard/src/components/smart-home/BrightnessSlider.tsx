"use client";

import { useCallback, useRef, useState } from "react";

interface BrightnessSliderProps {
  /** Current brightness 0-255 from HA */
  brightness: number;
  onBrightnessChange: (brightness: number) => void;
}

export function BrightnessSlider({
  brightness,
  onBrightnessChange,
}: BrightnessSliderProps) {
  const pct = Math.round((brightness / 255) * 100);
  const [localPct, setLocalPct] = useState(pct);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newPct = Number(e.target.value);
      setLocalPct(newPct);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onBrightnessChange(Math.round((newPct / 100) * 255));
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
        className="flex-1 h-1.5 rounded-full appearance-none bg-label-quaternary
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4
          [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:cursor-pointer"
      />
      <span className="type-caption-1 text-label-secondary w-8 text-right">
        {localPct}%
      </span>
    </div>
  );
}
