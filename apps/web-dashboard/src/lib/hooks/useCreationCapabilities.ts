"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch, useAuth } from "@/lib/auth";

export type CreationState = "ready" | "disabled" | "restricted" | "not_configured" | "offline" | "busy" | "unverified" | "unavailable";
export interface CreationCapability { id: string; label: string; state: CreationState; reason: string; detail: string; inferenceVerified?: false }
export interface CreationCapabilities { version: 1; checkedAt: string; capabilities: CreationCapability[] }
const IDS = new Set(["pdf", "slides", "workbook", "office", "analysis", "artifact", "web_fetch", "web_search", "speech", "image", "video"]);
const STATES = new Set(["ready", "disabled", "restricted", "not_configured", "offline", "busy", "unverified", "unavailable"]);
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export function parseCreationCapabilities(value: unknown): CreationCapabilities {
  if (!object(value) || value.version !== 1 || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) || !Array.isArray(value.capabilities) || value.capabilities.length !== IDS.size) throw new Error("invalid_creation_status");
  const seen = new Set<string>();
  for (const row of value.capabilities) {
    if (!object(row) || typeof row.id !== "string" || !IDS.has(row.id) || seen.has(row.id) || typeof row.label !== "string" || row.label.length > 96 || typeof row.state !== "string" || !STATES.has(row.state) || typeof row.reason !== "string" || !/^[a-z_]{1,80}$/.test(row.reason) || typeof row.detail !== "string" || row.detail.length > 512 || (row.inferenceVerified !== undefined && row.inferenceVerified !== false)) throw new Error("invalid_creation_status");
    seen.add(row.id);
  }
  return value as unknown as CreationCapabilities;
}

/** On-demand with a visible refresh; closing/unmounting aborts the probe. */
export function useCreationCapabilities(enabled: boolean) {
  const { user } = useAuth();
  const scope = user?.id && user.role ? JSON.stringify([user.id, user.role]) : null;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const [view, setView] = useState<{ scope: string | null; data: CreationCapabilities | null; loading: boolean; error: boolean }>({ scope: null, data: null, loading: false, error: false });
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled || scope === null || activeScope.current !== scope) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    const timer = setTimeout(() => current.abort(), 8_000);
    const active = () => controller.current === current && activeScope.current === scope;
    setView({ scope, data: null, loading: true, error: false });
    try {
      const response = await authFetch("/api/capabilities/creation", { signal: current.signal, cache: "no-store" });
      if (!response.ok) throw new Error("creation_status_unavailable");
      const result = parseCreationCapabilities(await response.json());
      if (active() && !current.signal.aborted) setView({ scope, data: result, loading: false, error: false });
    } catch { if (active()) setView({ scope, data: null, loading: false, error: true }); }
    finally { clearTimeout(timer); if (active()) { setView((previous) => ({ ...previous, loading: false })); controller.current = null; } }
  }, [enabled, scope]);
  useEffect(() => {
    if (enabled) void refresh();
    return () => { controller.current?.abort(); controller.current = null; };
  }, [enabled, refresh]);
  // Scope the rendered value too: effects run after render, so clearing only
  // inside the effect would briefly show the previous person's permissions.
  const visible = enabled && scope !== null && view.scope === scope;
  return { data: visible ? view.data : null, loading: visible ? view.loading : enabled && scope !== null, error: visible ? view.error : false, refresh };
}
