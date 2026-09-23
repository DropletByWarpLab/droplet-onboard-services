"use client";

import { useState } from "react";
import useSWR from "swr";
import { TerminalSquare, AlertTriangle, KeyRound, Eye, EyeOff } from "lucide-react";
import {
  SSH_LOGIN_PASSWORD_MIN,
  isValidSshLoginPassword,
  isValidSshLoginUsername,
} from "@droplet/shared-types";
import {
  confirmNetworkCommand,
  fetchSshAccess,
  setSshAccess,
  setSshLogin,
  type SshAccessStatus,
} from "@/lib/api";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";

/**
 * SSH access (Droplet Design System · Network · System) — WARP-1984, WARP-2887.
 *
 * The support-troubleshooting door. Off by default, and off again after every
 * restart: a boot oneshot (droplet-ssh-access-boot-reset) rewrites the host
 * intent to off, so this toggle can never read green over a box that came
 * back up with sshd down. LAN-only: this never opens anything on the
 * internet side.
 *
 * WARP-2887 adds the login the door uses. Without it the toggle opened a door
 * only the baked provisioning key could walk through, so the owner could turn
 * SSH on for a support engineer and still have nothing to hand them. The
 * login is a username + password the owner chooses; saving it is the same
 * Tier-3 two-step as the toggle, and what the card shows afterwards is the
 * account the HOST reports, not the one that was typed.
 *
 * COPY POSTURE (ADR-002, home-user persona). The audience for this card is not
 * a sysadmin — it is whoever owns the business. So it says "command-line login
 * to this Droplet from your local network" rather than "sshd", explains what
 * being on means in terms of consequence, and never uses "SSH" alone as though
 * the word carried its own explanation. The heading keeps the term because
 * that IS what a support engineer will ask them to turn on, by name.
 *
 * The three-state readback matters more than it looks. `pending` and `unknown`
 * both render distinctly from `off` because "we can't confirm the box opened
 * the door" and "the door is shut" send someone down completely different
 * paths during an incident.
 */
export function SshAccessCard() {
  const { data, isLoading, mutate } = useSWR<SshAccessStatus>(
    "/api/network/ssh",
    fetchSshAccess,
    { refreshInterval: 15000 },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = data?.enabled ?? false;
  const status = data?.status ?? "unknown";
  // No host units on this deployment shape — render honestly read-only rather
  // than a toggle that would write an intent nothing will ever pick up.
  const unavailable = status === "unknown";

  async function onToggle() {
    if (!data || unavailable) return;
    const next = !enabled;
    setSaving(true);
    setError(null);
    try {
      const result = await setSshAccess(next);
      if (
        result.status === "confirmation_required" &&
        result.confirmationToken &&
        result.operation
      ) {
        // Tier 3 — the toggle itself is the consent, same two-step the
        // reboot and VPN controls already use.
        await confirmNetworkCommand(result.confirmationToken, result.operation);
      }
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change SSH access.");
      await mutate();
    } finally {
      setSaving(false);
    }
  }

  function description(): string {
    if (unavailable) {
      return "Not available on this Droplet — no command-line login is offered.";
    }
    if (status === "pending") {
      return enabled
        ? "Turning off — waiting for the Droplet to confirm."
        : "Turning on — waiting for the Droplet to confirm.";
    }
    return enabled
      ? "On — someone with the login can reach this Droplet from your local network."
      : "Off — no command-line login to this Droplet.";
  }

  return (
    <div className="card">
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "var(--card-inner)", color: "var(--text-muted)" }}
        >
          <TerminalSquare size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="type-headline" style={{ color: "var(--text)" }}>
            SSH access
          </h3>
          <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
            {description()}
          </p>
        </div>
        {unavailable ? (
          <span className="badge muted">Off</span>
        ) : (
          <ToggleSwitch
            on={enabled}
            onToggle={onToggle}
            disabled={isLoading || saving || status === "pending"}
            ariaLabel="SSH access for troubleshooting"
          />
        )}
      </div>

      {enabled && status === "applied" && (
        <div className="mt-3 flex items-start gap-2 type-caption-1 text-system-orange bg-system-orange/10 rounded-sm px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            Leave this on only while someone is troubleshooting, then turn it
            back off. If you forget, it turns itself off the next time this
            Droplet restarts.
          </span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 type-caption-1 text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {!unavailable && data && (
        <SshLoginSection login={data.login} onChanged={() => mutate()} />
      )}
    </div>
  );
}

/**
 * WARP-2887 — the login the door uses. Shown whenever the host units exist,
 * on or off: a login can be set ahead of turning access on (it persists across
 * restarts; only the door closes). `login` is absent on an older orchestrator,
 * which renders as "unknown" rather than as "none".
 */
function SshLoginSection({
  login,
  onChanged,
}: {
  login: SshAccessStatus["login"] | undefined;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loginStatus = login?.status ?? "unknown";
  // One ruleset, shared with the orchestrator route and service via
  // @droplet/shared-types — the Save button lights up only for input the
  // server will accept, and a bound changed there changes here.
  const usernameValid = isValidSshLoginUsername(username);
  const passwordValid = isValidSshLoginPassword(password);

  function summary(): string {
    switch (loginStatus) {
      case "set":
        return `Login: ${login?.username}`;
      case "pending":
        return "Saving the login — waiting for the Droplet to confirm.";
      case "refused":
        return login?.username
          ? `The Droplet refused the new login; “${login.username}” still works.`
          : "The Droplet refused that login. Try a different username.";
      case "none":
        return "No login set yet — turning SSH on opens a door nobody can use.";
      default:
        return "Login state not reported by this Droplet.";
    }
  }

  async function onSave() {
    if (!usernameValid || !passwordValid) return;
    setSaving(true);
    setError(null);
    try {
      const result = await setSshLogin(username, password);
      if (
        result.status === "confirmation_required" &&
        result.confirmationToken &&
        result.operation
      ) {
        await confirmNetworkCommand(result.confirmationToken, result.operation);
      }
      setPassword("");
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the login.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="flex items-start gap-3">
        <KeyRound size={16} className="mt-0.5 flex-shrink-0" style={{ color: "var(--text-muted)" }} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <p className="type-subheadline" style={{ color: "var(--text)" }}>
            {summary()}
          </p>
          <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
            Whoever uses this login can run administrative commands on the
            Droplet, so share it only with someone you trust.
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            className="btn"
            onClick={() => setEditing(true)}
            disabled={loginStatus === "pending"}
          >
            {loginStatus === "set" ? "Change login" : "Set login"}
          </button>
        )}
      </div>

      {editing && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
          <div>
            <label
              htmlFor="ssh-login-username"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              Username
            </label>
            <input
              id="ssh-login-username"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value.trim())}
              placeholder="support"
              className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              aria-invalid={username !== "" && !usernameValid}
              disabled={saving}
            />
          </div>
          <div>
            <label
              htmlFor="ssh-login-password"
              className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
            >
              Password (at least {SSH_LOGIN_PASSWORD_MIN} characters)
            </label>
            <div className="relative">
              <input
                id="ssh-login-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full px-3 py-2.5 pr-10 outline-none focus:ring-2 focus:ring-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
                aria-invalid={password !== "" && !passwordValid}
                disabled={saving}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-2 -mr-2 text-[color:var(--text-muted)] transition-colors duration-200 hover:text-[color:var(--text)]"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div className="flex gap-2 mt-1">
            <button
              type="submit"
              className="btn primary"
              disabled={saving || !usernameValid || !passwordValid}
            >
              {saving ? "Saving…" : "Save login"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setEditing(false);
                setPassword("");
                setError(null);
              }}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 type-caption-1 text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
