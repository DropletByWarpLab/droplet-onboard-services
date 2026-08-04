"use client";

import { useRef, useState } from "react";
import { Plus, Pencil, RefreshCw, Loader2, AlertCircle, Info } from "lucide-react";
import {
  createInterface,
  editInterface,
  restartNetwork,
  confirmNetworkCommand,
  fetchNetworkOperation,
  type InterfaceWriteFields,
} from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Dialog } from "@/components/Dialog";

/**
 * Interface Add / Edit / Restart write controls (KAN-10).
 *
 * The Interfaces table was read-only (PR #669). Editing an interface is high
 * blast radius — a wrong proto/address/zone can cut this dashboard's own
 * connection — so every write here rides the SAME blast-radius-safety patterns
 * the rest of the Network tab uses, never a new design system:
 *   - the Tier-2 (add/edit) / Tier-3 (restart) confirmNetworkCommand flow, so
 *     the orchestrator answers 202 and the routing service wraps the actual
 *     write in safe_apply (60s auto-rollback);
 *   - the shared ConfirmDialog primitive for the consent prompt;
 *   - an EXTRA confirm before a write to the MANAGEMENT interface (the one this
 *     dashboard is reached on) — that confirm IS what sets `force:true`, the
 *     connectivity-self-cut acknowledgement the routing guard requires.
 */

export interface InterfaceRow {
  name: string;
  device: string | null;
  proto: string | null;
  address: string | null;
  zone: string | null;
  up: boolean;
  present: boolean;
}

// The interfaces the dashboard is reached on. A write to one of these needs the
// extra connectivity-self-cut confirm; the routing service is the authoritative
// guard (refuses without force), this list just decides when to prompt.
const MANAGEMENT_INTERFACES = new Set(["lan", "mgmt"]);

const PROTO_OPTIONS = [
  { value: "static", label: "Static IP" },
  { value: "dhcp", label: "Automatic (DHCP)" },
  { value: "dhcpv6", label: "Automatic (DHCPv6)" },
  { value: "pppoe", label: "PPPoE" },
  { value: "none", label: "Unmanaged" },
] as const;

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
const NAME_RE = /^[a-z0-9_]{1,15}$/;

type EditorMode =
  | { kind: "add" }
  | { kind: "edit"; row: InterfaceRow };

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

function isManagement(name: string): boolean {
  return MANAGEMENT_INTERFACES.has(name.trim().toLowerCase());
}

async function pollOperation(operationId: string): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const op = await fetchNetworkOperation(operationId);
    if (op.state === "applied") return;
    if (op.state === "rejected" || op.state === "rolled_back" || op.state === "unknown") {
      throw new Error(op.reason ?? "The change didn't take, so nothing was changed.");
    }
    if (Date.now() - startedAt > 70_000) {
      throw new Error("Timed out waiting for the router.");
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

export function InterfaceWriteControls({
  rows,
  canEdit,
  isOwner,
  onApplied,
}: {
  rows: InterfaceRow[];
  /** owner/admin — may add + edit interfaces. */
  canEdit: boolean;
  /** owner only — may also restart networking. */
  isOwner: boolean;
  onApplied?: () => void;
}) {
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const editTriggerRef = useRef<HTMLElement | null>(null);

  if (!canEdit) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--card-bd)] pt-4">
      <button
        ref={addBtnRef}
        type="button"
        onClick={() => setEditor({ kind: "add" })}
        className="btn ghost"
      >
        <Plus size={16} aria-hidden="true" />
        Add interface
      </button>

      {/* Per-row Edit buttons live in the table; expose a compact editor launcher
          here too so keyboard users have a single predictable control region. */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Edit interfaces">
        {rows
          .filter((r) => r.present)
          .map((row) => (
            <button
              key={row.name}
              type="button"
              onClick={(e) => {
                editTriggerRef.current = e.currentTarget;
                setEditor({ kind: "edit", row });
              }}
              className="type-caption-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[color:var(--text-muted)] hover:bg-[var(--hover)] transition-colors"
            >
              <Pencil size={13} aria-hidden="true" />
              Edit {row.name}
            </button>
          ))}
      </div>

      {isOwner && (
        <div className="ml-auto">
          <RestartNetworkButton onApplied={onApplied} />
        </div>
      )}

      {editor && (
        <InterfaceEditorDialog
          mode={editor}
          triggerRef={editor.kind === "add" ? addBtnRef : editTriggerRef}
          onClose={() => setEditor(null)}
          onApplied={onApplied}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor dialog (Add + Edit share one form)
// ---------------------------------------------------------------------------
function InterfaceEditorDialog({
  mode,
  triggerRef,
  onClose,
  onApplied,
}: {
  mode: EditorMode;
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const isEdit = mode.kind === "edit";
  const existing = mode.kind === "edit" ? mode.row : null;
  const name = existing?.name ?? "";

  const [nameInput, setNameInput] = useState(name);
  const [proto, setProto] = useState(existing?.proto ?? "static");
  // Address shown as ip/mask in the read table; the editor takes a bare IPv4.
  const [ipaddr, setIpaddr] = useState(existing?.address?.split("/")[0] ?? "");
  const [device, setDevice] = useState(existing?.device ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Holds the management extra-confirm: when set, the write is staged and waits
  // for the connectivity-self-cut acknowledgement.
  const [pendingManagement, setPendingManagement] = useState<
    null | { name: string; fields: InterfaceWriteFields }
  >(null);

  const targetName = isEdit ? name : nameInput.trim();
  const isStatic = proto === "static";

  function validate(): string | null {
    if (!isEdit && !NAME_RE.test(nameInput.trim())) {
      return "Name must be lowercase letters, digits or underscores (max 15).";
    }
    if (isStatic && ipaddr.trim() && !IPV4_RE.test(ipaddr.trim())) {
      return "Enter a valid IPv4 address (e.g. 192.168.40.1).";
    }
    return null;
  }

  function buildFields(force: boolean): InterfaceWriteFields {
    const fields: InterfaceWriteFields = { proto };
    if (device.trim()) fields.device = device.trim();
    if (isStatic && ipaddr.trim()) fields.ipaddr = ipaddr.trim();
    if (force) fields.force = true;
    return fields;
  }

  async function dispatchWrite(force: boolean) {
    setStatus({ kind: "saving" });
    try {
      const fields = buildFields(force);
      const result = isEdit
        ? await editInterface(targetName, fields)
        : await createInterface(targetName, { proto, ...fields });

      if (
        result.status === "confirmation_required" &&
        result.confirmationToken &&
        result.operation
      ) {
        const { operationId } = await confirmNetworkCommand(
          result.confirmationToken,
          result.operation,
        );
        if (operationId) await pollOperation(operationId);
      }
      onApplied?.();
      onClose();
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Couldn't save the interface.",
      });
    }
  }

  function handleSave() {
    const v = validate();
    if (v) {
      setStatus({ kind: "error", message: v });
      return;
    }
    // A write to the management interface needs the extra connectivity-self-cut
    // confirm before we send force:true.
    if (isManagement(targetName)) {
      setPendingManagement({ name: targetName, fields: buildFields(true) });
      return;
    }
    void dispatchWrite(false);
  }

  const saving = status.kind === "saving";
  const titleId = "iface-editor-title";

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        triggerRef={triggerRef}
        labelledBy={titleId}
        maxWidth="sm"
        placement="center"
      >
        {/* Body padding comes from the <Dialog> primitive (WARP-1153). */}
        <div className="space-y-4">
          <div>
            <h2 id={titleId} className="type-headline text-[color:var(--text)]">
              {isEdit ? `Edit ${name}` : "Add interface"}
            </h2>
            <p className="type-subheadline text-[color:var(--text-muted)] mt-1.5">
              {isEdit
                ? "Change how this interface connects. We'll ask you to confirm before applying."
                : "Set up a new network interface. We'll ask you to confirm before applying."}
            </p>
          </div>

          <div className="space-y-4">
            {!isEdit && (
              <div>
                <label htmlFor="iface-name" className="type-subheadline text-[color:var(--text-muted)] block mb-1.5">
                  Name
                </label>
                <input
                  id="iface-name"
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="e.g. guest"
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors font-mono"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                  disabled={saving}
                  autoComplete="off"
                />
              </div>
            )}

            <div>
              <label htmlFor="iface-proto" className="type-subheadline text-[color:var(--text-muted)] block mb-1.5">
                Connection type
              </label>
              <select
                id="iface-proto"
                value={proto}
                onChange={(e) => setProto(e.target.value)}
                className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
                disabled={saving}
              >
                {PROTO_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {isStatic && (
              <div>
                <label htmlFor="iface-ip" className="type-subheadline text-[color:var(--text-muted)] block mb-1.5">
                  IP address
                </label>
                <input
                  id="iface-ip"
                  type="text"
                  value={ipaddr}
                  onChange={(e) => setIpaddr(e.target.value)}
                  placeholder="192.168.40.1"
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors font-mono"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                  disabled={saving}
                  inputMode="numeric"
                  autoComplete="off"
                />
              </div>
            )}

            <div>
              <label htmlFor="iface-device" className="type-subheadline text-[color:var(--text-muted)] block mb-1.5">
                Device <span className="text-[color:var(--text-muted)]">(optional)</span>
              </label>
              <input
                id="iface-device"
                type="text"
                value={device}
                onChange={(e) => setDevice(e.target.value)}
                placeholder="e.g. br-lan.20"
                className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors font-mono"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
                disabled={saving}
                autoComplete="off"
              />
            </div>
          </div>

          {targetName && isManagement(targetName) && (
            <div
              role="note"
              className="flex items-start gap-2 type-footnote text-[color:var(--text)] bg-system-orange/10 rounded-sm px-3 py-2"
            >
              <Info size={14} className="mt-0.5 flex-shrink-0 text-system-orange" aria-hidden="true" />
              <span>
                This is the interface this dashboard is reached on. Changing it can
                cut your own connection — we&rsquo;ll ask you to confirm once more.
              </span>
            </div>
          )}

          {status.kind === "error" && (
            <div
              role="alert"
              className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
            >
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span>{status.message}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="btn ghost"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="btn primary"
            >
              {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add"}
            </button>
          </div>
        </div>
      </Dialog>

      {/* Extra confirm before a management-interface write — this acknowledgement
          IS what sends force:true to the routing safe_apply guard. */}
      <ConfirmDialog
        open={pendingManagement !== null}
        title="Change the interface you're connected through?"
        description="This is the interface this dashboard reaches the appliance on. If the new settings are wrong you'll lose your connection — the appliance will revert automatically after a minute, then you can reconnect."
        confirmLabel="I understand — continue"
        variant="destructive"
        onConfirm={async () => {
          setPendingManagement(null);
          await dispatchWrite(true);
        }}
        onCancel={() => setPendingManagement(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Restart networking (owner-only, Tier 3)
// ---------------------------------------------------------------------------
function RestartNetworkButton({ onApplied }: { onApplied?: () => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restarting = status.kind === "saving";

  async function doRestart() {
    setStatus({ kind: "saving" });
    try {
      await restartNetwork();
      setStatus({ kind: "idle" });
      onApplied?.();
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Couldn't restart networking. Try again.",
      });
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={restarting}
        className="btn ghost"
        /* `.droplet-shell .btn` pins `color` at (0,2,0) — the danger ink has to
           come from the style attribute to win. */
        style={{ color: "var(--danger)" }}
      >
        {restarting ? (
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw size={16} aria-hidden="true" />
        )}
        {restarting ? "Restarting…" : "Restart network"}
      </button>

      {status.kind === "error" && (
        <div
          role="alert"
          className="mt-2 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{status.message}</span>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        triggerRef={triggerRef}
        title="Restart networking?"
        description="Every interface drops and reconnects for a few seconds — this dashboard included. Devices reconnect on their own."
        confirmLabel="Restart"
        variant="destructive"
        onConfirm={async () => {
          setConfirmOpen(false);
          await doRestart();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
