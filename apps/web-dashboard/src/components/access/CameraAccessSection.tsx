"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, KeyRound, Video } from "lucide-react";
import {
  fetchCameraAccess,
  fetchCameras,
  setCameraAccess,
  type CameraAccessSaveResult,
} from "@/lib/api";
import type { AccessTier, CameraInfo } from "@/lib/types";

/**
 * WARP-1976 — which cameras can this person see?
 *
 * Sits inside the person panel on /users, because access is managed where
 * PEOPLE are managed. WARP-1962 shipped the model, the enforcement and the
 * endpoints; until this screen existed the feature was enforced and
 * unusable — a family member saw nothing (the safe default) and no owner
 * could grant them anything without curl.
 *
 * ## Two things the model requires this UI to respect
 *
 * **Owners and admins are unrestricted.** Their access does not come from
 * the grant table at all, so a per-camera checklist for them would be a
 * lie: ticking boxes would change nothing. They get a statement, not
 * controls.
 *
 * **Set semantics, not a diff.** The endpoint replaces the whole list, so
 * the screen sends what it shows. A client-computed delta would race a
 * second admin editing the same person.
 */

export interface CameraAccessSectionProps {
  /** Local User.id. Null for a roster row not yet provisioned locally. */
  userId: string | null;
  /** The person's tier — owner/admin bypass per-camera scoping entirely. */
  tier?: AccessTier | null;
  /** First name, for copy that names them. */
  displayName?: string;
  /** Test seam so the suite doesn't reach for the network. */
  loadCameras?: () => Promise<CameraInfo[]>;
  loadGrants?: (userId: string) => Promise<string[]>;
  saveGrants?: (userId: string, cameras: string[]) => Promise<CameraAccessSaveResult>;
}

type Phase = "loading" | "ready" | "error";

const UNRESTRICTED: ReadonlySet<string> = new Set(["owner", "admin"]);

export function CameraAccessSection({
  userId,
  tier,
  displayName,
  loadCameras,
  loadGrants,
  saveGrants,
}: CameraAccessSectionProps) {
  const unrestricted = !!tier && UNRESTRICTED.has(tier);

  const [phase, setPhase] = useState<Phase>("loading");
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!userId || unrestricted) return;
    // A caller (or a test double) may not supply these. Degrade to the
    // error state rather than throwing inside the person panel and taking
    // the whole roles-and-access tab down with us — this section is an
    // addition to that panel, not a reason for it to stop rendering.
    setPhase("loading");
    try {
      // Resolve the real API functions INSIDE the try. Under vitest a
      // module mocked without these exports throws on the binding itself,
      // not on the call — so touching them at parameter-default time would
      // take the whole person panel down in every suite whose `@/lib/api`
      // mock predates this section. Degrading to the error state is the
      // honest outcome: we genuinely cannot read access here.
      const getCameras = loadCameras ?? fetchCameras;
      const getGrants = loadGrants ?? fetchCameraAccess;
      const [list, grants] = await Promise.all([getCameras(), getGrants(userId)]);
      setCameras(list);
      setSelected(new Set(grants));
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [userId, unrestricted, loadCameras, loadGrants]);

  useEffect(() => {
    void load();
  }, [load]);

  // An owner/admin draws no access from the grant table. Say so plainly
  // rather than rendering controls that would do nothing.
  if (unrestricted) {
    return (
      <Frame>
        <p
          data-testid="camera-access-unrestricted"
          className="type-caption-1"
          style={{ color: "var(--text-muted)", display: "flex", gap: 6, alignItems: "flex-start" }}
        >
          <KeyRound size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            Sees every camera. Owners and admins aren&apos;t limited to a list — that
            comes with administering the appliance.
          </span>
        </p>
      </Frame>
    );
  }

  if (!userId) {
    return (
      <Frame>
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          This person hasn&apos;t signed in yet, so there&apos;s no account to give
          camera access to.
        </p>
      </Frame>
    );
  }

  if (phase === "loading") {
    return (
      <Frame>
        <div
          data-testid="camera-access-loading"
          style={{ height: 48, background: "var(--surface-2)", borderRadius: 8 }}
        />
      </Frame>
    );
  }

  if (phase === "error") {
    return (
      <Frame>
        <p
          data-testid="camera-access-error"
          className="type-caption-1"
          style={{ color: "var(--danger)", display: "flex", gap: 6, alignItems: "flex-start" }}
        >
          <AlertTriangle size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            Couldn&apos;t load camera access.{" "}
            <button
              type="button"
              onClick={() => void load()}
              style={{ color: "var(--brand)", fontWeight: 600, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}
            >
              Try again
            </button>
          </span>
        </p>
      </Frame>
    );
  }

  const first = (displayName || "This person").split(" ")[0];
  const toggle = (name: string) => {
    setNote(null);
    setUnknown([]);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  async function save() {
    if (!userId) return;
    setSaving(true);
    setNote(null);
    setUnknown([]);
    try {
      // Send the whole set — what the screen shows IS the new state.
      const put = saveGrants ?? setCameraAccess;
      const result = await put(userId, [...selected]);
      setSelected(new Set(result.granted));
      setUnknown(result.unknown ?? []);
      setNote(
        result.granted.length === 0
          ? `${first} can no longer see any cameras.`
          : `${first} can now see ${result.granted.length} camera${result.granted.length === 1 ? "" : "s"}.`,
      );
    } catch {
      setNote("Couldn't save. Nothing changed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Frame>
      {cameras.length === 0 ? (
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          There are no cameras on this Droplet yet.
        </p>
      ) : (
        <>
          {/* The default is "sees nothing", and an empty checklist looks
              exactly like a loading bug. Say which it is. */}
          {selected.size === 0 && (
            <p
              data-testid="camera-access-empty"
              className="type-caption-1 mb-2"
              style={{ color: "var(--text-muted)" }}
            >
              {first} can&apos;t see any cameras yet. Tick the ones they should be
              able to watch.
            </p>
          )}

          <ul style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {cameras.map((c) => (
              <li key={c.name}>
                <label
                  className="flex items-center gap-2.5 rounded-lg px-2 cursor-pointer hover:bg-[var(--hover)]"
                  // 44px: this list is used on a phone, and a checkbox row
                  // is the easiest thing in a settings screen to under-size.
                  style={{ minHeight: 44 }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.name)}
                    onChange={() => toggle(c.name)}
                    aria-label={c.displayName || c.name}
                    style={{ width: 16, height: 16, accentColor: "var(--brand)" }}
                  />
                  <Video size={14} aria-hidden="true" style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  <span className="type-subheadline" style={{ color: "var(--text)", minWidth: 0 }}>
                    {c.displayName || c.name}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-3 mt-3 flex-wrap">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="btn primary disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save camera access"}
            </button>
            <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
              {selected.size === 0
                ? "No cameras selected"
                : `${selected.size} of ${cameras.length} selected`}
            </span>
          </div>

          {note && (
            <p data-testid="camera-access-note" className="type-caption-1 mt-2" style={{ color: "var(--text-muted)" }}>
              {note}
            </p>
          )}

          {/* The server reports names it didn't recognise. Dropping them
              would make a typo indistinguishable from success. */}
          {unknown.length > 0 && (
            <p
              data-testid="camera-access-unknown"
              className="type-caption-1 mt-1"
              style={{ color: "#d9a35c" }}
            >
              Not recognised, so not granted: {unknown.join(", ")}
            </p>
          )}
        </>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div className="type-caption-1 mb-1.5" style={{ color: "var(--text-muted)" }}>
        Cameras
      </div>
      {children}
    </div>
  );
}
