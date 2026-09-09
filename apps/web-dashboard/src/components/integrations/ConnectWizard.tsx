"use client";

/**
 * The connect wizard — the owner-facing flow behind every hub tile's
 * "Connect" (design brief §5).
 *
 * ## What changed, and why (WARP-2451)
 *
 * This component used to BE one vendor's flow: four hardcoded steps asking
 * "Where is <vendor> running?", a host, a TCP port, a reachability probe and a
 * SQL-Anywhere DBA script. WARP-2291 made the hub's dispatch total — every tile
 * now routes, opens this wizard, or says why it can do neither — which meant
 * the *second* vendor to declare a wizard would be handed a host/port form for
 * a cloud API that has neither. That failure is not a crash. It is a form the
 * owner cannot complete truthfully, which is worse, because they will try.
 *
 * So the wizard renders from the provider's `ProviderDescriptor`
 * (`@droplet/shared-types`, WARP-2217) — the SAME object the admin credential
 * configurator renders from (WARP-2275) and the same one the orchestrator
 * validates against. A provider describes its credentials once; both surfaces
 * obey. They share the descriptor, not this component.
 *
 * ## The two flows, and how one is chosen
 *
 * Selection is DATA, never a vendor name: a descriptor that declares
 * `lanProvisioning` gets the LAN-database flow (find the server, provision the
 * read-only account, choose scopes, confirm); everything else gets the generic
 * credential flow, which asks for exactly the fields the descriptor declares
 * and nothing that cannot be answered for a cloud API. No vendor id appears in
 * this file, and a test asserts that — matching what WARP-2291 achieved for
 * `app/integrations/page.tsx`.
 *
 * A new provider therefore needs NO change here. Registering a descriptor with
 * `credentialFields` is the whole of it, which is what the runtime-registered
 * fixture provider in `__tests__/ConnectWizard.test.tsx` proves.
 *
 * ## What it does not do
 *
 * It never fakes a connection. Every network action hits the real orchestrator
 * endpoints; when one is not wired up yet the wizard says so in words.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  Server,
  Lock,
  ShieldCheck,
  Copy,
  Check,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { SafetyChip } from "./SafetyChip";
import {
  credentialFieldsFor,
  credentialVariantFor,
  CREDENTIAL_VARIANT_FIELD,
  descriptorForCatalogId,
  type CredentialFieldDef,
  type LanProvisioning,
  type ProviderDescriptor,
} from "@droplet/shared-types";
import { testLanConnection, connectLanProvider } from "@/lib/api.erp";
import { fetchSaasCredentials, saveSaasCredential } from "@/lib/api";
import type { LanConnectInput } from "@/lib/erp-types";
import type { TypedError } from "@/lib/hooks/apiFetch";

/**
 * Save state as a discriminated union, per `DnsServersForm.tsx:46-51`.
 *
 * Not three booleans: "busy", "done" and "failed" cannot be true at once, and
 * the boolean shape is the one that produces a form claiming success while
 * showing an error.
 */
type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; message: string };

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
};

/** A short, safe reason an attempt failed. Built from the typed `code`
 *  `apiFetch` attaches, never from a response body (rule 19). */
function friendlyConnectError(err: unknown, displayName: string): string {
  const code = (err as TypedError)?.code;
  if (code === "TIMEOUT") return "The server didn't answer in time — check it's on and reachable.";
  if (code === "NETWORK_ERROR" || code === "UNKNOWN")
    return `Setup isn't available on this Droplet yet — the ${displayName} connector is still being wired up.`;
  const msg = (err as Error)?.message;
  return msg || "Something went wrong. Try again.";
}

/** The progress rail. Rendered only for a flow with more than one step — a
 *  single dot is a progress bar that has never told anyone anything. */
function StepDots({ count, index }: { count: number; index: number }) {
  if (count < 2) return null;
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={`h-1.5 rounded-full transition-all duration-200 ${
            i === index ? "w-5 bg-accent" : i < index ? "w-1.5 bg-accent" : "w-1.5 bg-separator"
          }`}
        />
      ))}
    </div>
  );
}

/** The guide link, at the moment of use (WARP-2342). Renders nothing when the
 *  provider declares none, rather than linking nowhere. */
function SetupGuideLink({ href }: { href: string | undefined }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mt-3 inline-flex items-center gap-1.5 type-footnote text-accent"
      data-testid="setup-guide-link"
    >
      <BookOpen size={14} aria-hidden />
      Read the setup guide
    </a>
  );
}

/**
 * The placeholder is the ONLY thing that tells the owner a credential is
 * already stored — the value itself never leaves the box, so there is nothing
 * else it could be derived from. Same copy as the admin configurator's
 * `secretPlaceholder` and `EmailChannelSection.tsx:190`.
 */
function secretPlaceholder(hasValue: boolean): string {
  return hasValue ? "Saved — replace to change" : "Paste the value";
}

// ---------------------------------------------------------------------------
// Flow 1 — credentials. The default for any provider that does not provision a
// database account of its own.
// ---------------------------------------------------------------------------

function CredentialFlow({
  descriptor,
  headingId,
  onClose,
  onConnected,
}: {
  descriptor: ProviderDescriptor;
  headingId: string;
  onClose: () => void;
  onConnected?: () => void;
}) {
  const [variantId, setVariantId] = useState<string | undefined>(
    () => credentialVariantFor(descriptor)?.id,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /**
   * Which secrets the box already holds, by field name. Read from the shared
   * credential view, which carries `hasValue` booleans and no values at all.
   * `false` until it answers and on any failure — claiming a credential is
   * stored when we do not know would be a guess about persistent state.
   */
  const [stored, setStored] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [done, setDone] = useState(false);

  const variant = credentialVariantFor(descriptor, variantId);
  const fields = useMemo(
    () => credentialFieldsFor(descriptor, variantId),
    [descriptor, variantId],
  );

  useEffect(() => {
    let cancelled = false;
    fetchSaasCredentials()
      .then((views) => {
        if (cancelled) return;
        const view = views.find((v) => v.provider === descriptor.id);
        const next: Record<string, boolean> = {};
        for (const f of view?.fields ?? []) next[f.name] = f.hasValue === true;
        setStored(next);
      })
      // A failed read leaves every placeholder on "Paste the value". The form
      // still works; only the hint about what is already stored is missing, and
      // inventing that hint is the one thing here that would mislead.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [descriptor.id]);

  /** A field is answered when it holds a non-blank value, or when it is a
   *  secret the box already stores and the owner left alone. */
  const answered = useCallback(
    (f: CredentialFieldDef) => {
      if ((drafts[f.name] ?? "").trim() !== "") return true;
      return f.secret && stored[f.name] === true;
    },
    [drafts, stored],
  );

  /** The declared format, applied only to what was actually typed. A blank
   *  field is "not answered yet", never "wrong". */
  const malformed = useCallback(
    (f: CredentialFieldDef) => {
      const typed = drafts[f.name] ?? "";
      if (typed === "" || !f.pattern) return false;
      return !new RegExp(f.pattern).test(typed);
    },
    [drafts],
  );

  const canSubmit =
    status.kind !== "busy" &&
    fields.length > 0 &&
    fields.every((f) => (!f.required || answered(f)) && !malformed(f));

  async function submit() {
    setStatus({ kind: "busy" });
    const payload: Record<string, string> = {};
    for (const f of fields) {
      const typed = drafts[f.name];
      // The client half of the three-way rule (WARP-2275): an untouched secret
      // is OMITTED, not sent as "", which would clear the very credential the
      // owner was leaving alone while editing something else.
      if (f.secret && (typed === undefined || typed === "")) continue;
      if (typed !== undefined) payload[f.name] = typed;
    }
    if (variant) payload[CREDENTIAL_VARIANT_FIELD] = variant.id;

    try {
      await saveSaasCredential(descriptor.id, payload);
      // Drop the typed secrets once the box holds them. Keeping a copy in React
      // state only widens where the plaintext lives, and a second save would
      // resend a value the owner never re-entered.
      const justStored = fields.filter((f) => f.secret && (drafts[f.name] ?? "") !== "");
      setDrafts((cur) => {
        const next = { ...cur };
        for (const f of fields) if (f.secret) delete next[f.name];
        return next;
      });
      setStored((cur) => {
        const next = { ...cur };
        for (const f of justStored) next[f.name] = true;
        return next;
      });
      setStatus({ kind: "idle" });
      setDone(true);
      onConnected?.();
    } catch (err) {
      setStatus({ kind: "error", message: friendlyConnectError(err, descriptor.displayName) });
    }
  }

  if (done) {
    return (
      <Result
        headingId={headingId}
        displayName={descriptor.displayName}
        note={null}
        onClose={onClose}
      />
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 border-b border-separator">
        <StepDots count={1} index={0} />
        <SafetyChip variant="setup" />
      </div>
      <div className="px-6 py-6">
        <h2 id={headingId} className="type-title-2 text-label-primary">
          Connect {descriptor.displayName}
        </h2>
        <p className="type-subheadline text-label-secondary mt-2">
          Droplet reads {descriptor.displayName} with a credential you create and own.
          It&rsquo;s stored encrypted on this box and never leaves it.
        </p>
        <SetupGuideLink href={descriptor.catalog?.setupGuideHref} />

        {/* A discriminated choice — two genuinely different ways to
            authenticate the same account. Only the chosen path's fields render
            below; the union of both would ask for values that cannot coexist. */}
        {descriptor.credentialVariants && descriptor.credentialVariants.length > 0 && (
          <div className="mt-5 flex gap-2" role="radiogroup" aria-label="How you'll connect">
            {descriptor.credentialVariants.map((v) => (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={v.id === variant?.id}
                className={`flex-1 rounded-sm border p-3 text-left type-footnote transition-colors ${
                  v.id === variant?.id
                    ? "border-accent bg-accent-subtle text-accent"
                    : "border-separator text-label-secondary"
                }`}
                onClick={() => {
                  setVariantId(v.id);
                  setStatus({ kind: "idle" });
                }}
              >
                <span className="block type-subheadline text-label-primary">{v.label}</span>
                {v.description}
              </button>
            ))}
          </div>
        )}

        {fields.length === 0 ? (
          <p className="mt-5 type-footnote text-label-secondary">
            This connector needs no credentials.
          </p>
        ) : (
          fields.map((field) => (
            <div key={field.name} className="mt-5">
              <label
                className="block type-footnote text-label-secondary"
                htmlFor={`connect-${field.name}`}
              >
                {field.label}
                {field.required && " *"}
              </label>
              <input
                id={`connect-${field.name}`}
                // The one behavioural difference a secret gets. Everything else
                // about the field arrives from the descriptor.
                type={field.secret ? "password" : "text"}
                className="dp-input mt-1.5 w-full"
                style={monoStyle}
                autoComplete={field.secret ? "new-password" : "off"}
                placeholder={field.secret ? secretPlaceholder(stored[field.name] === true) : ""}
                value={drafts[field.name] ?? ""}
                onChange={(e) => setDrafts((cur) => ({ ...cur, [field.name]: e.target.value }))}
              />
              {malformed(field) ? (
                <p className="mt-1.5 type-caption-1 text-system-red" role="status">
                  That doesn&rsquo;t look right — check you copied the whole value.
                </p>
              ) : field.help ? (
                <p className="mt-1.5 type-caption-1 text-label-tertiary">{field.help}</p>
              ) : null}
            </div>
          ))
        )}

        {status.kind === "error" && (
          <div
            className="mt-4 flex items-start gap-2 rounded-sm bg-system-red/10 p-3 type-footnote text-system-red"
            role="alert"
          >
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span>{status.message}</span>
          </div>
        )}

        <div className="mt-4 flex items-start gap-2 rounded-sm bg-surface-secondary p-3 type-footnote text-label-secondary">
          <ShieldCheck size={15} className="text-accent shrink-0 mt-0.5" />
          <span>
            Droplet reads only. It never writes to {descriptor.displayName}, and you can
            disconnect at any time.
          </span>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" className="type-footnote text-label-secondary px-3" onClick={onClose}>
            Not now
          </button>
          <button type="button" className="dp-btn-primary" onClick={submit} disabled={!canSubmit}>
            {status.kind === "busy" ? "Connecting…" : `Connect ${descriptor.displayName}`}
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Flow 2 — LAN database. Selected by `lanProvisioning`; the same four steps
// this component shipped with, with every vendor string read off the
// descriptor instead of typed into the JSX.
// ---------------------------------------------------------------------------

type LanStep = 1 | 2 | 3 | 4;

function LanFlow({
  descriptor,
  lan,
  headingId,
  onClose,
  onConnected,
}: {
  descriptor: ProviderDescriptor;
  lan: LanProvisioning;
  headingId: string;
  onClose: () => void;
  onConnected?: () => void;
}) {
  const name = descriptor.displayName;
  const [step, setStep] = useState<LanStep>(1);
  const [done, setDone] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(lan.defaultPort));
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ reachable: boolean; message?: string } | null>(null);
  const [scopes, setScopes] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(lan.scopes.map((s) => [s.id, true])),
  );
  const [enableWrites, setEnableWrites] = useState(false);
  const [adminPath, setAdminPath] = useState<"self" | "handoff" | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // The provisioned account's password is generated (strong, unique per box)
  // and stored via a secretRef by Droplet — never fabricated in the browser
  // (that would strand a live credential the connector cannot retrieve). The
  // descriptor's script carries the placeholder Droplet fills in.
  const provisionScript = useMemo(() => lan.script.join("\n"), [lan.script]);
  const selectedScopes = lan.scopes.map((s) => s.id).filter((id) => scopes[id]);

  async function runTest() {
    setTesting(true);
    setTest(null);
    setStatus({ kind: "idle" });
    try {
      setTest(
        await testLanConnection(descriptor.id, {
          host,
          port: Number(port) || lan.defaultPort,
        }),
      );
    } catch (err) {
      setTest({ reachable: false, message: friendlyConnectError(err, name) });
    } finally {
      setTesting(false);
    }
  }

  async function doConnect() {
    setStatus({ kind: "busy" });
    const input: LanConnectInput = {
      host,
      port: Number(port) || lan.defaultPort,
      scopes: selectedScopes,
      enableWrites,
    };
    try {
      await connectLanProvider(descriptor.id, input);
      setStatus({ kind: "idle" });
      setDone(true);
      onConnected?.();
    } catch (err) {
      setStatus({ kind: "error", message: friendlyConnectError(err, name) });
    }
  }

  function copyScript() {
    void navigator.clipboard?.writeText(provisionScript);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (done) {
    return (
      <Result
        headingId={headingId}
        displayName={name}
        note={enableWrites ? "Writes are on. Droplet will always confirm with you first." : null}
        onClose={onClose}
      />
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 border-b border-separator">
        <StepDots count={4} index={step - 1} />
        <SafetyChip variant={step === 4 ? "read-phi" : "setup"} />
      </div>

      <div className="px-6 py-6">
        {/* Step 1 — find the server */}
        {step === 1 && (
          <div>
            <h2 id={headingId} className="type-title-2 text-label-primary">
              Where is {name} running?
            </h2>
            <p className="type-subheadline text-label-secondary mt-2">
              Enter the computer on your network that runs {name}. It&rsquo;s usually your
              server or front-desk PC.
            </p>

            <label className="block mt-5 type-footnote text-label-secondary">Server address</label>
            <div className="mt-1.5 flex items-center gap-2 dp-input" style={monoStyle}>
              <Server size={15} className="text-label-tertiary shrink-0" />
              <input
                className="flex-1 bg-transparent outline-none text-label-primary placeholder:text-label-tertiary"
                placeholder={lan.hostPlaceholder}
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  setTest(null);
                }}
                aria-label={`${name} server address`}
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
                  style={monoStyle}
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
                    <>
                      Found {lan.reachableLabel} at{" "}
                      <span style={monoStyle}>
                        {host}:{port}
                      </span>
                      .
                    </>
                  ) : (
                    test.message ??
                    "Nothing answered there — check the address, or that the server is on."
                  )}
                </span>
              </div>
            )}

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                className="dp-btn-secondary"
                onClick={runTest}
                disabled={!host || testing}
              >
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
              Droplet connects using its own view-only account inside {name} — never a
              shared password, never an admin. Ask whoever manages {name} to run this
              once.
            </p>

            <div className="mt-4 rounded-sm border border-separator bg-surface-secondary p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="type-caption-1 text-label-tertiary">Username</div>
                  <div className="type-callout text-label-primary" style={monoStyle}>
                    {lan.accountName}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="type-caption-1 text-label-tertiary flex items-center gap-1">
                    <Lock size={11} /> Password
                  </div>
                  <div className="type-callout text-label-secondary truncate" style={monoStyle}>
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
                  adminPath === "self"
                    ? "border-accent bg-accent-subtle text-accent"
                    : "border-separator text-label-secondary"
                }`}
                onClick={() => setAdminPath("self")}
              >
                <div className="type-subheadline text-label-primary">
                  I have {name} admin access
                </div>
                Droplet runs the setup for you.
              </button>
              <button
                type="button"
                className={`flex-1 rounded-sm border p-3 text-left type-footnote transition-colors ${
                  adminPath === "handoff"
                    ? "border-accent bg-accent-subtle text-accent"
                    : "border-separator text-label-secondary"
                }`}
                onClick={() => setAdminPath("handoff")}
              >
                <div className="type-subheadline text-label-primary">
                  Send to my {name} admin
                </div>
                Copy the script and finish later.
              </button>
            </div>

            <div className="mt-4 flex items-start gap-2 rounded-sm bg-surface-secondary p-3 type-footnote text-label-secondary">
              <ShieldCheck size={15} className="text-accent shrink-0 mt-0.5" />
              <span>
                This account can only read the data you choose in the next step. It
                can&rsquo;t change anything unless you turn on writes later — and even then,
                only with your confirmation.
              </span>
            </div>

            <div className="mt-6 flex items-center justify-between">
              <button type="button" className="dp-btn-secondary" onClick={() => setStep(1)}>
                Back
              </button>
              <button
                type="button"
                className="dp-btn-primary"
                disabled={!adminPath}
                onClick={() => setStep(3)}
              >
                Verify account <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}

        {/* Step 3 — scopes + write opt-in */}
        {step === 3 && (
          <div>
            <h2 id={headingId} className="type-title-2 text-label-primary">
              What should Droplet read?
            </h2>
            <div className="mt-4 dp-group">
              {lan.scopes.map((s) => (
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
                    checked={scopes[s.id] ?? false}
                    onChange={(e) =>
                      setScopes((prev) => ({ ...prev, [s.id]: e.target.checked }))
                    }
                    className="accent-[var(--color-accent)] w-4 h-4"
                  />
                </label>
              ))}
            </div>

            {lan.writeOptIn && (
              <div className="mt-4 rounded-sm border border-separator p-3">
                <label className="flex items-start justify-between gap-3 cursor-pointer">
                  <span>
                    <span className="type-subheadline text-label-primary">
                      {lan.writeOptIn.label}
                    </span>
                    <span className="block type-footnote text-system-orange mt-1">
                      {lan.writeOptIn.caution}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={enableWrites}
                    onChange={(e) => setEnableWrites(e.target.checked)}
                    className="accent-[var(--color-accent)] w-4 h-4 mt-1 shrink-0"
                    aria-label={lan.writeOptIn.label}
                  />
                </label>
              </div>
            )}

            <div className="mt-6 flex items-center justify-between">
              <button type="button" className="dp-btn-secondary" onClick={() => setStep(2)}>
                Back
              </button>
              <button type="button" className="dp-btn-primary" onClick={() => setStep(4)}>
                Continue <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}

        {/* Step 4 — confirm + connect */}
        {step === 4 && (
          <div>
            <h2 id={headingId} className="type-title-2 text-label-primary">
              Confirm and connect
            </h2>
            <dl className="mt-4 rounded-sm border border-separator divide-y divide-separator">
              {[
                ["Server", `${host}:${port}`, true],
                ["Database", lan.databaseName, true],
                ["Account", lan.accountName, true],
                [
                  "Reads",
                  selectedScopes.length
                    ? `${selectedScopes.length} of ${lan.scopes.length} data types`
                    : "none",
                  false,
                ],
                ["Mode", enableWrites ? "Writes enabled" : "Read-only", false],
              ].map(([k, v, mono]) => (
                <div key={String(k)} className="flex items-center justify-between px-4 py-3">
                  <dt className="type-footnote text-label-secondary">{k}</dt>
                  <dd
                    className="type-footnote text-label-primary"
                    style={mono ? monoStyle : undefined}
                  >
                    {v}
                  </dd>
                </div>
              ))}
            </dl>

            {status.kind === "error" && (
              <div
                className="mt-4 flex items-start gap-2 rounded-sm bg-system-red/10 p-3 type-footnote text-system-red"
                role="alert"
              >
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                <span>{status.message}</span>
              </div>
            )}

            <p className="mt-4 type-caption-1 text-label-tertiary">
              Droplet will start reading the data you chose. Nothing leaves your network.
            </p>

            <div className="mt-5 flex items-center justify-between">
              <button type="button" className="dp-btn-secondary" onClick={() => setStep(3)}>
                Back
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="type-footnote text-label-secondary px-3"
                  onClick={onClose}
                >
                  Not now
                </button>
                <button
                  type="button"
                  className="dp-btn-primary"
                  onClick={doConnect}
                  disabled={status.kind === "busy"}
                >
                  {status.kind === "busy" ? "Connecting…" : `Connect ${name}`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

/** The shared success screen. One rendering for both flows, because the owner
 *  asked the same question of both: is it connected? */
function Result({
  headingId,
  displayName,
  note,
  onClose,
}: {
  headingId: string;
  displayName: string;
  note: string | null;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 border-b border-separator">
        <span />
        <SafetyChip variant="read-phi" />
      </div>
      <div className="px-6 py-6">
        <div className="text-center py-4">
          <div className="mx-auto w-16 h-16 rounded-full bg-system-green/12 flex items-center justify-center">
            <CheckCircle2 size={30} className="text-system-green" />
          </div>
          <h2
            id={headingId}
            className="type-display text-label-primary mt-4"
            style={{ fontSize: 34 }}
          >
            Connected
          </h2>
          <p className="type-subheadline text-label-secondary mt-2">
            Droplet is reading your practice now — synced just now.
          </p>
          {note && <p className="type-footnote text-system-orange mt-3">{note}</p>}
          <button type="button" className="dp-btn-primary mt-6" onClick={onClose}>
            Open {displayName} dashboard
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * A tile whose descriptor this build cannot resolve.
 *
 * Reachable when the box reports a provider the dashboard has no descriptor
 * for. It says so rather than rendering an empty dialog — a wizard with no
 * fields and a live-looking Connect button is the exact failure this story is
 * about, one layer down.
 */
function NoFlow({ headingId, onClose }: { headingId: string; onClose: () => void }) {
  return (
    <div className="px-6 py-6">
      <h2 id={headingId} className="type-title-2 text-label-primary">
        This connector can&rsquo;t be set up here yet
      </h2>
      <p className="type-subheadline text-label-secondary mt-2">
        Droplet knows about this connection, but the dashboard has no setup flow for
        it. Nothing has been changed.
      </p>
      <div className="mt-6 flex justify-end">
        <button type="button" className="dp-btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export function ConnectWizard({
  catalogId,
  onClose,
  onConnected,
  triggerRef,
}: {
  /**
   * The hub card being connected, or null when the wizard is shut.
   *
   * Carrying WHICH provider rather than a bare `open` flag is what lets one
   * component serve every vendor: the flow, the fields and the endpoints all
   * resolve from this id's descriptor.
   */
  catalogId: string | null;
  onClose: () => void;
  onConnected?: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
}) {
  const headingId = useId();
  const open = catalogId !== null;
  const descriptor = catalogId ? descriptorForCatalogId(catalogId) : undefined;
  const lan = descriptor?.lanProvisioning;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      triggerRef={triggerRef}
      labelledBy={headingId}
      maxWidth="xl"
    >
      {/* Keyed on the provider, so re-opening — or opening a DIFFERENT tile —
          mounts a fresh flow. Resetting state is then structural rather than an
          effect that has to remember every field anyone ever added. */}
      <div className="flex flex-col" key={catalogId ?? "closed"}>
        {!descriptor ? (
          <NoFlow headingId={headingId} onClose={onClose} />
        ) : lan ? (
          <LanFlow
            descriptor={descriptor}
            lan={lan}
            headingId={headingId}
            onClose={onClose}
            onConnected={onConnected}
          />
        ) : (
          <CredentialFlow
            descriptor={descriptor}
            headingId={headingId}
            onClose={onClose}
            onConnected={onConnected}
          />
        )}
      </div>
    </Dialog>
  );
}
