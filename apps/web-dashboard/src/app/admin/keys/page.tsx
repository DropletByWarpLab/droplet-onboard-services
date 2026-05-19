"use client";

import Link from "next/link";
import { KeyRound, ExternalLink } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export default function KeysPage() {
  return (
    <div>
      <div className="dp-top">
        <div className="dp-crumbs">
          <Link href="/" style={{ color: "var(--rd-text-3)" }}>Home</Link>
          <span aria-hidden>›</span>
          <span className="here">Keys &amp; integrations</span>
        </div>
      </div>

      <div className="dp-page">
        <div className="dp-page-h">
          <div>
            <p className="dp-cap">Admin</p>
            <h1>Keys &amp; integrations</h1>
            <p className="sub">
              BYOK provider keys for OpenAI, Anthropic, and other cloud LLMs. Each key is
              encrypted at rest with Fernet and only released into the AI gateway at request
              time.
            </p>
          </div>
          <Link href="/settings#ai-keys" className="dp-btn dp-btn--sm">
            Open AI keys in Settings
            <ExternalLink size={11} strokeWidth={1.75} />
          </Link>
        </div>

        <ComingSoon
          icon={KeyRound}
          title="Dedicated page coming soon"
          description="Today, BYOK keys live in Settings. A dedicated keys & integrations surface — with usage stats, last-used-at, and per-key audit — is part of the extension marketplace milestone."
          unlockedBy="Extension marketplace (M3.6)"
          ticket="WARP-M3.6"
        />
      </div>
    </div>
  );
}
