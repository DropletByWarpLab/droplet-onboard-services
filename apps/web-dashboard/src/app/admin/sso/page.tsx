"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export default function SsoPage() {
  return (
    <div>
      <div className="dp-top">
        <div className="dp-crumbs">
          <Link href="/" style={{ color: "var(--rd-text-3)" }}>Home</Link>
          <span aria-hidden>›</span>
          <span className="here">Login &amp; SSO</span>
        </div>
      </div>

      <div className="dp-page">
        <div className="dp-page-h">
          <div>
            <p className="dp-cap">Admin</p>
            <h1>Login &amp; SSO</h1>
            <p className="sub">
              Configure password rules, second-factor requirements, and SAML / OIDC identity
              providers for your team.
            </p>
          </div>
        </div>

        <ComingSoon
          icon={Lock}
          title="Coming soon"
          description="Today the dashboard authenticates against Nextcloud OCS (cookie + JWT). SAML and OIDC support are part of the JWT/RBAC rollout."
          unlockedBy="JWT + RBAC complete (M1.3 + M2.2)"
          ticket="WARP-M1.3"
        />
      </div>
    </div>
  );
}
