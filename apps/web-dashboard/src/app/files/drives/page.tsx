"use client";

import { DrivesPanel } from "@/components/FileManager/DrivesPanel";

/** Drives surface — the storage breakdown reached from the Files sub-nav.
 *  Mirrors the Droplet Design System handoff's "Drives" tab: a pooled-storage
 *  summary plus a card per mounted volume, driven by the real
 *  /api/storage/drives data. */
export default function DrivesPage() {
  return <DrivesPanel />;
}
