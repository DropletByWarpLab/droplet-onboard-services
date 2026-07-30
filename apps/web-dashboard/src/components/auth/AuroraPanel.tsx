import { Shield, Lock, Check } from "lucide-react";
import { DropletMark } from "@/components/DropletMark";

const TRUST = [
  { icon: Shield, label: "On-prem" },
  { icon: Lock, label: "Encrypted at rest" },
  { icon: Check, label: "Yours, not licensed" },
] as const;

/**
 * Left-hand brand hero for the sign-in split (the signature Aurora moment).
 * Hidden on small screens — the form panel carries a compact wordmark there.
 *
 * Copy is product positioning, not feature state, so it ships now; the
 * interactive auth methods are gated separately (see `flags.ts`).
 */
export function AuroraPanel({ className = "" }: { className?: string }) {
  return (
    <aside
      className={`relative overflow-hidden aurora-brand text-white flex-col justify-between p-12 xl:p-14 ${className}`}
    >
      <div className="flex items-center gap-2.5">
        <DropletMark size={26} className="text-white" />
        <span className="text-[19px] font-bold tracking-tight">Droplet</span>
      </div>

      <div className="max-w-[460px]">
        {/* Brand copy, NOT the page heading — the real <h1> is the form
            column's "Welcome back" / "You've been invited". This used to be
            an <h1> too, which gave every auth page two competing top-level
            headings; screen-reader users landed on the marketing line
            instead of the thing they came to do. */}
        <p className="text-[40px] xl:text-[42px] leading-[1.08] font-bold tracking-[-0.025em]">
          Your company&rsquo;s brain.
          <br />
          On your premises.
        </p>
        <p className="mt-[18px] text-[16px] leading-[1.55] text-white/85 max-w-[400px]">
          One box runs your AI, files, cameras, and network — and nothing leaves
          the building unless you say so.
        </p>
        <ul className="flex flex-wrap gap-2 mt-6">
          {TRUST.map(({ icon: Icon, label }) => (
            <li
              key={label}
              className="inline-flex items-center gap-[7px] px-3 py-1.5 rounded-full bg-white/[0.12] border border-white/[0.18] text-[12.5px] font-medium backdrop-blur-sm"
            >
              <Icon size={13} aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center gap-2 text-[12.5px] text-white/80">
        <span
          aria-hidden="true"
          className="w-[7px] h-[7px] rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.25)]"
        />
        Online · on your local network
      </div>
    </aside>
  );
}
