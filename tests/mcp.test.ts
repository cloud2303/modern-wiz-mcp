import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { Client, InMemoryTransport, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createWizMcp } from "../src/mcp.js";
import { createHttpService } from "../src/http.js";
import { readConfig } from "../src/config.js";
import type { WizArticles } from "../src/articles.js";
import { WizError } from "../src/errors.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const coreTools = ["create_article", "create_folder", "delete_article", "get_article", "get_image_url", "get_write_status", "list_articles", "list_folders", "search_articles", "update_article", "upload_image"];
const article = { docId: "doc", title: "Test article", category: "/Notes/", version: 5, markdown: "# Context\n\nArticle content", warnings: [], uri: "wiz://articles/doc" };
function service(overrides: Partial<Record<keyof WizArticles, unknown>> = {}) {
  return {
    listFolders: async () => ({ folders: [{ path: "/Notes/", name: "Notes", depth: 0 }] }),
    listArticles: async () => ({ articles: [{ docId: "doc", title: "Test article" }], offset: 0, limit: 50, nextOffset: null }),
    searchArticles: async () => ({ articles: [{ docId: "doc", title: "Test article" }], truncated: false }),
    getArticle: async () => ({ ...article }),
    updateArticle: async () => ({ ...article, version: 6, saved: true, changed: true }),
    getWriteStatus: () => ({ requestId: "00000000-0000-4000-8000-000000000001", status: "acknowledged" }),
    ...overrides,
  } as unknown as WizArticles;
}
async function inMemory(t: TestContext, articles = service()) {
  const server = createWizMcp(articles);
  const client = new Client({ name: "wiz-mcp-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
function output(result: CallToolResult) {
  if (result.structuredContent !== undefined) return result.structuredContent as Record<string, unknown>;
  const text = result.content.find(item => item.type === "text");
  assert.ok(text && text.type === "text");
  return JSON.parse(text.text) as Record<string, unknown>;
}

test("real MCP Client initializes, discovers article tools and reads article resources", async t => {
  const client = await inMemory(t);
  assert.equal(client.getServerVersion()?.name, "modern-wiz-mcp");
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), coreTools);
  assert.equal(tools.find(tool => tool.name === "get_article")?.annotations?.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === "update_article")?.annotations?.readOnlyHint, false);
  const response = await client.callTool({ name: "get_article", arguments: { docId: "doc" } });
  assert.ok(!response.isError);
  assert.equal(output(response).markdown, article.markdown);
  const resource = await client.readResource({ uri: "wiz://articles/doc" });
  assert.equal(resource.contents.length, 1);
  assert.equal(resource.contents[0].mimeType, "text/markdown");
  assert.ok("text" in resource.contents[0]);
  assert.equal(resource.contents[0].text, article.markdown);
});

test("tool failures remain isError and unknown upstream details are sanitized", async t => {
  const client = await inMemory(t, service({
    getArticle: async (input: { docId: string }) => {
      if (input.docId === "missing") throw new WizError("NOT_FOUND", "文章不存在。");
      throw new Error("upstream response contains private-token");
    },
  }));
  const missing = await client.callTool({ name: "get_article", arguments: { docId: "missing" } });
  assert.equal(missing.isError, true);
  assert.equal(output(missing).code, "NOT_FOUND");
  const failure = await client.callTool({ name: "get_article", arguments: { docId: "doc" } });
  assert.equal(failure.isError, true);
  assert.equal(output(failure).code, "UPSTREAM_ERROR");
  assert.equal(JSON.stringify(failure).includes("private-token"), false);
});

test("MCP input validation rejects unsafe ids, empty searches and ambiguous updates before backend calls", async t => {
  let calls = 0;
  const forbidden = () => { calls++; throw new Error("backend should not be invoked"); };
  const client = await inMemory(t, service({ getArticle: forbidden, searchArticles: forbidden, updateArticle: forbidden, createArticle: forbidden, deleteArticle: forbidden, uploadImage: forbidden }));
  for (const params of [
    { name: "get_article", arguments: { docId: "../other" } },
    { name: "search_articles", arguments: { query: "   " } },
    { name: "update_article", arguments: { docId: "doc", expectedVersion: 5 } },
    { name: "update_article", arguments: { docId: "doc", expectedVersion: 5, markdown: "Content", edits: [{ blockId: "p", oldText: "old", newText: "new" }] } },
    { name: "delete_article", arguments: { docId: "../other" } },
    { name: "create_article", arguments: { folder: "../secret" } },
    { name: "upload_image", arguments: { docId: "../other", expectedVersion: 1, url: "https://example.com/a.png" } },
    { name: "upload_image", arguments: { docId: "doc", expectedVersion: 1 } },
    { name: "upload_image", arguments: { docId: "doc", expectedVersion: 1, url: "http://example.com/a.png" } },
    { name: "upload_image", arguments: { docId: "doc", expectedVersion: 1, url: "https://example.com/a.png", contentBase64: "aaaa" } },
  ]) {
    const result = await client.callTool(params);
    assert.equal(result.isError, true);
  }
  assert.equal(calls, 0);
});

async function httpFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "wiz-mcp-http-"));
  const config = readConfig({
    WIZ_TOKEN: "synthetic-token", WIZ_KB_GUID: "kb", WIZ_USER_GUID: "user", WIZ_SERVER_URL: "https://test.wiz.cn",
    WIZ_SESSION_PATH: join(directory, "session.json"), WIZ_JOURNAL_PATH: join(directory, "writes"),
    MCP_AUTH_TOKEN: "service-secret",
  });
  const http = createHttpService(service(), config);
  await new Promise<void>(resolve => http.server.listen(0, "127.0.0.1", resolve));
  const address = http.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await http.close(); rmSync(directory, { recursive: true, force: true }); });
  return { http, url };
}
async function rawRequest(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(url, { method: "GET", headers }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("write journal retention is off unless WIZ_KEEP_WRITE_JOURNAL is true", () => {
  const account = { WIZ_TOKEN: "synthetic-token", WIZ_KB_GUID: "kb", WIZ_USER_GUID: "user", WIZ_SERVER_URL: "https://test.wiz.cn" };
  assert.equal(readConfig(account).keepWriteJournal, false);
  assert.equal(readConfig({ ...account, WIZ_KEEP_WRITE_JOURNAL: "true" }).keepWriteJournal, true);
  assert.equal(readConfig({ ...account, WIZ_KEEP_WRITE_JOURNAL: "0" }).keepWriteJournal, false);
  assert.throws(() => readConfig({ ...account, WIZ_KEEP_WRITE_JOURNAL: "maybe" }), (error: WizError) => error.code === "INVALID_CONFIG");
});

test("Streamable HTTP Client performs initialize, tool reads and resource reads with Bearer auth", async t => {
  const { url } = await httpFixture(t);
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer service-secret", Origin: "https://proxy.example" } },
  });
  const client = new Client({ name: "http-test", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "modern-wiz-mcp");
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), coreTools);
  assert.equal(output(await client.callTool({ name: "get_article", arguments: { docId: "doc" } })).markdown, article.markdown);
  const resource = await client.readResource({ uri: "wiz://articles/doc" });
  assert.ok("text" in resource.contents[0]);
  assert.equal(resource.contents[0].text, article.markdown);
});

test("HTTP service rejects missing or wrong Bearer tokens and accepts any Host or Origin", async t => {
  const { url } = await httpFixture(t);
  const absent = await rawRequest(`${url}/health`, {});
  assert.equal(absent.status, 401);
  const wrong = await rawRequest(`${url}/health`, { Authorization: "Bearer wrong-token" });
  assert.equal(wrong.status, 401);
  const proxied = await rawRequest(`${url}/health`, { Authorization: "Bearer service-secret", Host: "proxy.example", Origin: "https://proxy.example" });
  assert.equal(proxied.status, 200);
  const malformedOrigin = await rawRequest(`${url}/health`, { Authorization: "Bearer service-secret", Origin: "invalid-origin" });
  assert.equal(malformedOrigin.status, 200);
  const healthy = await rawRequest(`${url}/health`, { Authorization: "Bearer service-secret" });
  assert.equal(healthy.status, 200);
  assert.deepEqual(JSON.parse(healthy.body), { ok: true, service: "modern-wiz-mcp" });
  assert.equal(healthy.body.includes("secret"), false);
});

test("the image proxy answers without the MCP bearer token", async t => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const articles = service({ readProxiedImage: async () => ({ bytes: png, mime: "image/png" }) });
  const http = createHttpService(articles, readConfig({
    WIZ_TOKEN: "synthetic-token", WIZ_KB_GUID: "kb", WIZ_USER_GUID: "user", WIZ_SERVER_URL: "https://test.wiz.cn",
    MCP_AUTH_TOKEN: "service-secret",
  }));
  await new Promise<void>(resolve => http.server.listen(0, "127.0.0.1", resolve));
  const address = http.server.address();
  assert.ok(address && typeof address !== "string");
  t.after(() => http.close());
  const image = await rawRequest(`http://127.0.0.1:${address.port}/resources/doc/figure.png?exp=1&sig=x`, {});
  assert.equal(image.status, 200);
  assert.equal(image.body, png.toString("utf8"));
  const denied = await rawRequest(`http://127.0.0.1:${address.port}/health`, {});
  assert.equal(denied.status, 401);
});

test("stdio entrypoint can be spawned by a real Client with a synthetic env file and clean protocol stdout", { timeout: 10_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "wiz-mcp-stdio-"));
  const envPath = join(directory, "synthetic.env");
  writeFileSync(envPath, [
    "WIZ_TOKEN=synthetic-token", "WIZ_KB_GUID=kb", "WIZ_USER_GUID=user", "WIZ_SERVER_URL=https://test.wiz.cn",
    `WIZ_SESSION_PATH=${join(directory, "session.json")}`, `WIZ_JOURNAL_PATH=${join(directory, "writes")}`,
    "WIZ_REFRESH_INTERVAL_SECONDS=86400", "",
  ].join("\n"), { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "node_modules/tsx/dist/cli.mjs"), join(projectRoot, "src/main.ts"), "--stdio", "--env-file", envPath],
    cwd: projectRoot, stderr: "pipe", env: {},
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const client = new Client({ name: "stdio-test", version: "1" });
  t.after(async () => { await client.close(); await transport.close(); rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "modern-wiz-mcp");
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), coreTools);
  // This invalid request tests the child process without any upstream network calls.
  const invalid = await client.callTool({ name: "get_article", arguments: { docId: "../invalid" } });
  assert.equal(invalid.isError, true);
  assert.equal(stderr.includes("synthetic-token"), false);
});
