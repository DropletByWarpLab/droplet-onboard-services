"use client";

/**
 * WARP-2977 P2b (ADR-059 §3.4) — /security/zones, titled "Areas".
 *
 * The places the owner cares about and which cameras (or parts of a camera's
 * view) cover each, so the Security feed can say where something happened.
 * "Areas" is the UI noun; the route and the code keep `zone`. It lives under
 * /security so the nav-derived route guard gates it with the rest of the
 * module, and every household role can read it (view level) — the manage
 * controls inside render only at manage. The body is `AreasPanel`.
 */
import { MapPin } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { AreasPanel, COPY } from "@/components/security/AreasPanel";

export default function SecurityAreasPage() {
  return (
    <ShellPage icon={<MapPin size={15} />} label="Security" title={COPY.title} sub={COPY.sub}>
      <AreasPanel />
    </ShellPage>
  );
}
