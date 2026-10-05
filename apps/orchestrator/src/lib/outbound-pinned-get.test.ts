/**
 * WARP-3535 — `pinnedGet`, the read half of the pinned-destination connector.
 *
 * `pinnedFetch` posts and reads nothing back; the GitHub / GitLab poll has to
 * read the answer. Everything `outbound-pinned-fetch.test.ts` proves about the
 * dial is true here too (the two share one agent): vetted address only, original
 * Host and SNI, no redirect, a deadline. What is new, and pinned here:
 *
 *   - the answer comes back (status, headers, body), with a 304 carrying no body;
 *   - the body is read under a ceiling, so a host cannot make the box buffer
 *     whatever it likes, and the connection is dropped when it tries;
 *   - the caller's own abort signal ends the request.
 *
 * Real sockets on 127.0.0.1; destinations are built by hand because the guard
 * would (rightly) refuse loopback and the unit under test is the connector.
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
import { pinnedGet, PINNED_GET_MAX_BODY_BYTES } from "./outbound-pinned-fetch.js";

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

function destination(url: string, addresses: PinnedDestination["addresses"]): PinnedDestination {
  const parsed = new URL(url);
  return { url: parsed, hostname: parsed.hostname, addresses, scope: "public" };
}

const LOOPBACK = [{ address: "127.0.0.1", family: 4 as const }];

describe("pinnedGet — connects to the vetted address, speaks the original name, reads the answer", () => {
  it("sends a GET with the headers given and returns status, headers and body", async () => {
    const seen: Array<{ host?: string; method?: string; url?: string; body: string; headers: http.IncomingHttpHeaders }> = [];
    const { port } = await listen(
      http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seen.push({ host: req.headers.host, method: req.method, url: req.url, body, headers: req.headers });
          res.writeHead(200, { "content-type": "application/json", etag: 'W/"abc"', "x-ratelimit-remaining": "4999" });
          res.end(JSON.stringify([{ id: 1 }]));
        });
      }),
    );

    // `.invalid` can never resolve (RFC 2606): the request can only succeed
    // because the connector used the pinned address instead of asking DNS.
    const dest = destination(`http://api-pinned.invalid:${port}/repos/acme/widgets/pulls?state=open&per_page=100`, LOOPBACK);
    const res = await pinnedGet(dest, { headers: { authorization: "Bearer t", "if-none-match": 'W/"old"' } });

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('W/"abc"');
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4999");
    expect(new TextDecoder().decode(res.body)).toBe('[{"id":1}]');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      host: `api-pinned.invalid:${port}`, // the ORIGINAL Host, not the address
      method: "GET",
      url: "/repos/acme/widgets/pulls?state=open&per_page=100",
      body: "",
    });
    expect(seen[0]!.headers.authorization).toBe("Bearer t");
    expect(seen[0]!.headers["if-none-match"]).toBe('W/"old"');
  });

  it("returns a 304 with an empty body and its headers", async () => {
    const { port } = await listen(
      http.createServer((_req, res) => {
        res.writeHead(304, { etag: 'W/"abc"', "x-ratelimit-remaining": "4998" }).end();
      }),
    );
    const res = await pinnedGet(destination(`http://api-pinned.invalid:${port}/x`, LOOPBACK), { headers: {} });
    expect(res.status).toBe(304);
    expect(res.body.byteLength).toBe(0);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4998");
  });

  it("does not follow a redirect — the 3xx is the answer", async () => {
    let hits = 0;
    const { port } = await listen(
      http.createServer((req, res) => {
        hits += 1;
        if (req.url === "/start") {
          res.writeHead(302, { location: `http://127.0.0.1:${res.socket!.localPort as number}/internal-admin` }).end();
        } else {
          res.writeHead(200).end("followed");
        }
      }),
    );
    const res = await pinnedGet(destination(`http://api-pinned.invalid:${port}/start`, LOOPBACK), { headers: {} });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/internal-admin");
    expect(hits).toBe(1);
  });
});

describe("pinnedGet — a body is read under a ceiling", () => {
  it("rejects a response larger than the ceiling and drops the connection", async () => {
    let closed = false;
    const { port } = await listen(
      http.createServer((req, res) => {
        req.socket.on("close", () => (closed = true));
        res.writeHead(200, { "content-type": "application/json" });
        res.write("x".repeat(64 * 1024));
        // …and keeps sending: a host that will not stop.
        const timer = setInterval(() => res.write("x".repeat(64 * 1024)), 5);
        res.on("close", () => clearInterval(timer));
      }),
    );
    // Mutation: read the whole body -> this never rejects and the test times out.
    await expect(
      pinnedGet(destination(`http://api-pinned.invalid:${port}/big`, LOOPBACK), { headers: {} }, { maxBodyBytes: 100 * 1024 }),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
  });

  it("accepts a body exactly at the ceiling", async () => {
    const { port } = await listen(http.createServer((_req, res) => res.writeHead(200).end("y".repeat(1000))));
    const res = await pinnedGet(destination(`http://api-pinned.invalid:${port}/`, LOOPBACK), { headers: {} }, { maxBodyBytes: 1000 });
    expect(res.body.byteLength).toBe(1000);
  });

  it("defaults to 16 MiB, which is enough for a page of 100 long pull request bodies", () => {
    expect(PINNED_GET_MAX_BODY_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe("pinnedGet — it ends when it should", () => {
  it("gives up on a deadline when the host never answers", async () => {
    const { port } = await listen(http.createServer(() => undefined));
    const started = Date.now();
    await expect(
      pinnedGet(destination(`http://api-pinned.invalid:${port}/`, LOOPBACK), { headers: {}, timeoutMs: 200 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("ends when the caller aborts", async () => {
    const { port } = await listen(http.createServer(() => undefined));
    const controller = new AbortController();
    const pending = pinnedGet(destination(`http://api-pinned.invalid:${port}/`, LOOPBACK), {
      headers: {},
      timeoutMs: 20_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("rejects when nothing is listening on the pinned address", async () => {
    const { port, server } = await listen(http.createServer());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(
      pinnedGet(destination(`http://api-pinned.invalid:${port}/`, LOOPBACK), { headers: {}, timeoutMs: 2_000 }),
    ).rejects.toThrow();
  });
});

function mintCertificate(): { key: string; cert: string; cleanup: () => void } | null {
  const dir = mkdtempSync(path.join(tmpdir(), "pinned-get-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-sha256", "-days", "1", "-subj", "/CN=api.pinned.test",
        "-addext", "subjectAltName=DNS:api.pinned.test",
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

describe.skipIf(!TLS)("pinnedGet — TLS carries the original hostname", () => {
  const { key, cert } = TLS ?? { key: "", cert: "" };

  it("sends the ORIGINAL hostname as SNI and verifies the certificate against it", async () => {
    const sni: string[] = [];
    const { port } = await listen(
      https.createServer(
        { key, cert, SNICallback: (servername, cb) => (sni.push(servername), cb(null, undefined)) },
        (_req, res) => res.writeHead(200).end("ok"),
      ),
    );
    const dest = destination(`https://api.pinned.test:${port}/x`, LOOPBACK);
    const res = await pinnedGet(dest, { headers: {} }, { connect: { ca: cert } });
    expect(res.status).toBe(200);
    expect(sni).toEqual(["api.pinned.test"]);
  });

  it("refuses a certificate that is not for the ORIGINAL hostname, and an unknown CA by default", async () => {
    const { port } = await listen(https.createServer({ key, cert }, (_req, res) => res.writeHead(200).end("ok")));
    await expect(
      pinnedGet(destination(`https://other-name.pinned.test:${port}/x`, LOOPBACK), { headers: {} }, { connect: { ca: cert } }),
    ).rejects.toThrow();
    await expect(pinnedGet(destination(`https://api.pinned.test:${port}/x`, LOOPBACK), { headers: {} })).rejects.toThrow();
  });
});
