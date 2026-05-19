"use client";

import { Building2, Home as HomeIcon } from "lucide-react";
import { useProfileMode } from "@/lib/profileMode";

export function ProfileModeToggle({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useProfileMode();
  return (
    <div
      className="dp-seg"
      role="group"
      aria-label="Profile mode"
      title="Switch role taxonomy between Home and Business profile"
    >
      <button
        type="button"
        className={mode === "home" ? "on" : ""}
        onClick={() => setMode("home")}
        aria-pressed={mode === "home"}
      >
        <HomeIcon size={12} strokeWidth={mode === "home" ? 2 : 1.5} />
        {!compact && <span>Home</span>}
      </button>
      <button
        type="button"
        className={mode === "business" ? "on" : ""}
        onClick={() => setMode("business")}
        aria-pressed={mode === "business"}
      >
        <Building2 size={12} strokeWidth={mode === "business" ? 2 : 1.5} />
        {!compact && <span>Business</span>}
      </button>
    </div>
  );
}
