/**
 * WARP-3506 / WARP-3510 — a STATEFUL stand-in for Frigate 0.17's HTTP API, for
 * the tests that need Frigate to behave rather than merely to be called.
 *
 * The defects behind these tickets are interactions, not single calls:
 *
 *   - `PUT /api/config/set` (requires_restart: 1) only WRITES config.yml. The
 *     camera does not exist for `/api/stats` until something restarts Frigate.
 *   - every authored-YAML writer is read-modify-write, so two of them that
 *     overlap lose an update.
 *   - a reconcile prunes whatever the DB snapshot does not name.
 *
 * A stub that answers each URL with a canned body cannot show any of that, so
 * this one keeps the YAML, applies `config/set` as Frigate does (deep-merge of
 * `config_data` into the authored file), makes a camera appear in `/api/stats`
 * only after a restart, and records every call in order.
 *
 * `fetch` rejects with a connection error while a restart is in flight when
 * `downDuringRestart` is set — that is what the orchestrator sees for the
 * first seconds after `POST /api/restart`.
 */
import { parse, parseDocument } from "yaml";

export interface FakeFrigateOptions {
  /** Authored config.yml text. */
  yaml?: string;
  /**
   * `camera_fps` a camera reports once Frigate has restarted with it in the
   * config. A key mapped to `null` never appears in `/api/stats` at all (the
   * process did not start); a number is its fps (0 = started, no frames).
   * Default for an unlisted camera: 5.
   */
  fpsAfterRestart?: Record<string, number | null>;
  /** How many `/api/stats` polls after a restart fail with a connection error. */
  downPollsAfterRestart?: number;
  /** Make `/api/restart` itself fail with this status. */
  restartStatus?: number;
}

type Held = { match: string; release: () => void; wait: Promise<void> };

export function makeFakeFrigate(opts: FakeFrigateOptions = {}) {
  let yaml = opts.yaml ?? "mqtt:\n  enabled: true\ncameras: {}\n";
  const calls: string[] = [];
  let restarts = 0;
  /** Cameras that have been started by a restart, with the fps they report. */
  const running = new Map<string, number>();
  let downPolls = 0;
  const held: Held[] = [];

  function camerasInYaml(): string[] {
    const doc = parse(yaml) as { cameras?: Record<string, unknown> } | null;
    return Object.keys(doc?.cameras ?? {});
  }

  function describeCall(url: string, init?: RequestInit): string {
    const u = new URL(url);
    return `${(init?.method ?? "GET").toUpperCase()} ${u.pathname}${u.search}`;
  }

  async function fetchImpl(input: string | URL, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const call = describeCall(url, init);
    calls.push(call);

    const hold = held.find((h) => call.includes(h.match));
    if (hold) {
      held.splice(held.indexOf(hold), 1);
      await hold.wait;
    }

    const path = new URL(url).pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/config/raw" && method === "GET") {
      // Frigate 0.17 serves the authored file JSON-string-encoded.
      return new Response(JSON.stringify(yaml), { status: 200 });
    }

    if (path === "/api/config/save" && method === "POST") {
      yaml = String(init?.body ?? "");
      if (new URL(url).searchParams.get("save_option") === "restart") restart();
      return new Response(JSON.stringify({ success: true, message: "saved" }), { status: 200 });
    }

    if (path === "/api/config/set" && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        config_data?: { cameras?: Record<string, unknown> };
        requires_restart?: number;
      };
      const doc = parseDocument(yaml);
      for (const [key, block] of Object.entries(body.config_data?.cameras ?? {})) {
        doc.setIn(["cameras", key], doc.createNode(block));
      }
      yaml = String(doc);
      // Frigate 0.17: requires_restart=1 ONLY writes the file. Nothing starts.
      return new Response(
        JSON.stringify({ success: true, message: "Config successfully updated, restart to apply" }),
        { status: 200 },
      );
    }

    if (path === "/api/restart" && method === "POST") {
      if (opts.restartStatus && opts.restartStatus >= 400) {
        return new Response(JSON.stringify({ success: false }), { status: opts.restartStatus });
      }
      restart();
      return new Response(JSON.stringify({ success: true, message: "Restarting" }), { status: 200 });
    }

    if (path === "/api/stats" && method === "GET") {
      if (downPolls > 0) {
        downPolls -= 1;
        throw new TypeError("fetch failed");
      }
      const cameras: Record<string, { camera_fps: number }> = {};
      for (const [key, fps] of running) cameras[key] = { camera_fps: fps };
      return new Response(JSON.stringify({ cameras }), { status: 200 });
    }

    throw new Error(`fake-frigate: unexpected ${call}`);
  }

  function restart(): void {
    restarts += 1;
    running.clear();
    for (const key of camerasInYaml()) {
      const fps = key in (opts.fpsAfterRestart ?? {}) ? opts.fpsAfterRestart![key] : 5;
      if (fps !== null && fps !== undefined) running.set(key, fps);
    }
    downPolls = opts.downPollsAfterRestart ?? 0;
  }

  return {
    fetch: fetchImpl,
    /** Authored config.yml as Frigate currently holds it. */
    yaml: () => yaml,
    /** Replace the authored file without going through the API (a manual edit). */
    setYaml: (next: string) => {
      yaml = next;
    },
    /** Camera keys in the authored file. */
    cameras: camerasInYaml,
    /** Every request, in arrival order, as `METHOD /path?query`. */
    calls,
    restarts: () => restarts,
    /**
     * Park the NEXT request whose `METHOD /path?query` contains `match` until
     * the returned function is called — pins an interleaving deterministically.
     */
    hold(match: string): () => void {
      let release!: () => void;
      const wait = new Promise<void>((r) => {
        release = r;
      });
      held.push({ match, release, wait });
      return release;
    },
  };
}

export type FakeFrigate = ReturnType<typeof makeFakeFrigate>;
