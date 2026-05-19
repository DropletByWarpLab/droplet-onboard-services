"use client";

import Link from "next/link";
import { Laptop } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export default function SessionsPage() {
  return (
    <div>
      <div className="dp-top">
        <div className="dp-crumbs">
          <Link href="/" style={{ color: "var(--rd-text-3)" }}>Home</Link>
          <span aria-hidden>›</span>
          <span className="here">Sessions &amp; devices</span>
        </div>
      </div>

      <div className="dp-page">
        <div className="dp-page-h">
          <div>
            <p className="dp-cap">Admin</p>
            <h1>Sessions &amp; devices</h1>
            <p className="sub">
              See every device signed into your Droplet. Revoke any session with one click.
            </p>
          </div>
        </div>

        <ComingSoon
          icon={Laptop}
          title="Coming soon"
          description="Sessions surface depends on device pairing (QR/PIN handshake) and JWT refresh-token storage. Paired devices show up here once both ship."
          unlockedBy="Device pairing flow (M2.3) + JWT refresh"
          ticket="WARP-M2.3"
        />
      </div>
    </div>
  );
}
