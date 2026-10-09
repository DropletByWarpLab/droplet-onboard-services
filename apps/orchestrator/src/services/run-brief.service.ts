/** Fixed instructions selected by a validated, persisted brief key. */
export const RUN_BRIEFS = {
  "app-setup": [
    "Set up the code in your bound Workshop workspace as a hosted Droplet web app.",
    "Inspect existing files and extension-manifest.json first. Preserve the person's UI and behaviour.",
    "Use kind app, runtime static/node20/python312, tools [], processes 1 and egress none.",
    "Static: set http.dir to built assets, omit entrypoint, create a readable http.health file; use relative asset URLs.",
    "Process: bind 127.0.0.1 on PORT (also DROPLET_EXT_PORT), route under DROPLET_EXT_BASE_PATH, write only to DROPLET_EXT_DATA_DIR.",
    "http.health is relative to the app base path. Never select a public port or change firewall/router rules.",
    "Dependencies and builds must be vendored and committed; no network installs. Report missing dependencies rather than claiming a build.",
    "Make required build output and vendored dependencies trackable in .gitignore; ignored files are absent from the proposed version. Inspect the diff before proposing.",
    "Use workspace_read/search/write/run to adapt and test. workspace_run command app-check probes health and root for at most 30 seconds; read actual results.",
    "After checks pass, workspace_propose is your final action: a pinned proposal/version for owner MFA review. Promotion signs it later. Never promote, deploy or grant access yourself.",
    "If setup is blocked, say what is missing and report the checks actually run.",
  ].join("\n"),
} as const;

export type RunBriefKey = keyof typeof RUN_BRIEFS;
export function isRunBriefKey(value: unknown): value is RunBriefKey {
  return typeof value === "string" && Object.hasOwn(RUN_BRIEFS, value);
}
export function applyRunBrief(key: string | null | undefined, goal: string): string {
  if (!key) return goal;
  if (!isRunBriefKey(key)) throw new Error(`Unsupported run brief: ${key}`);
  return `${RUN_BRIEFS[key]}\n\nPerson's request:\n${goal}`;
}
