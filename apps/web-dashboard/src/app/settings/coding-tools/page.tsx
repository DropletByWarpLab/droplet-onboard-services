/**
 * WARP-3452 — /settings/coding-tools: people point GitHub Copilot and other
 * coding tools on the LAN at this box's local model, through `/llm/` with a
 * personal `dlk_` token.
 *
 * Everything renders from GET /api/llm-access, and the box decides who sees
 * what (`isAdmin`, `canCreate`), never a role check here:
 *   · owner/admin: the box-wide switch (off by default) and everyone's tokens,
 *     with revoke;
 *   · switch off: anyone else sees that it is off, plus their own tokens
 *     with Revoke only (off does not revoke them);
 *   · switch on: the two base URLs, the active model id, the context window,
 *     create a token (shown once), their own tokens, per-client snippets and
 *     the limits.
 * An external guest can never hold a token (the box answers 403), so the page
 * does not ask and renders a locked state; a 403 from the box renders the same.
 */
"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Check, Copy, RefreshCw, Terminal } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Sect, Toggle, type BadgeKind } from "@/components/shell/primitives";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CodeBlock } from "@/components/CodeBlock";
import { useAuth } from "@/lib/auth";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  LlmAccessError,
  createLlmToken,
  renewLlmToken,
  revokeLlmToken,
  setLlmAccessEnabled,
  useAllLlmTokens,
  useLlmAccess,
  type LlmAccessState,
  type LlmTokenRow,
  type LlmTokenStatus,
  type LlmTokenWithUser,
} from "@/lib/hooks/useLlmAccess";
import { TOKEN_PLACEHOLDER, clientGuides } from "./clients";

const SWITCH_LABEL = "Coding tools can use the local model";

const STATUS_BADGE: Record<LlmTokenStatus, { kind: BadgeKind; label: string }> = {
  active: { kind: "ok", label: "Active" },
  expired: { kind: "warn", label: "Expired" },
  revoked: { kind: "muted", label: "Revoked" },
};

const MUTED = { fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" } as const;
// `.lrow .sub` is single-line with an ellipsis; these lines must wrap whole.
const WRAP = { whiteSpace: "normal", wordBreak: "break-word" } as const;

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function fmtUsage(u: LlmTokenRow["usage30d"]): string {
  const tokens = u.promptTokens + u.completionTokens;
  const base = `${u.requests.toLocaleString()} requests · ${tokens.toLocaleString()} tokens`;
  return u.errors > 0 ? `${base} · ${u.errors.toLocaleString()} errors` : base;
}

type RevokeTarget = { id: string; label: string; person?: string };

export default function CodingToolsPage() {
  const { user } = useAuth();
  const isGuest = user?.role === "guest";
  const { access, error, isLoading, mutate } = useLlmAccess(isGuest);
  const all = useAllLlmTokens(access?.isAdmin === true);
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (isGuest || error?.status === 403) return <Locked />;

  const refresh = () => {
    void mutate();
    void all.mutate();
  };

  const renew = async (id: string) => {
    setActionError(null);
    try {
      await renewLlmToken(id);
      refresh();
    } catch {
      setActionError("Couldn't renew that token. Try again.");
    }
  };

  const performRevoke = async () => {
    if (!revokeTarget) return;
    setActionError(null);
    try {
      await revokeLlmToken(revokeTarget.id);
      refresh();
    } catch (err) {
      setActionError("Couldn't revoke that token. Try again.");
      throw err; // keeps the dialog open
    }
  };

  return (
    <ShellPage
      icon={<Terminal size={15} />}
      label="Coding tools"
      title="Coding tools"
      sub="Use this Droplet's local model from GitHub Copilot and other coding tools on your network."
    >
      <div style={{ maxWidth: 880 }}>
        {error && !access && (
          <div
            role="alert"
            className="card border border-system-red/40 bg-system-red/5"
            style={{ padding: 16, marginBottom: 16 }}
          >
            <p className="text-system-red flex items-center gap-2" style={{ fontSize: 15 }}>
              <AlertTriangle size={16} /> Couldn&rsquo;t load coding tools
            </p>
            <p className="mt-1" style={MUTED}>
              The box didn&rsquo;t answer. This is a connection problem, not a setting.
            </p>
            <button onClick={() => void mutate()} className="btn ghost sm" style={{ marginTop: 10 }} type="button">
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        )}

        {isLoading && !access && (
          <p className="px-1" style={MUTED}>
            Loading…
          </p>
        )}

        {access && (
          <>
            {access.isAdmin && (
              <AccessSwitch
                enabled={access.enabled}
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

            {access.enabled ? (
              <>
                <Connection access={access} />
                <YourTokens
                  access={access}
                  onCreated={refresh}
                  onRenew={renew}
                  onRevoke={setRevokeTarget}
                />
                <Guides access={access} />
                <Limits contextWindow={access.contextWindow} />
              </>
            ) : (
              !access.isAdmin && (
                <>
                  <div className="card" style={{ padding: 0, marginBottom: 16 }}>
                    <div className="empty">
                      <span className="ei">
                        <Terminal size={22} />
                      </span>
                      <span className="eh">Your admin hasn&rsquo;t turned this on</span>
                      <span>An owner or admin can turn on coding tools for the business.</span>
                    </div>
                  </div>
                  {/* Off does not revoke: a token is still `active` and works
                      again when the switch comes back on, so a person must be
                      able to kill one now (a lost laptop). Revoke only. */}
                  {access.tokens.length > 0 && (
                    <YourTokens
                      access={access}
                      onCreated={refresh}
                      onRenew={renew}
                      onRevoke={setRevokeTarget}
                    />
                  )}
                </>
              )
            )}

            {access.isAdmin && (
              <AllTokens tokens={all.tokens} failed={!!all.error} onRevoke={setRevokeTarget} />
            )}
          </>
        )}

        <ConfirmDialog
          open={revokeTarget !== null}
          onConfirm={performRevoke}
          onCancel={() => setRevokeTarget(null)}
          title={
            revokeTarget
              ? `Revoke "${revokeTarget.label}"${revokeTarget.person ? ` for ${revokeTarget.person}` : ""}?`
              : "Revoke token?"
          }
          description="Any tool using it stops working right away. This can't be undone; create a new token to reconnect."
          confirmLabel="Revoke"
          variant="destructive"
        />
      </div>
    </ShellPage>
  );
}

function Locked() {
  return (
    <ShellPage icon={<Terminal size={15} />} label="Coding tools" title="Coding tools">
      <div className="card" style={{ padding: 0, maxWidth: 880 }}>
        <div className="empty">
          <span className="ei">
            <Terminal size={22} />
          </span>
          <span className="eh">Coding tools aren&rsquo;t available to guests</span>
          <span>Only owners, admins and members can connect coding tools to this Droplet.</span>
        </div>
      </div>
    </ShellPage>
  );
}

function AccessSwitch({
  enabled,
  onSaved,
}: {
  enabled: boolean;
  onSaved: (next: LlmAccessState) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await setLlmAccessEnabled(next));
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
                Off by default. While it&rsquo;s on, owners, admins and members can create their
                own tokens; guests never can. Turning it off stops every token from working, but
                none are deleted.
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

function CopyRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="lrow" style={{ padding: "12px 16px" }}>
      <span className="rt">
        <span className="nm">{label}</span>
        <span className="sub mono" style={{ ...WRAP, wordBreak: "break-all", userSelect: "all" }}>
          {value}
        </span>
        {note && (
          <span className="sub" style={WRAP}>
            {note}
          </span>
        )}
      </span>
      <CopyButton label={label} value={value} />
    </div>
  );
}

function Connection({ access }: { access: LlmAccessState }) {
  // Rendered only once the box has answered, which is always in the browser.
  const origin = window.location.origin;
  return (
    <>
      <Sect title="Connection" />
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div className="rows">
          <CopyRow label="Base URL for OpenAI-style tools" value={`${origin}/llm/v1`} />
          <CopyRow label="Base URL for Ollama-style tools" value={`${origin}/llm`} />
          {access.activeModel ? (
            <CopyRow
              label="Model id"
              value={access.activeModel}
              note="This id changes if an admin changes the box's model. Update your tools when it does."
            />
          ) : (
            <div className="lrow" style={{ padding: "12px 16px" }}>
              <span className="rt">
                <span className="nm">Model id</span>
                <span className="sub" style={WRAP}>
                  No model is active on this box right now, so coding tools can&rsquo;t connect yet.
                </span>
              </span>
            </div>
          )}
          {access.contextWindow !== null && (
            <div className="lrow" style={{ padding: "12px 16px" }}>
              <span className="rt">
                <span className="nm">Context window</span>
              </span>
              <span className="rmeta mono">{access.contextWindow.toLocaleString()} tokens</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function YourTokens({
  access,
  onCreated,
  onRenew,
  onRevoke,
}: {
  access: LlmAccessState;
  onCreated: () => void;
  onRenew: (id: string) => void;
  onRevoke: (target: RevokeTarget) => void;
}) {
  const [label, setLabel] = useState("");
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

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const name = label.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { token } = await createLlmToken(name);
      setSecret(token);
      setLabel("");
      onCreated();
    } catch (err) {
      setCreateError(
        err instanceof LlmAccessError && err.code === "disabled"
          ? "An admin has just turned coding tools off."
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

  return (
    <>
      <Sect title="Your tokens" />
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        {access.enabled && access.canCreate && (
          <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5" style={{ flex: "1 1 240px" }}>
              <label htmlFor="token-label" className="px-0.5" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Token name
              </label>
              <input
                id="token-label"
                ref={inputRef}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={64}
                placeholder="e.g. MacBook – VS Code"
                className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
              />
            </div>
            <button type="submit" className="btn primary sm" disabled={creating || !label.trim()}>
              {creating ? "Creating…" : "Create token"}
            </button>
          </form>
        )}
        {createError && (
          <p role="alert" className="text-system-red mt-2" style={{ fontSize: 13 }}>
            {createError}
          </p>
        )}

        {secret && (
          <div
            ref={panelRef}
            tabIndex={-1}
            role="region"
            aria-labelledby="new-token-title"
            className="mt-3 outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            style={{ padding: 12, borderRadius: 8, background: "var(--inset)" }}
          >
            <p id="new-token-title" style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
              Copy your new token now
            </p>
            <p className="mt-1" style={MUTED}>
              You won&rsquo;t see it again. Use it where the steps below say {TOKEN_PLACEHOLDER}, and
              keep it private: anyone who has it can use the model as you.
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <code
                className="font-mono flex-1"
                style={{ fontSize: 12, wordBreak: "break-all", userSelect: "all", color: "var(--text)" }}
              >
                {secret}
              </code>
              <CopyButton label="token" value={secret} />
            </div>
            <button type="button" className="btn ghost sm mt-2" onClick={dismiss}>
              I&rsquo;ve copied it
            </button>
          </div>
        )}

        {access.tokens.length === 0 ? (
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
                  <th className="font-medium pb-2 pr-4">Created</th>
                  <th className="font-medium pb-2 pr-4">Last used</th>
                  <th className="font-medium pb-2 pr-4">Expires</th>
                  <th className="font-medium pb-2 pr-4">Last 30 days</th>
                  <th className="font-medium pb-2 pr-4">Status</th>
                  <th className="font-medium pb-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {access.tokens.map((t) => (
                  <tr key={t.id} style={{ borderTop: "1px solid var(--card-bd)", color: "var(--text-muted)" }}>
                    <td className="py-2 pr-4" style={{ color: "var(--text)" }}>
                      {t.label}
                    </td>
                    <td className="py-2 pr-4 font-mono">dlk_{t.prefix}…</td>
                    <td className="py-2 pr-4">{fmtDate(t.createdAt)}</td>
                    <td className="py-2 pr-4">{t.lastUsedAt ? formatRelativeTime(t.lastUsedAt) : "Never"}</td>
                    <td className="py-2 pr-4">{fmtDate(t.expiresAt)}</td>
                    <td className="py-2 pr-4">{fmtUsage(t.usage30d)}</td>
                    <td className="py-2 pr-4">
                      <Badge kind={STATUS_BADGE[t.status].kind}>{STATUS_BADGE[t.status].label}</Badge>
                    </td>
                    <td className="py-2">
                      {t.status !== "revoked" && (
                        <div className="flex justify-end gap-1.5">
                          {/* Renewing is pointless while the switch is off. */}
                          {access.enabled && (
                            <button
                              type="button"
                              className="btn ghost sm"
                              aria-label={`Renew ${t.label}`}
                              onClick={() => onRenew(t.id)}
                            >
                              Renew
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn ghost sm"
                            aria-label={`Revoke ${t.label}`}
                            onClick={() => onRevoke({ id: t.id, label: t.label })}
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
        {access.enabled && (
          <p className="mt-3" style={{ fontSize: 12, color: "var(--text-muted)" }}>
            A token lasts 364 days. Renew it before then to keep it working.
          </p>
        )}
      </div>
    </>
  );
}

function AllTokens({
  tokens,
  failed,
  onRevoke,
}: {
  tokens: LlmTokenWithUser[] | undefined;
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
                    <td className="py-2 pr-4">{t.label}</td>
                    <td className="py-2 pr-4">{t.lastUsedAt ? formatRelativeTime(t.lastUsedAt) : "Never"}</td>
                    <td className="py-2 pr-4">{fmtDate(t.expiresAt)}</td>
                    <td className="py-2 pr-4">
                      <Badge kind={STATUS_BADGE[t.status].kind}>{STATUS_BADGE[t.status].label}</Badge>
                    </td>
                    <td className="py-2 text-right">
                      {t.status !== "revoked" && (
                        <button
                          type="button"
                          className="btn ghost sm"
                          aria-label={`Revoke ${t.label} for ${t.user.displayName}`}
                          onClick={() => onRevoke({ id: t.id, label: t.label, person: t.user.displayName })}
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

function Guides({ access }: { access: LlmAccessState }) {
  const guides = clientGuides({
    origin: window.location.origin,
    model: access.activeModel,
    contextWindow: access.contextWindow,
  });
  return (
    <>
      <Sect title="Set up your tool" extra={`Replace ${TOKEN_PLACEHOLDER} with your token`} />
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div className="rows">
          {guides.map((g) => (
            <details key={g.id} data-client={g.id} style={{ padding: "12px 16px" }}>
              <summary
                className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)" }}
              >
                {g.name}
              </summary>
              <p className="mt-2" style={MUTED}>
                {g.steps}
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
                  <code>{g.snippet}</code>
                </CodeBlock>
              </div>
            </details>
          ))}
        </div>
      </div>
    </>
  );
}

function Limits({ contextWindow }: { contextWindow: number | null }) {
  const limits = [
    "Copilot's inline code completions always come from GitHub. This box's model powers Copilot Chat and agent mode.",
    "If the business uses Copilot Business or Enterprise, an org admin must first turn on the “Bring Your Own Language Model Key” policy.",
    "Agent mode needs tool calling turned on (toolCalling: true in VS Code).",
    `Requests longer than the context window${
      contextWindow !== null ? ` (${contextWindow.toLocaleString()} tokens)` : ""
    } are refused, not cut short.`,
    "Codex CLI works only on boxes that run Ollama.",
    "Copilot's old built-in Ollama entry can't send a token. Use Custom Endpoint or the Ollama extension instead.",
    "When the box is busy, its own chat goes first. Your tool may wait or be asked to retry.",
  ];
  return (
    <>
      <Sect title="Good to know" />
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <ul className="list-disc pl-5 space-y-1.5" style={MUTED}>
          {limits.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-4" style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          If your browser warned you about this page&rsquo;s certificate
        </p>
        <p className="mt-1" style={MUTED}>
          Each tool on your computer has to trust the box&rsquo;s certificate too. Add the
          certificate to your computer&rsquo;s trust store (Keychain Access on a Mac, the
          certificate manager on Windows); VS Code and JetBrains IDEs read it from there. Tools
          built on Node.js, such as Copilot CLI and OpenCode, also need{" "}
          <code className="font-mono">NODE_EXTRA_CA_CERTS</code> set to the certificate file.
          Don&rsquo;t turn off certificate checking to get around it.
        </p>
      </div>
    </>
  );
}
