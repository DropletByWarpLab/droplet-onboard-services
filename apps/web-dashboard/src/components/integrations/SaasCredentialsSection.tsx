"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, KeyRound, Loader2 } from "lucide-react";
import { Sect } from "@/components/shell/primitives";
import { useAuth } from "@/lib/auth";
import { DisconnectControl } from "@/components/integrations/DisconnectControl";
import { disconnectedCredentialView } from "@/lib/credential-purge";
import {
  fetchSaasCredentials,
  saveSaasCredential,
  type SaasCredentialField,
  type SaasCredentialView,
  type SaasConnectionState,
} from "@/lib/api";

/**
 * WARP-2275 — the admin-only credential configurator.
 *
 * ONE component for every provider. It renders whatever `credentialFields` the
 * WARP-2217 descriptor declares — labels, types, requiredness, secrecy and
 * help text all arrive from the server. There is deliberately no vendor name
 * anywhere in this file: if a provider ever needs special handling here, the
 * descriptor is under-specified and that is the bug to fix.
 *
 * Three specifics that are not stylistic:
 *
 *  - **The admin gate precedes the fetch effects.** `SaasCredentialsSection`
 *    returns null for a non-admin *before* `SaasCredentialsPanel` — which owns
 *    every `useEffect` — is ever mounted. A gate placed after the effects
 *    renders exactly the same nothing while having already issued an
 *    admin-only request, which is why the test asserts BOTH "renders null" and
 *    "issued no fetch". Splitting the component in two is also what keeps this
 *    legal: an early `return null` above a hook would break the rules of hooks.
 *  - **Secret inputs are `type="password"` with a `hasValue`-driven
 *    placeholder.** The value is never sent to the browser, so "Saved — replace
 *    to change" is how an admin learns a credential exists.
 *  - **Client state is a discriminated union**, per `DnsServersForm.tsx:46-51`,
 *    so "saving", "saved" and "failed" cannot be true at once — the shape that
 *    produces a form claiming success and showing an error simultaneously.
 *
 * The dashboard has no zod and no react-hook-form; state is hand-rolled
 * `useState`, matching `EmailChannelSection.tsx`.
 */

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "saving"; provider: string }
  | { kind: "saved"; provider: string }
  | { kind: "error"; message: string }
  | { kind: "loadFailed" };

/** What each state means to a person, in their words rather than the enum's. */
const STATE_COPY: Record<SaasConnectionState, { label: string; tone: "ok" | "warn" | "idle" }> =
  {
    NOT_CONFIGURED: { label: "Not connected", tone: "idle" },
    PROVISIONING: { label: "Checking the connection", tone: "idle" },
    CONNECTED: { label: "Connected", tone: "ok" },
    // The distinction this whole surface exists to preserve: a credential IS
    // stored, and it was refused. "Not connected" would send an admin to paste
    // the same key again.
    NEEDS_RECONNECT: { label: "Credential rejected — replace it", tone: "warn" },
    // And the OTHER distinction WARP-2458 pulled apart: something a new key
    // will not fix — a vendor-side refusal such as an IP access policy or a
    // plan limit. "Replace it" here would send an admin to mint keys until
    // one worked; the fix lives in the vendor's console, so that is where the
    // copy points. Same "Can't connect" vocabulary as the hub tile
    // (`connector-visuals.tsx`), so the two surfaces name one state one way.
    ERROR: { label: "Can't connect — check the vendor's settings", tone: "warn" },
    DEGRADED: { label: "Connected, with recent errors", tone: "warn" },
    DRIFT_LOCKED: { label: "Locked — the vendor's data shape changed", tone: "warn" },
    // Split in two by `stateCopyFor` below — see WARP-2483. This entry is the
    // wording for a box that gave no answer either way.
    DISABLED: { label: "Turned off", tone: "idle" },
  };

/**
 * WARP-2483 — the state line, with `DISABLED` split on whether the credential
 * actually went.
 *
 * ADR-041 §2's promise is that disconnecting removes the key, and this is the
 * one page in the product where a person hands one over. A flat "Turned off"
 * is true of both a connection whose credential was destroyed and one whose
 * credential is still decryptable in Postgres — opposite facts, and the second
 * is the one that still owes the admin an action.
 *
 * WARP-2489 — the presence half is `credentialsPurged`, the box's own answer.
 * It was `!hasCredentials`, and that is a different question:
 * `hasCredentials` is an `every()` over the DECLARED secret fields, so a
 * provider declaring two with one stored reports `false` while that one is
 * still sealed on the row. The page then told an admin the key had been
 * destroyed — the dashboard asserting something false about the box, in the
 * place the promise is made. Only the box can answer it, because only the box
 * can see both credential columns; `credentialsPurgedFor` in
 * `integrations.service.ts` is the single derivation, and the hub tile
 * (`connector-visuals.tsx` `statusView`) reads the very same field, so the two
 * surfaces cannot describe one row two ways.
 *
 * `undefined` is a THIRD answer and stays one: a box that sent no purge fact
 * gets the neutral "Turned off" from `STATE_COPY`, never a guess.
 * `!hasCredentials` could not express that — it is always a boolean, so the
 * old code claimed one of the two sentences even when it had been told
 * nothing.
 *
 * Nothing new about the secret reaches the browser to support any of this: the
 * view type still has no field that could carry a value, a prefix or a length,
 * and this function receives only booleans.
 *
 * `tone` reuses the existing three-way union — the finished state rests at
 * `idle`, the unfinished one at `warn`. No colour is added.
 */
export function stateCopyFor(view: SaasCredentialView): {
  label: string;
  tone: "ok" | "warn" | "idle";
} {
  const disconnected = disconnectedCredentialView(
    view.state === "DISABLED",
    view.credentialsPurged,
  );
  if (!disconnected) return STATE_COPY[view.state];
  return disconnected.purged
    ? { label: disconnected.line, tone: "idle" }
    : { label: disconnected.line, tone: "warn" };
}

const inputClass =
  "w-full px-3 py-2 type-footnote focus:outline-none focus:ring-2 focus:ring-[var(--brand)] placeholder:text-[var(--text-faint)] transition-shadow";

const inputStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-input)",
  color: "var(--text)",
};

/** The placeholder is the ONLY thing that tells an admin a secret is stored —
 *  the value itself never leaves the box. */
function secretPlaceholder(field: SaasCredentialField): string {
  return field.hasValue ? "Saved — replace to change" : "Paste the value";
}

/**
 * WARP-2518 — whether this provider's card offers Disconnect.
 *
 * The mirror of `ConnectorCard`'s rule, over `SaasConnectionState` instead of
 * `IntegrationStatus`, and deliberately NOT over `hasCredentials`: that is an
 * `every()` over the declared secret fields, so a provider with two declared
 * and one stored answers `false` while a live key sits on the row — the exact
 * confusion WARP-2489 removed from the state line, which would come straight
 * back if the button that PURGES the key were hidden by it.
 *
 * `NOT_CONFIGURED` has nothing to disconnect. A `DISABLED` row the box says is
 * already purged has nothing left either, and offering it would contradict the
 * "credential removed" line the same card is rendering.
 */
export function offersDisconnect(view: SaasCredentialView): boolean {
  if (view.state === "NOT_CONFIGURED") return false;
  if (view.state === "DISABLED" && view.credentialsPurged === true) return false;
  return true;
}

function ProviderForm({
  view,
  status,
  onSave,
  onDisconnected,
}: {
  view: SaasCredentialView;
  status: Status;
  /** Resolves true when the save landed, which is the form's cue to drop the
   *  typed secret. Returning the outcome rather than reading it back off
   *  `status` keeps the clearing tied to THIS submit, not to whatever the
   *  shared status happened to be when the component next rendered. */
  onSave: (provider: string, fields: Record<string, string>) => Promise<boolean>;
  /** Fired after the box confirmed a disconnect — the panel answers by
   *  re-reading, which is what refreshes `credentialsPurged` and the state
   *  line derived from it. */
  onDisconnected: () => void;
}) {
  // Non-secret values pre-fill from the server; secrets start empty, always.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of view.fields) {
      if (f.secret) continue;
      const v = view.values[f.name];
      initial[f.name] = v === undefined ? "" : String(v);
    }
    return initial;
  });

  const busy = status.kind === "saving" && status.provider === view.provider;
  const justSaved = status.kind === "saved" && status.provider === view.provider;
  const stateCopy = stateCopyFor(view);

  async function submit() {
    const fields: Record<string, string> = {};
    for (const f of view.fields) {
      const typed = drafts[f.name];
      if (f.secret) {
        // The client half of the three-way rule. An untouched secret is OMITTED
        // — not sent as "", which would clear the very credential the admin was
        // trying to leave alone while editing something else.
        if (typed !== undefined && typed !== "") fields[f.name] = typed;
        continue;
      }
      if (typed !== undefined) fields[f.name] = typed;
    }

    const ok = await onSave(view.provider, fields);
    if (!ok) return; // a failed save must never lose what was typed

    // Drop the typed secrets once they are stored. The box now holds them and
    // the read view will report `hasValue`, so keeping a copy in React state
    // only widens where the plaintext lives — and a second Save would resend a
    // value the admin never re-entered.
    setDrafts((cur) => {
      const next = { ...cur };
      for (const f of view.fields) if (f.secret) delete next[f.name];
      return next;
    });
  }

  return (
    <div className="card space-y-4" data-testid={`provider-${view.provider}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <KeyRound size={16} style={{ color: "var(--text-muted)" }} />
          <div>
            <p className="type-headline" style={{ color: "var(--text)" }}>
              {view.displayName}
            </p>
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              {view.category}
            </p>
          </div>
        </div>
        <span
          className={`type-caption-1 flex items-center gap-1 ${
            stateCopy.tone === "ok"
              ? "text-system-green"
              : stateCopy.tone === "warn"
                ? "text-system-red"
                : ""
          }`}
          style={stateCopy.tone === "idle" ? { color: "var(--text-muted)" } : undefined}
        >
          {stateCopy.tone === "ok" && <Check size={14} />}
          {stateCopy.tone === "warn" && <AlertCircle size={14} />}
          {stateCopy.label}
        </span>
      </div>

      {view.fields.length === 0 ? (
        <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
          This connector needs no credentials.
        </p>
      ) : (
        view.fields.map((field) => (
          <div key={field.name} className="space-y-1">
            <label
              className="type-caption-1 block"
              style={{ color: "var(--text-muted)" }}
              htmlFor={`${view.provider}-${field.name}`}
            >
              {field.label}
              {field.required && " *"}
            </label>
            <input
              id={`${view.provider}-${field.name}`}
              // The one behavioural difference a secret field gets. Everything
              // else about it comes from the descriptor.
              type={field.secret ? "password" : "text"}
              className={inputClass}
              style={inputStyle}
              autoComplete={field.secret ? "new-password" : "off"}
              placeholder={field.secret ? secretPlaceholder(field) : ""}
              value={drafts[field.name] ?? ""}
              onChange={(e) =>
                setDrafts((cur) => ({ ...cur, [field.name]: e.target.value }))
              }
            />
            {field.help && (
              <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>
                {field.help}
              </p>
            )}
          </div>
        ))
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || view.fields.length === 0}
          onClick={submit}
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {busy ? "Saving…" : "Save"}
        </button>
        {justSaved && (
          <span className="type-caption-1 flex items-center gap-1 text-system-green">
            <Check size={14} /> Saved
          </span>
        )}
      </div>

      {/* WARP-2518 — the far side of the page. This is the one surface where a
          credential is handed over, so it is the one where ADR-041 §2's
          promise that disconnecting REMOVES it is most owed a control. Below
          Save and behind its own confirmation: the two actions are opposites
          and must not be adjacent buttons. */}
      {offersDisconnect(view) && (
        <div className="pt-3 border-t border-separator">
          <DisconnectControl
            provider={view.provider}
            displayName={view.displayName}
            onDisconnected={onDisconnected}
          />
        </div>
      )}
    </div>
  );
}

/** Owns the fetch effects. Only ever mounted for an admin — see the gate. */
function SaasCredentialsPanel() {
  const [views, setViews] = useState<SaasCredentialView[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      setViews(await fetchSaasCredentials());
      setStatus({ kind: "ready" });
    } catch {
      // An explicit failed state, never an empty list standing in for one — a
      // silent empty result masquerading as "nothing configured" is the exact
      // dishonesty this configurator exists to prevent.
      setStatus({ kind: "loadFailed" });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async (
    provider: string,
    fields: Record<string, string>,
  ): Promise<boolean> => {
    setStatus({ kind: "saving", provider });
    try {
      const saved = await saveSaasCredential(provider, fields);
      setViews((cur) => cur.map((v) => (v.provider === provider ? saved : v)));
      setStatus({ kind: "saved", provider });
      return true;
    } catch (err) {
      // The message names refused FIELDS, never their values — the orchestrator
      // guarantees that, and the form does not add anything to it.
      setStatus({
        kind: "error",
        message:
          err instanceof Error && err.message
            ? err.message
            : "Couldn't save those credentials. Check the values and try again.",
      });
      return false;
    }
  };

  if (status.kind === "loading") {
    return (
      <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
        Loading connectors…
      </p>
    );
  }

  if (status.kind === "loadFailed") {
    return (
      <p className="type-footnote text-system-red">
        Couldn&rsquo;t load the connector list.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {status.kind === "error" && (
        <p className="type-footnote text-system-red" role="alert">
          {status.message}
        </p>
      )}
      {views.length === 0 ? (
        <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
          No cloud connectors are available on this box yet.
        </p>
      ) : (
        views.map((view) => (
          <ProviderForm
            key={view.provider}
            view={view}
            status={status}
            onSave={handleSave}
            // WARP-2518 — re-read rather than patch the row in place. The
            // disconnect response is an `IntegrationConnection`, a different
            // shape from the `SaasCredentialView` this page renders, and
            // hand-mapping one onto the other is how the two surfaces would
            // come to disagree about `credentialsPurged`. Only the box derives
            // that fact; the page asks it again.
            onDisconnected={() => void load()}
          />
        ))
      )}
    </div>
  );
}

export function SaasCredentialsSection() {
  const { user } = useAuth();
  const isAdmin = user?.role === "owner" || user?.role === "admin";

  // BEFORE the fetch effects — `SaasCredentialsPanel` owns every one of them,
  // and it is not mounted at all here. Mirrors the server's
  // `requireRole("owner","admin")`; the nav entry carries the same roles on
  // parent and child so the two cannot drift apart.
  if (!isAdmin) return null;

  return (
    <section className="mb-10">
      <Sect title="Connector credentials" />
      <SaasCredentialsPanel />
    </section>
  );
}
