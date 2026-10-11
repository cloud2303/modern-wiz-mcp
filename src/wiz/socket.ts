import { Connection, type Doc } from "sharedb/lib/client/index.js";
import WebSocket from "ws";
import { WizError } from "../errors.js";
import { registerWizTypes } from "./registerTypes.js";
import type { WizDoc } from "./types.js";
import { composeDocumentOps, diffWizDocuments } from "./operations.js";
import { discardWriteRecord, finishWriteRecord, prepareWriteRecord, type WriteRecord } from "./writeJournal.js";

export interface OpenDocumentOptions {
  serverUrl: string;
  appId: string;
  docId: string;
  token: string;
  userId: string;
  displayName?: string;
  permission: "r" | "w";
  /** When set, fetch must show no document; the snapshot is created and acknowledged before return. */
  createData?: WizDoc;
  journalPath?: string;
  /** Confirmed writes stay on disk only when set. Uncertain and rejected records always stay. */
  keepJournal?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface OpenedDocument {
  doc: Doc;
  readonly data: WizDoc;
  readonly version: number;
  requestId?: string;
  close(): void;
}
interface Lifetime {
  failure: Promise<never>;
  permission: "r" | "w";
  error?: WizError;
  close(): void;
  fail(error: WizError): void;
}
const lifetimes = new WeakMap<OpenedDocument, Lifetime>();
const writers = new WeakSet<OpenedDocument>();
const createdRequests = new WeakMap<Doc, string>();

function upstreamError(message: Record<string, unknown>): WizError | null {
  const value = message.err ?? message.error;
  const code = typeof value === "string" ? value : value && typeof value === "object" ? String((value as Record<string, unknown>).code ?? "") : "";
  if (/auth.?error|unauthori[sz]ed|token.*expir/i.test(`${message.a ?? ""} ${code}`)) {
    return new WizError("AUTH_REQUIRED", "为知文档凭证已失效，请刷新账号授权后重试。");
  }
  if (message.a === "op" && value !== undefined) return new WizError("WRITE_REJECTED", "为知服务器拒绝了修改，原请求不会自动重放。");
  if (value !== undefined || message.a === "error") return new WizError("UPSTREAM_ERROR", "为知服务器未能处理文档请求。");
  return null;
}

async function withDeadline<T>(lifetime: Lifetime, action: () => Promise<T>, signal?: AbortSignal, timeoutMs = 20_000): Promise<T> {
  if (lifetime.error) throw lifetime.error;
  if (signal?.aborted) {
    const error = new WizError("CANCELLED", "文档请求已取消。"); lifetime.fail(error); throw error;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelled = () => lifetime.fail(new WizError("CANCELLED", "文档请求已取消。"));
  signal?.addEventListener("abort", cancelled, { once: true });
  try {
    timer = setTimeout(() => lifetime.fail(new WizError("TIMEOUT", "等待为知文档响应超时。")), timeoutMs);
    return await Promise.race([action(), lifetime.failure]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", cancelled);
  }
}
const callback = (run: (done: (error?: Error | null) => void) => void) => new Promise<void>((resolve, reject) => {
  run(error => error ? reject(new WizError("UPSTREAM_ERROR", "为知文档请求失败。")) : resolve());
});

function retainAcknowledgement(journalPath: string, record: WriteRecord, version: number, keepJournal: boolean | undefined, message: string) {
  if (!keepJournal) {
    try { discardWriteRecord(journalPath, record.requestId); return; }
    catch { /* A failed delete falls through so the record is not left looking unfinished. */ }
  }
  try { finishWriteRecord(journalPath, record, "acknowledged", { confirmedVersion: version }); }
  catch {
    throw new WizError("WRITE_JOURNAL_ERROR", message, { requestId: record.requestId, confirmed: true, version });
  }
}

async function acknowledgeCreate(doc: Doc, data: WizDoc, journalPath: string, lifetime: Lifetime, keepJournal?: boolean) {
  const proposed = structuredClone(data);
  const record = prepareWriteRecord(journalPath, { collection: doc.collection, docId: doc.id, baseVersion: 0, before: { blocks: [] }, proposed, operation: [["create"]] });
  createdRequests.set(doc, record.requestId);
  try {
    await callback(done => doc.create(proposed, "ot-json1", done));
    retainAcknowledgement(journalPath, record, doc.version as number, keepJournal, "为知已确认创建正文，但完成日志无法写入，请核对该请求。");
  } catch (error) {
    if (error instanceof WizError && error.details?.confirmed) throw error;
    const failure = lifetime.error ?? error;
    const rejected = failure instanceof WizError && failure.code === "WRITE_REJECTED";
    try { finishWriteRecord(journalPath, record, rejected ? "rejected" : "uncertain", { errorCode: failure instanceof WizError ? failure.code : "UPSTREAM_ERROR" }); }
    catch { /* The prepared record remains available for manual reconciliation. */ }
    lifetime.close();
    throw new WizError(rejected ? "WRITE_REJECTED" : "WRITE_UNCERTAIN", rejected ? "为知拒绝了新建正文，请核对后重试。" : "未收到正文创建确认，服务器可能已创建。请先核对请求记录，勿直接重试。", { requestId: record.requestId, cause: failure instanceof WizError ? failure.code : "UPSTREAM_ERROR" });
  }
}

/** The upstream socket stays private. Read fetches only; write subscribes for ShareDB OT. */
export async function openDocument(options: OpenDocumentOptions): Promise<OpenedDocument> {
  if (options.signal?.aborted) throw new WizError("CANCELLED", "文档请求已取消。");
  registerWizTypes();
  const base = new URL(options.serverUrl);
  if (!["ws:", "wss:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new WizError("INVALID_INPUT", "文档服务器地址无效。");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/editor/${encodeURIComponent(options.appId)}/${encodeURIComponent(options.docId)}`;
  const wizHost = base.hostname === "wiz.cn" || base.hostname.endsWith(".wiz.cn");
  const socket = new WebSocket(base, { headers: { Origin: wizHost ? "https://www.wiz.cn" : base.protocol === "wss:" ? `https://${base.host}` : `http://${base.host}` }, maxPayload: 32 * 1024 * 1024 });
  const connection = new Connection(socket);
  connection._initializeHandshake = () => connection.send({ a: "hs", id: connection.id, auth: {
    appId: options.appId, docId: options.docId, token: options.token, userId: options.userId,
    displayName: options.displayName ?? "Wiz MCP", avatarUrl: `https://as.wiz.cn/as/user/avatar/${encodeURIComponent(options.userId)}`,
    permission: options.permission,
  } });
  let rejectFailure!: (error: WizError) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  // A socket can fail between awaited operations; retain its failure without an unhandled rejection.
  void failure.catch(() => {});
  let closed = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const lifetime: Lifetime = {
    failure, permission: options.permission,
    close() {
      if (closed) return;
      closed = true;
      if (!lifetime.error) {
        lifetime.error = new WizError("DOCUMENT_CLOSED", "文档连接已关闭。");
        rejectFailure(lifetime.error);
      }
      // Prevent any ShareDB next-tick flush immediately; no socket is ever rebound.
      connection.canSend = false;
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) {
        socket.close();
        closeTimer = setTimeout(() => socket.terminate(), 250);
        closeTimer.unref();
      }
    },
    fail(error) {
      if (lifetime.error) return;
      lifetime.error = error; rejectFailure(error); lifetime.close();
    },
  };
  connection.on("error", () => lifetime.fail(new WizError("UPSTREAM_ERROR", "文档同步失败。")));
  connection.on("connection error", () => lifetime.fail(new WizError("CONNECTION_CLOSED", "无法连接为知文档服务器。")));
  socket.on("close", () => { if (closeTimer) clearTimeout(closeTimer); if (!closed) lifetime.fail(new WizError("CONNECTION_CLOSED", "为知文档连接已断开。")); });
  socket.on("error", () => lifetime.fail(new WizError("CONNECTION_CLOSED", "无法连接为知文档服务器。")));
  const handleMessage = connection.handleMessage.bind(connection);
  connection.handleMessage = (message: Record<string, unknown>) => {
    if (lifetime.error) return;
    try {
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid message");
      const error = upstreamError(message);
      if (error) { lifetime.fail(error); return; }
      if (message.a === "pong") return;
      handleMessage(message);
    } catch { lifetime.fail(new WizError("INVALID_PROTOCOL", "文档服务器返回了无法处理的同步数据。")); }
  };
  try {
    let doc!: Doc;
    await withDeadline(lifetime, async () => {
      await new Promise<void>((resolve, reject) => {
        if (connection.canSend && connection.id) return resolve();
        const connected = () => { connection.removeListener("connected", connected); resolve(); };
        connection.once("connected", connected);
        void failure.catch(error => { connection.removeListener("connected", connected); reject(error); });
      });
      doc = connection.get(options.appId, options.docId);
      // Wiz rich-text cannot invert a deletion without its original snapshot.
      // A headless request closes on rejection/OT failure and keeps its journal;
      // it neither rolls back with an incomplete inverse nor retries queued ops.
      const recoverable = doc as Doc & { _rollback(error: Error | null): void; _hardRollback(error: Error): void };
      recoverable._rollback = () => lifetime.fail(new WizError("WRITE_REJECTED", "为知拒绝了修改，原请求不会自动重放。"));
      recoverable._hardRollback = () => lifetime.fail(new WizError("INVALID_PROTOCOL", "文档操作无法合并，请重新读取并核对写入请求。"));
      doc.on("error", () => lifetime.fail(new WizError("UPSTREAM_ERROR", "为知文档同步失败。")));
      await callback(done => doc.fetch(done));
      const exists = Array.isArray((doc.data as WizDoc | undefined)?.blocks);
      if (options.createData) {
        if (options.permission !== "w") throw new WizError("READ_ONLY", "创建协同文档需要可写连接。");
        if (exists) throw new WizError("ALREADY_EXISTS", "协同文档已存在，没有重复创建。");
        if (!options.journalPath) throw new WizError("INVALID_INPUT", "创建文档需要写入日志。");
        if (!Array.isArray(options.createData.blocks) || !options.createData.blocks.length) throw new WizError("INVALID_DOCUMENT", "新建正文没有有效的块。");
        await acknowledgeCreate(doc, options.createData, options.journalPath, lifetime, options.keepJournal);
      } else if (options.permission === "w") await callback(done => doc.subscribe(done));
      if (!Array.isArray((doc.data as WizDoc | undefined)?.blocks) || !Number.isInteger(doc.version)) {
        throw new WizError("INVALID_SNAPSHOT", "为知未返回有效的协同文档快照。");
      }
    }, options.signal, options.timeoutMs);
    const opened: OpenedDocument = {
      doc,
      get data() { return structuredClone(doc.data as WizDoc); },
      get version() { return doc.version as number; },
      ...(options.createData ? { requestId: createdRequests.get(doc) } : {}),
      close: () => lifetime.close(),
    };
    lifetimes.set(opened, lifetime);
    return opened;
  } catch (error) {
    lifetime.close(); throw error;
  }
}

export interface CommitOptions { journalPath: string; keepJournal?: boolean; signal?: AbortSignal; timeoutMs?: number }
export interface CommitResult { data: WizDoc; version: number; changed: boolean; requestId?: string }

/** expectedVersion guards this client's baseline; concurrent upstream writers still merge through OT. */
export async function commitDocument(opened: OpenedDocument, after: WizDoc, expectedVersion: number, options: CommitOptions): Promise<CommitResult> {
  const lifetime = lifetimes.get(opened);
  if (!lifetime || lifetime.error) throw lifetime?.error ?? new WizError("DOCUMENT_CLOSED", "文档连接已关闭。");
  if (lifetime.permission !== "w") throw new WizError("READ_ONLY", "该文档连接只允许读取。");
  if (writers.has(opened)) throw new WizError("WRITE_IN_PROGRESS", "该文档连接正在保存修改。");
  if (opened.doc.version !== expectedVersion || opened.doc.hasWritePending()) throw new WizError("VERSION_CONFLICT", "文章已发生变化，请重新读取后计算修改。", { expectedVersion, currentVersion: opened.doc.version });
  if (options.signal?.aborted) throw new WizError("CANCELLED", "文档请求已取消。");
  const before = opened.data;
  const operation = composeDocumentOps(diffWizDocuments(before, after));
  if (!operation) return { data: before, version: opened.version, changed: false };
  writers.add(opened);
  let record: WriteRecord | undefined;
  try {
    record = prepareWriteRecord(options.journalPath, { collection: opened.doc.collection, docId: opened.doc.id, baseVersion: expectedVersion, before, proposed: after, operation });
    await withDeadline(lifetime, () => callback(done => opened.doc.submitOp(operation, { source: "wiz-mcp" }, done)), options.signal, options.timeoutMs);
    const result = { data: opened.data, version: opened.version, changed: true, requestId: record.requestId };
    retainAcknowledgement(options.journalPath, record, result.version, options.keepJournal, "为知已确认保存，但完成日志无法写入，请核对该请求。");
    return result;
  } catch (error) {
    if (!record) throw error;
    if (error instanceof WizError && error.details?.confirmed) throw error;
    const rejected = error instanceof WizError && error.code === "WRITE_REJECTED";
    try { finishWriteRecord(options.journalPath, record, rejected ? "rejected" : "uncertain", { errorCode: error instanceof WizError ? error.code : "UPSTREAM_ERROR" }); }
    catch { /* The prepared record remains available for manual reconciliation. */ }
    lifetime.close();
    throw new WizError(rejected ? "WRITE_REJECTED" : "WRITE_UNCERTAIN", rejected ? "为知拒绝了修改，请核对原内容。" : "未收到保存确认，服务器可能已保存。请先核对请求记录和最新文章，勿直接重试。", { requestId: record.requestId, cause: error instanceof WizError ? error.code : "UPSTREAM_ERROR" });
  } finally { writers.delete(opened); }
}
