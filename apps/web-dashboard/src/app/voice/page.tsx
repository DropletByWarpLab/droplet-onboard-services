"use client";

/**
 * WARP-1055 — /voice: microphone health, live input meter, and the
 * guided calibration wizard (Flow A). A peer surface of Cameras /
 * Network / Devices — same ShellPage chrome, same offline pattern.
 *
 * SWR wiring lives in useVoiceSurfaceData; the presentational
 * VoiceSurface (tested in voice.page.test.tsx) does the §9 state
 * mapping. A generic fetch failure renders the standard offline card
 * (the Cameras pattern); a 503 `voice_unavailable` instead renders the
 * red "Microphone not working" hero inside the surface — voice-io is
 * down but the box itself answered.
 *
 * WARP-1056 — the §3.3 profiles section rides useVoiceProfiles, and
 * `?enroll=<userId>` (the People-row "Add voice" deep-link) opens
 * Flow B with that person preselected. useSearchParams must be read
 * under a Suspense boundary (Next.js app-router rule — same pattern
 * as /network).
 */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Mic, RefreshCw } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { VoiceSurface } from "@/components/voice/VoiceSurface";
import { useVoiceSurfaceData } from "@/lib/hooks/useVoice";
import { useVoiceProfiles } from "@/lib/hooks/useVoiceProfiles";
import { useVoiceActivity } from "@/lib/hooks/useVoiceActivity";

const PAGE_SUB = "Microphone, wake word, and who Droplet recognizes.";

export default function VoicePage() {
  return (
    <Suspense fallback={null}>
      <VoicePageInner />
    </Suspense>
  );
}

function VoicePageInner() {
  const data = useVoiceSurfaceData();
  const profilesData = useVoiceProfiles();
  const searchParams = useSearchParams();
  const enrollUserId = searchParams.get("enroll");
  // WARP-1058 — §3.4 feed (signed kind=voice rows; its own cadence).
  const voiceActivity = useVoiceActivity();

  if (data.offline) {
    return (
      <ShellPage icon={<Mic size={15} />} label="Voice" title="Voice" sub={PAGE_SUB}>
        <div className="card">
          <div className="empty">
            <span className="ei">
              <Mic size={24} />
            </span>
            <span className="eh">Voice service is offline</span>
            <span style={{ maxWidth: "44ch" }}>
              Make sure this Droplet is powered on and reachable, then try
              again in a moment — or contact support if this persists.
            </span>
            <button
              onClick={data.refresh}
              className="btn"
              type="button"
              style={{ marginTop: 8 }}
            >
              <RefreshCw size={16} />
              Retry
            </button>
          </div>
        </div>
      </ShellPage>
    );
  }

  return (
    <ShellPage icon={<Mic size={15} />} label="Voice" title="Voice" sub={PAGE_SUB}>
      <VoiceSurface
        status={data.status}
        calibration={data.calibration}
        unavailable={data.unavailable}
        enabled={data.enabled}
        loading={data.loading}
        noiseSustained={data.noiseSustained}
        profiles={profilesData.profiles}
        speakerModelAvailable={profilesData.speakerModelAvailable}
        initialEnrollUserId={enrollUserId}
        onProfilesChanged={profilesData.refresh}
        activity={voiceActivity.rows}
        onRefresh={data.refresh}
        onCalibrationApplied={data.onCalibrationApplied}
      />
    </ShellPage>
  );
}
