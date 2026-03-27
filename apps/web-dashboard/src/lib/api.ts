import type {
  ChatRequest,
  DeviceInfo,
  FileEntryInfo,
  HealthResponse,
  ModelsResponse,
  SyncTargetInfo,
} from "./types";

const BASE = "";

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${BASE}/api/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

export async function fetchDevices(): Promise<DeviceInfo[]> {
  const res = await fetch(`${BASE}/api/devices`);
  if (!res.ok) throw new Error(`Failed to fetch devices: ${res.status}`);
  return res.json();
}

export async function fetchModels(): Promise<ModelsResponse> {
  const res = await fetch(`${BASE}/api/llm/models`);
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
  return res.json();
}

export async function sendChat(request: ChatRequest): Promise<Response> {
  return fetch(`${BASE}/api/llm/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
}

export async function saveProviderKey(
  provider: string,
  apiKey: string
): Promise<void> {
  const res = await fetch(`${BASE}/api/llm/keys/${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to save key: ${body}`);
  }
}

export async function listProviderKeys(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/llm/keys`);
  if (!res.ok) throw new Error(`Failed to list keys: ${res.status}`);
  const data = await res.json();
  return data.providers;
}

export async function deleteProviderKey(provider: string): Promise<void> {
  const res = await fetch(`${BASE}/api/llm/keys/${provider}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete key: ${res.status}`);
}

// --- File operations ---

export async function fetchFiles(path: string): Promise<FileEntryInfo[]> {
  const res = await fetch(`${BASE}/api/files?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.status}`);
  return res.json();
}

export function getDownloadUrl(path: string): string {
  return `${BASE}/api/files/download?path=${encodeURIComponent(path)}`;
}

export async function uploadFiles(
  path: string,
  files: FileList | File[]
): Promise<void> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  const res = await fetch(
    `${BASE}/api/files/upload?path=${encodeURIComponent(path)}`,
    { method: "POST", body: formData }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed: ${body}`);
  }
}

export async function deleteFile(path: string): Promise<void> {
  const res = await fetch(
    `${BASE}/api/files?path=${encodeURIComponent(path)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function createDirectory(path: string): Promise<void> {
  const res = await fetch(`${BASE}/api/files/mkdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`Failed to create directory: ${res.status}`);
}

// --- Sync targets ---

export async function fetchSyncTargets(): Promise<SyncTargetInfo[]> {
  const res = await fetch(`${BASE}/api/sync/targets`);
  if (!res.ok) throw new Error(`Failed to fetch sync targets: ${res.status}`);
  return res.json();
}

export async function createSyncTarget(data: {
  path: string;
  label: string;
  intervalMin: number;
}): Promise<SyncTargetInfo> {
  const res = await fetch(`${BASE}/api/sync/targets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to create sync target: ${res.status}`);
  return res.json();
}

export async function updateSyncTarget(
  id: string,
  data: Partial<{ label: string; intervalMin: number; enabled: boolean }>
): Promise<SyncTargetInfo> {
  const res = await fetch(`${BASE}/api/sync/targets/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to update sync target: ${res.status}`);
  return res.json();
}

export async function deleteSyncTarget(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/sync/targets/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete sync target: ${res.status}`);
}

export async function triggerSync(targetId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/sync/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId }),
  });
  if (!res.ok) throw new Error(`Failed to trigger sync: ${res.status}`);
}
