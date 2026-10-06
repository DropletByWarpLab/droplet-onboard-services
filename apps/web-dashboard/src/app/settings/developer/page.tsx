/**
 * WARP-3533 — /settings/developer: let scripts use Projects as you (personal API
 * tokens), and subscribe to due dates in a calendar app (ICS links).
 *
 * Everything renders from GET /api/developer and GET /api/developer/feeds, and
 * the box decides who sees what (`isAdmin`, `canCreate`, the scopes it offers),
 * never a role check here:
 *   · owner/admin: the workspace switch (off by default) and everyone's tokens,
 *     with revoke;
 *   · switch off: anyone else sees that it is off, plus their own tokens with
 *     Revoke only (off does not revoke them);
 *   · switch on: create a token (name, access, expiry; shown once), their own
 *     tokens, how to use one, and the OpenAPI document;
 *   · calendar links for "My work" and each project: created once, shown once,
 *     replaced or turned off per feed.
 * An external guest can never hold a token (the box answers 403), so the page
 * does not ask and renders a locked state; a 403 from the box renders the same.
 */
"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AlertTriangle, Braces, Calendar, Check, Copy, FileJson, RefreshCw } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Sect, Toggle, type BadgeKind } from "@/components/shell/primitives";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CodeBlock } from "@/components/CodeBlock";
import { useAuth } from "@/lib/auth";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  DeveloperError,
  createApiToken,
  downloadOpenApi,
  revokeApiToken,
  revokeFeed,
  rotateFeed,
  setApiTokensEnabled,
  useAllDevTokens,
  useDeveloper,
  useFeeds,
  type DevScope,
  type DevTokenRow,
  type DevTokenStatus,
  type DevTokenWithUser,
  type DeveloperState,
  type FeedRow,
  type FeedTarget,
} from "@/lib/hooks/useDeveloper";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

const SWITCH_LABEL = "Allow API tokens";
const TOKEN_PLACEHOLDER = "<your token>";

const STATUS_BADGE: Record<DevTokenStatus, { kind: BadgeKind; label: string }> = {
  active: { kind: "ok", label: "Active" },
  expired: { kind: "warn", label: "Expired" },
  revoked: { kind: "muted", label: "Revoked" },
};

/** The choices for how long a token lasts. `days: null` is no expiry. */
const EXPIRY_CHOICES: Array<{ id: string; label: string; days: number | null }> = [
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "365", label: "1 year", days: 365 },
  { id: "none", label: "No expiry", days: null },
];

const MUTED = { fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" } as const;
// `.lrow .sub` is single-line with an ellipsis; these lines must wrap whole.
const WRAP = { whiteSpace: "normal", wordBreak: "break-word" } as const;

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

type RevokeTarget = { id: string; name: string; person?: string };

export default function DeveloperPage() {
  const { user } = useAuth();
  const isGuest = user?.role === "guest";
  const { state, error, isLoading, mutate } = useDeveloper(isGuest);
  const all = useAllDevTokens(state?.isAdmin === true);
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (isGuest || error?.status === 403) return <Locked />;

  const refresh = () => {
    void mutate();
    void all.mutate();
  };

  const performRevoke = async () => {
    if (!revokeTarget) return;
    setActionError(null);
    try {
      await revokeApiToken(revokeTarget.id);
      refresh();
    } catch (err) {
      setActionError("Couldn't revoke that token. Try again.");
      throw err; // keeps the dialog open
    }
  };

  return (
    <ShellPage
      icon={<Braces size={15} />}
      label="Developer"
      title="Developer"
      sub="Let scripts use your projects, and see due dates in your calendar app."
    >
      <div style={{ maxWidth: 880 }}>
        {error && !state && (
          <div role="alert" className="card border border-system-red/40 bg-system-red/5" style={{ padding: 16, marginBottom: 16 }}>
            <p className="text-system-red flex items-center gap-2" style={{ fontSize: 15 }}>
              <AlertTriangle size={16} /> Couldn&rsquo;t load developer settings
            </p>
            <p className="mt-1" style={MUTED}>
              The box didn&rsquo;t answer. This is a connection problem, not a setting.
            </p>
            <button onClick={() => void mutate()} className="btn ghost sm" style={{ marginTop: 10 }} type="button">
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        )}

        {isLoading && !state && (
          <p className="px-1" style={MUTED}>
            Loading…
          </p>
        )}

        {state && (
          <>
            {state.isAdmin && (
              <AccessSwitch
                enabled={state.enabled}
                onSaved={(next) => {
                  void mutate(next, { revalidate: false });
                  void all.mutate();
                }}
              />
            )}

            {actionError && (
              <p role="alert" className="text-system-red" style={{ fontSize: 13, marginBottom: 12 }}>
                {actionError}
              </p>
            )}

            {state.enabled ? (
              <>
                <YourTokens state={state} onCreated={refresh} onRevoke={setRevokeTarget} />
                <Usage state={state} />
              </>
            ) : (
              !state.isAdmin && (
                <>
                  <div className="card" style={{ padding: 0, marginBottom: 16 }}>
                    <div className="empty">
                      <span className="ei">
                        <Braces size={22} />
                      </span>
                      <span className="eh">Your admin hasn&rsquo;t turned on API tokens</span>
                      <span>An owner or admin can allow them for the business.</span>
                    </div>
                  </div>
                  {/* Off does not revoke: a token is still `active` and works
                      again when the switch comes back on, so a person must be
                      able to kill one now (a lost laptop). Revoke only. */}
                  {state.tokens.length > 0 && (
                    <YourTokens state={state} onCreated={refresh} onRevoke={setRevokeTarget} />
                  )}
                </>
              )
            )}

            {state.isAdmin && <AllTokens tokens={all.tokens} failed={!!all.error} onRevoke={setRevokeTarget} />}
          </>
        )}

        <CalendarLinks skip={!state} />

        <ConfirmDialog
          open={revokeTarget !== null}
          onConfirm={performRevoke}
          onCancel={() => setRevokeTarget(null)}
          title={
            revokeTarget
              ? `Revoke "${revokeTarget.name}"${revokeTarget.person ? ` for ${revokeTarget.person}` : ""}?`
              : "Revoke token?"
          }
          description="Any script using it stops working right away. This can't be undone; create a new token to reconnect."
          confirmLabel="Revoke"
          variant="destructive"
        />
      </div>
    </ShellPage>
  );
}

function Locked() {
  return (
    <ShellPage icon={<Braces size={15} />} label="Developer" title="Developer">
      <div className="card" style={{ padding: 0, maxWidth: 880 }}>
        <div className="empty">
          <span className="ei">
            <Braces size={22} />
          </span>
          <span className="eh">Developer settings aren&rsquo;t available to guests</span>
          <span>Only owners, admins and members can create API tokens or calendar links.</span>
        </div>
      </div>
    </ShellPage>
  );
}

function AccessSwitch({ enabled, onSaved }: { enabled: boolean; onSaved: (next: DeveloperState) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await setApiTokensEnabled(next));
    } catch {
      setError("That didn't change. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Sect title="Access" />
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div className="rows">
          <div className="lrow" style={{ padding: "12px 16px" }}>
            <span className="rt">
              <span className="nm">{SWITCH_LABEL}</span>
              <span className="sub" style={WRAP}>
                Off by default. While it&rsquo;s on, owners, admins and members can create their own tokens, which
                let a script use projects as them; guests never can. Turning it off stops every token from working,
                but none are deleted.
              </span>
            </span>
            <Toggle on={enabled} onChange={(next) => void toggle(next)} ariaLabel={SWITCH_LABEL} />
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-system-red" style={{ fontSize: 13, marginBottom: 12 }}>
          {error}
        </p>
      )}
    </>
  );
}

function useCopy(value: string) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // `navigator.clipboard` is undefined on a non-secure origin (a box reached
    // over plain http); the value stays selectable text either way.
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return { copied, copy };
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const { copied, copy } = useCopy(value);
  return (
    <button type="button" className="btn ghost sm" onClick={copy} aria-label={`${copied ? "Copied" : "Copy"} ${label}`}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** A value shown exactly once, with the one thing to do with it. */
function ShownOnce({
  title,
  intro,
  label,
  value,
  onDismiss,
  panelRef,
}: {
  title: string;
  intro: string;
  label: string;
  value: string;
  onDismiss: () => void;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-label={title}
      className="mt-3 outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
      style={{ padding: 12, borderRadius: 8, background: "var(--inset)" }}
    >
      <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{title}</p>
      <p className="mt-1" style={MUTED}>
        {intro}
      </p>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <code className="font-mono flex-1" style={{ fontSize: 12, wordBreak: "break-all", userSelect: "all", color: "var(--text)" }}>
          {value}
        </code>
        <CopyButton label={label} value={value} />
      </div>
      <button type="button" className="btn ghost sm mt-2" onClick={onDismiss}>
        I&rsquo;ve copied it
      </button>
    </div>
  );
}

function scopeSummary(ids: string[], scopes: DevScope[]): string {
  const names = ids.map((id) => scopes.find((s) => s.id === id)?.label ?? id);
  return names.join(", ");
}

function YourTokens({
  state,
  onCreated,
  onRevoke,
}: {
  state: DeveloperState;
  onCreated: () => void;
  onRevoke: (target: RevokeTarget) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>(() => state.scopes.slice(0, 1).map((s) => s.id));
  const [expiry, setExpiry] = useState("90");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The one-time panel takes focus so a keyboard or screen-reader user lands
  // on the secret; dismissing it returns focus to the name field.
  useEffect(() => {
    if (secret) panelRef.current?.focus();
  }, [secret]);

  const toggleScope = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || picked.length === 0 || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const days = EXPIRY_CHOICES.find((c) => c.id === expiry)?.days ?? null;
      const { token } = await createApiToken({
        name: trimmed,
        scopes: picked,
        expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
      });
      setSecret(token);
      setName("");
      onCreated();
    } catch (err) {
      setCreateError(
        err instanceof DeveloperError && err.code === "disabled"
          ? "An admin has just turned API tokens off."
          : "Couldn't create the token. Try again.",
      );
    } finally {
      setCreating(false);
    }
  };

  const dismiss = () => {
    setSecret(null);
    inputRef.current?.focus();
  };

  const canCreateHere = state.enabled && state.canCreate;

  return (
    <>
      <Sect title="Your tokens" />
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        {canCreateHere &&
          (state.scopes.length === 0 ? (
            <p style={MUTED}>
              Nothing is turned on for a token to reach yet. Turn on Projects first, then come back.
            </p>
          ) : (
            <form onSubmit={handleCreate} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1.5" style={{ flex: "1 1 240px" }}>
                  <label htmlFor="token-name" className="px-0.5" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Token name
                  </label>
                  <input
                    id="token-name"
                    ref={inputRef}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={64}
                    placeholder="e.g. Nightly export"
                    className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-input)",
                      color: "var(--text)",
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="token-expiry" className="px-0.5" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Lasts
                  </label>
                  <ThemedSelect
                    id="token-expiry"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    className="px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)]"
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-input)",
                      color: "var(--text)",
                    }}
                  >
                    {EXPIRY_CHOICES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </ThemedSelect>
                </div>
              </div>

              <fieldset className="flex flex-col gap-1.5" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="px-0.5" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  What it can do
                </legend>
                {state.scopes.map((s) => (
                  <label key={s.id} className="flex items-start gap-2" style={{ fontSize: 13, color: "var(--text)" }}>
                    <input
                      type="checkbox"
                      checked={picked.includes(s.id)}
                      onChange={() => toggleScope(s.id)}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      {s.label}
                      <span className="block" style={MUTED}>
                        {s.description}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <div>
                <button type="submit" className="btn primary sm" disabled={creating || !name.trim() || picked.length === 0}>
                  {creating ? "Creating…" : "Create token"}
                </button>
              </div>
            </form>
          ))}
        {createError && (
          <p role="alert" className="text-system-red mt-2" style={{ fontSize: 13 }}>
            {createError}
          </p>
        )}

        {secret && (
          <ShownOnce
            title="Copy your new token now"
            intro={`You won't see it again. Use it where the examples below say ${TOKEN_PLACEHOLDER}, and keep it private: anyone who has it can use your projects as you, within the access you chose.`}
            label="token"
            value={secret}
            onDismiss={dismiss}
            panelRef={panelRef}
          />
        )}

        {state.tokens.length === 0 ? (
          <p className="mt-3" style={MUTED}>
            You don&rsquo;t have any tokens yet.
          </p>
        ) : (
          <div className="overflow-x-auto mt-3">
            <table className="w-full" style={{ fontSize: 12, lineHeight: "16px" }}>
              <thead>
                <tr className="text-left" style={{ color: "var(--text-muted)" }}>
                  <th className="font-medium pb-2 pr-4">Name</th>
                  <th className="font-medium pb-2 pr-4">Token</th>
                  <th className="font-medium pb-2 pr-4">Access</th>
                  <th className="font-medium pb-2 pr-4">Last used</th>
                  <th className="font-medium pb-2 pr-4">Expires</th>
                  <th className="font-medium pb-2 pr-4">Status</th>
                  <th className="font-medium pb-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.tokens.map((t: DevTokenRow) => (
                  <tr key={t.id} style={{ borderTop: "1px solid var(--card-bd)", color: "var(--text-muted)" }}>
                    <td className="py-2 pr-4" style={{ color: "var(--text)" }}>
                      {t.name}
                    </td>
                    <td className="py-2 pr-4 font-mono">dpm_{t.prefix}…</td>
                    <td className="py-2 pr-4">{scopeSummary(t.scopes, state.scopes)}</td>
                    <td className="py-2 pr-4">{t.lastUsedAt ? formatRelativeTime(t.lastUsedAt) : "Never"}</td>
                    <td className="py-2 pr-4">{t.expiresAt ? fmtDate(t.expiresAt) : "Never"}</td>
                    <td className="py-2 pr-4">
                      <Badge kind={STATUS_BADGE[t.status].kind}>{STATUS_BADGE[t.status].label}</Badge>
                    </td>
                    <td className="py-2">
                      {t.status !== "revoked" && (
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            className="btn ghost sm"
                            aria-label={`Revoke ${t.name}`}
                            onClick={() => onRevoke({ id: t.id, name: t.name })}
                          >
                            Revoke
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          A token stops working when you leave, when your role changes, when it expires and when you revoke it.
        </p>
      </div>
    </>
  );
}

function AllTokens({
  tokens,
  failed,
  onRevoke,
}: {
  tokens: DevTokenWithUser[] | undefined;
  failed: boolean;
  onRevoke: (target: RevokeTarget) => void;
}) {
  return (
    <>
      <Sect title="Everyone's tokens" />
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        {failed ? (
          <p className="text-system-red" style={{ fontSize: 13 }}>
            Couldn&rsquo;t load everyone&rsquo;s tokens. Reload the page to try again.
          </p>
        ) : !tokens ? (
          <p style={MUTED}>Loading…</p>
        ) : tokens.length === 0 ? (
          <p style={MUTED}>Nobody has created a token yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" style={{ fontSize: 12, lineHeight: "16px" }}>
              <thead>
                <tr className="text-left" style={{ color: "var(--text-muted)" }}>
                  <th className="font-medium pb-2 pr-4">Person</th>
                  <th className="font-medium pb-2 pr-4">Name</th>
                  <th className="font-medium pb-2 pr-4">Last used</th>
                  <th className="font-medium pb-2 pr-4">Expires</th>
                  <th className="font-medium pb-2 pr-4">Status</th>
                  <th className="font-medium pb-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} style={{ borderTop: "1px solid var(--card-bd)", color: "var(--text-muted)" }}>
                    <td className="py-2 pr-4" style={{ color: "var(--text)" }}>
                      {t.user.displayName}
                    </td>
                    <td className="py-2 pr-4">{t.name}</td>
                    <td className="py-2 pr-4">{t.lastUsedAt ? formatRelativeTime(t.lastUsedAt) : "Never"}</td>
                    <td className="py-2 pr-4">{t.expiresAt ? fmtDate(t.expiresAt) : "Never"}</td>
                    <td className="py-2 pr-4">
                      <Badge kind={STATUS_BADGE[t.status].kind}>{STATUS_BADGE[t.status].label}</Badge>
                    </td>
                    <td className="py-2 text-right">
                      {t.status !== "revoked" && (
                        <button
                          type="button"
                          className="btn ghost sm"
                          aria-label={`Revoke ${t.name} for ${t.user.displayName}`}
                          onClick={() => onRevoke({ id: t.id, name: t.name, person: t.user.displayName })}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Usage({ state }: { state: DeveloperState }) {
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Rendered only once the box has answered, which is always in the browser.
  const origin = window.location.origin;
  const curl = `curl -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}" \\\n  ${origin}/api/pm/projects`;

  const download = async () => {
    setDownloadError(null);
    try {
      await downloadOpenApi(state.openapiPath);
    } catch {
      setDownloadError("Couldn't download the document. Try again.");
    }
  };

  return (
    <>
      <Sect title="Using a token" />
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <p style={MUTED}>
          Send the token in an <code className="font-mono">Authorization: Bearer</code> header. It works on the projects
          API only, as you, and never beyond what your own role allows. It can make 300 requests a minute.
        </p>
        <div className="mt-2">
          <CodeBlock
            className="font-mono"
            style={{
              fontSize: 12,
              lineHeight: "18px",
              padding: 12,
              borderRadius: 8,
              background: "var(--inset)",
              color: "var(--text)",
              overflowX: "auto",
            }}
          >
            <code>{curl}</code>
          </CodeBlock>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <button type="button" className="btn ghost sm" onClick={() => void download()}>
            <FileJson size={13} /> OpenAPI document
          </button>
          <span style={MUTED}>Describes every route of the projects API, for code generators and API tools.</span>
        </div>
        {downloadError && (
          <p role="alert" className="text-system-red mt-2" style={{ fontSize: 13 }}>
            {downloadError}
          </p>
        )}
      </div>
    </>
  );
}

function feedKey(t: FeedTarget): string {
  return t.kind === "my_work" ? "my_work" : `project:${t.projectId}`;
}

function CalendarLinks({ skip }: { skip: boolean }) {
  const { feeds, error, isLoading, mutate } = useFeeds(skip);
  const [shown, setShown] = useState<{ key: string; name: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [offTarget, setOffTarget] = useState<{ target: FeedTarget; name: string } | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shown) panelRef.current?.focus();
  }, [shown]);

  const targetOf = (f: FeedRow): FeedTarget =>
    f.kind === "my_work" ? { kind: "my_work" } : { kind: "project", projectId: f.projectId ?? "" };

  const create = async (f: FeedRow) => {
    const target = targetOf(f);
    setBusy(feedKey(target));
    setFeedError(null);
    try {
      const { url } = await rotateFeed(target);
      // The box hands back a path; a calendar app needs the whole address.
      setShown({ key: feedKey(target), name: f.name, url: `${window.location.origin}${url}` });
      void mutate();
    } catch {
      setFeedError("Couldn't create the link. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    if (!offTarget) return;
    setFeedError(null);
    try {
      await revokeFeed(offTarget.target);
      if (shown?.key === feedKey(offTarget.target)) setShown(null);
      void mutate();
    } catch (err) {
      setFeedError("Couldn't turn the link off. Try again.");
      throw err; // keeps the dialog open
    }
  };

  const projectsOff = error instanceof DeveloperError && error.status === 404;

  return (
    <>
      <Sect title="Calendar links" />
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <p style={MUTED}>
          Paste a link into Google Calendar, Apple Calendar or Outlook to see due dates there. Each item with a due date
          is an all-day event that links back here. A link works like a password: anyone who has it can see those due
          dates without signing in. It lasts 180 days, and creating a new link or turning one off stops the old one
          right away.
        </p>

        {shown && (
          <ShownOnce
            title={`Copy the link for ${shown.name} now`}
            intro="You won't see it again. Paste it into your calendar app's “subscribe to calendar” option."
            label="calendar link"
            value={shown.url}
            onDismiss={() => setShown(null)}
            panelRef={panelRef}
          />
        )}

        {feedError && (
          <p role="alert" className="text-system-red mt-2" style={{ fontSize: 13 }}>
            {feedError}
          </p>
        )}

        {projectsOff ? (
          <p className="mt-3" style={MUTED}>
            Projects isn&rsquo;t turned on, so there are no due dates to show yet.
          </p>
        ) : error ? (
          <p role="alert" className="text-system-red mt-3" style={{ fontSize: 13 }}>
            Couldn&rsquo;t load your calendar links. Reload the page to try again.
          </p>
        ) : isLoading || !feeds ? (
          <p className="mt-3" style={MUTED}>
            Loading…
          </p>
        ) : (
          <div className="rows mt-3">
            {feeds.map((f) => {
              const key = feedKey(targetOf(f));
              const active = f.state === "active";
              return (
                <div key={key} className="lrow" style={{ padding: "10px 0", alignItems: "center" }}>
                  <span className="ri">
                    <Calendar size={16} />
                  </span>
                  <span className="rt">
                    <span className="nm">
                      {f.name}
                      {f.identifier ? <span className="font-mono" style={{ ...MUTED, marginLeft: 8 }}>{f.identifier}</span> : null}
                    </span>
                    <span className="sub" style={WRAP}>
                      {f.kind === "my_work"
                        ? "Items assigned to you that have a due date."
                        : "Every item in this project that has a due date."}{" "}
                      {active && f.expiresAt
                        ? `A link is active until ${fmtDate(f.expiresAt)}. It can't be shown again.`
                        : "No link yet."}
                    </span>
                  </span>
                  <span className="flex gap-1.5">
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy === key}
                      aria-label={`${active ? "Create a new link for" : "Create a link for"} ${f.name}`}
                      onClick={() => void create(f)}
                    >
                      {active ? "Create new link" : "Create link"}
                    </button>
                    {active && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        aria-label={`Turn off the link for ${f.name}`}
                        onClick={() => setOffTarget({ target: targetOf(f), name: f.name })}
                      >
                        Turn off
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={offTarget !== null}
        onConfirm={turnOff}
        onCancel={() => setOffTarget(null)}
        title={offTarget ? `Turn off the link for ${offTarget.name}?` : "Turn off link?"}
        description="Every calendar app subscribed with it stops getting updates. You can create a new link later."
        confirmLabel="Turn off"
        variant="destructive"
      />
    </>
  );
}
