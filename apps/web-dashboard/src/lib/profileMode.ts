"use client";

import { useEffect, useState } from "react";

export type ProfileMode = "home" | "business";

const STORAGE_KEY = "droplet.profile-mode";
const EVENT = "droplet:profile-mode-change";

export type CanonicalRole = "owner" | "admin" | "family" | "guest";
export type DisplayRole =
  | "owner"
  | "admin"
  | "manager"
  | "member"
  | "viewer"
  | "family"
  | "guest";

export const HOME_ROLES: DisplayRole[] = ["owner", "admin", "family", "guest"];
export const BUSINESS_ROLES: DisplayRole[] = [
  "owner",
  "admin",
  "manager",
  "member",
  "viewer",
  "guest",
];

export function rolesForMode(mode: ProfileMode): DisplayRole[] {
  return mode === "home" ? HOME_ROLES : BUSINESS_ROLES;
}

// Maps a Business-mode display role to the canonical 4-role taxonomy
// the orchestrator's auth layer actually persists (owner/admin/family/guest).
export function canonicalize(role: DisplayRole): CanonicalRole {
  switch (role) {
    case "owner":
    case "admin":
      return role;
    case "manager":
      return "admin";
    case "member":
      return "family";
    case "viewer":
    case "guest":
      return "guest";
    case "family":
      return "family";
  }
}

function readMode(): ProfileMode {
  if (typeof window === "undefined") return "home";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "business" ? "business" : "home";
}

export function useProfileMode(): [ProfileMode, (m: ProfileMode) => void] {
  const [mode, setModeState] = useState<ProfileMode>("home");

  useEffect(() => {
    setModeState(readMode());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<ProfileMode>).detail;
      if (detail === "home" || detail === "business") setModeState(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setModeState(readMode());
    };
    window.addEventListener(EVENT, onChange as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setMode = (m: ProfileMode) => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, m);
    window.dispatchEvent(new CustomEvent<ProfileMode>(EVENT, { detail: m }));
    setModeState(m);
  };

  return [mode, setMode];
}
