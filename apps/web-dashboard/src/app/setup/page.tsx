"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { setupAdmin, loginUser, fetchMatterDevices } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  ArrowRight,
  Eye,
  EyeOff,
  Lightbulb,
  Lock,
  Radar,
  ThermometerSun,
  ToggleRight,
  User,
  Wifi,
} from "lucide-react";
import { DropletMark } from "@/components/DropletMark";
import { WelcomeFlourish } from "@/components/auth/WelcomeFlourish";
import type { MatterDevice, MatterGrouped } from "@/lib/types";

type Step = "welcome" | "account" | "discovery" | "done";
const STEPS: Step[] = ["welcome", "account", "discovery", "done"];
const RESERVED_USERNAMES = ["admin", "root"];

const CATEGORY_ICONS: Record<string, typeof Lightbulb> = {
  light: Lightbulb,
  switch: ToggleRight,
  climate: ThermometerSun,
  sensor: Radar,
};

export default function SetupPage() {
  const { completeSetup } = useAuth();
  const [step, setStep] = useState<Step>("welcome");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Discovery state
  const [discoveredDevices, setDiscoveredDevices] = useState<MatterDevice[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanSeconds, setScanSeconds] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const seenIdsRef = useRef<Set<string>>(new Set());

  async function handleCreateAccount() {
    setError(null);

    if (!username.trim()) {
      setError("Username is required");
      return;
    }
    if (username.length < 2) {
      setError("Username must be at least 2 characters");
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      setError("Username can only contain letters, numbers, dots, hyphens, and underscores");
      return;
    }
    if (RESERVED_USERNAMES.includes(username.toLowerCase())) {
      setError("This username is reserved and cannot be used");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsSubmitting(true);
    try {
      await setupAdmin(username, password, displayName || undefined);
      // Auto-login so we can call authenticated endpoints during discovery
      await loginUser(username, password);
      completeSetup();
      setStep("discovery");
    } catch (err: any) {
      setError(err.message || "Setup failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  // --- Discovery polling ---
  const startDiscovery = useCallback(() => {
    setIsScanning(true);
    setScanSeconds(0);
    seenIdsRef.current.clear();
    setDiscoveredDevices([]);

    // Poll for devices every 3 seconds
    pollRef.current = setInterval(async () => {
      try {
        const grouped = await fetchMatterDevices();
        const allDevices = flattenGrouped(grouped);
        // Only add truly new devices (not seen before)
        const newDevices: MatterDevice[] = [];
        for (const d of allDevices) {
          if (!seenIdsRef.current.has(d.nodeId)) {
            seenIdsRef.current.add(d.nodeId);
            newDevices.push(d);
          }
        }
        if (newDevices.length > 0) {
          setDiscoveredDevices((prev) => [...prev, ...newDevices]);
        }
      } catch {
        // Matter controller may still be booting — keep polling.
      }
    }, 3000);

    // Count seconds for UX
    timerRef.current = setInterval(() => {
      setScanSeconds((s) => s + 1);
    }, 1000);
  }, []);

  useEffect(() => {
    if (step === "discovery") {
      startDiscovery();
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [step, startDiscovery]);

  function handleFinishDiscovery() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    setIsScanning(false);
    setStep("done");
  }

  return (
    <div className="min-h-screen bg-surface-primary flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                s === step
                  ? "w-8 bg-accent"
                  : STEPS.indexOf(step) > i
                  ? "w-4 bg-accent/40"
                  : "w-4 bg-separator"
              }`}
            />
          ))}
        </div>

        {/* Step: Welcome */}
        {step === "welcome" && (
          <div className="text-center animate-in fade-in duration-300">
            <div className="flex items-center justify-center mx-auto mb-6">
              <DropletMark size={48} className="text-accent" />
            </div>

            <h1 className="type-large-title text-label-primary mb-3">
              Welcome to Droplet
            </h1>
            <p className="type-body text-label-secondary mb-2">
              Your private edge AI appliance
            </p>
            <p className="type-subheadline text-label-tertiary mb-10 max-w-sm mx-auto">
              Droplet keeps your files, conversations, and smart home control
              completely private — powered by local AI running on your hardware.
            </p>

            <button
              onClick={() => setStep("account")}
              className="dp-btn-primary w-full"
            >
              Get Started
              <ArrowRight size={16} />
            </button>
          </div>
        )}

        {/* Step: Create Account */}
        {step === "account" && (
          <div className="animate-in fade-in duration-300">
            <h1 className="type-title-1 text-label-primary mb-2 text-center">
              Create your account
            </h1>
            <p className="type-subheadline text-label-secondary mb-8 text-center">
              This will be the administrator account for your Droplet.
            </p>

            <div className="space-y-4">
              <div>
                <label className="type-subheadline text-label-secondary block mb-1.5">
                  Username
                </label>
                <div className="relative">
                  <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary" />
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.toLowerCase())}
                    placeholder="your-username"
                    autoComplete="username"
                    className="dp-input pl-10"
                    autoFocus
                  />
                </div>
              </div>

              <div>
                <label className="type-subheadline text-label-secondary block mb-1.5">
                  Display Name
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your name (optional)"
                  className="dp-input"
                />
              </div>

              <div>
                <label className="type-subheadline text-label-secondary block mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary" />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    autoComplete="new-password"
                    className="dp-input pl-10 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-label-tertiary hover:text-label-secondary"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <p className="type-caption-1 text-label-quaternary mt-1.5">
                  Must be at least 8 characters
                </p>
              </div>

              <div>
                <label className="type-subheadline text-label-secondary block mb-1.5">
                  Confirm Password
                </label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary" />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    autoComplete="new-password"
                    className="dp-input pl-10"
                    onKeyDown={(e) => e.key === "Enter" && handleCreateAccount()}
                  />
                </div>
              </div>

              {error && (
                <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
                  {error}
                </p>
              )}

              <button
                onClick={handleCreateAccount}
                disabled={isSubmitting}
                className="dp-btn-primary w-full mt-2"
              >
                {isSubmitting ? "Creating account..." : "Create Account"}
              </button>
            </div>
          </div>
        )}

        {/* Step: Device Discovery */}
        {step === "discovery" && (
          <div className="animate-in fade-in duration-300">
            {/* Scanning header */}
            <div className="text-center mb-8">
              <div className="relative w-16 h-16 mx-auto mb-5">
                <div className="absolute inset-0 rounded-full bg-accent/10 animate-scan-pulse" />
                <div className="absolute inset-2 rounded-full bg-accent/20 animate-scan-pulse" style={{ animationDelay: "0.3s" }} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Wifi size={28} className="text-accent" />
                </div>
              </div>

              <h1 className="type-title-1 text-label-primary mb-2">
                Discovering your devices
              </h1>
              <p className="type-subheadline text-label-tertiary">
                {discoveredDevices.length === 0
                  ? "Scanning your network for smart home devices..."
                  : `${discoveredDevices.length} device${discoveredDevices.length !== 1 ? "s" : ""} found`}
              </p>
            </div>

            {/* Discovered devices grid */}
            <div className="space-y-2 mb-8 max-h-[320px] overflow-y-auto">
              {discoveredDevices.map((device, index) => {
                const Icon = CATEGORY_ICONS[device.category] || Wifi;
                return (
                  <div
                    key={device.nodeId}
                    className="animate-device-appear flex items-center gap-3 dp-card !py-3"
                    style={{ animationDelay: `${index * 80}ms` }}
                  >
                    <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                      <Icon size={18} className="text-accent" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="type-subheadline text-label-primary truncate">
                        {device.name}
                      </p>
                      <p className="type-caption-1 text-label-tertiary capitalize">
                        {device.category.replace("_", " ")}
                      </p>
                    </div>
                    <div className="w-2 h-2 rounded-full bg-system-green flex-shrink-0" />
                  </div>
                );
              })}

              {/* Scanning placeholder rows */}
              {discoveredDevices.length === 0 && (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 dp-card !py-3 opacity-30"
                      style={{ animationDelay: `${i * 200}ms` }}
                    >
                      <div className="w-9 h-9 rounded-lg bg-surface-secondary animate-pulse" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3 w-32 bg-surface-secondary rounded animate-pulse" />
                        <div className="h-2.5 w-20 bg-surface-secondary rounded animate-pulse" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Scanning timer */}
            {isScanning && (
              <p className="type-caption-1 text-label-quaternary text-center mb-4">
                Scanning... {scanSeconds}s
              </p>
            )}

            {/* Actions */}
            <div className="space-y-3">
              <button
                onClick={handleFinishDiscovery}
                className={`dp-btn-primary w-full transition-all duration-300 ${
                  discoveredDevices.length > 0 ? "opacity-100" : "opacity-60"
                }`}
              >
                {discoveredDevices.length > 0 ? "Continue" : "Continue"}
                <ArrowRight size={16} />
              </button>
              <button
                onClick={handleFinishDiscovery}
                className="w-full type-subheadline text-label-tertiary hover:text-label-secondary py-2 transition-colors"
              >
                Skip for now
              </button>
            </div>
          </div>
        )}

        {/* Step: Done — fluid completion flourish + auto-redirect to dashboard.
            Replaces the legacy static check + /login button (WARP-216). The
            user is already logged in by the time we reach this branch (see
            handleCreateAccount), so the redirect target is the dashboard. */}
        {step === "done" && (
          <WelcomeFlourish
            displayName={displayName || undefined}
            subtitle={
              discoveredDevices.length > 0
                ? `${discoveredDevices.length} device${
                    discoveredDevices.length !== 1 ? "s" : ""
                  } connected and ready to control.`
                : "You can add smart home devices later from the Devices page."
            }
            redirectTo="/"
          />
        )}
      </div>
    </div>
  );
}

// --- Helpers ---

function flattenGrouped(grouped: MatterGrouped): MatterDevice[] {
  return [
    ...grouped.lights,
    ...grouped.switches,
    ...grouped.climate,
    ...grouped.sensors,
    ...grouped.media,
    ...grouped.covers,
    ...grouped.locks,
    ...grouped.other,
  ];
}
