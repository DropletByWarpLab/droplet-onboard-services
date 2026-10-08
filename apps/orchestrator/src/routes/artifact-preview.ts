import { Router } from "express";

export const ARTIFACT_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src http: https:; frame-src blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";

// This response contains trusted, static code only. Never interpolate a file,
// user input, credential, or generated markup here. An HTTP response is needed:
// Connection-Allowlist cannot be enforced by a CSP meta tag or srcdoc alone.
// Its policy container is inherited by the opaque generated srcdoc child.
export const ARTIFACT_PREVIEW_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><script>
(() => {
  "use strict";
  const nonce = location.hash.slice(1);
  if (!/^[a-f0-9-]{36}$/.test(nonce) || parent === window) return;
  let state = "initial";
  const send = (type, extra = {}) => parent.postMessage({ type, nonce, ...extra }, "*");

  // Based on the Web Platform Test for Connection-Allowlist's webrtc=block:
  // https://github.com/web-platform-tests/wpt/blob/master/content-security-policy/webrtc/webrtc.js
  // A denied connection's FIRST ICE transition is failed on both peers. An
  // ordinary failed/unreachable connection first enters checking and fails
  // this probe. API absence, exceptions, and timeouts are all fail-closed.
  async function rtcIsBlocked() {
    if (typeof RTCPeerConnection !== "function") return false;
    const peers = [];
    let timer;
    try {
      const a = new RTCPeerConnection({ iceServers: [] }); peers.push(a);
      const b = new RTCPeerConnection({ iceServers: [] }); peers.push(b);
      const firstState = (peer) => new Promise(resolve => {
        peer.oniceconnectionstatechange = () => resolve(peer.iceConnectionState === "failed");
      });
      const aBlocked = firstState(a), bBlocked = firstState(b);
      const forward = (to) => ({ candidate }) => { if (candidate) void to.addIceCandidate(candidate).catch(() => {}); };
      a.onicecandidate = forward(b); b.onicecandidate = forward(a);
      const attempt = async () => {
        a.createDataChannel("droplet-boundary-probe");
        await a.setLocalDescription(await a.createOffer());
        await b.setRemoteDescription(a.localDescription);
        await b.setLocalDescription(await b.createAnswer());
        await a.setRemoteDescription(b.localDescription);
        return (await aBlocked) && (await bBlocked);
      };
      return await Promise.race([attempt(), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
    } catch { return false; }
    finally { clearTimeout(timer); for (const peer of peers) peer.close(); }
  }

  async function networkIsBlocked() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      // Parent has already proved this public, secret-free endpoint reachable.
      // no-cors avoids mistaking an opaque frame's CORS failure for enforcement.
      // The trusted host's CSP permits this probe; the Connection-Allowlist
      // HTTP header alone must refuse it before establishing a connection.
      await fetch(new URL("/api/artifact-preview-probe", location.href), { mode: "no-cors", credentials: "omit", cache: "no-store", signal: controller.signal });
      return false;
    } catch (error) { return !controller.signal.aborted && error instanceof TypeError; }
    finally { clearTimeout(timer); }
  }

  addEventListener("message", async (event) => {
    if (event.source !== parent || event.data?.nonce !== nonce) return;
    if (state === "initial" && event.data.type === "droplet-artifact-init") {
      state = "probing";
      const supported = (await rtcIsBlocked()) && (await networkIsBlocked());
      state = supported ? "ready" : "failed";
      send("droplet-artifact-ready", { supported });
      return;
    }
    if (state !== "ready" || event.data.type !== "droplet-artifact-content" || typeof event.data.content !== "string") return;
    const content = event.data.content;
    if (new TextEncoder().encode(content).byteLength > 196608) { state = "failed"; return; }
    state = "loaded";
    const frame = document.createElement("iframe");
    frame.title = "Interactive artifact content";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.referrerPolicy = "no-referrer";
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '"><meta name="referrer" content="no-referrer"></head><body>' + content + '</body></html>';
    document.body.append(frame);
    send("droplet-artifact-loaded");
  });
})();
</script></body></html>`;

/** Public, static, secret-free host. Mount before auth: the opaque sandbox has
 * no cookie access, and a login/SSO redirect must never replace this policy. */
export function createArtifactPreviewRouter(): Router {
  const router = Router();
  router.get("/artifact-preview", (_req, res) => {
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "Connection-Allowlist": "()",
      "Content-Security-Policy": ARTIFACT_PREVIEW_CSP,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-DNS-Prefetch-Control": "off",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(ARTIFACT_PREVIEW_DOCUMENT);
  });
  router.get("/artifact-preview-probe", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(204).end();
  });
  return router;
}
