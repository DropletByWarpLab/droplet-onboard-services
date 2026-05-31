"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Check } from "lucide-react";
import { DropletMark } from "@/components/DropletMark";
import { translateError } from "@/lib/friendly-errors";
import { AuroraPanel } from "@/components/auth/AuroraPanel";
import { SignInForm } from "@/components/auth/SignInForm";

/** Only allow same-origin path redirects from `?next=` (no open redirect). */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const fromSetup = searchParams.get("from") === "setup";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleLogin() {
    setError(null);

    if (!email.trim() || !password.trim()) {
      setError("Enter your work email and password to continue.");
      return;
    }

    setIsSubmitting(true);
    try {
      // The built-in directory keys on email in a later PR; today the
      // orchestrator validates the identifier as a username, so we pass it
      // through unchanged.
      await login(email.trim(), password);
      router.push(safeNext(searchParams.get("next")));
    } catch (err) {
      // WARP-294: never render err.message verbatim — orchestrator may
      // surface terse strings like "OCS 401" / "connect ECONNREFUSED".
      setError(translateError(err, "auth"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh grid lg:grid-cols-[1.05fr_1fr] bg-surface-primary">
      <AuroraPanel className="hidden lg:flex" />

      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-[380px]">
          {/* Compact wordmark — stands in for the brand panel on small screens */}
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <DropletMark size={24} className="text-accent" />
            <span className="type-headline text-label-primary">Droplet</span>
          </div>

          <h1 className="type-title-1 text-label-primary">Welcome back</h1>
          <p className="type-subheadline text-label-secondary mt-1.5 mb-6">
            Sign in to your Droplet workspace.
          </p>

          {fromSetup && (
            <div className="flex items-center gap-2 bg-accent/10 text-accent rounded-lg px-4 py-3 mb-6">
              <Check size={16} className="flex-shrink-0" aria-hidden="true" />
              <p className="type-subheadline">
                Setup already completed. Sign in to access your dashboard.
              </p>
            </div>
          )}

          <SignInForm
            email={email}
            password={password}
            showPassword={showPassword}
            onEmailChange={setEmail}
            onPasswordChange={setPassword}
            onTogglePassword={() => setShowPassword((s) => !s)}
            onSubmit={handleLogin}
            error={error}
            submitting={isSubmitting}
          />

          <p className="type-caption-1 text-label-tertiary text-center mt-6 leading-relaxed">
            Sign-in happens on your local network — nothing leaves the box.
          </p>
        </div>
      </div>
    </div>
  );
}
