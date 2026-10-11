import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { WizArticles } from "../src/articles.js";
import { resourceHash } from "../src/wiz/resources.js";
import type { WizAuthManager, WizRequestOptions, Account } from "../src/auth.js";
import { WizError } from "../src/errors.js";
import type { OpenedDocument } from "../src/wiz/socket.js";
import type { WizDoc } from "../src/wiz/types.js";

const account: Account = { kbServer: "https://test.wiz.cn", kbGuid: "kb", userGuid: "user", userId: "owner@example.com", token: "account-secret" };
const document: WizDoc = { blocks: [{ id: "paragraph", type: "text", text: [{ insert: "Original article" }] }], meta: { title: "Title" } };
type Options = ConstructorParameters<typeof WizArticles>[1];
function fixture(t: TestContext, request: (path: string, options: WizRequestOptions) => unknown | Promise<unknown>, options: Partial<Options> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "wiz-articles-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const auth = { getAccount: async () => ({ ...account }), request: async (path: string, input?: WizRequestOptions) => request(path, input ?? {}) } as unknown as WizAuthManager;
  return new WizArticles(auth, { journalPath: join(directory, "writes"), timeoutMs: 1000, ...options });
}
const metadata = () => ({ info: { type: "collaboration", title: "Title", category: "/Notes/" } });
function opened(close = () => {}, version = 5): OpenedDocument {
  return { data: structuredClone(document), version, close, doc: {} } as OpenedDocument;
}
const readRequest = (path: string) => path.includes("/download/") ? metadata() : { editorToken: "editor-secret" };
const isCode = (code: string) => (error: unknown) => error instanceof WizError && error.code === code;

test("article list sends category pagination and normalizes search results from the actual upstream endpoint", async t => {
  const calls: Array<{ path: string; options: WizRequestOptions }> = [];
  const note = { docGuid: "doc", title: "Article", category: "/Notes/", abstractText: "Context", type: "collaboration", dataModified: 123 };
  const service = fixture(t, (path, options) => {
    calls.push({ path, options });
    return path.includes("/search/") ? [note, { ...note, docGuid: "second" }] : [note];
  });
  const list = await service.listArticles({ folder: "/Notes/", offset: 20, limit: 1 });
  assert.equal(calls[0].path, "/ks/note/list/category/kb");
  assert.deepEqual(calls[0].options.query, { category: "/Notes/", start: "20", count: "1", withAbstract: "true" });
  assert.equal(list.nextOffset, 21);
  assert.deepEqual(list.articles[0], { docId: "doc", title: "Article", category: "/Notes/", abstract: "Context", modified: 123, type: "collaboration" });
  const search = await service.searchArticles({ query: "关键词 & exact", folder: "/Notes/", limit: 1 });
  assert.equal(calls[1].path, "/ks/note/search/kb");
  assert.deepEqual(calls[1].options.query, { ss: "关键词 & exact", withAbstract: "true" });
  assert.equal(search.folder, "/Notes/");
  assert.equal(search.articles.length, 1);
  assert.equal(search.returnedByUpstream, 2);
  assert.equal(search.truncated, true);
  const defaults = await Promise.all([service.listArticles({}), service.searchArticles({ query: "关键词 & exact" })]);
  assert.equal(defaults[0].folder, "/AI/");
  assert.ok(calls.some(call => call.options.query?.category === "/AI/"));
  assert.equal(defaults[1].folder, "/AI/");
  assert.equal(defaults[1].articles.length, 0);
});

test("traditional html notes become markdown without opening a collaboration socket", async t => {
  const calls: Array<{ path: string; data: string | undefined }> = [];
  const html = "<html><head><title>忽略</title></head><body><h1>旧笔记</h1><div>正文 <b>重点</b></div><img src=\"index_files/figure.png\"><script>alert(1)</script></body></html>";
  const service = fixture(t, (path, options) => {
    calls.push({ path, data: options.query?.downloadData });
    if (options.query?.downloadData === "1") return { info: { type: "document", title: "旧笔记", category: "/AI/", version: 4 }, html };
    return { info: { type: "document", title: "旧笔记", category: "/AI/", version: 4 } };
  }, { open: async () => assert.fail("traditional note must not open a socket") });
  const article = await service.getArticle({ docId: "doc", includeBlocks: true });
  assert.equal(article.type, "document");
  assert.equal(article.version, 4);
  assert.match(article.markdown, /^# 旧笔记\n\n正文 \*\*重点\*\*/);
  assert.match(article.markdown, /!\[]\(https:\/\/test\.wiz\.cn\/ks\/share\/resources\/kb\/doc\/index_files\/figure\.png\)$/);
  assert.equal(article.markdown.includes("alert"), false);
  assert.equal(article.warnings[0], "这是传统 HTML 笔记，只能读取，不能修改。");
  assert.equal(article.warnings.includes("传统笔记没有协同块。"), true);
  assert.equal(article.document, undefined);
  assert.deepEqual(calls.map(call => call.data), ["0", "1"]);
  await assert.rejects(service.updateArticle({ docId: "doc", expectedVersion: 4, markdown: "# 旧笔记\n\n改" }), isCode("UNSUPPORTED_NOTE"));
  assert.equal(calls.some(call => call.path.includes("/tokens")), false);
});

test("lite notes keep pre markdown and a collaboration image reference becomes a signed proxy url", async t => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const html = "<html><body><pre># 旧笔记\n\n![图](index_files/figure.png)</pre></body></html>";
  let fetched = "";
  const service = fixture(t, path => path.endsWith("/tokens") ? { editorToken: "editor-secret" } : { info: { type: path.includes("doc") ? "collaboration" : "document", title: "旧笔记", category: "/AI/", version: 2 }, html }, {
    resourceSecret: "proxy-secret",
    fetch: async (url, init) => {
      fetched = String(url);
      assert.equal(new Headers(init?.headers).get("x-live-editor-token"), "editor-secret");
      return new Response(png, { status: 200 });
    },
  });
  const legacy = await service.getArticle({ docId: "legacy" });
  assert.match(legacy.markdown, /^# 旧笔记/);
  assert.match(legacy.markdown, /https:\/\/test\.wiz\.cn\/ks\/share\/resources\/kb\/legacy\/index_files\/figure\.png/);
  const issued = await service.imageProxyUrl({ uri: "wiz://resources/doc/figure.png", base: "http://127.0.0.1:8790" });
  const wrapped = await service.imageProxyUrl({ uri: "![图](<wiz://resources/doc/figure.png>)", base: "http://127.0.0.1:8790" });
  assert.equal(new URL(wrapped.url).pathname, new URL(issued.url).pathname);
  const url = new URL(issued.url);
  const image = await service.readProxiedImage({ docId: "doc", name: "figure.png", exp: url.searchParams.get("exp") ?? "", sig: url.searchParams.get("sig") ?? "" });
  assert.equal(image.mime, "image/png");
  assert.equal(fetched, "https://test.wiz.cn/editor/kb/doc/resources/figure.png");
  await assert.rejects(service.readProxiedImage({ docId: "doc", name: "figure.png", exp: "1", sig: "nope" }), isCode("AUTH_REQUIRED"));
});

test("article reads open read-only, convert the snapshot and always close without committing", async t => {
  let closes = 0;
  const calls: string[] = [];
  const service = fixture(t, (path, options) => {
    calls.push(path);
    if (path.endsWith("/tokens")) assert.equal(options.method, "POST");
    return readRequest(path);
  }, {
    open: async options => {
      assert.equal(options.permission, "r");
      assert.equal(options.serverUrl, "wss://test.wiz.cn");
      assert.equal(options.token, "editor-secret");
      return opened(() => closes++);
    },
    commit: async () => assert.fail("read must not submit any modification"),
  });
  const article = await service.getArticle({ docId: "doc", includeBlocks: true });
  assert.equal(article.version, 5);
  assert.equal(article.markdown.trim(), "Original article");
  assert.deepEqual(article.document, document);
  assert.equal(JSON.stringify(article).includes("secret"), false);
  assert.deepEqual(calls, ["/ks/note/download/kb/doc", "/ks/note/kb/doc/tokens"]);
  assert.equal(closes, 1);
});

test("a version conflict closes the writable connection without submitting stale content", async t => {
  let closes = 0;
  const service = fixture(t, readRequest, {
    open: async options => { assert.equal(options.permission, "w"); return opened(() => closes++, 6); },
    commit: async () => assert.fail("stale input must never be committed"),
  });
  await assert.rejects(service.updateArticle({ docId: "doc", expectedVersion: 5, edits: [{ blockId: "paragraph", oldText: "Original", newText: "New" }] }),
    error => error instanceof WizError && error.code === "VERSION_CONFLICT" && error.details?.actualVersion === 6);
  assert.equal(closes, 1);
});

test("same-document writes return BUSY until the first commit receives confirmation", async t => {
  let openedCount = 0;
  let acknowledge!: () => void;
  let entered!: () => void;
  const inCommit = new Promise<void>(resolve => { entered = resolve; });
  const service = fixture(t, readRequest, {
    open: async () => { openedCount++; return opened(); },
    commit: async (_opened, after) => {
      entered();
      await new Promise<void>(resolve => { acknowledge = resolve; });
      return { data: after, version: 6, changed: true };
    },
  });
  const input = { docId: "doc", expectedVersion: 5, edits: [{ blockId: "paragraph", oldText: "Original", newText: "Updated" }] };
  const first = service.updateArticle(input);
  await inCommit;
  await assert.rejects(service.updateArticle(input), isCode("BUSY"));
  assert.equal(openedCount, 1);
  acknowledge();
  assert.equal((await first).saved, true);
});

test("saved:true is returned only after commit ACK with the confirmed content and version", async t => {
  let closes = 0;
  let acknowledge!: () => void;
  let entered!: () => void;
  let settled = false;
  const inCommit = new Promise<void>(resolve => { entered = resolve; });
  const service = fixture(t, readRequest, {
    open: async () => opened(() => closes++),
    commit: async (_opened, after, expectedVersion, options) => {
      assert.equal(expectedVersion, 5);
      assert.ok(options.journalPath.endsWith("writes"));
      assert.equal(after.blocks[0].id, "paragraph");
      assert.equal((after.blocks[0].text?.[0] as { insert: string }).insert, "Updated article");
      entered();
      await new Promise<void>(resolve => { acknowledge = resolve; });
      return { data: after, version: 6, changed: true, requestId: "00000000-0000-4000-8000-000000000001" };
    },
  });
  const pending = service.updateArticle({ docId: "doc", expectedVersion: 5, edits: [{ blockId: "paragraph", oldText: "Original", newText: "Updated" }] }).then(result => { settled = true; return result; });
  await inCommit;
  assert.equal(settled, false);
  assert.equal(closes, 0);
  acknowledge();
  const result = await pending;
  assert.equal(result.saved, true);
  assert.equal(result.version, 6);
  assert.equal(result.markdown.trim(), "Updated article");
  assert.equal(result.requestId, "00000000-0000-4000-8000-000000000001");
  assert.equal(closes, 1);
});

test("failed commits release the writer lock and close the connection without reporting saved", async t => {
  let closes = 0;
  let attempts = 0;
  const service = fixture(t, readRequest, {
    open: async () => opened(() => closes++),
    commit: async (_opened, after) => {
      if (++attempts === 1) throw new WizError("WRITE_UNCERTAIN", "Missing ACK", { requestId: "00000000-0000-4000-8000-000000000001" });
      return { data: after, version: 6, changed: true };
    },
  });
  const input = { docId: "doc", expectedVersion: 5, edits: [{ blockId: "paragraph", oldText: "Original", newText: "Updated" }] };
  await assert.rejects(service.updateArticle(input), isCode("WRITE_UNCERTAIN"));
  assert.equal(closes, 1);
  assert.equal((await service.updateArticle(input)).saved, true);
  assert.equal(closes, 2);
});

test("create registers a collaboration note only after the editor snapshot is acknowledged", async t => {
  const calls: Array<{ path: string; options: WizRequestOptions }> = [];
  let closes = 0;
  const service = fixture(t, (path, options) => {
    calls.push({ path, options });
    if (path.endsWith("/tokens")) return { editorToken: "editor-secret" };
    if (path.includes("/note/upload/")) return {};
    throw new Error(`unexpected ${path}`);
  }, {
    open: async options => {
      assert.equal(options.permission, "w");
      assert.equal(options.docId.length > 0, true);
      assert.ok(options.createData);
      assert.equal(options.createData.blocks[0]?.text?.[0] && "insert" in options.createData.blocks[0].text[0] && options.createData.blocks[0].text[0].insert, "Hello");
      return { data: options.createData, version: 1, requestId: "00000000-0000-4000-8000-000000000009", close: () => { closes++; }, doc: {} } as unknown as OpenedDocument;
    },
  });
  const created = await service.createArticle({ title: "计划", folder: "Projects", markdown: "Hello", tags: "work" });
  assert.equal(created.saved, true);
  assert.equal(created.title, "计划");
  assert.equal(created.category, "/Projects/");
  assert.equal(created.markdown.trim(), "Hello");
  assert.equal(created.requestId, "00000000-0000-4000-8000-000000000009");
  assert.equal(JSON.stringify(created).includes("owner@example.com"), false);
  assert.equal(JSON.stringify(created).includes("editor-secret"), false);
  const upload = calls.find(call => call.path.includes("/note/upload/"));
  assert.ok(upload);
  assert.equal(upload.options.method, "POST");
  assert.equal(upload.path, `/ks/note/upload/kb/${created.docId}`);
  const body = upload.options.body as Record<string, unknown>;
  assert.equal(body.type, "collaboration");
  assert.equal(body.title, "计划");
  assert.equal(body.category, "/Projects/");
  assert.equal(body.owner, "owner@example.com");
  assert.equal(body.collaborationStatus, "normal");
  assert.equal(body.status, "localInfoModified");
  assert.equal(body.version, 0);
  assert.equal(body.tags, "work");
  assert.equal(body.docGuid, created.docId);
  assert.equal(closes, 1);
  assert.deepEqual(calls.map(call => call.path), [`/ks/note/kb/${created.docId}/tokens`, upload.path]);
});

test("create uploads https images before the note is listed and never stores the remote address", async t => {
  const calls: string[] = [];
  const service = fixture(t, (path, options) => {
    calls.push(path);
    if (path.endsWith("/tokens")) return { editorToken: "editor-secret" };
    if (path.includes("/note/upload/")) return {};
    throw new Error(`unexpected ${path}`);
  }, {
    lookup: publicLookup,
    fetch: async (url, init) => {
      const href = String(url);
      if (href === "https://cdn.example/pic.png") return new Response(png, { status: 200 });
      if (href.endsWith(`/resources/${resourceHash(png)}`)) return Response.json([]);
      assert.match(href, /^https:\/\/test\.wiz\.cn\/editor\/kb\/[^/]+\/resources$/);
      assert.equal(new Headers(init?.headers).get("x-live-editor-token"), "editor-secret");
      return Response.json(["stored-picture.png"]);
    },
    open: async options => {
      const image = options.createData?.blocks.find(block => block.embedType === "image");
      assert.equal(image?.embedData?.src, "loading");
      assert.equal(JSON.stringify(options.createData).includes("cdn.example"), false);
      return { data: structuredClone(options.createData), version: 1, requestId: "00000000-0000-4000-8000-000000000021", close: () => {}, doc: {} } as unknown as OpenedDocument;
    },
    commit: async (_opened, after) => {
      assert.equal(after.blocks.find(block => block.embedType === "image")?.embedData?.src, "stored-picture.png");
      assert.equal(JSON.stringify(after).includes("cdn.example"), false);
      return { data: after, version: 2, changed: true, requestId: "00000000-0000-4000-8000-000000000022" };
    },
  });
  const created = await service.createArticle({ title: "带图", markdown: "# 带图\n\n![示例](https://cdn.example/pic.png)\n" });
  assert.equal(created.saved, true);
  assert.match(created.markdown, /wiz:\/\/resources\/.+\/stored-picture\.png/);
  assert.equal(created.markdown.includes("cdn.example"), false);
  assert.equal(calls.at(-1)?.includes("/note/upload/"), true);
});

test("a failed image upload does not list the new note", async t => {
  const calls: string[] = [];
  const service = fixture(t, (path) => {
    calls.push(path);
    return { editorToken: "editor-secret" };
  }, {
    lookup: publicLookup,
    fetch: async () => new Response("no", { status: 404 }),
    open: async options => ({ data: structuredClone(options.createData), version: 1, close: () => {}, doc: {} } as unknown as OpenedDocument),
    commit: async () => assert.fail("failed image upload must not commit"),
  });
  await assert.rejects(service.createArticle({ markdown: "![示例](https://cdn.example/pic.png)" }), isCode("IMAGE_UPLOAD_FAILED"));
  assert.equal(calls.some(path => path.includes("/note/upload/")), false);
  await assert.rejects(service.createArticle({ markdown: "![示例](http://cdn.example/pic.png)" }), isCode("INVALID_INPUT"));
});

test("update uploads a new https image before committing the article", async t => {
  let committed = false;
  const service = fixture(t, readRequest, {
    lookup: publicLookup,
    fetch: async (url) => String(url) === "https://cdn.example/pic.png" ? new Response(png, { status: 200 }) : Response.json(String(url).endsWith("/resources") ? ["stored-picture.png"] : []),
    open: async () => opened(),
    commit: async (_opened, after) => {
      committed = true;
      const image = after.blocks.find(block => block.embedType === "image");
      assert.equal(image?.embedData?.src, "stored-picture.png");
      assert.equal(JSON.stringify(after).includes("https://"), false);
      return { data: after, version: 6, changed: true };
    },
  });
  const saved = await service.updateArticle({ docId: "doc", expectedVersion: 5, markdown: "Original article\n\n![示例](https://cdn.example/pic.png)\n" });
  assert.equal(saved.saved, true);
  assert.equal(committed, true);
  assert.match(saved.markdown, /stored-picture\.png/);
});

test("a failed editor create does not register the note", async t => {
  const calls: string[] = [];
  const service = fixture(t, path => { calls.push(path); return { editorToken: "editor-secret" }; }, {
    open: async () => { throw new WizError("WRITE_UNCERTAIN", "未确认", { requestId: "00000000-0000-4000-8000-000000000001" }); },
  });
  await assert.rejects(service.createArticle({ markdown: "Hello" }), isCode("WRITE_UNCERTAIN"));
  assert.equal(calls.some(path => path.includes("/note/upload/")), false);
});

test("registration failure after the editor create reports the document id and closes the socket", async t => {
  let closes = 0;
  const service = fixture(t, path => path.endsWith("/tokens") ? { editorToken: "editor-secret" } : Promise.reject(new WizError("UPSTREAM_ERROR", "登记失败")), {
    open: async () => opened(() => closes++),
  });
  const error = await service.createArticle({ markdown: "Hello" }).catch(caught => caught);
  assert.equal(error instanceof WizError && error.code, "NOTE_NOT_REGISTERED");
  assert.equal(typeof (error as WizError).details?.docId, "string");
  assert.equal(closes, 1);
});

test("delete uploads one document record built from the current note info", async t => {
  const calls: Array<{ path: string; options: WizRequestOptions }> = [];
  const info = { docGuid: "doc", title: "计划", type: "collaboration", version: 14043, owner: "owner@example.com", category: "/My Notes/" };
  const service = fixture(t, (path, options) => {
    calls.push({ path, options });
    if (path.includes("/download/")) return { info };
    if (path.includes("/deleted/upload/")) return {};
    throw new Error(`unexpected ${path}`);
  });
  assert.deepEqual(await service.deleteArticle({ docId: "doc" }), { docId: "doc", deleted: true });
  assert.equal(calls[0].path, "/ks/note/download/kb/doc");
  assert.equal(calls[1].path, "/ks/deleted/upload/kb");
  assert.equal(calls[1].options.method, "POST");
  const records = calls[1].options.body as Array<Record<string, unknown>>;
  assert.equal(records.length, 1);
  assert.equal(records[0].type, "document");
  assert.equal(records[0].deletedGuid, "doc");
  assert.equal(records[0].operatorGuid, "user");
  assert.equal(records[0].kbGuid, "kb");
  assert.equal(records[0].clientType, "WizNoteDesktop");
  assert.equal(records[0].status, "localDataModified");
  assert.equal(records[0].content, JSON.stringify(info));
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const publicLookup = async () => ["93.184.216.34"];

test("upload inserts a new image and leaves an existing image with the same address untouched", async t => {
  const calls: string[] = [];
  let closes = 0;
  const imageDoc: WizDoc = { blocks: [
    { id: "paragraph", type: "text", text: [{ insert: "正文" }] },
    { id: "img", type: "embed", embedType: "image", embedData: { src: "https://cdn.example/pic.png", fileName: "示例" } },
  ] };
  const service = fixture(t, readRequest, {
    lookup: publicLookup,
    fetch: async (url, init) => {
      const href = String(url);
      calls.push(href);
      if (href === "https://cdn.example/pic.png") return new Response(png, { status: 200, headers: { "Content-Type": "image/png" } });
      assert.equal(new Headers(init?.headers).get("x-live-editor-token"), "editor-secret");
      if (href.endsWith(`/resources/${resourceHash(png)}`)) {
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)), { name: "示例.png", size: png.length });
        return Response.json([]);
      }
      assert.equal(href, "https://test.wiz.cn/editor/kb/doc/resources");
      const form = init?.body;
      assert.ok(form instanceof FormData);
      assert.equal(form.get("file-hash"), resourceHash(png));
      assert.equal(form.get("file-size"), String(png.length));
      return Response.json(["uploaded-resource.png"]);
    },
    open: async options => {
      assert.equal(options.permission, "w");
      assert.equal(options.token, "editor-secret");
      return { data: structuredClone(imageDoc), version: 5, close: () => { closes++; }, doc: {} } as unknown as OpenedDocument;
    },
    commit: async (_opened, after, expectedVersion) => {
      assert.equal(expectedVersion, 5);
      assert.equal(after.blocks.length, 3);
      assert.equal(after.blocks[1].id, "img");
      assert.equal(after.blocks[1].embedData?.src, "https://cdn.example/pic.png");
      assert.equal(after.blocks[2].embedData?.src, "uploaded-resource.png");
      assert.equal(after.blocks[2].embedData?.fileType, "image/png");
      assert.equal(after.blocks[2].embedData?.fileName, "示例.png");
      return { data: after, version: 6, changed: true, requestId: "00000000-0000-4000-8000-000000000011" };
    },
  });
  const saved = await service.uploadImage({ docId: "doc", expectedVersion: 5, url: "https://cdn.example/pic.png", alt: "示例" });
  assert.equal(saved.saved, true);
  assert.equal(saved.resource, "uploaded-resource.png");
  assert.match(saved.markdown, /wiz:\/\/resources\/doc\/uploaded-resource\.png/);
  assert.match(saved.markdown, /https:\/\/cdn\.example\/pic\.png/);
  assert.equal(JSON.stringify(saved).includes("editor-secret"), false);
  assert.equal(closes, 1);
  assert.equal(calls[0], "https://cdn.example/pic.png");
});

test("an existing resource hash skips the binary upload", async t => {
  const urls: string[] = [];
  const service = fixture(t, readRequest, {
    fetch: async (url) => {
      urls.push(String(url));
      return Response.json(["already-there.png"]);
    },
    open: async () => opened(),
    commit: async (_opened, after) => {
      assert.equal(after.blocks.at(-1)?.embedData?.src, "already-there.png");
      return { data: after, version: 6, changed: true };
    },
  });
  const saved = await service.uploadImage({ docId: "doc", expectedVersion: 5, contentBase64: png.toString("base64"), fileName: "dot.png" });
  assert.equal(saved.saved, true);
  assert.equal(saved.fileName, "dot.png");
  assert.deepEqual(urls, [`https://test.wiz.cn/editor/kb/doc/resources/${resourceHash(png)}`]);
});

test("a stale version and a private image address do not upload", async t => {
  let fetches = 0;
  let opens = 0;
  const service = fixture(t, readRequest, {
    lookup: publicLookup,
    fetch: async () => { fetches++; return new Response(null, { status: 500 }); },
    open: async () => { opens++; return opened(() => {}, 9); },
    commit: async () => assert.fail("stale image upload must not commit"),
  });
  await assert.rejects(service.uploadImage({ docId: "doc", expectedVersion: 5, url: "https://cdn.example/pic.png" }), isCode("VERSION_CONFLICT"));
  assert.equal(fetches, 0);
  assert.equal(opens, 1);
  await assert.rejects(service.uploadImage({ docId: "doc", expectedVersion: 5, url: "https://127.0.0.1/a.png" }), isCode("INVALID_INPUT"));
  assert.equal(opens, 1);
});

test("delete rejects an invalid id before calling upstream", async t => {
  const service = fixture(t, () => assert.fail("invalid id must not call upstream"));
  await assert.rejects(service.deleteArticle({ docId: "../other" }), isCode("INVALID_INPUT"));
});
