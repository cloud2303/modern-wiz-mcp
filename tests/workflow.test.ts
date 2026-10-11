import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { WebSocketServer } from "ws";
import { WizAuthManager } from "../src/auth.js";
import { WizArticles } from "../src/articles.js";
import { createWizMcp } from "../src/mcp.js";
import { openDocument } from "../src/wiz/socket.js";
import { registerWizTypes } from "../src/wiz/registerTypes.js";
import type { WizDoc } from "../src/wiz/types.js";
import type { Connection } from "sharedb/lib/client/index.js";

const ShareDB = createRequire(import.meta.url)("sharedb");
registerWizTypes();
const callback = (run: (done: (error?: Error | null) => void) => void) => new Promise<void>((resolve, reject) => run(error => error ? reject(error) : resolve()));
const output = (result: CallToolResult) => result.structuredContent as Record<string, any>;

test("AI searches, reads Markdown, saves it, reopens it and checks confirmation through real MCP and ShareDB", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "wiz-mcp-workflow-"));
  const initial: WizDoc = {
    blocks: [
      { id: "heading", type: "text", heading: 1, text: [{ insert: "Project" }] },
      { id: "body", type: "text", text: [{ insert: "hello", attributes: { "style-bold": true } }], comments: ["comment"], custom: { keep: true } },
      { id: "image", type: "embed", embedType: "image", embedData: { src: "uploaded.png", fileName: "图.png", width: 640 }, privateEditorData: { keep: true } },
    ],
    comments: { comment: { id: "comment", blocks: [] } }, meta: { title: "Project", version: 999 }, customRoot: { keep: true },
  };
  const backend = new ShareDB();
  const admin: Connection = backend.connect();
  const canonical = admin.get("kb", "article");
  await callback(done => canonical.create(structuredClone(initial), "ot-json1", done));
  const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => ws.once("listening", resolve));
  const address = ws.address(); assert.ok(address && typeof address === "object");
  const messages: Record<string, any>[] = [];
  ws.on("connection", socket => {
    let authenticated = false;
    const stream = new Duplex({ objectMode: true, read() {}, write(chunk, _encoding, done) {
      if (chunk.a !== "init" || authenticated) if (socket.readyState === 1) socket.send(JSON.stringify(chunk));
      done();
    } });
    backend.listen(stream);
    stream.on("error", () => {});
    socket.on("message", bytes => {
      const message = JSON.parse(String(bytes)); messages.push(message);
      if (message.a === "hs") {
        assert.equal(message.auth.token, "synthetic-editor-token");
        authenticated = true;
        stream.push({ ...message, auth: undefined });
      } else stream.push(message);
    });
    socket.on("close", () => { stream.push(null); stream.destroy(); });
  });
  const auth = new WizAuthManager({ token: "synthetic-account-token", kbGuid: "kb", userGuid: "user", serverUrl: "https://test.wiz.cn",
    sessionPath: join(directory, "session.json"), timeoutMs: 1000, refreshIntervalMs: 60000 }, {
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(new Headers(init?.headers).get("x-wiz-token"), "synthetic-account-token");
      if (url.pathname === "/ks/note/search/kb") return Response.json({ returnCode: 200, result: [{ docGuid: "article", title: "Project", category: "/AI/", type: "collaboration" }] });
      if (url.pathname === "/ks/note/download/kb/article") return Response.json({ returnCode: 200, result: { info: { type: "collaboration", title: "Project" } } });
      if (url.pathname === "/ks/note/kb/article/tokens") return Response.json({ returnCode: 200, result: { editorToken: "synthetic-editor-token" } });
      throw new Error("Unexpected synthetic request");
    }) as typeof fetch,
  });
  const articles = new WizArticles(auth, { journalPath: join(directory, "writes"), keepWriteJournal: true, timeoutMs: 1000,
    open: options => openDocument({ ...options, serverUrl: `ws://127.0.0.1:${address.port}` }),
  });
  const server = createWizMcp(articles), client = new Client({ name: "workflow-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const hits = output(await client.callTool({ name: "search_articles", arguments: { query: "Project" } }));
    assert.equal(hits.articles[0].docId, "article");
    const first = output(await client.callTool({ name: "get_article", arguments: { docId: "article", includeBlocks: true } }));
    assert.equal(first.version, 1); assert.equal(first.document.meta.version, 999);
    assert.match(first.markdown, /wiz:\/\/resources\/article\/uploaded.png/);
    assert.equal(messages.some(message => message.a === "s" || message.a === "op"), false);
    assert.equal(JSON.stringify(first).includes("synthetic-"), false);
    const savedResult = await client.callTool({ name: "update_article", arguments: { docId: "article", expectedVersion: first.version,
      markdown: first.markdown.replace("hello", "hello updated") } });
    assert.ok(!savedResult.isError, JSON.stringify(savedResult));
    const saved = output(savedResult);
    assert.equal(saved.saved, true); assert.equal(saved.version, 2);
    const confirmed = output(await client.callTool({ name: "get_write_status", arguments: { requestId: saved.requestId } }));
    assert.equal(confirmed.status, "acknowledged"); assert.equal("proposed" in confirmed, false);
    const second = output(await client.callTool({ name: "get_article", arguments: { docId: "article", includeBlocks: true } }));
    assert.match(second.markdown, /hello updated/);
    assert.deepEqual(second.document.blocks.map((block: { id: string }) => block.id), initial.blocks.map(block => block.id));
    assert.deepEqual(second.document.blocks[2], initial.blocks[2]);
    assert.deepEqual(second.document.comments, initial.comments); assert.deepEqual(second.document.customRoot, initial.customRoot);
    assert.deepEqual(second.document.blocks[1].custom, { keep: true });
    const edited = output(await client.callTool({ name: "update_article", arguments: { docId: "article", expectedVersion: second.version,
      edits: [{ blockId: "body", oldText: "updated", newText: "final" }] } }));
    assert.equal(edited.saved, true); assert.match(edited.markdown, /hello final/);
    const stale = await client.callTool({ name: "update_article", arguments: { docId: "article", expectedVersion: first.version, markdown: "stale" } });
    assert.equal(stale.isError, true); assert.equal(output(stale).code, "VERSION_CONFLICT");
    assert.equal(messages.filter(message => message.a === "op").length, 2);
    await callback(done => canonical.fetch(done));
    assert.deepEqual((canonical.data as WizDoc).blocks[2], initial.blocks[2]);
    assert.equal((canonical.data as WizDoc).blocks[1].text?.[0].attributes?.["style-bold"], true);
  } finally {
    await client.close(); await server.close(); auth.stop();
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    admin.close(); await callback(done => backend.close(done));
    rmSync(directory, { recursive: true, force: true });
  }
});
