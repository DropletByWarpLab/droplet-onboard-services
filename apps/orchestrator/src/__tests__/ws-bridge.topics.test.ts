/**
 * WARP-493 — ws-bridge per-user topic set.
 *
 * brain_ingest / transcription_worker publish brain status flips to
 * `droplet/files/<BrainMemoryItem.userId>/brain/indexed`, and post-493
 * that key is the local `User.id` UUID. The bridge historically
 * subscribed only under `req.user.username` (which still keys the
 * nextcloud-watcher publishes), so it must ADDITIONALLY subscribe
 * `droplet/files/<user.id>/#` — otherwise live status chips silently
 * degrade to polling after the cutover.
 *
 * `validateTokenForWs` and `subscribeToTopic` are both mocked so we can
 * stamp the production identity shape (id UUID ≠ username) and capture
 * the exact subscription set without a broker.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";

const validateMock = vi.fn();
vi.mock("../middleware/auth.js", () => ({
  SESSION_COOKIE_NAME: "droplet_session",
  validateTokenForWs: (...args: unknown[]) => validateMock(...args),
}));

const subscribedTopics: string[] = [];
vi.mock("../services/mqtt.service.js", () => ({
  subscribeToTopic: (topic: string) => {
    subscribedTopics.push(topic);
    return () => {};
  },
}));

import { attachWsBridge } from "../services/ws-bridge.service.js";

async function connectOnce(user: {
  id: string;
  username: string;
}): Promise<string[]> {
  subscribedTopics.length = 0;
  validateMock.mockResolvedValue({
    ...user,
    displayName: user.username,
    role: "owner",
  });

  const server: HttpServer = createServer();
  attachWsBridge(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");

  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/ws/events`);
  await once(ws, "open");
  // Let the connection handler finish registering subscriptions.
  await new Promise((r) => setImmediate(r));
  const topics = [...subscribedTopics];
  ws.close();
  await once(ws, "close");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return topics;
}

afterEach(() => {
  validateMock.mockReset();
});

describe("ws-bridge subscription topics (WARP-493)", () => {
  it("subscribes droplet/files/<user.id>/# IN ADDITION to the username set", async () => {
    const topics = await connectOnce({
      id: "9f8e7d6c-5b4a-4210-aedc-ba9876543210",
      username: "alice-nc",
    });

    // UUID-keyed brain status flips (post-493 writers).
    expect(topics).toContain(
      "droplet/files/9f8e7d6c-5b4a-4210-aedc-ba9876543210/#",
    );
    // Username-keyed topics stay — nextcloud-watcher + chat/notification
    // publishes are still username-keyed.
    expect(topics).toContain("droplet/files/alice-nc/#");
    expect(topics).toContain("droplet/chat/alice-nc/#");
  });

  it("does not double-subscribe when id === username (dev shape)", async () => {
    const topics = await connectOnce({ id: "dev", username: "dev" });
    expect(
      topics.filter((t) => t === "droplet/files/dev/#"),
    ).toHaveLength(1);
  });
});
