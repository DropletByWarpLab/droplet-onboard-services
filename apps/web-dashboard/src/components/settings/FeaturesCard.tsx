"use client";

import { useEffect, useState } from "react";
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
 * as the theme toggle, not a §6 write chip surface). Renders NOTHING for
 * family/guest — Settings is an admin surface (§6.3), and the PATCH is
 * owner/admin-gated server-side anyway.
 *
 * Born from a live incident: the first Matter device commissioned on .87
 * was invisible because smart_home ships defaultEnabled:false and no UI
 * existed to switch it on (WARP-1367).
 */

const LOAD_ERROR_LINE = "Couldn't load features — refresh to try again.";
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

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
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
      <Sect title="Features" />
      <div className="card" style={{ padding: 0 }}>
        <div className="rows">
          {loadFailed ? (
            <div className="lrow" style={{ padding: "12px 16px" }}>
              <span className="rt">
                <span className="sub">{LOAD_ERROR_LINE}</span>
              </span>
            </div>
          ) : modules === null ? (
            <div className="lrow" style={{ padding: "12px 16px" }}>
              <span className="rt">
                <span className="sub">Loading features…</span>
              </span>
            </div>
          ) : (
            CATEGORY_LABELS.map(({ key, label }) => {
              const group = modules.filter((m) => m.category === key);
              if (group.length === 0) return null;
              return (
                <div key={key} role="group" aria-label={label}>
                  <div
                    className="lrow"
                    style={{ padding: "10px 16px 4px" }}
                    aria-hidden="true"
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: "0.4px",
                        textTransform: "uppercase",
                        color: "var(--color-label-secondary, rgba(60,60,67,0.8))",
                      }}
                    >
                      {label}
                    </span>
                  </div>
                  {group.map((mod) => (
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
                      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10 }}>
                        {mod.core ? (
                          <span className="sub" style={{ whiteSpace: "nowrap" }}>
                            Always on
                          </span>
                        ) : (
                          <ToggleSwitch
                            on={mod.enabled}
                            onToggle={() => void handleToggle(mod)}
                            disabled={!mod.available || pending.has(mod.id)}
                            ariaLabel={`${mod.label} enabled`}
                          />
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>
      {toggleError ? (
        <p
          role="alert"
          style={{
            margin: "8px 2px 0",
            fontSize: 13,
            color: "var(--color-system-red, #ff3b30)",
          }}
        >
          {toggleError}
        </p>
      ) : null}
    </section>
  );
}
