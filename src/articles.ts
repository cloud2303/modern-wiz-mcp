import { createHash, randomUUID } from "node:crypto";
import type { WizAuthManager } from "./auth.js";
import { WizError } from "./errors.js";
import { openDocument, commitDocument } from "./wiz/socket.js";
import { importMarkdown, planArticleUpdate } from "./wiz/markdown.js";
import { assertRemoteImageUrl, prepareImage, uploadEditorResource, type PrepareImageInput } from "./wiz/resources.js";
import { wizDocToMarkdownResult } from "./wiz/toMarkdown.js";
import type { WizBlock, WizDoc } from "./wiz/types.js";
import { inspectWriteJournal } from "./wiz/writeJournal.js";

export interface UpdateInput {
  docId: string;
  expectedVersion: number;
  markdown?: string;
  edits?: Array<{ blockId: string; oldText: string; newText: string }>;
}
export interface CreateInput {
  title?: string;
  folder?: string;
  markdown?: string;
  tags?: string;
}
export interface UploadImageInput {
  docId: string;
  expectedVersion: number;
  url?: string;
  contentBase64?: string;
  fileName?: string;
  alt?: string;
}
interface Options {
  journalPath: string;
  keepWriteJournal?: boolean;
  timeoutMs?: number;
  maxConcurrent?: number;
  open?: typeof openDocument;
  commit?: typeof commitDocument;
  fetch?: typeof fetch;
  lookup?: PrepareImageInput["lookup"];
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function validDocId(value: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new WizError("INVALID_INPUT", "文章标识无效。");
  return value;
}
function noteTitle(value?: string) {
  const title = value?.trim() || "<无标题笔记>";
  if (title.length > 512) throw new WizError("INVALID_INPUT", "标题过长。");
  return title;
}
const defaultFolder = "/AI/";
function noteFolder(value = defaultFolder) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || trimmed.includes("..") || /[\u0000-\u001f\\]/.test(trimmed)) throw new WizError("INVALID_INPUT", "文件夹路径无效。");
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.endsWith("/") ? withSlash : `${withSlash}/`;
}
function noteTags(value?: string) {
  const tags = value?.trim() ?? "";
  if (tags.length > 2000 || /[\u0000-\u001f]/.test(tags)) throw new WizError("INVALID_INPUT", "标签无效。");
  return tags;
}
const contentHash = () => createHash("md5").update(randomUUID()).digest("hex");
interface RemoteImageJob { id: string; url: string; fileName?: string }
/** https 图片留给上传；外链不能留在最终正文里。返回的文档里这些图片暂时是 loading。 */
function remoteImageJobs(doc: WizDoc): { doc: WizDoc; jobs: RemoteImageJob[] } {
  const jobs: RemoteImageJob[] = [];
  let next: WizDoc | undefined;
  for (let index = 0; index < doc.blocks.length; index++) {
    const block = doc.blocks[index];
    const src = block?.type === "embed" && block.embedType === "image" && typeof block.embedData?.src === "string" ? block.embedData.src : "";
    if (!src.startsWith("http://") && !src.startsWith("https://")) continue;
    if (!src.startsWith("https://")) throw new WizError("INVALID_INPUT", "图片必须是 https 地址。写入时服务会下载并上传到为知，不能保存外链。");
    if (!next) next = structuredClone(doc);
    const fileName = typeof block.embedData?.fileName === "string" ? block.embedData.fileName : undefined;
    jobs.push({ id: block.id, url: src, ...(fileName ? { fileName } : {}) });
    next.blocks[index] = { ...next.blocks[index], embedData: { ...next.blocks[index].embedData, src: "loading" } };
  }
  return { doc: next ?? doc, jobs };
}
function emptyDocument(): WizDoc {
  return { blocks: [{ id: randomUUID(), type: "text", text: [] }], comments: {} };
}

function normalizeNote(value: unknown) {
  const note = object(value);
  if (typeof note.docGuid !== "string") throw new WizError("UPSTREAM_ERROR", "为知返回的文章列表无效。");
  return {
    docId: note.docGuid,
    title: typeof note.title === "string" ? note.title : "无标题",
    category: typeof note.category === "string" ? note.category : "",
    abstract: typeof note.abstractText === "string" ? note.abstractText : "",
    modified: note.dataModified ?? null,
    type: typeof note.type === "string" ? note.type : "",
  };
}

export class WizArticles {
  private readonly open: typeof openDocument;
  private readonly commit: typeof commitDocument;
  private active = 0;
  private readonly writing = new Set<string>();

  constructor(private readonly auth: WizAuthManager, private readonly options: Options) {
    this.open = options.open ?? openDocument;
    this.commit = options.commit ?? commitDocument;
  }

  async listFolders(signal?: AbortSignal) {
    const account = await this.auth.getAccount(signal);
    const result = await Promise.all([
      this.auth.request(`/ks/kv/value/${account.kbGuid}`, { query: { key: "folders" }, signal }),
      this.auth.request(`/ks/kv/value/${account.kbGuid}`, { query: { key: "folders_pos" }, signal }),
    ]);
    const value = object(result[0]).value;
    const positions = object(result[1]).value;
    let order: Record<string, number> = {};
    try { order = typeof positions === "string" ? JSON.parse(positions) : {}; } catch { /* Optional sorting. */ }
    const paths = new Set<string>();
    if (typeof value === "string") for (const path of value.split("*")) {
      const parts = path.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) paths.add(`/${parts.slice(0, i).join("/")}/`);
    }
    return { folders: [...paths].map(path => {
      const parts = path.split("/").filter(Boolean);
      return { path, name: parts.at(-1)!, depth: parts.length - 1, position: Number(order?.[path]) || 1 };
    }).sort((a, b) => a.position - b.position || a.path.localeCompare(b.path, "zh-CN")) };
  }

  async listArticles(input: { folder?: string; offset?: number; limit?: number } = {}, signal?: AbortSignal) {
    const account = await this.auth.getAccount(signal);
    const folder = noteFolder(input.folder), offset = input.offset ?? 0, limit = input.limit ?? 50;
    const result = await this.auth.request(`/ks/note/list/category/${account.kbGuid}`, {
      query: { category: folder, start: String(offset), count: String(limit), withAbstract: "true" }, signal,
    });
    if (!Array.isArray(result)) throw new WizError("UPSTREAM_ERROR", "为知返回的文章列表无效。");
    return { folder, articles: result.map(normalizeNote), offset, limit, nextOffset: result.length === limit ? offset + limit : null };
  }

  async searchArticles(input: { query: string; folder?: string; limit?: number }, signal?: AbortSignal) {
    const account = await this.auth.getAccount(signal);
    const folder = noteFolder(input.folder);
    const result = await this.auth.request(`/ks/note/search/${account.kbGuid}`, { query: { ss: input.query, withAbstract: "true" }, signal });
    if (!Array.isArray(result)) throw new WizError("UPSTREAM_ERROR", "为知返回的搜索结果无效。");
    const limit = input.limit ?? 50;
    const matched = result.map(normalizeNote).filter(note => note.category === folder || note.category.startsWith(folder));
    return { folder, articles: matched.slice(0, limit), returnedByUpstream: result.length, truncated: matched.length > limit };
  }

  private async useDocument<T>(docId: string, permission: "r" | "w", signal: AbortSignal | undefined,
    run: (opened: Awaited<ReturnType<typeof openDocument>>, metadata: Record<string, unknown>, editorToken: string) => Promise<T>) {
    validDocId(docId);
    if (this.active >= (this.options.maxConcurrent ?? 8)) throw new WizError("BUSY", "服务正在处理其他文章，请稍后重试。");
    this.active++;
    try {
      let account = await this.auth.getAccount(signal);
      const metadata = object(await this.auth.request(`/ks/note/download/${account.kbGuid}/${docId}`, { query: { downloadInfo: "1", downloadData: "0" }, signal }));
      const info = object(metadata.info);
      if (typeof info.type !== "string") throw new WizError("UPSTREAM_ERROR", "为知未返回文章类型。");
      if (!info.type.toLowerCase().startsWith("collaboration")) throw new WizError("UNSUPPORTED_NOTE", "当前仅支持协同笔记，传统 HTML/ZIW 笔记暂不支持。");
      const tokens = object(await this.auth.request(`/ks/note/${account.kbGuid}/${docId}/tokens`, { method: "POST", signal }));
      if (typeof tokens.editorToken !== "string" || !tokens.editorToken) throw new WizError("AUTH_REQUIRED", "为知未返回文章编辑凭据。");
      // Account renewal may have moved the knowledge server during either HTTP call.
      account = await this.auth.getAccount(signal);
      const opened = await this.open({ serverUrl: account.kbServer.replace(/^https:/, "wss:"), appId: account.kbGuid,
        docId, token: tokens.editorToken, userId: account.userGuid, displayName: "Wiz MCP", permission, signal, timeoutMs: this.options.timeoutMs });
      try { return await run(opened, info, tokens.editorToken); } finally { opened.close(); }
    } finally { this.active--; }
  }

  private describe(docId: string, data: WizDoc, version: number, info: Record<string, unknown>, includeBlocks = false) {
    const result = wizDocToMarkdownResult(data, {
      resourceUrl: name => `wiz://resources/${docId}/${encodeURIComponent(name)}`,
      wikiLinkUrl: id => `wiz://articles/${encodeURIComponent(id)}`,
    });
    if (result.markdown.includes(`wiz://resources/${docId}/`)) result.warnings.push("为知内部图片只保留引用，本服务不把文件再下载出来。在为知客户端里会显示已保存的图片。");
    return {
      docId,
      title: typeof info.title === "string" ? info.title : data.meta?.title ?? "无标题",
      category: typeof info.category === "string" ? info.category : "",
      version,
      markdown: result.markdown,
      warnings: result.warnings,
      ...(includeBlocks ? { document: data } : {}),
      uri: `wiz://articles/${docId}`,
    };
  }

  async getArticle(input: { docId: string; includeBlocks?: boolean }, signal?: AbortSignal) {
    return this.useDocument(input.docId, "r", signal, async (opened, info) => this.describe(input.docId, opened.data, opened.version, info, input.includeBlocks));
  }

  async updateArticle(input: UpdateInput, signal?: AbortSignal) {
    validDocId(input.docId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new WizError("INVALID_INPUT", "更新需要 get_article 返回的 expectedVersion。");
    if (this.writing.has(input.docId)) throw new WizError("BUSY", "这篇文章正在保存，请稍后读取最新版本再重试。");
    this.writing.add(input.docId);
    try {
      return await this.useDocument(input.docId, "w", signal, async (opened, info, editorToken) => {
        if (opened.version !== input.expectedVersion) throw new WizError("VERSION_CONFLICT", "文章已变化，请重新读取后计算修改。", { expectedVersion: input.expectedVersion, actualVersion: opened.version });
        const after = planArticleUpdate(opened.data, { ...input, resourceDocId: input.docId });
        const pending = remoteImageJobs(after);
        let proposed = after;
        if (pending.jobs.length) {
          const account = await this.auth.getAccount(signal);
          proposed = await this.uploadRemoteImages(pending.doc, pending.jobs, { kbServer: account.kbServer, kbGuid: account.kbGuid, docId: input.docId, token: editorToken, signal });
        }
        const saved = await this.commit(opened, proposed, input.expectedVersion, { journalPath: this.options.journalPath, keepJournal: this.options.keepWriteJournal, signal, timeoutMs: this.options.timeoutMs });
        return { ...this.describe(input.docId, saved.data, saved.version, info), saved: true, changed: saved.changed,
          ...(saved.requestId ? { requestId: saved.requestId } : {}), concurrency: "版本在提交前检查；并发修改由上游 OT 合并。" };
      });
    } finally { this.writing.delete(input.docId); }
  }

  getWriteStatus(requestId: string) {
    return inspectWriteJournal(this.options.journalPath, requestId);
  }

  private async uploadRemoteImages(doc: WizDoc, jobs: RemoteImageJob[], context: { kbServer: string; kbGuid: string; docId: string; token: string; signal?: AbortSignal }) {
    const after = structuredClone(doc);
    const stored = new Map<string, { resource: string; fileName: string; fileSize: number; fileType: string }>();
    for (const job of jobs) {
      let uploaded = stored.get(job.url);
      if (!uploaded) {
        const file = await prepareImage({ url: job.url, alt: job.fileName, fetch: this.options.fetch, lookup: this.options.lookup, signal: context.signal, timeoutMs: this.options.timeoutMs });
        const resource = await uploadEditorResource({
          kbServer: context.kbServer, kbGuid: context.kbGuid, docId: context.docId, token: context.token, file,
          fetch: this.options.fetch, signal: context.signal, timeoutMs: this.options.timeoutMs,
        });
        uploaded = { resource, fileName: file.fileName, fileSize: file.bytes.length, fileType: file.mime };
        stored.set(job.url, uploaded);
      }
      const block = after.blocks.find(item => item.id === job.id);
      if (!block?.embedData) throw new WizError("UPSTREAM_ERROR", "图片块在上传前丢失。");
      block.embedData = { ...block.embedData, src: uploaded.resource, fileName: uploaded.fileName, fileSize: uploaded.fileSize, fileType: uploaded.fileType, previewType: block.embedData.previewType ?? "card" };
    }
    return after;
  }

  async createArticle(input: CreateInput = {}, signal?: AbortSignal) {
    const title = noteTitle(input.title);
    const folder = noteFolder(input.folder);
    const tags = noteTags(input.tags);
    const pending = remoteImageJobs(input.markdown === undefined ? emptyDocument() : importMarkdown(input.markdown));
    const document = pending.doc;
    const docId = randomUUID();
    if (this.active >= (this.options.maxConcurrent ?? 8)) throw new WizError("BUSY", "服务正在处理其他文章，请稍后重试。");
    this.active++;
    this.writing.add(docId);
    try {
      let account = await this.auth.getAccount(signal);
      if (!account.userId) throw new WizError("INVALID_CONFIG", "缺少笔记所有者账号。请配置 WIZ_USER_ID，或重新登录以取得登录名。");
      const tokens = object(await this.auth.request(`/ks/note/${account.kbGuid}/${docId}/tokens`, { method: "POST", signal }));
      if (typeof tokens.editorToken !== "string" || !tokens.editorToken) throw new WizError("AUTH_REQUIRED", "为知未返回新建文章的编辑凭据。");
      account = await this.auth.getAccount(signal);
      const opened = await this.open({ serverUrl: account.kbServer.replace(/^https:/, "wss:"), appId: account.kbGuid, docId,
        token: tokens.editorToken, userId: account.userGuid, displayName: "Wiz MCP", permission: "w", createData: document,
        journalPath: this.options.journalPath, keepJournal: this.options.keepWriteJournal, signal, timeoutMs: this.options.timeoutMs });
      try {
        let data = opened.data;
        let version = opened.version;
        let requestId = opened.requestId;
        if (pending.jobs.length) {
          const baseVersion = opened.version;
          try {
            const stored = await this.uploadRemoteImages(opened.data, pending.jobs, { kbServer: account.kbServer, kbGuid: account.kbGuid, docId, token: tokens.editorToken, signal });
            const saved = await this.commit(opened, stored, baseVersion, { journalPath: this.options.journalPath, keepJournal: this.options.keepWriteJournal, signal, timeoutMs: this.options.timeoutMs });
            data = saved.data;
            version = saved.version;
            requestId = saved.requestId ?? requestId;
          } catch (error) {
            if (error instanceof WizError && (error.code === "WRITE_UNCERTAIN" || error.code === "WRITE_JOURNAL_ERROR")) throw error;
            const cause = error instanceof WizError ? error.code : "UPSTREAM_ERROR";
            const message = error instanceof WizError ? error.message : "图片未能上传到为知。";
            throw new WizError("IMAGE_UPLOAD_FAILED", `${message} 笔记未进入列表，请勿直接再次新建。`, { docId, cause });
          }
        }
        const now = Date.now();
        await this.auth.request(`/ks/note/upload/${account.kbGuid}/${docId}`, { method: "POST", signal, body: {
          attachmentCount: 0, category: folder, collaborationStatus: "normal", coverImage: 0, created: now,
          dataMd5: contentHash(), dataModified: now, docGuid: docId, infoMd5: contentHash(), infoModified: now,
          kbGuid: account.kbGuid, markers: "", owner: account.userId, protected: 0, status: "localInfoModified",
          tags, title, type: "collaboration", version: 0,
        } });
        return { ...this.describe(docId, data, version, { title, category: folder, type: "collaboration" }), saved: true,
          ...(requestId ? { requestId } : {}) };
      } catch (error) {
        if (error instanceof WizError && (error.code === "NOTE_NOT_REGISTERED" || error.code === "IMAGE_UPLOAD_FAILED" || error.code === "WRITE_UNCERTAIN" || error.code === "WRITE_JOURNAL_ERROR")) throw error;
        throw new WizError("NOTE_NOT_REGISTERED", "协同正文已创建，但笔记列表登记失败。请勿直接再次新建，先核对该文章标识。", {
          docId, cause: error instanceof WizError ? error.code : "UPSTREAM_ERROR",
        });
      } finally { opened.close(); }
    } finally { this.writing.delete(docId); this.active--; }
  }

  async uploadImage(input: UploadImageInput, signal?: AbortSignal) {
    const docId = validDocId(input.docId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new WizError("INVALID_INPUT", "上传图片需要 get_article 返回的 expectedVersion。");
    if (Number(Boolean(input.url)) + Number(Boolean(input.contentBase64)) !== 1) throw new WizError("INVALID_INPUT", "需要且只能提供一个 https 图片地址或 base64 内容。");
    if (input.url) await assertRemoteImageUrl(input.url, { lookup: this.options.lookup, signal });
    if (this.writing.has(docId)) throw new WizError("BUSY", "这篇文章正在保存，请稍后读取最新版本再重试。");
    this.writing.add(docId);
    try {
      return await this.useDocument(docId, "w", signal, async (opened, info, editorToken) => {
        if (opened.version !== input.expectedVersion) throw new WizError("VERSION_CONFLICT", "文章已变化，请重新读取后计算修改。", { expectedVersion: input.expectedVersion, actualVersion: opened.version });
        const account = await this.auth.getAccount(signal);
        const file = await prepareImage({ ...input, fetch: this.options.fetch, lookup: this.options.lookup, signal, timeoutMs: this.options.timeoutMs });
        const resource = await uploadEditorResource({
          kbServer: account.kbServer, kbGuid: account.kbGuid, docId, token: editorToken, file,
          fetch: this.options.fetch, signal, timeoutMs: this.options.timeoutMs,
        });
        const image: WizBlock = { id: randomUUID(), type: "embed", embedType: "image", embedData: {
          src: resource, fileName: file.fileName, fileSize: file.bytes.length, fileType: file.mime, previewType: "card",
        } };
        const after = structuredClone(opened.data);
        after.blocks.push(image);
        const saved = await this.commit(opened, after, input.expectedVersion, { journalPath: this.options.journalPath, keepJournal: this.options.keepWriteJournal, signal, timeoutMs: this.options.timeoutMs });
        return { ...this.describe(docId, saved.data, saved.version, info), saved: true, resource, fileName: file.fileName, fileSize: file.bytes.length, fileType: file.mime,
          ...(saved.requestId ? { requestId: saved.requestId } : {}) };
      });
    } finally { this.writing.delete(docId); }
  }

  async deleteArticle(input: { docId: string }, signal?: AbortSignal) {
    const docId = validDocId(input.docId);
    if (this.writing.has(docId)) throw new WizError("BUSY", "这篇文章正在保存，请稍后重试。");
    this.writing.add(docId);
    try {
      const account = await this.auth.getAccount(signal);
      const metadata = object(await this.auth.request(`/ks/note/download/${account.kbGuid}/${docId}`, { query: { downloadInfo: "1", downloadData: "0" }, signal }));
      const info = object(metadata.info);
      if (!Object.keys(info).length) throw new WizError("UPSTREAM_ERROR", "为知未返回可删除的文章信息。");
      if (typeof info.docGuid === "string" && info.docGuid !== docId) throw new WizError("UPSTREAM_ERROR", "为知返回的文章标识与请求不一致。");
      const record = {
        clientType: "WizNoteDesktop", content: JSON.stringify({ ...info, docGuid: info.docGuid ?? docId }), created: Date.now(),
        deletedGuid: docId, kbGuid: account.kbGuid, operatorGuid: account.userGuid, status: "localDataModified", type: "document",
      };
      await this.auth.request(`/ks/deleted/upload/${account.kbGuid}`, { method: "POST", body: [record], signal });
      return { docId, deleted: true };
    } finally { this.writing.delete(docId); }
  }
}
