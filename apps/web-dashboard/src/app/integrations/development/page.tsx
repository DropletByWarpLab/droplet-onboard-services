"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GitBranch, RefreshCw, Trash2 } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Sect } from "@/components/shell/primitives";
import { authFetch } from "@/lib/auth";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

type Provider = "github" | "gitlab";
type Project = { id: string; name: string; identifier: string };
type State = { id: string; name: string; group: string };
type AvailableRepo = { externalId: string; apiRef: string; fullName: string; webUrl: string; defaultBranch: string | null };
type ConfiguredRepo = {
  id: string; provider: "GITHUB" | "GITLAB"; fullName: string; webUrl: string; defaultBranch: string | null;
  status: string; lastSyncedAt: string | null; lastAttemptAt: string | null; nextSyncAt: string;
  lastError: string | null; consecutiveFailures: number;
  projects: Array<{ projectId: string; onOpenedStateId: string | null; onMergedStateId: string | null; project: Project }>;
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
  return body as T;
}

export default function DevelopmentSettingsPage() {
  const [provider, setProvider] = useState<Provider>("github");
  const [available, setAvailable] = useState<AvailableRepo[]>([]);
  const [configured, setConfigured] = useState<ConfiguredRepo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectForNew, setProjectForNew] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshConfigured = useCallback(async () => {
    const [repoResult, projectResult] = await Promise.all([
      json<{ repositories: ConfiguredRepo[] }>("/api/pm/development/repositories"),
      json<{ projects: Array<Project & { kind?: string }> }>("/api/pm/projects"),
    ]);
    setConfigured(repoResult.repositories);
    setProjects(projectResult.projects.filter((project) => project.kind !== "SERVICE_DESK"));
  }, []);

  useEffect(() => { void refreshConfigured().catch((err) => setError(err instanceof Error ? err.message : "Could not load development settings.")); }, [refreshConfigured]);

  const discover = async () => {
    setLoading(true); setError(null); setNotice(null);
    try {
      const result = await json<{ items: AvailableRepo[]; truncated: boolean }>(`/api/pm/development/repositories/${provider}/available`);
      setAvailable(result.items);
      if (result.truncated) setNotice("The code host capped this repository list. Only the returned repositories are shown; narrow the token's repository access to discover a different set.");
      else if (!result.items.length) setNotice("No repositories were returned for this integration.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not discover repositories."); }
    finally { setLoading(false); }
  };

  const addRepo = async (repo: AvailableRepo) => {
    if (!projectForNew) { setError("Choose a project before adding a repository."); return; }
    setSaving(repo.externalId); setError(null); setNotice(null);
    try {
      await json(`/api/pm/development/repositories/${provider}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalId: repo.externalId, apiRef: repo.apiRef, projectIds: [projectForNew] }),
      });
      setNotice(`${repo.fullName} is mapped and will sync automatically.`);
      await refreshConfigured();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not add repository."); }
    finally { setSaving(null); }
  };

  const addMapping = async (repositoryId: string, projectId: string) => {
    setSaving(`${repositoryId}:${projectId}`); setError(null);
    try {
      await json(`/api/pm/development/repositories/${repositoryId}/projects`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }),
      });
      await refreshConfigured();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not map project."); }
    finally { setSaving(null); }
  };

  const remove = async (repoId: string, projectId?: string) => {
    setSaving(repoId); setError(null);
    try {
      const path = projectId
        ? `/api/pm/development/repositories/${repoId}/projects/${projectId}`
        : `/api/pm/development/repositories/${repoId}`;
      const response = await authFetch(path, { method: "DELETE" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      await refreshConfigured();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not remove mapping."); }
    finally { setSaving(null); }
  };

  return (
    <ShellPage icon={<GitBranch size={15} />} label="Integrations" title="Development links" sub="Choose code repositories and map them to Projects.">
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <label className="type-footnote" htmlFor="development-provider">Code host</label>
        <ThemedSelect id="development-provider" className="input" value={provider} disabled={loading || saving !== null} onChange={(event) => { setProvider(event.target.value as Provider); setAvailable([]); }}>
          <option value="github">GitHub</option><option value="gitlab">GitLab</option>
        </ThemedSelect>
        <button type="button" className="btn secondary" onClick={() => void discover()} disabled={loading}>
          <RefreshCw size={14} aria-hidden /> {loading ? "Discovering…" : "Discover repositories"}
        </button>
        <Link href="/integrations" className="type-footnote">Manage integration credentials</Link>
      </div>
      {error && <div className="card" role="alert" style={{ marginTop: 12, color: "var(--danger-ink)" }}>{error}</div>}
      {notice && <div className="card" role="status" style={{ marginTop: 12 }}>{notice}</div>}

      {available.length > 0 && <>
        <Sect title="Available repositories" />
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label htmlFor="new-repository-project" className="type-footnote">Map new repositories to</label>
          <ThemedSelect id="new-repository-project" className="input" value={projectForNew} onChange={(event) => setProjectForNew(event.target.value)}>
            <option value="">Choose a project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.identifier} · {project.name}</option>)}
          </ThemedSelect>
        </div>
        <div className="card" style={{ marginTop: 8 }}>
          {available.map((repo) => <div key={repo.externalId} className="lrow" style={{ gap: 10 }}>
            <span className="rt"><span className="nm">{repo.fullName}</span><span className="sub">{repo.defaultBranch ? `Default branch: ${repo.defaultBranch}` : "Default branch not reported"}</span></span>
            <button type="button" className="btn secondary" disabled={!projectForNew || saving === repo.externalId} onClick={() => void addRepo(repo)}>{saving === repo.externalId ? "Adding…" : "Add"}</button>
          </div>)}
        </div>
      </>}

      <Sect title="Configured repositories" />
      {configured.length === 0 ? <div className="card type-footnote">No repositories configured yet.</div> : (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {configured.map((repo) => <RepositoryCard key={repo.id} repo={repo} projects={projects} saving={saving} onAdd={addMapping} onRemove={remove} />)}
        </div>
      )}
    </ShellPage>
  );
}

function RepositoryCard({
  repo, projects, saving, onAdd, onRemove,
}: {
  repo: ConfiguredRepo; projects: Project[]; saving: string | null;
  onAdd: (repositoryId: string, projectId: string) => Promise<void>;
  onRemove: (repositoryId: string, projectId?: string) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState("");
  const unmapped = projects.filter((project) => !repo.projects.some((mapping) => mapping.projectId === project.id));
  return <section style={{ borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
    <div className="pm-row" style={{ justifyContent: "space-between", gap: 12 }}>
      <div><strong>{repo.fullName}</strong><div className="type-footnote">{repo.provider} · {repo.status.replaceAll("_", " ")}{repo.lastSyncedAt ? ` · synced ${new Date(repo.lastSyncedAt).toLocaleString()}` : " · never synced"}</div>
        {repo.lastError && <div role="status" className="type-footnote" style={{ color: "var(--danger-ink)", marginTop: 3 }}>{repo.lastError}</div>}
      </div>
      <a href={repo.webUrl} target="_blank" rel="noopener noreferrer" className="type-footnote">Open repository</a>
    </div>
    <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 6 }}>
      {repo.projects.map((mapping) => <ProjectMapping key={mapping.projectId} repositoryId={repo.id} mapping={mapping} saving={saving} onRemove={onRemove} />)}
    </div>
    {unmapped.length > 0 && <div className="pm-row" style={{ gap: 8, marginTop: 9 }}>
      <ThemedSelect className="input" aria-label={`Add project mapping for ${repo.fullName}`} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        <option value="">Add project mapping</option>{unmapped.map((project) => <option key={project.id} value={project.id}>{project.identifier} · {project.name}</option>)}
      </ThemedSelect>
      <button type="button" className="btn secondary" disabled={!projectId || saving === `${repo.id}:${projectId}`} onClick={() => void onAdd(repo.id, projectId)}>Map</button>
    </div>}
    <button type="button" className="pm-btn ghost sm" style={{ marginTop: 8 }} disabled={saving === repo.id} onClick={() => void onRemove(repo.id)}>Disconnect repository</button>
  </section>;
}

function ProjectMapping({
  repositoryId, mapping, saving, onRemove,
}: {
  repositoryId: string;
  mapping: ConfiguredRepo["projects"][number];
  saving: string | null;
  onRemove: (repositoryId: string, projectId?: string) => Promise<void>;
}) {
  const [states, setStates] = useState<State[]>([]);
  const [opened, setOpened] = useState(mapping.onOpenedStateId ?? "");
  const [merged, setMerged] = useState(mapping.onMergedStateId ?? "");
  const [saved, setSaved] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void json<{ states: State[] }>(`/api/pm/projects/${mapping.projectId}/states`)
      .then((result) => { if (active) setStates(result.states); })
      .catch(() => { if (active) setStates([]); });
    return () => { active = false; };
  }, [mapping.projectId]);
  const saveRules = async () => {
    setSaved(false); setSaveError(null);
    try {
      await json(`/api/pm/development/repositories/${repositoryId}/projects`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: mapping.projectId, onOpenedStateId: opened || null, onMergedStateId: merged || null }),
      });
      setSaved(true);
    } catch (err) { setSaved(false); setSaveError(err instanceof Error ? err.message : "Could not save state rules."); }
  };
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(130px, 100%), 1fr))", gap: 8, alignItems: "center" }}>
    <span className="type-footnote">{mapping.project.identifier} · {mapping.project.name}</span>
    <ThemedSelect className="input" aria-label={`${mapping.project.name} state when pull request opens`} value={opened} onChange={(event) => { setOpened(event.target.value); setSaved(false); }}>
      <option value="">On opened: no change</option>{states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
    </ThemedSelect>
    <ThemedSelect className="input" aria-label={`${mapping.project.name} state when pull request merges`} value={merged} onChange={(event) => { setMerged(event.target.value); setSaved(false); }}>
      <option value="">On merged: no change</option>{states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
    </ThemedSelect>
    <span className="pm-row" style={{ gap: 4 }}>
      <button type="button" className="pm-btn ghost sm" disabled={saved || saving === repositoryId} onClick={() => void saveRules()}>Save rules</button>
      <button type="button" className="pm-iconbtn" disabled={saving === repositoryId} onClick={() => void onRemove(repositoryId, mapping.projectId)} aria-label={`Remove ${mapping.project.name} mapping`}><Trash2 size={14} /></button>
    </span>
    {saveError && <span role="alert" className="type-footnote" style={{ color: "var(--danger-ink)", gridColumn: "2 / 4" }}>{saveError}</span>}
  </div>;
}
