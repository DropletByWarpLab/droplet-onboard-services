"use client";

/**
 * WARP-2871 — the Cloud section of /models: the ONE place for cloud models.
 *
 *   1. Switch card — the workspace `cloud_model_escape` channel. Owners/admins
 *      flip it here; turning ON is double-confirmed (prompts leave the box),
 *      turning OFF is a plain flip. Members see the state and who can change it.
 *   2. Providers card — one row per provider with its key state and, for
 *      admins, the key actions (moved off Settings).
 *   3. A caption saying where keys live and where they can go.
 *
 * Honesty: nothing here is derived from absence — `hasKey: null` renders
 * "Unknown", `allowedForYou: null` renders "Key saved", and the change line
 * only names a person/date the payload actually carries.
 */

import { useState } from "react";
import { ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import { setCloudModelEscape } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import { Badge } from "@/components/shell/primitives";
import { AccessToggle } from "@/components/access/bits";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CloudProviderRow } from "@/components/models/CloudProviderRow";
import type { CloudAccessInfo, CloudProviderRow as Row } from "@/lib/types";

// Second line sits under `.rt`: `.ri` 34px + 13px gap + 2px row padding.
const TEXT_INDENT = 49;

function changeLine(a: CloudAccessInfo): string | null {
  const date = a.escapeChangedAt
    ? new Date(a.escapeChangedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  if (!a.escapeEnabled && !a.escapeChangedBy && !date) {
    return "Off since setup · Nothing has left this Droplet for a cloud model.";
  }
  // Omit whichever of by/date the payload doesn't carry — never invent one.
  const parts = [
    `Turned ${a.escapeEnabled ? "on" : "off"}${a.escapeChangedBy ? ` by ${a.escapeChangedBy}` : ""}`,
  ];
  if (date) parts.push(date);
  return parts.join(" · ");
}

export function CloudSection({
  cloud,
  cloudAccess,
  canManage,
  onChanged,
}: {
  cloud: Row[];
  cloudAccess: CloudAccessInfo;
  /** Owner/admin — operable switch + key actions. */
  canManage: boolean;
  onChanged: () => void;
}) {
  const on = cloudAccess.escapeEnabled;
  const [confirmOn, setConfirmOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Resolves true on success. Errors are rendered below the card, never
   *  thrown — the OFF flip is fire-and-forget from the switch. */
  async function flip(enabled: boolean): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await setCloudModelEscape(enabled);
      onChanged();
      return true;
    } catch (err) {
      setError(translateError(err, "cloud-access"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Deviation from the brief's "member && allowedForYou === false": while the
  // box-wide switch is OFF, allowedForYou is false for everyone and the strip's
  // "your role doesn't allow" would name the wrong reason. The switch card
  // already says cloud is off, so the strip only appears when the ROLE is the
  // blocker.
  const memberStrip = !canManage && on && cloudAccess.allowedForYou === false;

  const caption = canManage
    ? on
      ? "Keys are managed by admins, stored encrypted on your Droplet, and never leave it except to the provider they belong to. Spend per provider appears here once the box starts reporting it."
      : "You can add keys while cloud is off. Nothing is sent to a provider until an admin turns cloud models on above."
    : "Keys are stored encrypted on your Droplet and never leave it except to the provider they belong to.";

  const line = changeLine(cloudAccess);

  return (
    <section aria-labelledby="models-cloud-heading">
      <div className="sect">
        <h2 id="models-cloud-heading">Cloud</h2>
        <span className="sx">Opt-in, off by default</span>
      </div>

      {/* Switch card */}
      <div className="card" style={{ padding: 6, marginBottom: 12 }}>
        <div className="rows">
          <div className="lrow">
            <span className={on ? "ri brand" : "ri"} aria-hidden>
              <ShieldCheck size={16} />
            </span>
            <span className="rt">
              <span className="nm">
                {canManage
                  ? "Allow cloud models on this Droplet"
                  : on
                    ? "Cloud models are allowed on this Droplet"
                    : "Cloud models are off on this Droplet"}
              </span>
              {/* .sub is nowrap+ellipsis by default; these are sentences. */}
              <span className="sub" style={{ whiteSpace: "normal" }}>
                {canManage
                  ? "Prompts sent to a cloud model leave the box. Only people with a key and a role that allows it can use one."
                  : "Only an admin can change this."}
              </span>
            </span>
            {on ? <Badge kind="ok">On</Badge> : <Badge kind="muted">Off</Badge>}
            {canManage && (
              <AccessToggle
                on={on}
                disabled={busy}
                ariaLabel="Allow cloud models on this Droplet"
                onChange={() => (on ? void flip(false) : setConfirmOn(true))}
              />
            )}
          </div>
          {line && (
            <div className="lrow" style={{ paddingLeft: TEXT_INDENT, paddingTop: 0, minHeight: 0 }}>
              <span className="rt">
                <span className="sub">{line}</span>
              </span>
            </div>
          )}
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="type-footnote"
          style={{ color: "var(--system-red, #ff3b30)", margin: "0 0 12px" }}
        >
          {error}
        </p>
      )}

      {/* Providers card */}
      <div className="card" style={{ padding: 6 }}>
        <div className="rows">
          {memberStrip && (
            <div
              className="lrow"
              style={{ background: "rgba(217,163,92,0.08)", borderRadius: 9, padding: "12px 8px" }}
            >
              <span className="ri sev-ic warn" aria-hidden>
                <Users size={16} />
              </span>
              <span className="rt">
                <span className="nm">Cloud keys are managed by an admin</span>
                <span className="sub" style={{ whiteSpace: "normal" }}>
                  Your role doesn’t allow cloud models yet. An admin can change that in{" "}
                  <Link href="/users" style={{ color: "var(--brand)" }}>
                    Roles &amp; Access
                  </Link>
                  .
                </span>
              </span>
            </div>
          )}
          {cloud.map((c) => (
            <CloudProviderRow
              key={c.provider}
              row={c}
              cloudAccess={cloudAccess}
              canManage={canManage}
              onChanged={onChanged}
            />
          ))}
        </div>
      </div>

      <p className="type-caption-1" style={{ color: "var(--text-muted)", marginTop: 12 }}>
        {caption}
      </p>

      <ConfirmDialog
        open={confirmOn}
        onConfirm={async () => {
          // ConfirmDialog closes on resolve and stays open on reject — a failed
          // PATCH must not read as success, so rethrow (the error text is
          // already rendered by flip).
          if (!(await flip(true))) throw new Error("cloud_escape_failed");
        }}
        onCancel={() => setConfirmOn(false)}
        title="Turn cloud models on?"
        description="Prompts sent to a cloud model will leave your Droplet and go to that provider. Only people with a key and a role that allows it can use one. This change is logged to Activity."
        confirmLabel="Turn on"
        variant="destructive"
      />
    </section>
  );
}
