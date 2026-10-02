"use client";

import { HardDrive } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { DrivesPanel } from "@/components/FileManager/DrivesPanel";

/** WARP-2959 — Storage: pools, physical volumes and the system disk.
 *
 *  This is the surface that used to be `/files/drives`. It reads the same
 *  `/api/storage/*` data as the Files browser, which is why it lived there,
 *  but it is box administration — RAID health, the install disk, and the
 *  tier-3 erase/adopt/reclaim actions — and none of that answers "where is
 *  my document?". Settings is where the rest of the box's hardware config
 *  already lives, beside Software updates and the Danger zone.
 *
 *  `DrivesPanel` is unchanged and still owns every control and gate. */
export default function StoragePage() {
  return (
    <ShellPage
      icon={<HardDrive size={15} />}
      label="Storage"
      title="Storage"
      sub="Storage pools and the physical volumes mounted on this Droplet."
    >
      <DrivesPanel />
    </ShellPage>
  );
}
