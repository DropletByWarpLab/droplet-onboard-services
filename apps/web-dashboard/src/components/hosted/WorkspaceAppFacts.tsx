"use client";
import useSWR from "swr";
import { HostedAppOpen, HostedAppSetup } from "./AppActions";
import { fetchHostedApps, hostedErrorCopy } from "./api";
import type { WorkspaceDetail } from "@/components/workshop/workspaces/api";
import { useAuth } from "@/lib/auth";

export function WorkspaceAppFacts({ detail, working }: { detail: WorkspaceDetail; working: boolean }) {
  const { user } = useAuth();
  const ownsWorkspace = user?.id === detail.userId;
  const hosted = useSWR(`/api/hosted?workspaceId=${encodeURIComponent(detail.id)}`, () => fetchHostedApps({ workspaceId: detail.id }), { refreshInterval: 10_000 });
  const app = detail.app && !("error" in detail.app) ? detail.app : null;
  const installed = hosted.data?.apps.find((item) => item.workspaceId === detail.id);
  return <section className="ws-sect" aria-label="App details">
    <h3 className="ws-sect-h">App</h3>
    {app ? <dl className="ws-facts"><dt>Runtime</dt><dd>{app.runtime === "static" ? "Static files" : app.runtime === "node20" ? "Node 20" : "Python 3.12"}</dd>
      <dt>Budget</dt><dd>{app.memoryMb} MB</dd><dt>Health check</dt><dd><code>{app.http.health}</code></dd>
      <dt>Network</dt><dd>{app.egress}</dd></dl> : <p className="ws-note">The assistant will check the app&apos;s files and prepare its manifest.</p>}
    {installed && <dl className="ws-facts"><dt>Status</dt><dd>{installed.status}</dd><dt>Address</dt><dd><code>{installed.url}</code></dd>
      <dt>Last check</dt><dd>{installed.lastHealthAt ? new Date(installed.lastHealthAt).toLocaleString() : "Not checked yet"}</dd></dl>}
    {hosted.isLoading ? <p className="ws-note" role="status">Checking apps…</p> : hosted.error ? <p className="ws-note" role="alert">{hostedErrorCopy(hosted.error)}</p> :
      hosted.data?.supervisionEnabled === false ? <p className="ws-note" role="status">Apps are turned off on this Droplet.</p> : null}
    <div className="flex flex-wrap gap-2 mt-3">
      {ownsWorkspace && <HostedAppSetup key={detail.id} workspaceId={detail.id} name={detail.name} disabled={working || hosted.data?.supervisionEnabled !== true} />}
      {installed?.status === "live" && <HostedAppOpen key={installed.slug} slug={installed.slug} disabled={hosted.data?.supervisionEnabled !== true} />}
    </div>
    {!ownsWorkspace && <p className="ws-note">The person who created this workspace can start setup with the assistant.</p>}
    <p className="ws-note">Follow setup in the chat. When it proposes a version, the owner reviews it in <a href="/admin/extensions">Extensions</a>.</p>
  </section>;
}
