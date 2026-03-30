"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setupAdmin } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Droplets, ArrowRight, Check, User, Lock, Eye, EyeOff } from "lucide-react";

type Step = "welcome" | "account" | "done";

export default function SetupPage() {
  const router = useRouter();
  const { completeSetup } = useAuth();
  const [step, setStep] = useState<Step>("welcome");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
      completeSetup();
      setStep("done");
    } catch (err: any) {
      setError(err.message || "Setup failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface-primary flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {["welcome", "account", "done"].map((s, i) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                s === step
                  ? "w-8 bg-accent"
                  : ["welcome", "account", "done"].indexOf(step) > i
                  ? "w-4 bg-accent/40"
                  : "w-4 bg-separator"
              }`}
            />
          ))}
        </div>

        {/* Step: Welcome */}
        {step === "welcome" && (
          <div className="text-center animate-in fade-in duration-300">
            <div className="w-20 h-20 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-6">
              <Droplets size={40} className="text-accent" />
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
                    placeholder="admin"
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

        {/* Step: Done */}
        {step === "done" && (
          <div className="text-center animate-in fade-in duration-300">
            <div className="w-20 h-20 rounded-full bg-system-green/10 flex items-center justify-center mx-auto mb-6">
              <Check size={40} className="text-system-green" />
            </div>

            <h1 className="type-title-1 text-label-primary mb-3">
              You&apos;re all set!
            </h1>
            <p className="type-body text-label-secondary mb-8">
              Your Droplet is ready. Sign in with your new account to get started.
            </p>

            <button
              onClick={() => router.push("/login")}
              className="dp-btn-primary w-full"
            >
              Sign In
              <ArrowRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
