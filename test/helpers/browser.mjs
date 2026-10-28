import { createServer } from "node:http";
import { once } from "node:events";
import { launch, newContext } from "../../src/browser.mjs";

export function html(body, script = "", css = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UX fixture</title><style>
  body{margin:0;padding:16px;font:16px/1.5 sans-serif;color:#111;background:white}button,input,select,textarea{font:inherit;padding:8px;min-height:36px}button{min-width:44px}a{display:inline-block;padding:8px} ${css}
  </style></head><body><main>${body}</main><script>${script}</script></body></html>`;
}

export async function fixture(routes, { viewport = "desktop" } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, method: req.method });
    const handler = routes[new URL(req.url, "http://fixture").pathname];
    if (!handler) { res.writeHead(404); res.end("Not found"); return; }
    try {
      if (typeof handler === "function") await handler(req, res);
      else { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(handler); }
    } catch (e) { res.writeHead(500); res.end(String(e.message)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let browser; let ctx;
  try { browser = await launch(); ctx = await newContext(browser, viewport); }
  catch (e) { server.closeAllConnections(); await new Promise((r) => server.close(r)); throw e; }
  return {
    url: `http://127.0.0.1:${server.address().port}`, ctx, browser, requests,
    async close() { await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); },
  };
}
