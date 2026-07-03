/**
 * Local, in-repo help index (PR #382).
 *
 * SOURCE FLAG (read me): the onboarding spec calls for `GET /help/search?q=`
 * to run *semantic* search over shipped help articles indexed in the same
 * embedding store as Files/chat (file-indexer + ai-gateway EmbedText). That
 * backend index does NOT exist for help content yet, and standing up a second
 * vector store is explicitly out of scope (spec "Architecture rules"). So
 * this PR ships a LOCAL, OFFLINE, in-repo index + a deterministic ranked
 * token search — searchable today, no new service, no invented data source.
 * When the embedding-backed `/help/search` lands, this index becomes the seed
 * corpus and the UI swaps `searchHelp` for the API call; the entry shape
 * (id / title / summary / keywords) is the contract either way.
 *
 * The entries mirror the browse-view sections on `/help` 1:1 (same anchors,
 * same offline-first vocabulary, ADR-002) so a search result deep-links to
 * the full prose via `#<id>`. `summary` is the plain-text the prose conveys;
 * `keywords` carry the synonyms a customer is likely to type that the prose
 * may not contain verbatim (e.g. "vpn", "wifi", "gpu").
 */

export interface HelpEntry {
  /** Anchor-safe slug — matches the section `id` on /help (deep-link target). */
  id: string;
  title: string;
  /** Plain-text the section's prose conveys; the primary search surface. */
  summary: string;
  /** Synonyms / customer phrasings not always present verbatim in `summary`. */
  keywords: string[];
}

export const HELP_INDEX: readonly HelpEntry[] = [
  {
    id: "privacy",
    title: "What is Droplet & how privacy works",
    summary:
      "Droplet is a private AI appliance that lives on your own network — a single box that runs your files, conversations, video, and smart-home control. The AI runs locally on the hardware in front of you (the GPU inside this Droplet), not on someone else's servers, so by default your messages and the model's replies never leave the box. Everything you store and record stays on the Droplet's own drives; nothing is sent off the appliance unless you explicitly choose to, like adding an optional cloud AI key in Settings. On your home network, your devices reach the Droplet over its own end-to-end-encrypted VPN, without passing through any cloud service — away-from-home access arrives with the secure relay, coming soon.",
    keywords: ["privacy", "what is droplet", "local ai", "local", "private", "on device", "on-device", "no cloud", "data", "security", "gpu", "hardware", "offline"],
  },
  {
    id: "claim",
    title: "Claiming your Droplet",
    summary:
      "Claiming binds this specific box to your workspace so only you can set it up and control it. It is a one-time step the first time you turn the Droplet on. A short code shaped like DRPL-XXXX-XXXX appears on the display on the front of the unit — type it into the Claim step, or scan the on-screen QR code with your phone to jump straight there. If no code is showing, make sure the box is powered on and the display is awake, then try again. The code only ever shows on the unit itself and never leaves your network.",
    keywords: ["claim", "claim code", "pair", "bind", "activate", "drpl", "qr code", "first time", "setup"],
  },
  {
    id: "workspace",
    title: "Your workspace",
    summary:
      "A workspace is the shared home for everyone who uses this Droplet — your files, conversations, devices, and people all live inside it. Most homes need just one. The workspace name is what people see; the short web address (the slug) is used in links. You can rename the workspace later from Settings.",
    keywords: ["workspace", "organization", "tenant", "home", "rename", "slug", "name", "address"],
  },
  {
    id: "roles",
    title: "Team & roles",
    summary:
      "Invite the people who share this Droplet from the People page or the wizard's team step. Everyone signs in with their own account — nothing is shared by password. Owners can do everything, including factory-reset and managing other people; admins handle day-to-day settings and devices; members use the Droplet's files, chat, and everyday features without changing how it is set up. To invite someone, open People in the sidebar, tap Invite, choose a role, and share the invite link. You can change or remove someone's access at any time.",
    keywords: ["roles", "permissions", "members", "team", "owner", "admin", "invite", "people", "access"],
  },
  {
    id: "extenders",
    title: "Wi-Fi extenders",
    summary:
      "If parts of your home are out of the Droplet's Wi-Fi range, add a Droplet extender to widen coverage. Plug it in on the same network and it shows up on the Network page for one-tap approval, usually within about 30 seconds. To approve one, open Network in the sidebar, find the pending extender, and tap Approve. It joins your Droplet's Wi-Fi and starts relaying right away — no separate app or account needed.",
    keywords: ["extender", "wifi extender", "mesh", "coverage", "range", "repeater", "network", "approve"],
  },
  {
    id: "internet",
    title: "Your box's web address",
    summary:
      "Your Droplet has its own secure web address — the name you gave it during setup — and it works across your home network, with a padlock and nothing to install. There's nothing to sign up for and no address to type in. Away-from-home access arrives with the secure relay — coming soon; when it lands you'll open the Droplet app, turn on Connect, and use the same address you use at home. No dynamic DNS, no subdomain or token, and no changes to your home router.",
    keywords: ["web address", "domain", "remote access", "connect", "away from home", "hostname", "url"],
  },
  {
    id: "storage",
    title: "Storage",
    summary:
      "Uploaded files live on the Droplet's drives. The friendly names you choose during setup are stored locally and nothing leaves the box. Rename a drive from Settings or the wizard's Storage step; the mount path on disk does not change. Plug in a new drive and the Droplet auto-mounts it within seconds.",
    keywords: ["drive", "drives", "disk", "mount", "rename", "usb", "space", "capacity"],
  },
  {
    id: "cameras",
    title: "Cameras",
    summary:
      "Cameras record straight to this Droplet's Frigate NVR — no cloud video service. Live feeds, motion detection, and clip retention all run on the box. Auto-discovery probes your LAN for ONVIF cameras every 30 seconds; accept new ones from a banner on the Cameras page. Network Isolation puts cameras on their own VLAN. Remote viewing works over the VPN and camera IPs never leave the Droplet.",
    keywords: ["camera", "frigate", "nvr", "onvif", "rtsp", "motion", "recording", "clips", "footage", "video", "isolation", "vlan"],
  },
  {
    id: "vpn",
    title: "Remote Access (WireGuard VPN)",
    summary:
      "Remote Access uses WireGuard, a modern open-source VPN. Each device gets its own private key and the key never goes through any cloud service. Add a device, name it, and scan the QR code with the WireGuard app to connect. Revoke a device to stop its access immediately — the lost-phone case, or to rotate a key. The Add a device button needs the box's web address ready first, which happens automatically.",
    keywords: ["vpn", "wireguard", "remote", "remote access", "tunnel", "qr code", "revoke", "rotate key", "away from home"],
  },
  {
    id: "ai",
    title: "AI (Chat)",
    summary:
      "The Droplet runs AI models locally on its GPU. By default your messages and the model's replies never leave the box — there is no hidden send-to-OpenAI step. Local models appear under On your Droplet (private). Cloud models are optional: add an API key in Settings and they show up under Cloud (uses internet). Conversation history is kept on the Droplet and you can delete a conversation to drop it permanently.",
    keywords: ["ai", "chat", "llm", "model", "models", "gpu", "ollama", "openai", "anthropic", "local", "private", "conversation", "history"],
  },
  {
    id: "devices",
    title: "Smart home devices",
    summary:
      "The Droplet speaks Matter, the smart-home protocol most new devices support. Pair a Matter light, switch, sensor, or thermostat and it appears on the Devices page. To pair, scan the QR code on the device — the pairing key is exchanged over your local Wi-Fi with no cloud account. Unpair from the device's detail panel.",
    keywords: ["smart home", "matter", "device", "devices", "light", "switch", "sensor", "thermostat", "pair", "unpair", "automation"],
  },
  {
    id: "files",
    title: "Files",
    summary:
      "The Files page is your view into the Droplet's Nextcloud-powered storage. Upload, download, and share — shares are encrypted-in-transit and can be set to expire. Sync Devices lets you pair a desktop machine so a chosen folder stays mirrored between your computer and the Droplet, OneDrive-style but without OneDrive.",
    keywords: ["files", "nextcloud", "upload", "download", "share", "sharing", "sync", "folder", "desktop", "mirror"],
  },
];

/**
 * Rank help entries against a free-text query.
 *
 * Deterministic, offline, no embeddings. Tokenizes the query on whitespace
 * and scores each entry by where its tokens land:
 *   - title match           → heaviest (a customer who types a topic name
 *                             wants that topic at the top);
 *   - keyword match         → strong (curated synonyms);
 *   - summary/body match    → present but lighter.
 * An entry must match EVERY query token (AND semantics) to appear — typing
 * more words narrows, it doesn't broaden. An empty/whitespace query returns
 * the full index (the browse corpus) so the caller can treat "no query" and
 * "all topics" the same way.
 */
export function searchHelp(query: string): HelpEntry[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...HELP_INDEX];

  const scored: Array<{ entry: HelpEntry; score: number }> = [];
  for (const entry of HELP_INDEX) {
    const title = entry.title.toLowerCase();
    const summary = entry.summary.toLowerCase();
    const keywordBlob = entry.keywords.join(" ").toLowerCase();

    let score = 0;
    let matchedEvery = true;
    for (const token of tokens) {
      const inTitle = title.includes(token);
      const inKeywords = keywordBlob.includes(token);
      const inSummary = summary.includes(token);
      if (!inTitle && !inKeywords && !inSummary) {
        matchedEvery = false;
        break;
      }
      if (inTitle) score += 10;
      if (inKeywords) score += 4;
      if (inSummary) score += 1;
    }
    if (matchedEvery) scored.push({ entry, score });
  }

  // Highest score first; stable by original index for ties (Array.sort is
  // stable in modern engines, and `scored` was built in index order).
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.entry);
}
