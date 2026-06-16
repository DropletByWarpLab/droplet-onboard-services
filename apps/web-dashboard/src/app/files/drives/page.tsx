"use client";

import Link from "next/link";
import { ArrowLeft, HardDrive } from "lucide-react";
import { DrivesPanel } from "@/components/FileManager/DrivesPanel";
import { ShellPage } from "@/components/shell/ShellPage";

/** Drives surface — the storage breakdown reached from the Files sub-nav.
 *  Mirrors the Droplet Design System handoff's "Drives" tab: a pooled-storage
 *  summary plus a card per mounted volume, driven by the real
 *  /api/storage/drives data. */
export default function DrivesPage() {
  return (
    <ShellPage
      icon={<HardDrive size={15} />}
      label="Drives"
      title="Drives"
      sub="Storage pools and the physical volumes mounted on this Droplet."
      actions={
        <Link href="/files" className="btn ghost" aria-label="Back to files">
          <ArrowLeft size={15} />
          Files
        </Link>
      }
    >
      <DrivesPanel />
    </ShellPage>
  );
}
