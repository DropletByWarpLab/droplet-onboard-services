"use client";

import { useCallback, useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import { Sect } from "@/components/shell/primitives";
import {
  applyBusinessType,
  fetchBusinessTypes,
  fetchAppModules,
  setAppModuleEnabled,
  type AppBusinessType,
  type AppModuleState,
} from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MODULE_GATE_KEY } from "@/lib/hooks/useModuleGate";

/**
 * WARP-1368 — Settings → "Features" (design contract §2.12).
 *
 * The operator surface for the WARP-1306 module toggles: every registry
 * module as a row (label + description), grouped Workspace / Operations,
 * with a ToggleSwitch on the right. Two orthogonal axes, never conflated
 * (module-registry.ts):
 *   - core modules are always on and never toggleable — pinned caption;
 *   - unavailable modules (backend not deployed on this box) are dimmed
 *     with a disabled switch — enablement can't outrun deployment.
 *
 * Toggles are optimistic: flip locally, PATCH, revert + error line on
 * failure (the flip itself is reversible, so no confirm step — same tier
 * as the theme toggle, not a §6 write chip surface; the workspace-wide
 * blast radius is signalled by the Sect sub-copy instead). Renders
 * NOTHING for family/guest — Settings is an admin surface (§6.3), and
 * the PATCH is owner/admin-gated server-side anyway.
 *
 * Rows stay DIRECT children of `.rows` (the category captions are rows
 * too) so the shell's `.rows > * + *` hairline separators apply — a
 * wrapper div per category would swallow them (UX review WARP-1368 §3).
 *
 * Born from a live incident: the first Matter device commissioned on .87
 * was invisible because smart_home ships defaultEnabled:false and no UI
 * existed to switch it on (WARP-1367).
 */

const LOAD_ERROR_LINE = "Couldn't load features.";
const TOGGLE_ERROR_LINE = "That didn't apply — the switch was put back. Try again.";

const CATEGORY_LABELS: Array<{
  key: AppModuleState["category"];
  label: string;
}> = [
  { key: "workspace", label: "Workspace" },
  { key: "operations", label: "Operations" },
];

export function FeaturesCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { mutate } = useSWRConfig();
  const isAdmin = user?.role === "owner" || user?.role === "admin";

  const [modules, setModules] = useState<AppModuleState[] | null>(null);
  const [businessType, setBusinessType] = useState<string | null>(null);
  const [businessTypes, setBusinessTypes] = useState<AppBusinessType[] | null>(null);
  const [selectedBusinessType, setSelectedBusinessType] = useState("");
  const [pendingBusinessType, setPendingBusinessType] = useState<string | null>(null);
  const [businessTypeError, setBusinessTypeError] = useState<string | null>(null);
  const [applyingBusinessType, setApplyingBusinessType] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [view, catalog] = await Promise.all([fetchAppModules(), fetchBusinessTypes()]);
      setModules(view.modules);
      setBusinessType(view.businessType);
      setBusinessTypes(catalog);
      setSelectedBusinessType(view.businessType ?? "");
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      setLoadFailed(false);
      try {
        const [view, catalog] = await Promise.all([fetchAppModules(), fetchBusinessTypes()]);
        if (!cancelled) {
          setModules(view.modules);
          setBusinessType(view.businessType);
          setBusinessTypes(catalog);
          setSelectedBusinessType(view.businessType ?? "");
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const refreshModules = useCallback(async () => {
    setRefreshError(false);
    setRefreshPending(true);
    try {
      const [readResult, cacheResult] = await Promise.allSettled([
        fetchAppModules(),
        mutate(MODULE_GATE_KEY),
      ]);
      if (readResult.status === "fulfilled") {
        setModules(readResult.value.modules);
        setBusinessType(readResult.value.businessType);
        setSelectedBusinessType(readResult.value.businessType ?? "");
      }
      if (readResult.status === "rejected" || cacheResult.status === "rejected") {
        setRefreshError(true);
        throw new Error("module_status_refresh_failed");
      }
    } finally {
      setRefreshPending(false);
    }
  }, [mutate]);

  if (!isAdmin) return null;

  const handleToggle = async (mod: AppModuleState) => {
    if (mod.core || !mod.available || applyingBusinessType || pendingBusinessType !== null || pending.has(mod.id)) return;
    const next = !mod.enabled;
    setToggleError(null);
    setPending((p) => new Set(p).add(mod.id));
    // Optimistic: the switch reflects the intent immediately.
    setModules((ms) =>
      ms?.map((m) =>
        m.id === mod.id ? { ...m, enabled: next, effective: m.available && next } : m,
      ) ?? null,
    );
    try {
      await setAppModuleEnabled(mod.id, next);
    } catch {
      // Revert — the server state is the truth.
      setModules((ms) =>
        ms?.map((m) =>
          m.id === mod.id
            ? { ...m, enabled: mod.enabled, effective: mod.effective }
            : m,
        ) ?? null,
      );
      setToggleError(TOGGLE_ERROR_LINE);
      setPending((p) => {
        const n = new Set(p);
        n.delete(mod.id);
        return n;
      });
      return;
    }
    toast(`${mod.label} turned ${next ? "on" : "off"}`);
    try {
      await refreshModules();
    } catch {
      // The server accepted the toggle. Keep that state visible and offer a
      // separate refresh action instead of reverting a successful write.
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(mod.id);
        return n;
      });
    }
  };

  const handleApplyBusinessType = async () => {
    if (!isAdmin || !pendingBusinessType || applyingBusinessType || pending.size > 0) return;
    setApplyingBusinessType(true);
    setBusinessTypeError(null);
    try {
      // Re-read the current preset before the write. The POST response remains
      // authoritative for the full module state after applying.
      let current: Awaited<ReturnType<typeof fetchAppModules>>;
      try {
        current = await fetchAppModules();
      } catch {
        setBusinessTypeError("Couldn't verify the current module settings. Try again.");
        throw new Error("business_type_preflight_failed");
      }
      if (current.businessType === pendingBusinessType) {
        setModules(current.modules);
        setBusinessType(current.businessType);
        setSelectedBusinessType(current.businessType ?? "");
        toast("That business preset is already selected");
        try {
          setRefreshError(false);
          await mutate(MODULE_GATE_KEY);
        } catch {
          // Current server state is already displayed; refresh can be retried.
          setRefreshError(true);
        }
        return;
      }
      let updated: Awaited<ReturnType<typeof applyBusinessType>>;
      try {
        updated = await applyBusinessType(pendingBusinessType);
      } catch {
        setBusinessTypeError("Couldn't apply that business preset. Try again.");
        throw new Error("business_type_apply_failed");
      }
      setModules(updated.modules);
      setBusinessType(updated.businessType);
      setSelectedBusinessType(updated.businessType ?? "");
      toast("Business preset applied");
      try {
        await refreshModules();
      } catch {
        // POST succeeded. Keep its accepted workspace view visible and let the
        // separate refresh action reconcile per-user module state.
      }
    } finally {
      setApplyingBusinessType(false);
    }
  };

  return (
    <section aria-label="Features">
      <Sect title="Features" extra="Applies to everyone on this Droplet" />
      <div className="card" style={{ padding: 0 }}>
        <div className="rows">
          {loadFailed ? (
            <div className="lrow" style={{ padding: "12px 16px", alignItems: "center" }}>
              <span className="rt">
                <span className="sub">{LOAD_ERROR_LINE}</span>
              </span>
              <button
                type="button"
                className="btn"
                style={{ marginLeft: "auto" }}
                onClick={() => void load()}
              >
                Try again
              </button>
            </div>
          ) : modules === null ? (
            <div className="lrow" style={{ padding: "12px 16px" }}>
              <span className="rt">
                <span className="sub">Loading features…</span>
              </span>
            </div>
          ) : (
            <>
            <div className="lrow" style={{ padding: "12px 16px", alignItems: "center" }}>
              <span className="rt">
                <span className="nm">Business type</span>
                <span className="sub">
                  {businessType
                    ? `Current preset: ${businessTypes?.find((item) => item.id === businessType)?.label ?? businessType}`
                    : "Not set — using module defaults"}
                </span>
                {businessTypes?.find((item) => item.id === selectedBusinessType)?.description ? (
                  <span className="sub">
                    {businessTypes.find((item) => item.id === selectedBusinessType)?.description}
                  </span>
                ) : null}
              </span>
              <select
                aria-label="Business type preset"
                className="input"
                value={selectedBusinessType}
                onChange={(event) => setSelectedBusinessType(event.target.value)}
                disabled={!businessTypes || applyingBusinessType || pending.size > 0 || pendingBusinessType !== null}
                style={{ marginLeft: "auto", maxWidth: 250 }}
              >
                <option value="">Choose a preset</option>
                {businessTypes?.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}{preset.id === "custom" ? "" : ` (${preset.modules.length} modules)`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn"
                disabled={!selectedBusinessType || selectedBusinessType === businessType || applyingBusinessType || pending.size > 0}
                onClick={() => {
                  setBusinessTypeError(null);
                  setPendingBusinessType(selectedBusinessType);
                }}
              >
                Apply
              </button>
            </div>
            {businessTypeError ? (
              <p role="alert" className="sub" style={{ padding: "0 16px 8px" }}>{businessTypeError}</p>
            ) : null}
            {CATEGORY_LABELS.flatMap(({ key, label }) => {
              const group = modules.filter((m) => m.category === key);
              if (group.length === 0) return [];
              return [
                // Caption rows and module rows stay siblings inside `.rows`
                // so the hairline separators between rows survive.
                <div key={`cap-${key}`} className="lrow" style={{ padding: "10px 16px 4px" }}>
                  <span className="g-cap">{label}</span>
                </div>,
                ...group.map((mod) => (
                  <div
                    key={mod.id}
                    className="lrow"
                    style={{
                      padding: "12px 16px",
                      alignItems: "center",
                      opacity: mod.available ? 1 : 0.55,
                    }}
                  >
                    <span className="rt">
                      <span className="nm">{mod.label}</span>
                      <span className="sub">
                        {mod.available
                          ? mod.description
                          : "Not installed on this Droplet"}
                      </span>
                    </span>
                    <span
                      style={{
                        marginLeft: "auto",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      {mod.core ? (
                        <span className="sub" style={{ whiteSpace: "nowrap" }}>
                          Always on
                        </span>
                      ) : (
                        <ToggleSwitch
                          on={mod.enabled}
                          onToggle={() => void handleToggle(mod)}
                          disabled={!mod.available || applyingBusinessType || pendingBusinessType !== null || pending.has(mod.id)}
                          ariaLabel={mod.label}
                        />
                      )}
                    </span>
                  </div>
                )),
              ];
            })}
            </>
          )}
        </div>
      </div>
      {refreshError ? (
        <p role="status" className="type-footnote rounded-sm px-3 py-2" style={{ margin: "8px 0 0" }}>
          Changes were applied, but current module status couldn&apos;t refresh.{" "}
          <button
            type="button"
            className="btn ghost sm"
            disabled={refreshPending || applyingBusinessType || pending.size > 0 || pendingBusinessType !== null}
            onClick={() => void refreshModules().catch(() => {})}
          >
            Refresh now
          </button>
        </p>
      ) : null}
      {toggleError ? (
        <p
          role="alert"
          className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
          style={{ margin: "8px 0 0" }}
        >
          {toggleError}
        </p>
      ) : null}
      <ConfirmDialog
        open={pendingBusinessType !== null}
        title={`Apply the ${businessTypes?.find((item) => item.id === pendingBusinessType)?.label ?? "selected"} preset?`}
        description={pendingBusinessType === "custom"
          ? "The Custom option records this choice and keeps the current module settings."
          : "This turns modules on or off to match the preset. You can still change individual modules afterward."}
        confirmLabel="Apply preset"
        variant="neutral"
        onConfirm={handleApplyBusinessType}
        onCancel={() => setPendingBusinessType(null)}
      />
    </section>
  );
}
