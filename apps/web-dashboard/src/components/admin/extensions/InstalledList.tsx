"use client";

/**
 * WARP-2900 (ADR-056 slice H4) — promoted extensions and the owner's
 * disable / enable / uninstall.
 *
 * A row is named by the extension's id and version (the box's names for it),
 * with what it got — the readback lines the orchestrator derived from
 * `provides` — never the author's own description. A failure is said by its
 * CODE (explainLifecycleFailure), never by the reason's detail, which can
 * carry the extension's build output, tool names and error text (review
 * #2326). Uninstall asks twice: it removes the running code, the tools and
 * the call-back token.
 *
 * Every lifecycle state the orchestrator can leave from is offered here, so
 * the owner never needs the raw API:
 *   - disabled → Enable;
 *   - failed → Retry (the same enable: re-verify, fresh token, start) or
 *     Disable;
 *   - uninstalled → Reinstall. The signed version row survives an uninstall
 *     (the proposal then reads "already promoted"), and enable re-verifies
 *     and reinstalls it, so the row stays listed with that one action rather
 *     than vanishing and leaving the owner no way back but a new version.
 */
import { useEffect, useRef, useState } from "react";
import { AppWindow, Puzzle } from "lucide-react";
import { Badge, Card, Row } from "@/components/shell/primitives";
import type { ExtensionListItem } from "@/lib/types";
import { STATUS_BADGE, displayVersion, explainExtensionError, explainLifecycleFailure } from "./copy";
import { HostedAppOpen } from "@/components/hosted/AppActions";
import { AppGrantDialog } from "@/components/hosted/AppGrantDialog";
import { AppUninstallDialog } from "@/components/hosted/AppUninstallDialog";

export interface InstalledListProps {
  extensions: ExtensionListItem[];
  loading: boolean;
  error: Error | undefined;
  canManage: boolean;
  /** The extension an action is running on, if any. */
  busy: string | null;
  onSetEnabled: (slug: string, enabled: boolean) => void;
  onUninstall: (slug: string) => void;
  onRefresh?: () => Promise<void>;
}

function signerLabel(signer: string): string {
  return signer === "box" ? "signed by this box" : signer === "release" ? "signed by Warp Lab" : `signed (${signer})`;
}

export function InstalledList(props: InstalledListProps) {
  const [confirmingUninstall, setConfirmingUninstall] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const [appDialog, setAppDialog] = useState<{ slug: string; kind: "grants" | "uninstall" | "delete-data" } | null>(null);
  const appTrigger = useRef<HTMLElement | null>(null);
  // Uninstall swaps its own button for Confirm / Keep: put focus on Confirm so
  // a keyboard or screen-reader user is not left on a button that is gone.
  useEffect(() => {
    if (confirmingUninstall !== null) confirmRef.current?.focus();
  }, [confirmingUninstall]);

  if (props.error) {
    return (
      <Card>
        <p className="sub" role="alert">
          Could not read the installed extensions. {explainExtensionError(props.error)}
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
  const shown = props.extensions;
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
    <>
    <Card>
      <div className="rows">
        {shown.map((ext) => {
          const badge = STATUS_BADGE[ext.status];
          const busy = props.busy === ext.id;
          const app = ext.readback?.kind === "app";
          const lines = ext.readback?.lines ?? [];
          const sub = [
            ext.version ? `version ${displayVersion(ext.version.version)} · ${signerLabel(ext.version.signer)}` : "no signed version",
            ext.status === "failed" ? explainLifecycleFailure(ext.failureReason) : null,
            lines[0] ?? null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Row
              key={ext.id}
              icon={app ? <AppWindow size={15} /> : <Puzzle size={15} />}
              iconBrand
              title={ext.id}
              sub={sub}
              right={
                <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge kind={badge.kind}>{app && ext.status === "installed" ? "Starting" : badge.label}</Badge>
                  {app && ext.status === "live" && <HostedAppOpen slug={ext.id} disabled={busy} />}
                  {app && props.canManage && <button type="button" className="btn sm" disabled={busy} aria-label={`Access for ${ext.id}`}
                    onClick={(event) => { appTrigger.current = event.currentTarget; setAppDialog({ slug: ext.id, kind: "grants" }); }}>Access</button>}
                  {props.canManage ? (
                    confirmingUninstall === ext.id ? (
                      <>
                        <button
                          type="button"
                          ref={confirmRef}
                          className="btn danger sm"
                          disabled={busy}
                          aria-label={`Confirm uninstall ${ext.id}`}
                          onClick={() => {
                            setConfirmingUninstall(null);
                            props.onUninstall(ext.id);
                          }}
                        >
                          Confirm uninstall
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          aria-label={`Keep ${ext.id}`}
                          onClick={() => setConfirmingUninstall(null)}
                        >
                          Keep
                        </button>
                      </>
                    ) : ext.status === "uninstalled" ? (
                      <><button
                        type="button"
                        className="btn sm"
                        disabled={busy || !ext.version}
                        aria-label={`Reinstall ${ext.id}`}
                        onClick={() => props.onSetEnabled(ext.id, true)}
                      >
                        Reinstall
                      </button>
                      {app && <button type="button" className="btn ghost sm" disabled={busy} aria-label={`Remove saved data for ${ext.id}`}
                        onClick={(event) => { appTrigger.current = event.currentTarget; setAppDialog({ slug: ext.id, kind: "delete-data" }); }}>Remove saved data</button>}</>
                    ) : (
                      <>
                        {ext.status === "disabled" || ext.status === "failed" ? (
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            aria-label={`${ext.status === "failed" ? "Retry" : "Enable"} ${ext.id}`}
                            onClick={() => props.onSetEnabled(ext.id, true)}
                          >
                            {ext.status === "failed" ? "Retry" : "Enable"}
                          </button>
                        ) : null}
                        {ext.status !== "disabled" ? (
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            aria-label={`Disable ${ext.id}`}
                            onClick={() => props.onSetEnabled(ext.id, false)}
                          >
                            Disable
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy}
                          aria-label={`Uninstall ${ext.id}`}
                          onClick={(event) => {
                            if (app) { appTrigger.current = event.currentTarget; setAppDialog({ slug: ext.id, kind: "uninstall" }); }
                            else setConfirmingUninstall(ext.id);
                          }}
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
    {appDialog?.kind === "grants" && <AppGrantDialog key={appDialog.slug} slug={appDialog.slug} triggerRef={appTrigger}
      onClose={() => setAppDialog(null)} onSaved={props.onRefresh ?? (async () => undefined)} />}
    {appDialog && appDialog.kind !== "grants" && <AppUninstallDialog key={appDialog.slug} slug={appDialog.slug} triggerRef={appTrigger} dataOnly={appDialog.kind === "delete-data"}
      onClose={() => setAppDialog(null)} onDone={props.onRefresh ?? (async () => undefined)} />}
    </>
  );
}
