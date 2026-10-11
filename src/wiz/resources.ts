import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WizError } from "../errors.js";

const remoteLimit = 8 * 1024 * 1024;
const inlineLimit = 1024 * 1024;
const imageTypes = {
  png: { mime: "image/png", extension: "png" },
  jpeg: { mime: "image/jpeg", extension: "jpg" },
  gif: { mime: "image/gif", extension: "gif" },
  webp: { mime: "image/webp", extension: "webp" },
} as const;
type ImageKind = keyof typeof imageTypes;
export interface ImageFile {
  bytes: Buffer;
  mime: (typeof imageTypes)[ImageKind]["mime"];
  extension: (typeof imageTypes)[ImageKind]["extension"];
  fileName: string;
}
export interface PrepareImageInput {
  url?: string;
  contentBase64?: string;
  fileName?: string;
  alt?: string;
  fetch?: typeof fetch;
  lookup?: (hostname: string) => Promise<string[]>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function imageKind(bytes: Buffer): ImageKind {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  const head = bytes.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype") || head.startsWith("<html")) {
    throw new WizError("INVALID_INPUT", "这个地址最终不是 png、jpeg、gif 或 webp（例如 SVG 或网页），没有上传。");
  }
  throw new WizError("INVALID_INPUT", "只接受 png、jpeg、gif 或 webp 图片。");
}

function displayName(preferred: string | undefined, extension: string) {
  const leaf = (preferred ?? "image").split(/[/\\]/).pop() ?? "image";
  const stem = leaf.replace(/\.[A-Za-z0-9]{1,8}$/, "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80);
  return `${stem || "image"}.${extension}`;
}

function privateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a === 255 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) {
    const value = address.toLowerCase();
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return privateAddress(mapped[1]);
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value);
  }
  return true;
}

function blockedHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isIP(host)) return privateAddress(host);
  return false;
}

async function assertPublicHttps(url: URL, resolve: PrepareImageInput["lookup"]) {
  if (url.protocol !== "https:" || url.username || url.password) throw new WizError("INVALID_INPUT", "只接受不带账号的 https 图片地址。");
  if (blockedHost(url.hostname)) throw new WizError("INVALID_INPUT", "不接受内网或本机图片地址。");
  let addresses: string[];
  try { addresses = await (resolve ?? (async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(record => record.address)))(url.hostname); }
  catch { throw new WizError("INVALID_INPUT", "无法确认图片地址指向的服务器。"); }
  if (!addresses.length || addresses.some(privateAddress)) throw new WizError("INVALID_INPUT", "不接受内网或本机图片地址。");
}

async function readLimited(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new WizError("INVALID_INPUT", "图片超过 8 MB。");
  if (!response.body) throw new WizError("UPSTREAM_ERROR", "图片下载没有返回内容。");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > limit) throw new WizError("INVALID_INPUT", "图片超过 8 MB。");
      chunks.push(Buffer.from(step.value));
    }
  } finally { reader.releaseLock(); }
  if (!total) throw new WizError("INVALID_INPUT", "图片是空文件。");
  return Buffer.concat(chunks, total);
}

/** Reject non-https and private hosts before any note is opened. */
export async function assertRemoteImageUrl(url: string, options: Pick<PrepareImageInput, "lookup" | "signal"> = {}) {
  options.signal?.throwIfAborted();
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new WizError("INVALID_INPUT", "图片地址无效。"); }
  await assertPublicHttps(parsed, options.lookup);
}

/** Download an https image or decode inline base64. The result is sniffed, not trusted from Content-Type. */
export async function prepareImage(input: PrepareImageInput): Promise<ImageFile> {
  if (Number(Boolean(input.url)) + Number(Boolean(input.contentBase64)) !== 1) throw new WizError("INVALID_INPUT", "需要且只能提供一个 https 图片地址或 base64 内容。");
  let bytes: Buffer;
  if (input.contentBase64) {
    if (input.contentBase64.length > Math.ceil(inlineLimit / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.contentBase64) || input.contentBase64.length % 4 !== 0) {
      throw new WizError("INVALID_INPUT", "图片 base64 无效或超过约 1 MB。更大的图片请传 https 地址。");
    }
    bytes = Buffer.from(input.contentBase64, "base64");
    if (!bytes.length || bytes.length > inlineLimit) throw new WizError("INVALID_INPUT", "图片 base64 无效或超过约 1 MB。更大的图片请传 https 地址。");
  } else {
    let current: URL;
    try { current = new URL(input.url!); } catch { throw new WizError("INVALID_INPUT", "图片地址无效。"); }
    const fetcher = input.fetch ?? globalThis.fetch;
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 30_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      await assertPublicHttps(current, input.lookup);
      try { response = await fetcher(current, { redirect: "manual", signal, headers: { Accept: "image/png,image/jpeg,image/gif,image/webp" } }); }
      catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof WizError) throw error;
        throw new WizError("UPSTREAM_ERROR", "暂时无法下载图片，请稍后重试。");
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new WizError("UPSTREAM_ERROR", "图片地址跳转无效。");
      try { current = new URL(location, current); } catch { throw new WizError("UPSTREAM_ERROR", "图片地址跳转无效。"); }
      response = undefined;
    }
    if (!response || !response.ok) throw new WizError("UPSTREAM_ERROR", "图片下载失败。");
    bytes = await readLimited(response, remoteLimit);
  }
  const kind = imageKind(bytes);
  const typed = imageTypes[kind];
  return { bytes, mime: typed.mime, extension: typed.extension, fileName: displayName(input.fileName || input.alt, typed.extension) };
}

export function resourceHash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("base64url");
}

function resourceName(value: unknown): string | undefined {
  const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { result?: unknown }).result) ? (value as { result: unknown[] }).result : undefined;
  const name = list?.[0];
  if (list && !list.length) return undefined;
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,220}\.(png|jpe?g|gif|webp)$/.test(name)) throw new WizError("UPSTREAM_ERROR", "为知未返回有效的图片资源名。");
  return name;
}

export function editorResourceBase(kbServer: string, kbGuid: string, docId: string) {
  return `${new URL(kbServer).origin}/editor/${kbGuid}/${docId}`;
}

/** Upload bytes to the note's editor resource store. An existing hash is reused and not sent again. */
export async function uploadEditorResource(input: {
  kbServer: string; kbGuid: string; docId: string; token: string; file: ImageFile;
  fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number;
}): Promise<string> {
  const fetcher = input.fetch ?? globalThis.fetch;
  const base = editorResourceBase(input.kbServer, input.kbGuid, input.docId);
  const hash = resourceHash(input.file.bytes);
  const headers = {
    "x-live-editor-token": input.token,
    "x-live-editor-base-url": Buffer.from(base, "utf8").toString("base64url"),
  };
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 30_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const send = async (url: string, init: RequestInit) => {
    let response: Response;
    try { response = await fetcher(url, { ...init, redirect: "error", signal }); }
    catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof WizError) throw error;
      throw new WizError("UPSTREAM_ERROR", "暂时无法上传图片，请稍后重试。");
    }
    if (!response.ok) throw new WizError("UPSTREAM_ERROR", "为知拒绝了这张图片，请换 png、jpeg、gif 或 webp 后重试。");
    try { return resourceName(await response.json()); }
    catch (error) {
      if (error instanceof WizError) throw error;
      throw new WizError("UPSTREAM_ERROR", "为知未返回有效的图片资源名。");
    }
  };
  const existing = await send(`${base}/resources/${hash}`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name: input.file.fileName, size: input.file.bytes.length }),
  });
  if (existing) return existing;
  const form = new FormData();
  form.append("file-size", String(input.file.bytes.length));
  form.append("file-hash", hash);
  form.append("file", new Blob([new Uint8Array(input.file.bytes)], { type: input.file.mime }), input.file.fileName);
  const uploaded = await send(`${base}/resources`, { method: "POST", headers: { ...headers, Accept: "application/json" }, body: form });
  if (!uploaded) throw new WizError("UPSTREAM_ERROR", "为知未返回有效的图片资源名。");
  return uploaded;
}
