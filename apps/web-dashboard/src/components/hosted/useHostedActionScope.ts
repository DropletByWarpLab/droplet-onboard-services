"use client";
import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";

/** Retire asynchronous UI work before it can act on a replacement account or resource. */
export function useHostedActionScope(resource: string, roles = ["owner", "admin", "family"]) {
  const { user, isLoading } = useAuth();
  const key = user && !isLoading && roles.includes(user.role ?? "") ? JSON.stringify([user.id, user.role, resource]) : null;
  const current = useRef({ key, revision: 0, mounted: false });
  // Invalidate during render too: an old promise can settle before effect cleanup.
  if (current.current.key !== key) {
    current.current.key = key;
    current.current.revision++;
  }
  useEffect(() => {
    current.current.mounted = true;
    return () => { current.current.mounted = false; current.current.revision++; };
  }, [key]);
  const capture = () => {
    const revision = current.current.revision;
    return () => key !== null && current.current.mounted && current.current.key === key && current.current.revision === revision;
  };
  return { key, capture };
}
