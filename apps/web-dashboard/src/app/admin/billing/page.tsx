"use client";

import Link from "next/link";
import { CreditCard } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export default function BillingPage() {
  return (
    <div>
      <div className="dp-top">
        <div className="dp-crumbs">
          <Link href="/" style={{ color: "var(--rd-text-3)" }}>Home</Link>
          <span aria-hidden>›</span>
          <span className="here">Plan &amp; billing</span>
        </div>
      </div>

      <div className="dp-page">
        <div className="dp-page-h">
          <div>
            <p className="dp-cap">Admin</p>
            <h1>Plan &amp; billing</h1>
            <p className="sub">
              See your plan, paid extensions, and seat counts. Owners control changes.
            </p>
          </div>
        </div>

        <ComingSoon
          icon={CreditCard}
          title="Coming soon"
          description="Droplet ships as a hardware appliance — there are no per-seat fees today. Billing will appear once paid extensions or cloud-backed services launch."
          unlockedBy="Extension marketplace (M3.6)"
          ticket="WARP-M3.6"
        />
      </div>
    </div>
  );
}
