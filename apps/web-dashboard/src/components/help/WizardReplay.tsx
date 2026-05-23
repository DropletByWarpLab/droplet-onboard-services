"use client";

import { useRef } from "react";
import {
  Cpu,
  FolderOpen,
  Globe,
  Video,
  X,
} from "lucide-react";
import { Dialog } from "@/components/Dialog";

/**
 * "How Droplet works" replay modal. Re-shows the four product-
 * positioning cards a customer would have seen on their first run, so
 * they can refresh their memory or hand the box off to someone new.
 *
 * Trigger lives on `/help`. The cards are intentionally identical-
 * looking to LearnMoreCards used in the wizard — same dp-card chrome,
 * same colour tokens, same plain-language tone (ADR-002 offline-first
 * copy rule, no cloud language).
 */
export function WizardReplay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="how-droplet-works"
      maxWidth="md"
      initialFocusRef={closeButtonRef}
    >
      <div>
        <div className="flex items-center justify-between px-5 py-4 border-b border-separator">
          <h2
            id="how-droplet-works"
            className="type-title-3 text-label-primary"
          >
            How Droplet works
          </h2>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="p-1 text-label-tertiary hover:text-label-primary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <Card
            icon={<FolderOpen size={18} className="text-accent" />}
            title="Your files live here, not in the cloud"
            body="When you upload a photo or document, it's stored on this Droplet's drives. No copies in someone else's data centre. If the Droplet's offline, the only thing affected is access — your files don't disappear."
          />
          <Card
            icon={<Cpu size={18} className="text-accent" />}
            title="The AI runs on your hardware"
            body="The local AI models run on the GPU inside this box. Your questions, the model's answers, the whole conversation — none of it leaves the Droplet. You can also configure cloud models (OpenAI, Anthropic) with your own API key, but those are explicit choices, not the default."
          />
          <Card
            icon={<Video size={18} className="text-accent" />}
            title="Your camera footage stays put"
            body="Cameras record straight to the Droplet's Frigate NVR. You can review footage, get motion alerts, and grant remote access — but the video files don't get streamed out to any cloud service. The Network Isolation toggle on the Cameras page can also put them on their own VLAN so other devices on your Wi-Fi can't browse them directly."
          />
          <Card
            icon={<Globe size={18} className="text-accent" />}
            title="Remote access is end-to-end encrypted"
            body="Your phone connects back to the Droplet via WireGuard — a modern VPN protocol. The handshake uses keys you generated on the Droplet, not credentials stored somewhere else. Off your home Wi-Fi, you reach the dashboard through the same name you saved during setup (yoursubdomain.duckdns.org)."
          />
        </div>
      </div>
    </Dialog>
  );
}

function Card({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="dp-card !p-4 flex items-start gap-3">
      <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="type-subheadline text-label-primary mb-1">{title}</p>
        <p className="type-footnote text-label-secondary">{body}</p>
      </div>
    </div>
  );
}
