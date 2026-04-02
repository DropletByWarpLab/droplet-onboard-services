"use client";

interface ToggleSwitchProps {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function ToggleSwitch({ on, onToggle, disabled }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
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
