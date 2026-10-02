import { type ReactNode } from "react";
import { DropletMark } from "@/components/DropletMark";
import { LoginHero } from "@/components/auth/LoginHero";
import { VERSION_LABEL } from "@/lib/brand";

/**
 * The shared shell for every public auth surface (sign-in, invite
 * acceptance).
 *
 * Before this existed, `/login` rendered the brand split while
 * `/invite/[token]` rendered a plain centred form on the page background —
 * so the two halves of the same flow (an admin invites you, you set a
 * password, you sign in) looked like they came from different products.
 * Both now share one shell: the hero on the left, the form column on the
 * right, and the compact wordmark standing in for the hero below `lg`.
 *
 * WARP-2973 — the hero is the dot-matrix landing (<LoginHero>), the split
 * is now even (that hero is a composition around a centred subject, so the
 * old 1.05fr bias pushed the subject off-centre), the form column sits
 * behind a 1px rule, and the build stamp closes the column.
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
    <div className="min-h-dvh grid lg:grid-cols-2 bg-surface-primary">
      <LoginHero className="hidden lg:block" />

      <div className="flex items-center justify-center p-6 sm:p-10 lg:border-l lg:border-separator">
        <div className="w-full max-w-[400px] flex flex-col gap-5">
          {/* Compact wordmark — stands in for the brand panel on small screens */}
          <div className="lg:hidden flex items-center gap-2">
            <DropletMark size={24} className="text-accent" />
            <span className="type-headline text-label-primary">Droplet</span>
          </div>

          <div>
            <h1 className="type-auth-title text-label-primary">{title}</h1>
            {subtitle && (
              <p className="type-subheadline text-label-secondary mt-1.5">
                {subtitle}
              </p>
            )}
          </div>

          {children}

          {footer && (
            <p className="type-caption-1 text-label-secondary text-center leading-relaxed">
              {footer}
            </p>
          )}

          {/* Build stamp — the same constant the sidebar renders, so the
              pre-login surface can never claim a different version than the
              dashboard behind it. */}
          <p className="type-caption-2 text-label-quaternary text-center font-mono">
            {VERSION_LABEL}
          </p>
        </div>
      </div>
    </div>
  );
}
