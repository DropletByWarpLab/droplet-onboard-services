"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Check, Lock, User, Eye, EyeOff } from "lucide-react";
import { DropletMark } from "@/components/DropletMark";
import { translateError } from "@/lib/friendly-errors";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const fromSetup = searchParams.get("from") === "setup";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleLogin() {
    setError(null);

    if (!username.trim() || !password.trim()) {
      setError("Username and password are required");
      return;
    }

    setIsSubmitting(true);
    try {
      await login(username, password);
      router.push("/");
    } catch (err) {
      // WARP-294: never render err.message verbatim — orchestrator may
      // surface terse strings like "OCS 401" / "connect ECONNREFUSED".
      setError(translateError(err, "auth"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface-primary flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center mx-auto mb-4">
            <DropletMark size={40} className="text-accent" />
          </div>
          <h1 className="type-title-1 text-label-primary">Sign in</h1>
          <p className="type-subheadline text-label-secondary mt-1">
            Access your Droplet dashboard
          </p>
        </div>

        {fromSetup && (
          <div className="flex items-center gap-2 bg-accent/10 text-accent rounded-lg px-4 py-3 mb-6">
            <Check size={16} className="flex-shrink-0" />
            <p className="type-subheadline">
              Setup already completed. Sign in to access your dashboard.
            </p>
          </div>
        )}

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
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                autoComplete="username"
                className="dp-input pl-10"
                autoFocus
              />
            </div>
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
                placeholder="Password"
                autoComplete="current-password"
                className="dp-input pl-10 pr-10"
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
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

          {error && (
            <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
              {error}
            </p>
          )}

          <button
            onClick={handleLogin}
            disabled={isSubmitting}
            className="dp-btn-primary w-full"
          >
            {isSubmitting ? "Signing in..." : "Sign In"}
          </button>
        </div>
      </div>
    </div>
  );
}
