"use client";

import { useCallback, useEffect, useState } from "react";
import { mutate as globalMutate } from "swr";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import { Sect } from "@/components/shell/primitives";
import {
  fetchAppModules,
  setAppModuleEnabled,
  type AppModuleState,
} from "@/lib/api";

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
  const isAdmin = user?.role === "owner" || user?.role === "admin";

  const [modules, setModules] = useState<AppModuleState[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const view = await fetchAppModules();
      setModules(view.modules);
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
        const view = await fetchAppModules();
        if (!cancelled) setModules(view.modules);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin) return null;

  const handleToggle = async (mod: AppModuleState) => {
    if (mod.core || !mod.available || pending.has(mod.id)) return;
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
      toast(`${mod.label} turned ${next ? "on" : "off"}`);
      // Revalidate the "/api/modules" SWR key the sidebar's useModuleGate reads,
      // so a switched-off feature's nav entry disappears immediately (WARP-1397)
      // instead of waiting for the next focus/poll revalidation.
      void globalMutate("/api/modules");
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
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(mod.id);
        return n;
      });
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
            CATEGORY_LABELS.flatMap(({ key, label }) => {
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
                          disabled={!mod.available}
                          ariaLabel={mod.label}
                        />
                      )}
                    </span>
                  </div>
                )),
              ];
            })
          )}
        </div>
      </div>
      {toggleError ? (
        <p
          role="alert"
          className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
          style={{ margin: "8px 0 0" }}
        >
          {toggleError}
        </p>
      ) : null}
    </section>
  );
}
