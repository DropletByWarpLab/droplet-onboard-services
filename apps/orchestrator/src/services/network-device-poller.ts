/**
 * WARP-3193 PERF-15 — shared device poller behind GET /network/devices/events.
 *
 * Each SSE client used to run its own 10 s setInterval against the routing
 * service with no in-flight guard, so N open dashboards meant N polls per tick
 * and a slow router let them stack. One poller per process now does a single
 * fetch per tick and fans the result out to every subscriber. A tick is
 * skipped while the previous fetch is still in flight, and the interval only
 * runs while someone is subscribed.
 *
 * Diffing stays per subscriber (each keeps its own last-sent JSON), so a
 * client sees exactly what the per-client poll showed it: the list on its
 * first successful tick, then only changes.
 */

export type DevicesListener = (devices: unknown) => void;

export interface DevicePoller {
  /** Start receiving device lists. Returns the unsubscribe function. */
  subscribe(listener: DevicesListener): () => void;
}

export function createDevicePoller(
  fetchDevices: () => Promise<unknown>,
  intervalMs = 10_000,
): DevicePoller {
  const subscribers = new Map<DevicesListener, { lastJson: string }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const devices = await fetchDevices();
      const json = JSON.stringify(devices);
      for (const [listener, state] of subscribers) {
        if (state.lastJson === json) continue;
        state.lastJson = json;
        try {
          listener(devices);
        } catch {
          // One broken stream must not starve the rest.
        }
      }
    } catch {
      // Non-fatal — same as the per-client poll: try again next tick.
    } finally {
      inFlight = false;
    }
  }

  return {
    subscribe(listener) {
      subscribers.set(listener, { lastJson: "" });
      if (timer === null) timer = setInterval(() => void tick(), intervalMs);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}
