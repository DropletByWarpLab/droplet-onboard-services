"use client";

/**
 * WARP-2900 (ADR-056 slice H4) — promoted extensions and the owner's
 * disable / enable / uninstall.
 *
 * A row is named by the extension's id and version (the box's names for it),
 * with what it got — the readback lines the orchestrator derived from
 * `provides` — never the author's own description. Uninstall asks twice: it
 * removes the code, the tools and the call-back token, and a promoted
 * version cannot be brought back without promoting it again.
 */
import { useState } from "react";
import { Puzzle } from "lucide-react";
import { Badge, Card, Row } from "@/components/shell/primitives";
import type { ExtensionListItem } from "@/lib/types";
import { STATUS_BADGE } from "./copy";

export interface InstalledListProps {
  extensions: ExtensionListItem[];
  loading: boolean;
  error: Error | undefined;
  canManage: boolean;
  /** The extension an action is running on, if any. */
  busy: string | null;
  onSetEnabled: (slug: string, enabled: boolean) => void;
  onUninstall: (slug: string) => void;
}

function signerLabel(signer: string): string {
  return signer === "box" ? "signed by this box" : signer === "release" ? "signed by Warp Lab" : `signed (${signer})`;
}

export function InstalledList(props: InstalledListProps) {
  const [confirmingUninstall, setConfirmingUninstall] = useState<string | null>(null);

  if (props.error) {
    return (
      <Card>
        <p className="sub" role="alert">
          Could not read the installed extensions. {props.error.message}
        </p>
      </Card>
    );
  }
  if (props.loading) {
    return (
      <Card>
        <p className="sub">Loading…</p>
      </Card>
    );
  }
  const shown = props.extensions.filter((e) => e.status !== "uninstalled");
  if (shown.length === 0) {
    return (
      <Card>
        <div className="empty">
          <span className="ei">
            <Puzzle size={24} />
          </span>
          <span className="eh">No extensions yet</span>
          <span>An extension appears here once an owner promotes a workshop proposal.</span>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="rows">
        {shown.map((ext) => {
          const badge = STATUS_BADGE[ext.status];
          const busy = props.busy === ext.id;
          const lines = ext.readback?.lines ?? [];
          const sub = [
            ext.version ? `version ${ext.version.version} · ${signerLabel(ext.version.signer)}` : "no signed version",
            ext.status === "failed" && ext.failureReason ? ext.failureReason : null,
            lines[0] ?? null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Row
              key={ext.id}
              icon={<Puzzle size={15} />}
              iconBrand
              title={ext.id}
              sub={sub}
              right={
                <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge kind={badge.kind}>{badge.label}</Badge>
                  {props.canManage ? (
                    confirmingUninstall === ext.id ? (
                      <>
                        <button
                          type="button"
                          className="btn danger sm"
                          disabled={busy}
                          onClick={() => {
                            setConfirmingUninstall(null);
                            props.onUninstall(ext.id);
                          }}
                        >
                          Confirm uninstall
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => setConfirmingUninstall(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        {ext.status === "disabled" ? (
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            aria-label={`Enable ${ext.id}`}
                            onClick={() => props.onSetEnabled(ext.id, true)}
                          >
                            Enable
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            aria-label={`Disable ${ext.id}`}
                            onClick={() => props.onSetEnabled(ext.id, false)}
                          >
                            Disable
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy}
                          aria-label={`Uninstall ${ext.id}`}
                          onClick={() => setConfirmingUninstall(ext.id)}
                        >
                          Uninstall
                        </button>
                      </>
                    )
                  ) : null}
                </span>
              }
            />
          );
        })}
      </div>
    </Card>
  );
}
