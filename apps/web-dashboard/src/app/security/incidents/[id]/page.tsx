"use client";

/**
 * WARP-2978 (ADR-059 P3 §8) — /security/incidents/:id, one incident.
 *
 * A detail page: no nav entry of its own; the /security prefix puts it under
 * the Security module's route guard. `?n=<notification id>` is set by the
 * toaster's "Open" and the service worker when an alert notification is
 * opened; Acknowledge sends it (validated here to the shape the box accepts).
 */
import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Shield } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { IncidentView, backTabFrom, notificationIdFrom } from "@/components/security/IncidentView";

export default function SecurityIncidentPage() {
  // useSearchParams needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <IncidentPage />
    </Suspense>
  );
}

function IncidentPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = typeof params?.id === "string" ? params.id : "";
  return (
    <ShellPage icon={<Shield size={15} />} label="Security" rhythm>
      <IncidentView id={id} notificationId={notificationIdFrom(search.get("n"))} backTab={backTabFrom(search.get("from"))} />
    </ShellPage>
  );
}
