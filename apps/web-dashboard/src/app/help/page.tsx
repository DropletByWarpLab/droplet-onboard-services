"use client";

import { useEffect, useState } from "react";
import {
  Cpu,
  FolderOpen,
  Globe,
  HardDrive,
  MessageSquare,
  Sparkles,
  Video,
} from "lucide-react";
import { WizardReplay } from "@/components/help/WizardReplay";

/**
 * /help — single-page customer-facing manual for Droplet.
 *
 * Section anchors line up with the LearnMoreCard `helpAnchor` props the
 * wizard's steps use, so "Learn more" links in the setup flow deep-link
 * here cleanly (e.g. /help#internet, /help#cameras, etc.).
 *
 * Style discipline: only design tokens (dp-card, type-*, text-label-*,
 * bg-surface-*), no freelance colours or font sizes. Offline-first
 * copy: no "connect to cloud", no "sync account" language anywhere.
 * The page is plain-text on purpose — no markdown library needed.
 */
export default function HelpPage() {
  const [replayOpen, setReplayOpen] = useState(false);

  // If the URL carries a hash (#internet, #cameras, etc.) and the page
  // mounted before the hash was processed, scroll to the section after
  // hydrate. Without this the deep-link from a LearnMoreCard can land
  // the user at the top of /help instead of at the topic they tapped.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash?.slice(1);
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) {
      // 50ms defer so the section's contents have settled.
      const t = window.setTimeout(
        () => el.scrollIntoView({ behavior: "smooth", block: "start" }),
        50,
      );
      return () => window.clearTimeout(t);
    }
  }, []);

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto">
      <header className="mb-8">
        <h1 className="type-large-title text-label-primary mb-2">Help</h1>
        <p className="type-body text-label-secondary mb-5">
          Plain answers to the questions that come up most often. Looking
          for the original setup walkthrough? Tap the button below.
        </p>
        <button
          type="button"
          onClick={() => setReplayOpen(true)}
          className="dp-btn-secondary"
        >
          <Sparkles size={16} aria-hidden="true" />
          How Droplet works
        </button>
      </header>

      <nav
        aria-label="Help table of contents"
        className="dp-card !p-4 mb-8"
      >
        <p className="type-subheadline text-label-primary mb-2">
          On this page
        </p>
        <ul className="space-y-1 type-footnote text-label-secondary">
          {SECTIONS.map((s) => (
            <li key={s.anchor}>
              <a
                href={`#${s.anchor}`}
                className="text-accent hover:underline"
              >
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {SECTIONS.map((section) => (
        <section
          key={section.anchor}
          id={section.anchor}
          className="mb-10 scroll-mt-20"
        >
          <div className="flex items-center gap-2 mb-3">
            <section.Icon size={20} className="text-accent" />
            <h2 className="type-title-2 text-label-primary">
              {section.title}
            </h2>
          </div>
          <div className="space-y-3 type-body text-label-secondary">
            {section.body}
          </div>
        </section>
      ))}

      <WizardReplay
        open={replayOpen}
        onClose={() => setReplayOpen(false)}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Content. Plain prose with the same vocabulary as the wizard steps.
// ──────────────────────────────────────────────────────────────────

interface Section {
  anchor: string;
  title: string;
  Icon: typeof FolderOpen;
  body: React.ReactNode;
}

const SECTIONS: Section[] = [
  {
    anchor: "internet",
    title: "Internet (DuckDNS)",
    Icon: Globe,
    body: (
      <>
        <p>
          DuckDNS gives this Droplet a permanent name on the internet —
          like <span className="font-mono">yourstudio.duckdns.org</span> —
          that keeps working even when your home internet&rsquo;s address
          changes. Your phone uses this name to dial back to the
          Droplet&rsquo;s VPN when you&rsquo;re away from home.
        </p>
        <p>
          <strong>To set it up:</strong> sign up for a free account at{" "}
          <a
            href="https://www.duckdns.org/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            duckdns.org
          </a>{" "}
          (Google / GitHub / Reddit / Twitter sign-in, no email needed).
          Pick a subdomain, copy the token, and paste both into the
          Internet step of the setup wizard or into the Remote Access
          page&rsquo;s Domain card.
        </p>
        <p>
          <strong>To change it later:</strong> open Remote Access in the
          sidebar, then tap Edit on the Domain card. Saving a new
          subdomain or token updates everything automatically — the VPN
          step picks up the new name without a restart.
        </p>
      </>
    ),
  },
  {
    anchor: "storage",
    title: "Storage",
    Icon: HardDrive,
    body: (
      <>
        <p>
          When you upload files, they live on the Droplet&rsquo;s drives.
          Names you choose during setup (&ldquo;Wedding Photos&rdquo;,
          &ldquo;Camera Footage&rdquo;) are stored locally — nothing
          leaves the box.
        </p>
        <p>
          <strong>To rename a drive:</strong> open Settings &rsaquo;
          Storage (or revisit the wizard&rsquo;s Storage step). The drive
          shows up in Files under whatever name you chose, but the actual
          mount path on disk doesn&rsquo;t change.
        </p>
        <p>
          <strong>If you plug in a new drive:</strong> the Droplet
          auto-mounts it and it shows up in the Storage list within a few
          seconds. You can then name it the same way.
        </p>
      </>
    ),
  },
  {
    anchor: "cameras",
    title: "Cameras",
    Icon: Video,
    body: (
      <>
        <p>
          Your cameras record straight to this Droplet&rsquo;s Frigate
          NVR — no cloud video service is involved. Live feeds, motion
          detection, clip retention, all run on the box.
        </p>
        <p>
          <strong>Auto-discovery:</strong> the camera-discovery service
          probes your LAN every 30 seconds for ONVIF-compatible cameras.
          When it finds new ones they appear as a banner on the Cameras
          page; tap Accept to add them.
        </p>
        <p>
          <strong>Network isolation:</strong> on the Cameras page,
          there&rsquo;s a Network Isolation toggle that puts your cameras
          on their own VLAN (192.168.100.0/24) — other devices on your
          Wi-Fi can&rsquo;t browse the feeds directly. The Droplet still
          can, so recordings and motion alerts keep working. Recommended
          if your cameras have default credentials.
        </p>
        <p>
          <strong>Remote viewing:</strong> connect your phone to the
          Droplet&rsquo;s VPN (Remote Access page) — once connected, the
          Cameras page works just like it does on your home Wi-Fi. The
          actual camera IPs and RTSP URLs never leave the Droplet.
        </p>
      </>
    ),
  },
  {
    anchor: "vpn",
    title: "Remote Access (WireGuard VPN)",
    Icon: Globe,
    body: (
      <>
        <p>
          Remote Access uses WireGuard, a modern open-source VPN. Each
          device that connects gets its own private key — the Droplet
          never sees your phone&rsquo;s key past the moment you scan the
          QR code, and the key never goes through any cloud service.
        </p>
        <p>
          <strong>To add a device:</strong> open Remote Access, tap
          &ldquo;Add a device&rdquo;, give it a name, and scan the QR
          code with the WireGuard app on your phone (free in the App
          Store / Play Store). Tap the toggle in the app — done.
        </p>
        <p>
          <strong>To revoke a device:</strong> open Remote Access, find
          the device in the list, and tap Revoke. The connection stops
          working immediately. Lost-phone scenario is the obvious case;
          you can also revoke + re-add to rotate the key.
        </p>
        <p>
          <strong>If the &ldquo;Add a device&rdquo; button is disabled:</strong>{" "}
          the Internet step (DuckDNS) hasn&rsquo;t been finished yet.
          The VPN needs a public name to dial back to. Go to the Internet
          section of this Help page (or revisit the wizard) and complete
          that first.
        </p>
      </>
    ),
  },
  {
    anchor: "ai",
    title: "AI (Chat)",
    Icon: MessageSquare,
    body: (
      <>
        <p>
          The Droplet runs AI models locally on its GPU. By default,
          your messages and the model&rsquo;s replies never leave this
          box — there&rsquo;s no &ldquo;send to OpenAI&rdquo; step
          hiding underneath.
        </p>
        <p>
          <strong>Local models:</strong> the Chat page lists everything
          the Droplet has installed under &ldquo;On your Droplet
          (private)&rdquo;. Llama, Mistral, Qwen, Gemma, Phi — whichever
          ones the operator pulled. They run on the Jetson GPU inside the
          box.
        </p>
        <p>
          <strong>Cloud models (optional):</strong> if you&rsquo;ve added
          API keys for OpenAI or Anthropic in Settings, those models also
          show up in the picker under &ldquo;Cloud (uses internet)&rdquo;.
          Picking one sends your message to that provider — useful if you
          want a specific frontier model, but no longer local-only.
        </p>
        <p>
          <strong>Conversation history:</strong> kept on this Droplet in
          its database. The dashboard&rsquo;s sidebar shows recent
          conversations. Delete a conversation from there to drop it
          permanently.
        </p>
      </>
    ),
  },
  {
    anchor: "devices",
    title: "Smart home devices",
    Icon: Cpu,
    body: (
      <>
        <p>
          The Droplet speaks Matter — the smart-home protocol most new
          devices support. Pair a Matter-compatible light / switch /
          sensor / thermostat and it appears on the Devices page.
        </p>
        <p>
          <strong>To pair:</strong> on the Devices page, tap &ldquo;Add
          device&rdquo;, scan the QR code printed on the device, follow
          the prompts. The pairing key is exchanged over your local
          Wi-Fi — no cloud account needed.
        </p>
        <p>
          <strong>To unpair:</strong> open the device&rsquo;s detail
          panel and tap Remove. The device leaves your network; if you
          want it back, pair it again.
        </p>
      </>
    ),
  },
  {
    anchor: "files",
    title: "Files",
    Icon: FolderOpen,
    body: (
      <>
        <p>
          The Files page is your view into the Droplet&rsquo;s
          Nextcloud-powered storage. Upload, download, share — all the
          obvious stuff. Shares are encrypted-in-transit and can be set
          to expire.
        </p>
        <p>
          <strong>Sync with your laptop:</strong> Files &rsaquo; Sync
          Devices lets you pair a desktop machine so a chosen folder
          stays mirrored between your computer and the Droplet
          (OneDrive-style, but without OneDrive).
        </p>
      </>
    ),
  },
];
