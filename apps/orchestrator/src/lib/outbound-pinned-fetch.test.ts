/**
 * WARP-3532 — the connector half of the pinned-destination guard.
 *
 * `outbound-url-guard.pinned.test.ts` proves what the guard lets through. This
 * proves what the connector DOES with it: it dials only the vetted addresses,
 * never resolves the hostname again, carries the original hostname as Host and
 * as TLS SNI, follows no redirect, reads no body and gives up on a deadline.
 *
 * These are real sockets on 127.0.0.1. The destinations are built by hand —
 * the guard would (rightly) refuse loopback — because the unit under test is
 * the connector, and a pinned address is just an address to it.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PinnedDestination } from "./outbound-url-guard.js";
import { pinnedFetch, pinnedLookup } from "./outbound-pinned-fetch.js";

const servers: Array<http.Server | https.Server> = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

async function listen<S extends http.Server | https.Server>(server: S): Promise<{ server: S; port: number }> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A vetted destination, as the guard would hand it over. */
function destination(url: string, addresses: PinnedDestination["addresses"]): PinnedDestination {
  const parsed = new URL(url);
  return { url: parsed, hostname: parsed.hostname, addresses, scope: "lan" };
}

const LOOPBACK = [{ address: "127.0.0.1", family: 4 as const }];

describe("pinnedLookup", () => {
  it("answers with the pinned addresses whatever hostname it is asked for", () => {
    const lookup = pinnedLookup([
      { address: "192.168.1.20", family: 4 },
      { address: "fd00::7", family: 6 },
    ]);
    const all = new Promise<unknown>((resolve) =>
      lookup("anything.example.com", { all: true }, (err, addrs) => resolve({ err, addrs })),
    );
    return Promise.all([
      expect(all).resolves.toEqual({
        err: null,
        addrs: [
          { address: "192.168.1.20", family: 4 },
          { address: "fd00::7", family: 6 },
        ],
      }),
      new Promise<unknown[]>((resolve) =>
        lookup("elsewhere.example.org", {}, (err, address, family) => resolve([err, address, family])),
      ).then((single) => expect(single).toEqual([null, "192.168.1.20", 4])),
    ]);
  });
});

describe("pinnedFetch — connects to the vetted address, speaks the original name", () => {
  it("dials the pinned address and never resolves the hostname", async () => {
    const seen: Array<{ host?: string; method?: string; url?: string; body: string; headers: http.IncomingHttpHeaders }> = [];
    const { port } = await listen(
      http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seen.push({ host: req.headers.host, method: req.method, url: req.url, body, headers: req.headers });
          res.writeHead(204).end();
        });
      }),
    );

    // `.invalid` can never resolve (RFC 2606): the request can only succeed
    // because the connector used the pinned address instead of asking DNS.
    const dest = destination(`http://pinned-name.invalid:${port}/hook?x=1`, LOOPBACK);
    const res = await pinnedFetch(dest, {
      headers: { "content-type": "application/json", "x-droplet-event": "work_item.created" },
      body: '{"a":1}',
    });

    expect(res.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      host: `pinned-name.invalid:${port}`, // the ORIGINAL Host, not the address
      method: "POST",
      url: "/hook?x=1",
      body: '{"a":1}',
    });
    expect(seen[0]!.headers["x-droplet-event"]).toBe("work_item.created");
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
  });

  it("does not follow a redirect — the 3xx is the answer", async () => {
    let hits = 0;
    const { port } = await listen(
      http.createServer((req, res) => {
        hits += 1;
        if (req.url === "/hook") {
          res.writeHead(302, { location: `http://127.0.0.1:${(res.socket!.localPort as number)}/internal-admin` }).end();
        } else {
          res.writeHead(200).end("followed");
        }
      }),
    );
    const res = await pinnedFetch(destination(`http://pinned.invalid:${port}/hook`, LOOPBACK), {
      headers: {},
      body: "{}",
    });
    expect(res.status).toBe(302);
    expect(hits).toBe(1);
  });

  it("returns on the status line without reading the body", async () => {
    const { port } = await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("x".repeat(256 * 1024)); // …and never ends
      }),
    );
    const started = Date.now();
    const res = await pinnedFetch(destination(`http://pinned.invalid:${port}/`, LOOPBACK), {
      headers: {},
      body: "{}",
      timeoutMs: 5_000,
    });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives up on a deadline when the receiver never answers", async () => {
    const { port } = await listen(http.createServer(() => undefined));
    const started = Date.now();
    await expect(
      pinnedFetch(destination(`http://pinned.invalid:${port}/`, LOOPBACK), {
        headers: {},
        body: "{}",
        timeoutMs: 200,
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("rejects when nothing is listening on the pinned address", async () => {
    const { port, server } = await listen(http.createServer());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(
      pinnedFetch(destination(`http://pinned.invalid:${port}/`, LOOPBACK), {
        headers: {},
        body: "{}",
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow();
  });
});

/** A throwaway self-signed certificate for `hooks.pinned.test`, or null when
 *  openssl is not installed (the TLS cases are then skipped, visibly). Minted at
 *  collection time so `describe.skipIf` can see it. */
function mintCertificate(): { key: string; cert: string; cleanup: () => void } | null {
  const dir = mkdtempSync(path.join(tmpdir(), "pinned-fetch-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-sha256", "-days", "1", "-subj", "/CN=hooks.pinned.test",
        "-addext", "subjectAltName=DNS:hooks.pinned.test",
        "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(path.join(dir, "key.pem"), "utf8"),
      cert: readFileSync(path.join(dir, "cert.pem"), "utf8"),
      cleanup,
    };
  } catch {
    cleanup();
    return null;
  }
}

const TLS = mintCertificate();
afterAll(() => TLS?.cleanup());

describe.skipIf(!TLS)("pinnedFetch — TLS carries the original hostname", () => {
  const { key, cert } = TLS ?? { key: "", cert: "" };

  it("sends the ORIGINAL hostname as SNI and verifies the certificate against it", async () => {
    const sni: string[] = [];
    const { port } = await listen(
      https.createServer(
        {
          key,
          cert,
          SNICallback: (servername, cb) => {
            sni.push(servername);
            cb(null, undefined);
          },
        },
        (_req, res) => res.writeHead(200).end("ok"),
      ),
    );
    const dest = destination(`https://hooks.pinned.test:${port}/hook`, LOOPBACK);

    // Trusting the throwaway CA is the only way this succeeds: the name on the
    // certificate is checked against the URL's hostname, not the pinned address.
    const res = await pinnedFetch(dest, { headers: {}, body: "{}" }, { connect: { ca: cert } });
    expect(res.status).toBe(200);
    expect(sni).toEqual(["hooks.pinned.test"]);
  });

  it("refuses a certificate that is not for the ORIGINAL hostname", async () => {
    const { port } = await listen(https.createServer({ key, cert }, (_req, res) => res.writeHead(200).end("ok")));
    // Same server, same pinned address — but the URL names a host the cert is not for.
    const dest = destination(`https://other-name.pinned.test:${port}/hook`, LOOPBACK);
    await expect(pinnedFetch(dest, { headers: {}, body: "{}" }, { connect: { ca: cert } })).rejects.toThrow();
  });

  it("does not trust an unknown CA by default", async () => {
    const { port } = await listen(https.createServer({ key, cert }, (_req, res) => res.writeHead(200).end("ok")));
    const dest = destination(`https://hooks.pinned.test:${port}/hook`, LOOPBACK);
    await expect(pinnedFetch(dest, { headers: {}, body: "{}" })).rejects.toThrow();
  });
});
