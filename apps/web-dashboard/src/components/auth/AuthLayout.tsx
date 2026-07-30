import { type ReactNode } from "react";
import { DropletMark } from "@/components/DropletMark";
import { AuroraPanel } from "@/components/auth/AuroraPanel";

/**
 * The shared shell for every public auth surface (sign-in, invite
 * acceptance).
 *
 * Before this existed, `/login` rendered the Aurora brand split while
 * `/invite/[token]` rendered a plain centred form on the page background —
 * so the two halves of the same flow (an admin invites you, you set a
 * password, you sign in) looked like they came from different products.
 * Both now share one shell: the Aurora hero on the left, a 380px form
 * column on the right, and the compact wordmark standing in for the hero
 * below `lg`.
 *
 * Anything that is genuinely per-surface — the heading, the sub-copy, the
 * form itself, the reassurance footnote — is passed in.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Optional centred footnote below the form (e.g. the local-network note). */
  footer?: ReactNode;
}) {
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

          <h1 className="type-auth-title text-label-primary">{title}</h1>
          {subtitle && (
            <p className="type-subheadline text-label-secondary mt-1.5 mb-6">
              {subtitle}
            </p>
          )}

          {children}

          {footer && (
            <p className="type-caption-1 text-label-secondary text-center mt-6 leading-relaxed">
              {footer}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
