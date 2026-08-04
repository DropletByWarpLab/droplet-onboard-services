"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plus } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  addFirewallRule,
  setZonePolicy,
  confirmNetworkCommand,
  fetchNetworkOperation,
} from "@/lib/api";
import type { NetworkCommandResult } from "@/lib/types";

/**
 * Firewall authoring (Droplet Design System · Network · Firewall). Two writes:
 * add a traffic rule, and edit a zone's default policy. Both are Tier-2 — the
 * orchestrator answers 202 + token, we pop a ConfirmDialog (the Write-tier gate,
 * with a blast-radius line for zone-policy since it can sever management), then
 * confirm + poll the operation. Zone-policy applies with a 60s auto-rollback on
 * the box, so a lockout reverts itself.
 */

const TARGETS = ["ACCEPT", "REJECT", "DROP"] as const;
type Target = (typeof TARGETS)[number];

/* Indigo input idiom, verbatim from the converted Settings / Users surfaces
   (WARP-1090 / WARP-1080): utilities for layout + focus, inline style for the
   four themeable values. Hoisted here only because this form packs six
   controls onto single JSX lines. */
const INPUT_CLASS =
  "w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors";
const INPUT_STYLE = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-input)",
  color: "var(--text)",
} as const;

async function pollOperation(operationId: string): Promise<void> {
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Timed out waiting for the router.")), 70_000),
  );
  const pollingLoop = async () => {
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected" || op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(op.reason ?? "The router didn't accept the change.");
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  };
  await Promise.race([pollingLoop(), deadline]);
}

/** Drive a Tier-2 firewall write through the 202 → confirm → poll flow. */
async function applyWrite(
  send: () => Promise<NetworkCommandResult>,
): Promise<{ needsConfirm: false } | { needsConfirm: true; token: string; operation: string }> {
  const result = await send();
  if (result.status === "confirmation_required") {
    if (!result.confirmationToken || !result.operation) {
      throw new Error("Server returned confirmation_required without a token — cannot proceed.");
    }
    return { needsConfirm: true, token: result.confirmationToken, operation: result.operation };
  }
  if (result.operationId) await pollOperation(result.operationId);
  return { needsConfirm: false };
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "applied" }
  | { kind: "error"; message: string };

// --- Add rule ---
export function FirewallRuleForm({ zones, onApplied }: { zones: string[]; onApplied?: () => void }) {
  const zoneOpts = zones.length ? zones : ["lan", "wan"];
  const [name, setName] = useState("");
  const [src, setSrc] = useState(zoneOpts[0]);
  const [dest, setDest] = useState(zoneOpts[zoneOpts.length - 1]);
  const [proto, setProto] = useState("tcp");
  const [destPort, setDestPort] = useState("");
  const [target, setTarget] = useState<Target>("REJECT");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, setPending] = useState<{ token: string; operation: string } | null>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  async function finish(after: () => Promise<{ needsConfirm: boolean }>) {
    try {
      const r = await after();
      if (!("needsConfirm" in r) || !r.needsConfirm) {
        setStatus({ kind: "applied" });
        setName("");
        setDestPort("");
        onApplied?.();
      }
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Couldn't add the rule." });
    }
  }

  async function handleSubmit() {
    if (!name.trim()) {
      setStatus({ kind: "error", message: "Give the rule a name." });
      return;
    }
    setStatus({ kind: "saving" });
    const res = await applyWrite(() =>
      addFirewallRule({
        name: name.trim(),
        src,
        dest,
        proto,
        destPort: destPort.trim() || undefined,
        target,
      }),
    ).catch((e) => {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Couldn't add the rule." });
      return null;
    });
    if (!res) return;
    if (res.needsConfirm) {
      setPending({ token: res.token, operation: res.operation });
      return;
    }
    setStatus({ kind: "applied" });
    setName("");
    setDestPort("");
    onApplied?.();
  }

  return (
    <div className="card">
      <h3 className="type-headline text-[color:var(--text)] mb-3 flex items-center gap-2">
        <Plus size={16} /> Add firewall rule
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <label className="type-caption-1 text-[color:var(--text-muted)]">
          Name
          <input className={`${INPUT_CLASS} mt-1`} style={INPUT_STYLE} value={name} onChange={(e) => setName(e.target.value)} maxLength={63} placeholder="Allow-NAS" />
        </label>
        <label className="type-caption-1 text-[color:var(--text-muted)]">
          From
          <select className={`${INPUT_CLASS} mt-1`} style={INPUT_STYLE} value={src} onChange={(e) => setSrc(e.target.value)}>
            {zoneOpts.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        <label className="type-caption-1 text-[color:var(--text-muted)]">
          To
          <select className={`${INPUT_CLASS} mt-1`} style={INPUT_STYLE} value={dest} onChange={(e) => setDest(e.target.value)}>
            {zoneOpts.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        <label className="type-caption-1 text-[color:var(--text-muted)]">
          Protocol
          <select className={`${INPUT_CLASS} mt-1`} style={INPUT_STYLE} value={proto} onChange={(e) => setProto(e.target.value)}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="tcpudp">TCP + UDP</option>
          </select>
        </label>
        <label className="type-caption-1 text-[color:var(--text-muted)]">
          Dest port
          <input className={`${INPUT_CLASS} mt-1 font-mono`} style={INPUT_STYLE} value={destPort} onChange={(e) => setDestPort(e.target.value)} placeholder="443 or 8000-8100" />
        </label>
        <label className="type-caption-1 text-[color:var(--text-muted)]">
          Action
          <select className={`${INPUT_CLASS} mt-1`} style={INPUT_STYLE} value={target} onChange={(e) => setTarget(e.target.value as Target)}>
            {TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>
      <button ref={submitRef} type="button" onClick={handleSubmit} disabled={status.kind === "saving"} className="btn primary mt-3">
        {status.kind === "saving" && <Loader2 size={16} className="animate-spin" />}
        Add rule
      </button>

      {status.kind === "applied" && (
        <p className="mt-3 flex items-center gap-1.5 type-footnote text-system-green">
          <CheckCircle2 size={14} /> Rule added.
        </p>
      )}
      {status.kind === "error" && (
        <p role="alert" className="mt-3 flex items-start gap-1.5 type-footnote text-system-red">
          <AlertCircle size={14} className="mt-0.5" /> {status.message}
        </p>
      )}

      <ConfirmDialog
        open={pending !== null}
        triggerRef={submitRef}
        title="Add this firewall rule?"
        description={`This adds a ${target} rule for ${proto.toUpperCase()} traffic from ${src} to ${dest}. Logged to Activity.`}
        confirmLabel="Add rule"
        variant="neutral"
        onConfirm={async () => {
          const p = pending;
          setPending(null);
          if (!p) return;
          await finish(async () => {
            const { operationId } = await confirmNetworkCommand(p.token, p.operation);
            if (operationId) await pollOperation(operationId);
            return { needsConfirm: false };
          });
        }}
        onCancel={() => {
          setPending(null);
          setStatus({ kind: "idle" });
        }}
      />
    </div>
  );
}

// --- Edit a zone's default policy ---
export function ZonePolicyEditor({
  zone,
  input,
  output,
  forward,
  onApplied,
}: {
  zone: string;
  input?: string;
  output?: string;
  forward?: string;
  onApplied?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState({
    input: (input ?? "ACCEPT") as Target,
    output: (output ?? "ACCEPT") as Target,
    forward: (forward ?? "REJECT") as Target,
  });
  useEffect(() => {
    setPolicy({
      input: (input ?? "ACCEPT") as Target,
      output: (output ?? "ACCEPT") as Target,
      forward: (forward ?? "REJECT") as Target,
    });
  }, [input, output, forward]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, setPending] = useState<{ token: string; operation: string } | null>(null);
  const editRef = useRef<HTMLButtonElement>(null);

  async function handleSave() {
    setStatus({ kind: "saving" });
    const res = await applyWrite(() => setZonePolicy({ zone, ...policy })).catch((e) => {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Couldn't update the policy." });
      return null;
    });
    if (!res) return;
    if (res.needsConfirm) {
      setPending({ token: res.token, operation: res.operation });
      return;
    }
    setStatus({ kind: "applied" });
    setOpen(false);
    onApplied?.();
  }

  return (
    <>
      <button ref={editRef} type="button" className="btn ghost sm" onClick={() => setOpen((o) => !o)} aria-label={`Edit ${zone} zone policy`}>
        Edit
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap items-end gap-2 bg-[var(--inset)] rounded-lg p-2">
          {(["input", "output", "forward"] as const).map((k) => (
            <label key={k} className="type-caption-2 text-[color:var(--text-muted)] capitalize">
              {k}
              <select
                className={`${INPUT_CLASS} mt-0.5 block`}
                style={INPUT_STYLE}
                value={policy[k]}
                onChange={(e) => setPolicy((p) => ({ ...p, [k]: e.target.value as Target }))}
                aria-label={`${zone} ${k} policy`}
              >
                {TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          ))}
          <button type="button" className="btn primary sm" onClick={handleSave} disabled={status.kind === "saving"}>
            {status.kind === "saving" ? <Loader2 size={14} className="animate-spin" /> : "Save"}
          </button>
          {status.kind === "error" && (
            <span role="alert" className="type-caption-2 text-system-red">{status.message}</span>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        triggerRef={editRef}
        title={`Change the ${zone} zone policy?`}
        description={`Setting ${zone} to input ${policy.input} / forward ${policy.forward} can change what traffic the firewall allows — a too-strict policy on your management zone could cut you off, but the box auto-reverts after 60 seconds if it loses contact.`}
        confirmLabel="Apply policy"
        variant="destructive"
        onConfirm={async () => {
          const p = pending;
          setPending(null);
          if (!p) return;
          try {
            const { operationId } = await confirmNetworkCommand(p.token, p.operation);
            if (operationId) await pollOperation(operationId);
            setStatus({ kind: "applied" });
            setOpen(false);
            onApplied?.();
          } catch (e) {
            setStatus({ kind: "error", message: e instanceof Error ? e.message : "Couldn't update the policy." });
          }
        }}
        onCancel={() => {
          setPending(null);
          setStatus({ kind: "idle" });
        }}
      />
    </>
  );
}
