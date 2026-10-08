"use client";
import { useAuth } from "@/lib/auth";
import { Sect } from "@/components/shell/primitives";
import { CreationCapabilitiesList } from "@/components/chat/CreationCapabilities";

export function CreationCapabilitiesCard() {
  const { user } = useAuth();
  if (user?.role !== "owner" && user?.role !== "admin") return null;
  return <>
    <Sect title="Creation capabilities" extra="Documents, research, analysis, speech and media" />
    <div className="card" style={{ padding: 16 }}><CreationCapabilitiesList enabled /></div>
  </>;
}
