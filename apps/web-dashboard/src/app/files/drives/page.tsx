"use client";

import { Topbar } from "@/components/Topbar";
import { DrivesPanel } from "@/components/FileManager/DrivesPanel";

/** Drives surface — the storage breakdown reached from the Files sub-nav.
 *  Mirrors the Droplet Design System handoff's "Drives" tab: a pooled-storage
 *  summary plus a card per mounted volume, driven by the real
 *  /api/storage/drives data. */
export default function DrivesPage() {
  return (
    <div>
      <Topbar crumbs={[{ label: "Files", href: "/files" }, { label: "Drives" }]} />
      <div className="p-6">
        <DrivesPanel />
      </div>
    </div>
  );
}
