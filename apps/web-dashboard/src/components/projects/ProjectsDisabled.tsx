"use client";

import { FolderKanban } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { EmptyBlock } from "@/components/projects/bits";

/** Honest "module off" state (WARP-1154/1155). Rendered when the orchestrator
 *  explicitly reports the Projects module disabled — a PERMANENT condition, so
 *  there is deliberately no Retry affordance and no PM request ever fires.
 *
 *  Lives in its own module (not the `projects/page.tsx` route file) because
 *  Next.js App Router rejects any non-reserved named export from a page route. */
export function ProjectsDisabled(): JSX.Element {
  return (
    <ShellPage icon={<FolderKanban size={15} />} label="Projects" title="Projects">
      <div className="pm-scope">
        <div className="pm-page">
          <div className="pm-surface" style={{ padding: 8 }}>
            <EmptyBlock
              icon="board"
              heading="Projects isn't enabled on this Droplet."
              body="An owner or admin can turn it on."
            />
          </div>
        </div>
      </div>
    </ShellPage>
  );
}
