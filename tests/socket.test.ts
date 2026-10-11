import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type { Connection, Doc } from "sharedb/lib/client/index.js";
import { registerWizTypes } from "../src/wiz/registerTypes.js";
import { openDocument, commitDocument } from "../src/wiz/socket.js";
import { inspectWriteJournal, listWriteJournal } from "../src/wiz/writeJournal.js";
import { applyDocumentOp, composeDocumentOps, diffWizDocuments } from "../src/wiz/operations.js";
import { WizError } from "../src/errors.js";
import type { WizDoc } from "../src/wiz/types.js";

const ShareDB = createRequire(import.meta.url)("sharedb");
registerWizTypes();
const initial: WizDoc = { blocks: [{ id: "paragraph", type: "text", text: [{ insert: "hello" }], comments: ["anchor"], custom: { keep: true } }], meta: { title: "Article", custom: "keep" }, comments: { anchor: { id: "anchor", blocks: [] } }, customRoot: { preserved: true } };
const done = (action: (callback: (error?: Error | null) => void) => void) => new Promise<void>((resolve, reject) => action(error => error ? reject(error) : resolve()));
const text = (data: WizDoc) => data.blocks[0].text?.map(segment => "insert" in segment ? segment.insert : "").join("");
interface FixtureOptions { ackDelay?: number; noHandshake?: boolean; closeOnAck?: boolean; holdOps?: boolean; rejectOps?: boolean }
async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wiz-mcp-socket-"));
  const backend = new ShareDB();
  const admin: Connection = backend.connect();
  const canonical: Doc = admin.get("kb", "article");
  await done(callback => canonical.create(structuredClone(initial), "ot-json1", callback));
  await done(callback => canonical.subscribe(callback));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const messages: Record<string, any>[] = [];
  let activeDocId = "article";
  const sockets = new Set<WebSocket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pendingOps: Array<() => void> = [];
  server.on("connection", socket => {
    sockets.add(socket);
    let authenticated = false;
    const stream = new Duplex({ objectMode: true, read() {}, write(chunk, _encoding, callback) {
      // The fixture requires Wiz auth before exposing the stock ShareDB handshake.
      if (chunk.a === "init" && !authenticated) { callback(); return; }
      const send = () => { if (socket.readyState === 1) socket.send(JSON.stringify(chunk)); };
      if (chunk.a === "op" && !chunk.op && !chunk.create && !chunk.del && !chunk.error) {
        if (options.closeOnAck) socket.close();
        else if (options.ackDelay) {
          const timer = setTimeout(() => { timers.delete(timer); send(); }, options.ackDelay); timers.add(timer);
        } else send();
      } else send();
      callback();
    } });
    backend.listen(stream);
    socket.on("message", bytes => {
      const message = JSON.parse(String(bytes)); messages.push(message);
      if (message.a === "hs") {
        if (options.noHandshake) return;
        if (message.auth?.token !== "synthetic-token") { socket.send(JSON.stringify({ a: "autherror", err: "autherror" })); return; }
        assert.equal(message.auth.appId, "kb"); assert.equal(message.auth.docId, activeDocId);
        authenticated = true;
        stream.push({ ...message, auth: undefined });
      } else if (message.a === "op" && options.rejectOps) {
        socket.send(JSON.stringify({ a: "op", c: message.c, d: message.d, seq: message.seq, src: message.src, error: { code: "DENIED", message: "Synthetic denial" } }));
      } else if (message.a === "op" && options.holdOps) pendingOps.push(() => stream.push(message));
      else stream.push(message);
    });
    socket.on("close", () => { sockets.delete(socket); stream.push(null); stream.destroy(); });
    stream.on("error", () => {});
  });
  const open = (permission: "r" | "w" = "w", overrides: Record<string, unknown> = {}) => {
    activeDocId = typeof overrides.docId === "string" ? overrides.docId : "article";
    return openDocument({ serverUrl: `ws://127.0.0.1:${address.port}`, appId: "kb", docId: activeDocId, token: "synthetic-token", userId: "synthetic-user", permission, timeoutMs: 1000, ...overrides });
  };
  return { open, messages, directory, canonical, sendMalformed: (version: number) => { for (const socket of sockets) socket.send(JSON.stringify({ a: "op", c: "kb", d: "article", v: version, op: ["blocks", 9999, "text", { et: "rich-text", e: [{ delete: 1 }] }] })); }, releaseOps: () => { for (const release of pendingOps.splice(0)) release(); }, async close() {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    admin.close(); await done(callback => backend.close(callback));
    await rm(directory, { recursive: true, force: true });
  } };
}

test("read uses authenticated fetch only and retains every snapshot field", async () => {
  const f = await fixture();
  try {
    const opened = await f.open("r");
    assert.deepEqual(opened.data, initial); assert.equal(opened.version, 1);
    assert.deepEqual(f.messages.map(message => message.a), ["hs", "f"]);
    await assert.rejects(commitDocument(opened, initial, 1, { journalPath: f.directory }), (error: WizError) => error.code === "READ_ONLY");
    opened.close();
  } finally { await f.close(); }
});

test("writer persists before submit and waits for delayed ACK before reporting saved", async () => {
  const f = await fixture({ ackDelay: 100 });
  try {
    const opened = await f.open(); const after = opened.data;
    after.blocks[0].text = [{ insert: "updated" }];
    let finished = false;
    const saving = commitDocument(opened, after, opened.version, { journalPath: f.directory, keepJournal: true }).then(result => { finished = true; return result; });
    await delay(30); assert.equal(finished, false);
    const records = listWriteJournal(f.directory); assert.equal(records.length, 1); assert.equal(records[0].status, "prepared");
    const stored = JSON.parse(await readFile(join(f.directory, `${records[0].requestId}.json`), "utf8"));
    assert.deepEqual(stored.before, initial); assert.deepEqual(stored.proposed, after); assert.ok(stored.operation);
    const result = await saving;
    assert.equal(result.changed, true); assert.equal(result.version, 2); assert.equal(text(result.data), "updated");
    assert.deepEqual(result.data.customRoot, initial.customRoot); assert.deepEqual(result.data.blocks[0].comments, ["anchor"]);
    assert.equal(inspectWriteJournal(f.directory, result.requestId!).status, "acknowledged");
    assert.equal("before" in inspectWriteJournal(f.directory, result.requestId!), false);
    assert.deepEqual(f.messages.map(message => message.a), ["hs", "f", "s", "op"]);
    opened.close();
  } finally { await f.close(); }
});

test("a confirmed write removes the local journal unless retention is enabled", async () => {
  const f = await fixture();
  try {
    const opened = await f.open(); const after = opened.data;
    after.blocks[0].text = [{ insert: "temporary" }];
    const result = await commitDocument(opened, after, opened.version, { journalPath: f.directory });
    assert.equal(result.changed, true);
    assert.deepEqual(listWriteJournal(f.directory), []);
    opened.close();
  } finally { await f.close(); }
});

test("a stale baseline fails before journaling or submitting", async () => {
  const f = await fixture();
  try {
    const opened = await f.open();
    await assert.rejects(commitDocument(opened, opened.data, 0, { journalPath: f.directory }), (error: WizError) => error.code === "VERSION_CONFLICT");
    assert.deepEqual(listWriteJournal(f.directory), []); assert.equal(f.messages.some(message => message.a === "op"), false);
    const result = await commitDocument(opened, opened.data, opened.version, { journalPath: f.directory }); assert.equal(result.changed, false);
    opened.close();
  } finally { await f.close(); }
});

test("simultaneous writes merge with real ShareDB rich-text OT", async () => {
  const f = await fixture({ holdOps: true });
  try {
    const a = await f.open(), b = await f.open();
    const afterA = a.data, afterB = b.data;
    afterA.blocks[0].text = [{ insert: "hello A" }]; afterB.blocks[0].text = [{ insert: "hello B" }];
    const saveA = commitDocument(a, afterA, a.version, { journalPath: f.directory, keepJournal: true });
    const saveB = commitDocument(b, afterB, b.version, { journalPath: f.directory, keepJournal: true });
    await delay(30); f.releaseOps(); await Promise.all([saveA, saveB]); await delay(30);
    assert.deepEqual(a.data, b.data); assert.match(text(a.data)!, /^hello (A B|B A)$/);
    assert.deepEqual(a.data.blocks[0].custom, { keep: true });
    assert.equal(listWriteJournal(f.directory).every(record => record.status === "acknowledged"), true);
    a.close(); b.close();
  } finally { await f.close(); }
});

test("auth failure, abort and handshake timeout close without any write", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.open("r", { token: "expired" }), (error: WizError) => error.code === "AUTH_REQUIRED");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.open("r", { signal: controller.signal }), (error: WizError) => error.code === "CANCELLED");
    assert.equal(f.messages.some(message => message.a === "op"), false);
  } finally { await f.close(); }
  const stalled = await fixture({ noHandshake: true });
  try { await assert.rejects(stalled.open("r", { timeoutMs: 30 }), (error: WizError) => error.code === "TIMEOUT"); }
  finally { await stalled.close(); }
});

for (const mode of ["timeout", "disconnect", "abort"] as const) test(`${mode} after submission keeps an uncertain journal and never replays`, async () => {
  const f = await fixture(mode === "disconnect" ? { closeOnAck: true } : { ackDelay: 2000 });
  try {
    const opened = await f.open(); const after = opened.data; after.blocks[0].text = [{ insert: mode }];
    const controller = new AbortController();
    const saving = commitDocument(opened, after, opened.version, { journalPath: f.directory, timeoutMs: 80, signal: controller.signal });
    if (mode === "abort") setTimeout(() => controller.abort(), 20);
    await assert.rejects(saving, (error: WizError) => error.code === "WRITE_UNCERTAIN" && typeof error.details?.requestId === "string");
    assert.equal(listWriteJournal(f.directory)[0].status, "uncertain");
    await delay(20); assert.equal(f.messages.filter(message => message.a === "op").length, 1);
    assert.equal(text(f.canonical.data as WizDoc), mode); // Persisted upstream even without the ACK.
    opened.close();
  } finally { await f.close(); }
});

test("explicit upstream rejection remains distinct from an uncertain ACK", async () => {
  const f = await fixture({ rejectOps: true });
  try {
    const opened = await f.open(); const after = opened.data; after.blocks[0].text = [{ insert: "denied" }];
    await assert.rejects(commitDocument(opened, after, opened.version, { journalPath: f.directory }), (error: WizError) => error.code === "WRITE_REJECTED");
    assert.equal(listWriteJournal(f.directory)[0].status, "rejected"); assert.deepEqual(f.canonical.data, initial);
    opened.close();
  } finally { await f.close(); }
});

test("model diff handles metadata, nested containers and block IDs atomically", () => {
  const before = structuredClone(initial); before.blocks.push({ id: "code", type: "code", children: ["lines"] }); before.lines = [{ id: "line", type: "code-line", text: [{ insert: "old" }] }];
  const after = structuredClone(before); after.blocks.reverse(); after.meta!.title = "New title"; after.lines = [{ id: "line", type: "code-line", text: [{ insert: "new" }] }, { id: "added", type: "code-line", text: [] }];
  const operation = composeDocumentOps(diffWizDocuments(before, after)); assert.ok(operation); assert.deepEqual(applyDocumentOp(before, operation), after);
});


test("malformed remote operation stops the connection without rollback/replay or process failure", async () => {
  const f = await fixture({ holdOps: true });
  try {
    const opened = await f.open(); const after = opened.data; after.blocks[0].text = [{ insert: "pending" }];
    const saving = commitDocument(opened, after, opened.version, { journalPath: f.directory });
    await delay(20); f.sendMalformed(opened.version);
    await assert.rejects(saving, (error: WizError) => error.code === "WRITE_UNCERTAIN" && error.details?.cause === "INVALID_PROTOCOL");
    assert.equal(listWriteJournal(f.directory)[0].status, "uncertain");
    await delay(20); assert.equal(f.messages.filter(message => message.a === "op").length, 1);
    assert.equal(f.messages.filter(message => message.a === "f").length, 1);
    assert.deepEqual(f.canonical.data, initial); opened.close();
  } finally { await f.close(); }
});

test("creating a missing document waits for the ot-json1 create acknowledgement", async () => {
  const f = await fixture();
  try {
    const data: WizDoc = { blocks: [{ id: "p", type: "text", text: [{ insert: "created" }] }], comments: {} };
    await assert.rejects(f.open("w", { createData: data, journalPath: f.directory }), (error: WizError) => error.code === "ALREADY_EXISTS");
    const opened = await f.open("w", { docId: "fresh", createData: structuredClone(data), journalPath: f.directory, keepJournal: true });
    assert.equal(text(opened.data), "created");
    assert.equal(typeof opened.version, "number");
    assert.equal(typeof opened.requestId, "string");
    const createdOp = f.messages.find(message => message.a === "op" && message.create);
    assert.equal(createdOp?.create?.type, "http://sharejs.org/types/JSONv1");
    const status = inspectWriteJournal(f.directory, opened.requestId!);
    assert.equal(status.status, "acknowledged");
    assert.equal(status.docId, "fresh");
    opened.close();
  } finally { await f.close(); }
});
