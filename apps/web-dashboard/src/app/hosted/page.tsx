"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import useSWRInfinite from "swr/infinite";
import { AppWindow, Plus, ScrollText } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/access";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Card, Row } from "@/components/shell/primitives";
import { NewToolDialog } from "@/components/workshop/NewToolDialog";
import { HostedAppOpen } from "@/components/hosted/AppActions";
import { AppLogsDialog } from "@/components/hosted/AppLogsDialog";
import { fetchHostedApps, hostedErrorCopy, type HostedApps } from "@/components/hosted/api";
import { STATUS_BADGE } from "@/components/admin/extensions/copy";
import "@/components/workshop/workshop.css";

const SUB = "Web apps that run on your Droplet. Open an app you have access to, or bring your own code.";
export default function HostedPage() {
  const { user } = useAuth();
  return <HostedPageContent key={JSON.stringify([user?.id, user?.role])} />;
}

function HostedPageContent() {
  const { user, isLoading } = useAuth();
  const manager = isAdminRole(user?.role);
  const allowed = manager || user?.role === "family";
  const router = useRouter();
  const apps = useSWRInfinite<HostedApps>((index, previous: HostedApps | null) => {
    if (isLoading || !allowed || (previous && !previous.nextCursor)) return null;
    return ["/api/hosted", index === 0 ? "" : previous?.nextCursor ?? ""];
  }, ([, cursor]: [string, string]) => fetchHostedApps(cursor ? { cursor } : {}), { refreshInterval: 10_000 });
  const pages = apps.data ?? [];
  const supervisionEnabled = pages[0]?.supervisionEnabled === true;
  const nextCursor = pages[pages.length - 1]?.nextCursor;
  const [creating, setCreating] = useState(false);
  const [logSlug, setLogSlug] = useState<string | null>(null);
  const newTrigger = useRef<HTMLButtonElement>(null);
  const logsTrigger = useRef<HTMLElement | null>(null);
  const shown = pages.flatMap((page) => page.apps).filter((app) => manager || app.grants.includes("family"));
  return <ShellPage icon={<AppWindow size={15} />} label="Apps" title="Apps" sub={SUB} actions={manager && !isLoading ? <>
    <Link href="/admin/extensions" className="btn">Review and manage</Link>
    <button ref={newTrigger} type="button" className="btn primary" disabled={!supervisionEnabled} onClick={() => setCreating(true)}><Plus size={14} aria-hidden /> New app</button>
  </> : undefined}>
    {isLoading ? <Card><p className="sub" role="status">Loading…</p></Card> : !allowed ? <Card><p className="sub" role="status">Apps are available to owners, admins and members with access. Ask the owner if you need an app.</p></Card> : <>
      {pages[0]?.supervisionEnabled === false && <Card><p className="sub" role="status">Apps are turned off on this Droplet. Ask the owner to enable them.</p></Card>}
      {apps.error && <Card>
        <p className="sub" role="alert">Couldn&apos;t load the apps. {hostedErrorCopy(apps.error)}</p><button type="button" className="btn" onClick={() => void apps.mutate()}>Try again</button>
      </Card>}
      {apps.isLoading ? <Card><p className="sub" role="status">Loading apps…</p></Card> : !apps.error && shown.length === 0 ? <Card><div className="empty"><AppWindow size={24} aria-hidden /><span className="eh">No apps yet</span>
        <span>{manager ? "Create an app workspace from a template, an archive, or code you push. The owner reviews it before it runs." : "Apps shared with members appear here once the owner makes them available."}</span>
      </div></Card> : <Card><div className="rows">{shown.map((app) => <Row key={app.id} icon={<AppWindow size={15} />} iconBrand title={app.name || app.slug}
        sub={`${app.version ? `Version ${app.version} · ` : ""}${app.memoryMb ? `${app.memoryMb} MB budget` : "Static files"}${app.lastHealthAt ? ` · Last checked ${new Date(app.lastHealthAt).toLocaleString()}` : " · Not checked yet"}`}
        right={<span className="flex flex-wrap items-center gap-2"><Badge kind={STATUS_BADGE[app.status].kind}>{app.status === "installed" ? "Starting" : STATUS_BADGE[app.status].label}</Badge>
          <HostedAppOpen slug={app.slug} disabled={!supervisionEnabled || app.status !== "live"} />
          {manager && <button type="button" className="btn sm" aria-label={`Logs for ${app.slug}`} onClick={(e) => { logsTrigger.current = e.currentTarget; setLogSlug(app.slug); }}><ScrollText size={13} aria-hidden /> Logs</button>}
        </span>} />)}</div></Card>}
      {nextCursor && <button type="button" className="btn" disabled={apps.isValidating} aria-busy={apps.isValidating}
        onClick={() => void apps.setSize((size) => size + 1)}>{apps.isValidating ? "Loading…" : "Load more apps"}</button>}
      {manager && <NewToolDialog open={creating} initialKind="app" onClose={() => setCreating(false)} triggerRef={newTrigger}
        onCreated={(workspace) => router.push(`/workshop?workspace=${encodeURIComponent(workspace.id)}${workspace.kind === "app" ? "&kind=app" : ""}`)} />}
      {manager && <AppLogsDialog slug={logSlug} onClose={() => setLogSlug(null)} triggerRef={logsTrigger} />}
    </>}
  </ShellPage>;
}
