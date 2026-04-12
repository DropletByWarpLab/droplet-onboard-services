import type {
  CameraInfo,
  ChatRequest,
  ConnectedDevice,
  DetectionEvent,
  DeviceInfo,
  DiscoveredCamera,
  MatterDevice,
  MatterDiscoveredDevice,
  MatterGrouped,
  FileEntryInfo,
  FileVersionInfo,
  TrashItemInfo,
  BulkOperationResult,
  FirewallConfig,
  HealthResponse,
  ModelsResponse,
  NetworkCommandResult,
  NetworkOverview,
  SessionChatRequest,
  SessionDetail,
  SessionInfo,
  StorageStats,
  WirelessScanResult,
  AuthUser,
  ShareInfo,
  ShareDetail,
  ShareCreateOptions,
  ShareUpdateOptions,
  DeviceClientInfo,
  PairingCodeInfo,
  PairingCodeStatus,
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
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Failed to set SSID: ${res.status}`);
  return data;
}

export async function setWifiPassword(password: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Failed to set password: ${res.status}`);
  return data;
}

export async function setWifiChannel(channel: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/channel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Failed to set channel: ${res.status}`);
  return data;
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
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation) throw new Error(data.error || `Failed to block device: ${res.status}`);
  return data;
}

export async function unblockNetworkDevice(mac: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/firewall/unblock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac }),
  });
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation) throw new Error(data.error || `Failed to unblock device: ${res.status}`);
  return data;
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
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation) throw new Error(data.error || `Failed to add port forward: ${res.status}`);
  return data;
}

export async function fetchRouterSystemInfo(): Promise<Record<string, unknown>> {
  const res = await authFetch(`${BASE}/api/network/system`);
  if (!res.ok) throw new Error(`Failed to fetch router system info: ${res.status}`);
  return res.json();
}

export async function confirmNetworkCommand(
  token: string,
  operation: string,
  entityId?: string,
): Promise<void> {
  // WARP-41: echo the operation (and optionally the entity) from the 202
  // response so the orchestrator can reject a token that was issued for a
  // different pending op.
  const res = await authFetch(`${BASE}/api/network/command/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmationToken: token, operation, entityId }),
  });
  if (!res.ok) throw new Error(`Failed to confirm command: ${res.status}`);
}

// --- Cameras / Frigate ---

export async function fetchCameras(): Promise<CameraInfo[]> {
  const res = await authFetch(`${BASE}/api/cameras`);
  if (!res.ok) throw new Error(`Failed to fetch cameras: ${res.status}`);
  const data = await res.json();
  return data.cameras ?? [];
}

export async function fetchCameraDetail(name: string): Promise<CameraInfo & { recentEvents: DetectionEvent[] }> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Failed to fetch camera: ${res.status}`);
  return res.json();
}

export async function fetchCameraEvents(limit = 20, camera?: string): Promise<DetectionEvent[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (camera) params.set("camera", camera);
  const url = camera
    ? `${BASE}/api/cameras/${encodeURIComponent(camera)}/events?${params}`
    : `${BASE}/api/cameras/events/recent?${params}`;
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`Failed to fetch camera events: ${res.status}`);
  const data = await res.json();
  return data.events ?? [];
}

export async function fetchDiscoveredCameras(): Promise<DiscoveredCamera[]> {
  const res = await authFetch(`${BASE}/api/cameras/discovered`);
  if (!res.ok) throw new Error(`Failed to fetch discovered cameras: ${res.status}`);
  return res.json();
}

export async function acceptDiscoveredCamera(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/discovered/${id}/accept`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to accept camera: ${res.status}`);
}

export async function rejectDiscoveredCamera(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/discovered/${id}/reject`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to reject camera: ${res.status}`);
}

export async function enableCamera(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}/enable`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to enable camera: ${res.status}`);
}

export async function disableCamera(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}/disable`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to disable camera: ${res.status}`);
}

export async function removeCamera(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to remove camera: ${res.status}`);
}

export function getCameraSnapshotUrl(name: string): string {
  return `${BASE}/api/cameras/${encodeURIComponent(name)}/snapshot`;
}

export async function addCameraManual(
  name: string,
  rtspUrl: string,
  manufacturer?: string,
  model?: string
): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, rtspUrl, manufacturer, model }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to add camera: ${res.status}`);
  }
}

export async function triggerCameraScan(): Promise<{ status: string; known?: number; pending?: number; message?: string }> {
  const res = await authFetch(`${BASE}/api/cameras/scan`, { method: "POST" });
  if (!res.ok) throw new Error(`Scan failed: ${res.status}`);
  return res.json();
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

// --- File management (Phase 1) — rename / move / copy / bulk / trash / versions ---

export async function renameFile(
  path: string,
  newName: string
): Promise<{ from: string; to: string }> {
  const res = await authFetch(`${BASE}/api/files/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, newName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to rename: ${res.status}`);
  }
  const data = await res.json();
  return data.renamed;
}

export async function moveFile(
  from: string,
  to: string,
  overwrite = false
): Promise<{ from: string; to: string }> {
  const res = await authFetch(`${BASE}/api/files/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, overwrite }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to move: ${res.status}`);
  }
  const data = await res.json();
  return data.moved;
}

export async function copyFile(
  from: string,
  to: string,
  overwrite = false
): Promise<{ from: string; to: string }> {
  const res = await authFetch(`${BASE}/api/files/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, overwrite }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to copy: ${res.status}`);
  }
  const data = await res.json();
  return data.copied;
}

export async function bulkDeleteFiles(
  paths: string[]
): Promise<BulkOperationResult[]> {
  const res = await authFetch(`${BASE}/api/files/bulk-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok && res.status !== 207) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Bulk delete failed: ${res.status}`);
  }
  const data = await res.json();
  return data.results;
}

export async function bulkMoveFiles(
  paths: string[],
  toDir: string,
  overwrite = false
): Promise<BulkOperationResult[]> {
  const res = await authFetch(`${BASE}/api/files/bulk-move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, toDir, overwrite }),
  });
  if (!res.ok && res.status !== 207) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Bulk move failed: ${res.status}`);
  }
  const data = await res.json();
  return data.results;
}

export async function bulkCopyFiles(
  paths: string[],
  toDir: string,
  overwrite = false
): Promise<BulkOperationResult[]> {
  const res = await authFetch(`${BASE}/api/files/bulk-copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, toDir, overwrite }),
  });
  if (!res.ok && res.status !== 207) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Bulk copy failed: ${res.status}`);
  }
  const data = await res.json();
  return data.results;
}

export async function fetchTrash(): Promise<TrashItemInfo[]> {
  const res = await authFetch(`${BASE}/api/files/trash`);
  if (!res.ok) {
    if (res.status === 501) return [];
    throw new Error(`Failed to fetch trash: ${res.status}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

export async function restoreTrashItem(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/trash/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Failed to restore: ${res.status}`);
}

export async function deleteTrashItem(name: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/files/trash/item?name=${encodeURIComponent(name)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Failed to purge trash item: ${res.status}`);
}

export async function emptyTrash(): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/trash`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to empty trash: ${res.status}`);
}

export async function fetchVersions(
  path: string
): Promise<{ fileId: number; versions: FileVersionInfo[] }> {
  const res = await authFetch(
    `${BASE}/api/files/versions?path=${encodeURIComponent(path)}`
  );
  if (!res.ok) {
    if (res.status === 501) return { fileId: 0, versions: [] };
    if (res.status === 404) return { fileId: 0, versions: [] };
    throw new Error(`Failed to fetch versions: ${res.status}`);
  }
  return res.json();
}

export async function restoreVersion(path: string, versionId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/versions/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, versionId }),
  });
  if (!res.ok) throw new Error(`Failed to restore version: ${res.status}`);
}

// --- Phase 2: favorites / recents / search / thumbnails / shares v2 ---

export async function toggleFavorite(path: string, favorite: boolean): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/favorite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, favorite }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update favorite: ${res.status}`);
  }
}

export async function fetchFavorites(): Promise<FileEntryInfo[]> {
  const res = await authFetch(`${BASE}/api/files/favorites`);
  if (!res.ok) throw new Error(`Failed to fetch favorites: ${res.status}`);
  const data = await res.json();
  return data.items ?? [];
}

export async function fetchRecents(limit = 50): Promise<FileEntryInfo[]> {
  const res = await authFetch(`${BASE}/api/files/recents?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch recents: ${res.status}`);
  const data = await res.json();
  return data.items ?? [];
}

export async function searchFiles(
  query: string,
  opts: { mime?: string; limit?: number } = {}
): Promise<FileEntryInfo[]> {
  const params = new URLSearchParams({ q: query });
  if (opts.mime) params.set("mime", opts.mime);
  if (opts.limit) params.set("limit", String(opts.limit));
  const res = await authFetch(`${BASE}/api/files/search?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Search failed: ${res.status}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

/** Build a thumbnail URL for <img src=...>. The orchestrator streams bytes + caches. */
export function getThumbnailUrl(path: string, x = 256, y = 256): string {
  return `${BASE}/api/files/thumbnail?path=${encodeURIComponent(path)}&x=${x}&y=${y}`;
}

export async function createShare(
  path: string,
  opts: ShareCreateOptions = { shareType: 3 }
): Promise<ShareDetail> {
  const res = await authFetch(`${BASE}/api/files/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, ...opts }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Share failed: ${res.status}`);
  }
  return res.json();
}

export async function updateShare(
  shareId: number,
  opts: ShareUpdateOptions
): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/share/${shareId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Share update failed: ${res.status}`);
  }
}

export async function deleteShare(shareId: number): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/share/${shareId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Share delete failed: ${res.status}`);
}

export async function fetchSharedWithMe(): Promise<ShareDetail[]> {
  const res = await authFetch(`${BASE}/api/files/shared-with-me`);
  if (!res.ok) throw new Error(`Failed to fetch shared-with-me: ${res.status}`);
  const data = await res.json();
  return data.shares ?? [];
}

// --- Phase 4: Semantic content search ---

export interface SemanticSearchResult {
  path: string;
  score: number;
  text: string;
}

export async function searchFileContent(
  query: string,
  limit = 20
): Promise<SemanticSearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await authFetch(`${BASE}/api/files/search/content?${params}`);
  if (!res.ok) {
    if (res.status === 503) return []; // AI gateway down — graceful degrade
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Semantic search failed: ${res.status}`);
  }
  const data = await res.json();
  return data.results ?? [];
}

// --- Phase 3: device clients + pairing + user admin ---

export async function createPairingCode(data: {
  deviceName: string;
  deviceType: "desktop" | "mobile";
  platform: "macos" | "windows" | "linux" | "ios" | "android" | "other";
}): Promise<PairingCodeInfo> {
  const res = await authFetch(`${BASE}/api/devices/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to generate pairing code: ${res.status}`);
  }
  return res.json();
}

export async function getPairingCodeStatus(code: string): Promise<PairingCodeStatus> {
  const res = await authFetch(`${BASE}/api/devices/pair/${code}/status`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Status lookup failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchDeviceClients(): Promise<DeviceClientInfo[]> {
  const res = await authFetch(`${BASE}/api/devices/clients`);
  if (!res.ok) throw new Error(`Failed to fetch device clients: ${res.status}`);
  const data = await res.json();
  return data.clients ?? [];
}

export async function revokeDeviceClient(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/devices/clients/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to revoke device: ${res.status}`);
  }
}

export async function updateUser(
  username: string,
  data: {
    displayName?: string;
    email?: string;
    quota?: string;
    password?: string;
  }
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/users/${username}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update user: ${res.status}`);
  }
}

export async function setUserEnabled(username: string, enabled: boolean): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const res = await authFetch(`${BASE}/api/auth/users/${username}/${action}`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to ${action} user: ${res.status}`);
  }
}

