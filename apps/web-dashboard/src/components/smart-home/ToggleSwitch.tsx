"use client";

interface ToggleSwitchProps {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Accessible name — set when the visible label lives in a sibling element
   *  (the switch renders no text of its own, so without this a screen reader
   *  announces only "switch, on/off"). */
  ariaLabel?: string;
}

export function ToggleSwitch({ on, onToggle, disabled, ariaLabel }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`
        relative inline-flex h-7 w-12 min-w-[48px] items-center rounded-full
        transition-colors duration-200 ease-smooth
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent
        disabled:opacity-40 disabled:cursor-not-allowed
        ${on ? "bg-system-green" : "bg-label-quaternary"}
      `}
    >
      <span
        className={`
          inline-block h-[22px] w-[22px] rounded-full bg-white shadow-sm
          transition-transform duration-200 ease-smooth
          ${on ? "translate-x-[22px]" : "translate-x-[3px]"}
        `}
      />
    </button>
  );
}
