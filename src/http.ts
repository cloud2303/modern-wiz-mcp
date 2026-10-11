import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { WizArticles } from "./articles.js";
import type { ServiceConfig } from "./config.js";
import { WizError } from "./errors.js";
import { createWizMcp } from "./mcp.js";
import { requestBase } from "./requestBase.js";

function publicBase(req: IncomingMessage, port: number) {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  const host = req.headers.host;
  if (!host || /[\s/@\\]/.test(host)) return `http://127.0.0.1:${port}`;
  return `${proto === "https" ? "https" : "http"}://${host}`;
}

function authorized(value: string | undefined, token: string | undefined) {
  if (!token) return true;
  const actual = Buffer.from(value ?? ""), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function pathPart(value: string) {
  try { return decodeURIComponent(value); } catch { return ""; }
}
export function createHttpService(articles: WizArticles, config: ServiceConfig): { server: Server; close: () => Promise<void> } {
  const handler = createMcpHandler(() => createWizMcp(articles), { responseMode: "json", maxRequestBodySize: 2 * 1024 * 1024 });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: 2 * 1024 * 1024 });
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const resource = /^\/resources\/([^/]+)\/([^/]+)$/.exec(requestUrl.pathname);
    if (resource && req.method === "GET") {
      void articles.readProxiedImage({
        docId: pathPart(resource[1]), name: pathPart(resource[2]),
        exp: requestUrl.searchParams.get("exp") ?? "", sig: requestUrl.searchParams.get("sig") ?? "",
      }).then(image => {
        res.writeHead(200, { "Content-Type": image.mime, "Cache-Control": "private, max-age=60" });
        res.end(image.bytes);
      }).catch(error => {
        const status = error instanceof WizError && error.code === "NOT_FOUND" ? 404 : error instanceof WizError && (error.code === "AUTH_REQUIRED" || error.code === "INVALID_INPUT") ? 401 : 502;
        if (!res.headersSent) res.writeHead(status);
        res.end();
      });
      return;
    }
    if (!authorized(req.headers.authorization, config.bearerToken)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }); res.end("Unauthorized"); return;
    }
    const path = requestUrl.pathname;
    if (path === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "modern-wiz-mcp" })); return;
    }
    if (path !== "/mcp") { res.writeHead(404); res.end("Not found"); return; }
    void requestBase.run(publicBase(req, config.port), () => nodeHandler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = 120_000;
  return { server, async close() {
    await handler.close();
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
  } };
}
