import type {
  ChatRequest,
  ConnectedDevice,
  DeviceInfo,
  MatterDevice,
  MatterDiscoveredDevice,
  MatterGrouped,
  FileEntryInfo,
  FirewallConfig,
  HealthResponse,
  ModelsResponse,
  NetworkCommandResult,
  NetworkOverview,
  SessionChatRequest,
  SessionDetail,
  SessionInfo,
  StorageStats,
  SyncTargetInfo,
  WirelessScanResult,
  AuthUser,
  ShareInfo,
} from "./types";
import { authFetch } from "./auth";

const BASE = "";

// --- Auth ---

export async function checkSetupRequired(): Promise<boolean> {
  const res = await authFetch(`${BASE}/api/auth/setup`);
  if (!res.ok) return true;
  const data = await res.json();
  return data.setupRequired;
}

export async function setupAdmin(
  username: string,
  password: string,
  displayName?: string
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, displayName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Setup failed");
  }
}

export async function loginUser(
  username: string,
  password: string
): Promise<{ user: AuthUser }> {
  const res = await authFetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Login failed");
  }
  return res.json();
}

export async function fetchMe(): Promise<AuthUser> {
  const res = await authFetch(`${BASE}/api/auth/me`);
  if (!res.ok) throw new Error("Not authenticated");
  return res.json();
}

export async function fetchUsers(): Promise<{ users: AuthUser[] }> {
  const res = await authFetch(`${BASE}/api/auth/users`);
  if (!res.ok) throw new Error(`Failed to fetch users: ${res.status}`);
  return res.json();
}

export async function createUser(
  username: string,
  password: string,
  displayName?: string
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, displayName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to create user");
  }
}

export async function deleteUser(username: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/users/${username}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete user: ${res.status}`);
}

// --- Storage ---

export async function fetchStorage(): Promise<StorageStats> {
  const res = await authFetch(`${BASE}/api/storage`);
  if (!res.ok) throw new Error(`Failed to fetch storage: ${res.status}`);
  return res.json();
}

// --- Health ---

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await authFetch(`${BASE}/api/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

export async function fetchDevices(): Promise<DeviceInfo[]> {
  const res = await authFetch(`${BASE}/api/devices`);
  if (!res.ok) throw new Error(`Failed to fetch devices: ${res.status}`);
  return res.json();
}

// --- Network / Router ---

export async function fetchNetworkStatus(): Promise<NetworkOverview> {
  const res = await authFetch(`${BASE}/api/network/status`);
  if (!res.ok) throw new Error(`Failed to fetch network status: ${res.status}`);
  return res.json();
}

export async function fetchConnectedDevices(): Promise<ConnectedDevice[]> {
  const res = await authFetch(`${BASE}/api/network/devices`);
  if (!res.ok) throw new Error(`Failed to fetch connected devices: ${res.status}`);
  const data = await res.json();
  return data.devices;
}

export async function fetchWifiSettings(): Promise<Record<string, unknown>> {
  const res = await authFetch(`${BASE}/api/network/wifi`);
  if (!res.ok) throw new Error(`Failed to fetch wifi settings: ${res.status}`);
  return res.json();
}

export async function scanWifiNetworks(): Promise<WirelessScanResult[]> {
  const res = await authFetch(`${BASE}/api/network/wifi/scan`);
  if (!res.ok) throw new Error(`Failed to scan wifi: ${res.status}`);
  const data = await res.json();
  return data.results;
}

export async function setWifiSsid(ssid: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/ssid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid }),
  });
  return res.json();
}

export async function setWifiPassword(password: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return res.json();
}

export async function setWifiChannel(channel: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/channel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel }),
  });
  return res.json();
}

export async function fetchDhcpLeases(): Promise<Record<string, unknown>[]> {
  const res = await authFetch(`${BASE}/api/network/dhcp/leases`);
  if (!res.ok) throw new Error(`Failed to fetch DHCP leases: ${res.status}`);
  const data = await res.json();
  return data.leases;
}

export async function fetchFirewallConfig(): Promise<FirewallConfig> {
  const res = await authFetch(`${BASE}/api/network/firewall`);
  if (!res.ok) throw new Error(`Failed to fetch firewall config: ${res.status}`);
  return res.json();
}

export async function blockNetworkDevice(mac: string, name?: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/firewall/block`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac, name }),
  });
  return res.json();
}

export async function unblockNetworkDevice(mac: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/firewall/unblock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac }),
  });
  return res.json();
}

export async function addNetworkPortForward(
  name: string,
  srcPort: string,
  destIp: string,
  destPort: string,
  proto: string = "tcp"
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/firewall/port-forward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, src_port: srcPort, dest_ip: destIp, dest_port: destPort, proto }),
  });
  return res.json();
}

export async function fetchRouterSystemInfo(): Promise<Record<string, unknown>> {
  const res = await authFetch(`${BASE}/api/network/system`);
  if (!res.ok) throw new Error(`Failed to fetch router system info: ${res.status}`);
  return res.json();
}

export async function confirmNetworkCommand(token: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/network/command/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmationToken: token }),
  });
  if (!res.ok) throw new Error(`Failed to confirm command: ${res.status}`);
}

// --- Matter Devices ---

export async function fetchMatterDevices(): Promise<MatterGrouped> {
  const res = await authFetch(`${BASE}/api/matter/devices`);
  if (!res.ok) throw new Error(`Failed to fetch Matter devices: ${res.status}`);
  return res.json();
}

export async function fetchMatterDevice(nodeId: string): Promise<MatterDevice> {
  const res = await authFetch(`${BASE}/api/matter/devices/${nodeId}`);
  if (!res.ok) throw new Error(`Failed to fetch device: ${res.status}`);
  return res.json();
}

export async function sendMatterCommand(
  nodeId: string,
  command: string,
  data?: Record<string, unknown>
): Promise<unknown> {
  const res = await authFetch(
    `${BASE}/api/matter/devices/${nodeId}/command`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, data }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to send command: ${res.status}`);
  }
  return res.json();
}

export async function discoverMatterDevices(): Promise<{ devices: MatterDiscoveredDevice[]; count: number }> {
  const res = await authFetch(`${BASE}/api/matter/discover`);
  if (!res.ok) throw new Error(`Failed to discover devices: ${res.status}`);
  return res.json();
}

export async function commissionMatterDevice(pairingCode: string): Promise<{ nodeId: string }> {
  const res = await authFetch(`${BASE}/api/matter/commission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairing_code: pairingCode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to commission device: ${res.status}`);
  }
  return res.json();
}

export async function decommissionMatterDevice(nodeId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/matter/devices/${nodeId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to decommission device: ${res.status}`);
}

// --- Models ---

export async function fetchModels(): Promise<ModelsResponse> {
  const res = await authFetch(`${BASE}/api/llm/models`);
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
  return res.json();
}

export async function sendChat(request: ChatRequest): Promise<Response> {
  return authFetch(`${BASE}/api/llm/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
}

// --- Provider keys ---

export async function saveProviderKey(
  provider: string,
  apiKey: string
): Promise<void> {
  const res = await authFetch(`${BASE}/api/llm/keys/${provider}`, {
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
  const res = await authFetch(`${BASE}/api/llm/keys`);
  if (!res.ok) throw new Error(`Failed to list keys: ${res.status}`);
  const data = await res.json();
  return data.providers;
}

export async function deleteProviderKey(provider: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/llm/keys/${provider}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete key: ${res.status}`);
}

// --- Sessions ---

export async function createSession(body: {
  model: string;
  title?: string;
  system_prompt?: string | null;
}): Promise<SessionInfo> {
  const res = await authFetch(`${BASE}/api/llm/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  return res.json();
}

export async function listSessions(
  limit = 50,
  offset = 0
): Promise<{ sessions: SessionInfo[] }> {
  const res = await authFetch(
    `${BASE}/api/llm/sessions?limit=${limit}&offset=${offset}`
  );
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
  return res.json();
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  const res = await authFetch(`${BASE}/api/llm/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`Failed to get session: ${res.status}`);
  return res.json();
}

export async function updateSessionTitle(
  sessionId: string,
  title: string
): Promise<SessionInfo> {
  const res = await authFetch(`${BASE}/api/llm/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to update session: ${res.status}`);
  return res.json();
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/llm/sessions/${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`);
}

export async function sendSessionChat(
  sessionId: string,
  request: SessionChatRequest
): Promise<Response> {
  return authFetch(`${BASE}/api/llm/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
}

// --- File operations ---

export async function fetchFiles(path: string): Promise<FileEntryInfo[]> {
  const res = await authFetch(`${BASE}/api/files?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.status}`);
  return res.json();
}

export function getDownloadUrl(path: string): string {
  return `${BASE}/api/files/download?path=${encodeURIComponent(path)}`;
}

export async function uploadFiles(
  path: string,
  files: FileList | File[],
  onProgress?: (percent: number) => void
): Promise<void> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }

  if (onProgress) {
    // Use XMLHttpRequest for progress events
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE}/api/files/upload?path=${encodeURIComponent(path)}`);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed: ${xhr.responseText}`));
        }
      };

      xhr.onerror = () => reject(new Error("Upload failed: network error"));
      xhr.send(formData);
    });
  }

  const res = await authFetch(
    `${BASE}/api/files/upload?path=${encodeURIComponent(path)}`,
    { method: "POST", body: formData }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed: ${body}`);
  }
}

export async function deleteFile(path: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/files?path=${encodeURIComponent(path)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function createDirectory(path: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/mkdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`Failed to create directory: ${res.status}`);
}

export async function createShareLink(path: string): Promise<ShareInfo> {
  const res = await authFetch(`${BASE}/api/files/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`Failed to create share: ${res.status}`);
  return res.json();
}

export async function fetchShares(path: string): Promise<ShareInfo[]> {
  const res = await authFetch(`${BASE}/api/files/shares?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch shares: ${res.status}`);
  const data = await res.json();
  return data.shares;
}

// --- Sync targets ---

export async function fetchSyncTargets(): Promise<SyncTargetInfo[]> {
  const res = await authFetch(`${BASE}/api/sync/targets`);
  if (!res.ok) throw new Error(`Failed to fetch sync targets: ${res.status}`);
  return res.json();
}

export async function createSyncTarget(data: {
  path: string;
  label: string;
  intervalMin: number;
}): Promise<SyncTargetInfo> {
  const res = await authFetch(`${BASE}/api/sync/targets`, {
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
  const res = await authFetch(`${BASE}/api/sync/targets/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to update sync target: ${res.status}`);
  return res.json();
}

export async function deleteSyncTarget(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/sync/targets/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete sync target: ${res.status}`);
}

export async function triggerSync(targetId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/sync/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId }),
  });
  if (!res.ok) throw new Error(`Failed to trigger sync: ${res.status}`);
}
