"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export default function GroupsPage() {
  return (
    <div>
      <div className="dp-top">
        <div className="dp-crumbs">
          <Link href="/" style={{ color: "var(--rd-text-3)" }}>Home</Link>
          <span aria-hidden>›</span>
          <span className="here">Groups &amp; teams</span>
        </div>
      </div>

      <div className="dp-page">
        <div className="dp-page-h">
          <div>
            <p className="dp-cap">Admin</p>
            <h1>Groups &amp; teams</h1>
            <p className="sub">
              Bucket people into reusable groups (Family, Engineering, Security…) and grant
              capabilities at the group level instead of per-person.
            </p>
          </div>
        </div>

        <ComingSoon
          icon={Users}
          title="Coming soon"
          description="Groups land alongside RBAC per-route guards. Until then, role assignments live on each user directly via the People page."
          unlockedBy="RBAC per-route guards (M2.2)"
          ticket="WARP-M2.2"
        />
      </div>
    </div>
  );
}
