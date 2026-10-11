import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { WizArticles } from "./articles.js";
import type { ServiceConfig } from "./config.js";
import { createWizMcp } from "./mcp.js";

function authorized(value: string | undefined, token: string | undefined) {
  if (!token) return true;
  const actual = Buffer.from(value ?? ""), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function createHttpService(articles: WizArticles, config: ServiceConfig): { server: Server; close: () => Promise<void> } {
  const handler = createMcpHandler(() => createWizMcp(articles), { responseMode: "json", maxRequestBodySize: 2 * 1024 * 1024 });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: 2 * 1024 * 1024 });
  const host = hostHeaderValidation(config.allowedHosts), origin = originValidation(config.allowedOrigins);
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!host(req, res) || !origin(req, res)) return;
    if (!authorized(req.headers.authorization, config.bearerToken)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }); res.end("Unauthorized"); return;
    }
    const path = (req.url ?? "").split("?")[0];
    if (path === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "modern-wiz-mcp" })); return;
    }
    if (path !== "/mcp") { res.writeHead(404); res.end("Not found"); return; }
    void nodeHandler(req, res).catch(() => {
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
