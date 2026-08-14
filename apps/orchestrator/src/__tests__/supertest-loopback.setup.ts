/**
 * WARP-1690 — supertest must bind the address it dials.
 *
 * supertest opens a fresh ephemeral server per request (`app.listen(0)` in
 * `Test#serverAddress`) and then dials `http://127.0.0.1:<port>`. Those are two
 * different tuples: `listen(0)` with no host binds the WILDCARD address (`[::]`,
 * dual-stack), and macOS/BSD only guarantees the tuple you actually bound is
 * free. A wildcard `listen(0)` will hand out a port that another socket already
 * holds on `127.0.0.1` specifically, and the kernel then routes the inbound
 * connection to the MOST SPECIFIC bind — i.e. to that other socket, not ours.
 *
 * A full orchestrator run makes well over 16,384 ephemeral binds (one per
 * supertest request), which is exactly one sweep of the macOS ephemeral range
 * (49152-65535). So the allocator wraps around and starts re-issuing ports that
 * are currently held on `127.0.0.1` — by this suite's own loopback-bound test
 * servers (`stt.client`, `update-agent/apply`, `update-agent/poller`,
 * `mtls-server`) or by any co-tenant process on the machine. The request lands
 * on a stranger and dies as `ECONNRESET`, `socket hang up`, or
 * `HPE_INVALID_CONSTANT: Expected HTTP/, RTSP/ or ICE/`. A single file never
 * makes enough binds to wrap the range, which is why every affected file passes
 * standalone and the failing file moves between full runs.
 *
 * Fix: bind the loopback address supertest dials. That allocation is exclusive
 * on the exact tuple used, so nothing can shadow it (measured: 60k consecutive
 * loopback binds against 100 held `127.0.0.1` ports, zero collisions; the same
 * 60k as wildcard binds collide 300 times).
 *
 * The bind uses the IPv4-mapped spelling `::ffff:127.0.0.1` rather than plain
 * `127.0.0.1`. The two are the same PCB entry — binding either makes the other
 * `EADDRINUSE`, so the exclusivity is identical — but the mapped form keeps the
 * socket AF_INET6, so `req.ip` stays `::ffff:127.0.0.1` exactly as it was under
 * the old dual-stack wildcard bind. Plain `127.0.0.1` would flip it to
 * `127.0.0.1` and change every per-IP rate-limit bucket key the suite asserts on.
 *
 * `listen()` with a host resolves through `dns.lookup` and so completes a tick
 * later than the hostless form, which supertest's constructor assumes is
 * synchronous. The URL is therefore built when the request is actually sent
 * (`Test#end`) instead of in the constructor.
 */
import { Server as TLSServer } from "node:tls";
import type { Server } from "node:http";
import supertest from "supertest";

type Pending = { server: Server; path: string; protocol: string };

// supertest exposes its `Test` class but does not type its internals; the two
// methods patched below are the ones that pick the port and issue the request.
const Test = (
  supertest as unknown as {
    Test: {
      prototype: {
        serverAddress: (app: Server, path: string) => string;
        end: (fn?: unknown) => unknown;
      };
    };
  }
).Test;
const pending = new WeakMap<object, Pending>();
const originalServerAddress = Test.prototype.serverAddress;
const originalEnd = Test.prototype.end;

Test.prototype.serverAddress = function (this: object, app: Server, path: string) {
  if (app.address()) return originalServerAddress.call(this, app, path);
  const server = app.listen(0, "::ffff:127.0.0.1");
  (this as { _server: Server })._server = server;
  const protocol = app instanceof TLSServer ? "https" : "http";
  pending.set(this, { server, path, protocol });
  // Placeholder — rewritten in end(), once the bind has a port.
  return `${protocol}://127.0.0.1:0${path}`;
};

Test.prototype.end = function (this: object, fn?: unknown) {
  const p = pending.get(this);
  if (!p) return originalEnd.call(this, fn);
  pending.delete(this);
  const send = () => {
    const { port } = p.server.address() as { port: number };
    (this as { url: string }).url = `${p.protocol}://127.0.0.1:${port}${p.path}`;
    originalEnd.call(this, fn);
  };
  if (p.server.listening) send();
  else p.server.once("listening", send);
  return this;
};
