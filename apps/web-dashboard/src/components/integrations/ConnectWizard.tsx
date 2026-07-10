"use client";

/**
 * Connect Eaglesoft wizard (design brief §5) — 4 steps + result, in the shared
 * Dialog (portaled → global design-token scope, so type-* / dp-* / tailwind
 * tokens, not the .droplet-shell classes).
 *
 * Every network action hits the real orchestrator endpoints (api.erp). Until
 * the connector backend lands (WARP-1095+) those 404, and the wizard says so
 * honestly instead of faking a connection.
 */

import { useEffect, useId, useMemo, useState, type RefObject } from "react";
import {
  Server,
  Lock,
  ShieldCheck,
  Copy,
  Check,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { SafetyChip } from "./SafetyChip";
import {
  testEaglesoftConnection,
  connectEaglesoft,
  type ConnectionTestResult,
} from "@/lib/api.erp";
import type { ErpScope, EaglesoftConnectInput } from "@/lib/erp-types";
import type { TypedError } from "@/lib/hooks/apiFetch";

type Step = 1 | 2 | 3 | 4 | "result";

const SCOPES: { id: ErpScope; label: string; tag?: string }[] = [
  { id: "schedule", label: "Schedule & appointments" },
  { id: "patients", label: "Patients & contact info", tag: "PHI" },
  { id: "providers", label: "Providers & chairs" },
  { id: "financials", label: "Production & accounts receivable", tag: "financial" },
  { id: "recall", label: "Recall / recare" },
];

function friendlyConnectError(err: unknown): string {
  const code = (err as TypedError)?.code;
  if (code === "TIMEOUT") return "The server didn't answer in time — check it's on and reachable.";
  if (code === "NETWORK_ERROR" || code === "UNKNOWN")
    return "Setup isn't available on this Droplet yet — the Eaglesoft connector is still being wired up.";
  const msg = (err as Error)?.message;
  return msg || "Something went wrong. Try again.";
}

export function ConnectWizard({
  open,
  onClose,
  onConnected,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  onConnected?: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
}) {
  const headingId = useId();
  const [step, setStep] = useState<Step>(1);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("2638");
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [scopes, setScopes] = useState<Record<ErpScope, boolean>>({
    schedule: true,
    patients: true,
    providers: true,
    financials: true,
    recall: true,
  });
  const [enableWrites, setEnableWrites] = useState(false);
  const [adminPath, setAdminPath] = useState<"self" | "handoff" | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      // reset on close so a re-open starts clean
      setStep(1);
      setHost("");
      setPort("2638");
      setAdvanced(false);
      setTest(null);
      setEnableWrites(false);
      setAdminPath(null);
      setError(null);
    }
  }, [open]);

  // The droplet_ro password is generated (strong, unique per box) and stored
  // via a secret_ref by Droplet when it provisions — never fabricated in the
  // browser (that would strand a live credential the connector can't retrieve).
  // The script carries the placeholder Droplet fills in with the issued value;
  // mirrors services/erp-connector/sql/provision.sql (WARP-1094, brief §8.1).
  const provisionScript = useMemo(
    () =>
      [
        "-- Run once as a SQL Anywhere DBA on the PattersonPM database.",
        "-- Replace <GENERATED_BY_DROPLET> with the password Droplet issues on the setup screen.",
        "CREATE USER droplet_ro IDENTIFIED BY '<GENERATED_BY_DROPLET>';",
        "GRANT SELECT ON dba.patient TO droplet_ro;",
        "GRANT SELECT ON dba.appointment TO droplet_ro;",
        "GRANT SELECT ON dba.provider TO droplet_ro;",
        "GRANT SELECT ON dba.service TO droplet_ro;",
        "GRANT SELECT ON dba.serv_trans TO droplet_ro;",
        "GRANT SELECT ON dba.recall TO droplet_ro;",
        "GRANT SELECT ON dba.account TO droplet_ro;   -- AR read only",
      ].join("\n"),
    [],
  );

  const selectedScopes = (Object.keys(scopes) as ErpScope[]).filter((s) => scopes[s]);

  async function runTest() {
    setTesting(true);
    setTest(null);
    setError(null);
    try {
      const result = await testEaglesoftConnection({ host, port: Number(port) || 2638 });
      setTest(result);
    } catch (err) {
      setTest({ reachable: false, message: friendlyConnectError(err) });
    } finally {
      setTesting(false);
    }
  }

  async function doConnect() {
    setBusy(true);
    setError(null);
    const input: EaglesoftConnectInput = {
      host,
      port: Number(port) || 2638,
      scopes: selectedScopes,
      enableWrites,
    };
    try {
      await connectEaglesoft(input);
      setStep("result");
      onConnected?.();
    } catch (err) {
      setError(friendlyConnectError(err));
    } finally {
      setBusy(false);
    }
  }

  function copyScript() {
    void navigator.clipboard?.writeText(provisionScript);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const dots = [1, 2, 3, 4];

  return (
    <Dialog open={open} onClose={onClose} triggerRef={triggerRef} labelledBy={headingId} maxWidth="xl">
      <div className="flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 border-b border-separator">
          <div className="flex items-center gap-2">
            {dots.map((d) => (
              <span
                key={d}
                aria-hidden
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  step !== "result" && d === step
                    ? "w-5 bg-accent"
                    : step === "result" || (typeof step === "number" && d < step)
                      ? "w-1.5 bg-accent"
                      : "w-1.5 bg-separator"
                }`}
              />
            ))}
          </div>
          <SafetyChip variant={step === 4 || step === "result" ? "read-phi" : "setup"} />
        </div>

        <div className="px-6 py-6">
          {/* Step 1 — find the server */}
          {step === 1 && (
            <div>
              <h2 id={headingId} className="type-title-2 text-label-primary">
                Where is Eaglesoft running?
              </h2>
              <p className="type-subheadline text-label-secondary mt-2">
                Enter the computer on your network that runs Eaglesoft. It&rsquo;s usually your
                server or front-desk PC.
              </p>

              <label className="block mt-5 type-footnote text-label-secondary">Server address</label>
              <div className="mt-1.5 flex items-center gap-2 dp-input" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                <Server size={15} className="text-label-tertiary shrink-0" />
                <input
                  className="flex-1 bg-transparent outline-none text-label-primary placeholder:text-label-tertiary"
                  placeholder="10.0.1.5 or server-pc"
                  value={host}
                  onChange={(e) => { setHost(e.target.value); setTest(null); }}
                  aria-label="Eaglesoft server address"
                />
              </div>

              <button
                type="button"
                className="mt-3 type-caption-1 text-accent"
                onClick={() => setAdvanced((a) => !a)}
              >
                {advanced ? "Hide advanced" : "Advanced"}
              </button>
              {advanced && (
                <div className="mt-2">
                  <label className="block type-footnote text-label-secondary">Port</label>
                  <input
                    className="dp-input mt-1.5 max-w-[140px]"
                    style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    aria-label="Port"
                  />
                </div>
              )}

              {test && (
                <div
                  className={`mt-4 flex items-start gap-2 rounded-sm p-3 type-footnote ${
                    test.reachable
                      ? "bg-system-green/10 text-system-green"
                      : "bg-system-red/10 text-system-red"
                  }`}
                >
                  {test.reachable ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                  <span>
                    {test.reachable ? (
                      <>Found an Eaglesoft database at{" "}
                        <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                          {host}:{port}
                        </span>.
                      </>
                    ) : (
                      test.message ??
                      "Nothing answered there — check the address, or that the server is on."
                    )}
                  </span>
                </div>
              )}

              <div className="mt-6 flex items-center justify-end gap-2">
                <button type="button" className="dp-btn-secondary" onClick={runTest} disabled={!host || testing}>
                  {testing ? "Testing…" : "Test connection"}
                </button>
                <button
                  type="button"
                  className="dp-btn-primary"
                  disabled={!test?.reachable}
                  onClick={() => setStep(2)}
                >
                  Continue <ArrowRight size={15} />
                </button>
              </div>
            </div>
          )}

          {/* Step 2 — provision the account */}
          {step === 2 && (
            <div>
              <h2 id={headingId} className="type-title-2 text-label-primary">
                Create Droplet&rsquo;s database account
              </h2>
              <p className="type-subheadline text-label-secondary mt-2">
                Droplet connects using its own view-only account inside Eaglesoft — never a shared
                password, never an admin. Ask whoever manages Eaglesoft to run this once.
              </p>

              <div className="mt-4 rounded-sm border border-separator bg-surface-secondary p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="type-caption-1 text-label-tertiary">Username</div>
                    <div className="type-callout text-label-primary" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                      droplet_ro
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="type-caption-1 text-label-tertiary flex items-center gap-1">
                      <Lock size={11} /> Password
                    </div>
                    <div className="type-callout text-label-secondary truncate" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                      Issued by Droplet
                    </div>
                  </div>
                  <button type="button" className="dp-btn-secondary shrink-0" onClick={copyScript}>
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                    {copied ? "Copied" : "Copy setup script"}
                  </button>
                </div>
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  className={`flex-1 rounded-sm border p-3 text-left type-footnote transition-colors ${
                    adminPath === "self" ? "border-accent bg-accent-subtle text-accent" : "border-separator text-label-secondary"
                  }`}
                  onClick={() => setAdminPath("self")}
                >
                  <div className="type-subheadline text-label-primary">I have Eaglesoft admin access</div>
                  Droplet runs the setup for you.
                </button>
                <button
                  type="button"
                  className={`flex-1 rounded-sm border p-3 text-left type-footnote transition-colors ${
                    adminPath === "handoff" ? "border-accent bg-accent-subtle text-accent" : "border-separator text-label-secondary"
                  }`}
                  onClick={() => setAdminPath("handoff")}
                >
                  <div className="type-subheadline text-label-primary">Send to my Eaglesoft admin</div>
                  Copy the script and finish later.
                </button>
              </div>

              <div className="mt-4 flex items-start gap-2 rounded-sm bg-surface-secondary p-3 type-footnote text-label-secondary">
                <ShieldCheck size={15} className="text-accent shrink-0 mt-0.5" />
                <span>
                  This account can only read the data you choose in the next step. It can&rsquo;t change
                  anything unless you turn on writes later — and even then, only with your confirmation.
                </span>
              </div>

              <div className="mt-6 flex items-center justify-between">
                <button type="button" className="dp-btn-secondary" onClick={() => setStep(1)}>Back</button>
                <button type="button" className="dp-btn-primary" disabled={!adminPath} onClick={() => setStep(3)}>
                  Verify account <ArrowRight size={15} />
                </button>
              </div>
            </div>
          )}

          {/* Step 3 — scopes + write opt-in */}
          {step === 3 && (
            <div>
              <h2 id={headingId} className="type-title-2 text-label-primary">What should Droplet read?</h2>
              <div className="mt-4 dp-group">
                {SCOPES.map((s) => (
                  <label key={s.id} className="dp-row cursor-pointer">
                    <span className="flex items-center gap-2 type-subheadline text-label-primary">
                      {s.label}
                      {s.tag && (
                        <span className="type-caption-2 px-1.5 py-0.5 rounded-full bg-surface-secondary text-label-tertiary uppercase tracking-wide">
                          {s.tag}
                        </span>
                      )}
                    </span>
                    <input
                      type="checkbox"
                      checked={scopes[s.id]}
                      onChange={(e) => setScopes((prev) => ({ ...prev, [s.id]: e.target.checked }))}
                      className="accent-[var(--color-accent)] w-4 h-4"
                    />
                  </label>
                ))}
              </div>

              <div className="mt-4 rounded-sm border border-separator p-3">
                <label className="flex items-start justify-between gap-3 cursor-pointer">
                  <span>
                    <span className="type-subheadline text-label-primary">
                      Let Droplet schedule appointments back into Eaglesoft
                    </span>
                    <span className="block type-footnote text-system-orange mt-1">
                      Off by default. When on, Droplet still asks you to confirm every change before it
                      writes. You can turn this off any time.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={enableWrites}
                    onChange={(e) => setEnableWrites(e.target.checked)}
                    className="accent-[var(--color-accent)] w-4 h-4 mt-1 shrink-0"
                    aria-label="Let Droplet schedule appointments back into Eaglesoft"
                  />
                </label>
              </div>

              <div className="mt-6 flex items-center justify-between">
                <button type="button" className="dp-btn-secondary" onClick={() => setStep(2)}>Back</button>
                <button type="button" className="dp-btn-primary" onClick={() => setStep(4)}>
                  Continue <ArrowRight size={15} />
                </button>
              </div>
            </div>
          )}

          {/* Step 4 — confirm + connect */}
          {step === 4 && (
            <div>
              <h2 id={headingId} className="type-title-2 text-label-primary">Confirm and connect</h2>
              <dl className="mt-4 rounded-sm border border-separator divide-y divide-separator">
                {[
                  ["Server", `${host}:${port}`, true],
                  ["Database", "PattersonPM", true],
                  ["Account", "droplet_ro", true],
                  ["Reads", selectedScopes.length ? `${selectedScopes.length} of ${SCOPES.length} data types` : "none", false],
                  ["Mode", enableWrites ? "Writes enabled" : "Read-only", false],
                ].map(([k, v, mono]) => (
                  <div key={String(k)} className="flex items-center justify-between px-4 py-3">
                    <dt className="type-footnote text-label-secondary">{k}</dt>
                    <dd
                      className="type-footnote text-label-primary"
                      style={mono ? { fontFamily: "var(--font-mono, ui-monospace, monospace)" } : undefined}
                    >
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>

              {error && (
                <div className="mt-4 flex items-start gap-2 rounded-sm bg-system-red/10 p-3 type-footnote text-system-red">
                  <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <p className="mt-4 type-caption-1 text-label-tertiary">
                Droplet will start reading the data you chose. Nothing leaves your network.
              </p>

              <div className="mt-5 flex items-center justify-between">
                <button type="button" className="dp-btn-secondary" onClick={() => setStep(3)}>Back</button>
                <div className="flex items-center gap-2">
                  <button type="button" className="type-footnote text-label-secondary px-3" onClick={onClose}>
                    Not now
                  </button>
                  <button type="button" className="dp-btn-primary" onClick={doConnect} disabled={busy}>
                    {busy ? "Connecting…" : "Connect Eaglesoft"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Result */}
          {step === "result" && (
            <div className="text-center py-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-system-green/12 flex items-center justify-center">
                <CheckCircle2 size={30} className="text-system-green" />
              </div>
              <h2 id={headingId} className="type-display text-label-primary mt-4" style={{ fontSize: 34 }}>
                Connected
              </h2>
              <p className="type-subheadline text-label-secondary mt-2">
                Droplet is reading your practice now — synced just now.
              </p>
              {enableWrites && (
                <p className="type-footnote text-system-orange mt-3">
                  Writes are on. Droplet will always confirm with you first.
                </p>
              )}
              <button type="button" className="dp-btn-primary mt-6" onClick={onClose}>
                Open Eaglesoft dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
