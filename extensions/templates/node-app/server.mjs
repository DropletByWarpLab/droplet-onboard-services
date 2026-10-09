import http from "node:http";
const base = process.env.DROPLET_EXT_BASE_PATH;
if (!base || !process.env.PORT) throw new Error("Run with the Droplet app host");
http.createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === `${base}healthz`) { res.writeHead(200, {"content-type":"text/plain"}); res.end("ok"); }
  else if (path === base) { res.writeHead(200, {"content-type":"text/html; charset=utf-8"}); res.end("<!doctype html><title>My Droplet app</title><h1>My Droplet app</h1>"); }
  else { res.writeHead(404); res.end("Not found"); }
}).listen(Number(process.env.PORT), "127.0.0.1");
