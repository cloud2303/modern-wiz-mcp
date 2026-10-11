import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { WizAuthManager } from "./auth.js";
import { WizArticles } from "./articles.js";
import { loadEnvironment, readConfig } from "./config.js";
import { createWizMcp } from "./mcp.js";
import { createHttpService } from "./http.js";
import { safeError } from "./errors.js";

async function main() {
  loadEnvironment();
  const config = readConfig();
  const auth = new WizAuthManager(config.auth);
  if (process.argv.includes("--refresh-only")) {
    await auth.refresh();
    console.error("为知登录凭据已刷新并持久保存。");
    return;
  }
  const articles = new WizArticles(auth, config);
  auth.start();
  let close: () => Promise<void>;
  if (process.argv.includes("--stdio")) {
    const stdio = serveStdio(() => {
      const server = createWizMcp(articles);
      server.server.onclose = () => auth.stop();
      return server;
    });
    close = () => stdio.close();
    console.error("modern-wiz-mcp 已在 stdio 启动。");
  } else {
    const http = createHttpService(articles, config);
    await new Promise<void>((resolve, reject) => {
      http.server.once("error", reject);
      http.server.listen(config.port, config.host, () => { http.server.removeListener("error", reject); resolve(); });
    });
    close = http.close;
    console.error(`modern-wiz-mcp 已启动，端口 ${config.port}，MCP 路径 /mcp。`);
  }
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    auth.stop();
    await close();
  };
  process.once("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
}
main().catch(error => { console.error(safeError(error).message); process.exitCode = 1; });
