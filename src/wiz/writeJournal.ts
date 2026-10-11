import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { WizError } from "../errors.js";
import type { WizDoc } from "./types.js";
import type { WizOp } from "./operations.js";

export type WriteStatus = "prepared" | "acknowledged" | "rejected" | "uncertain";
export interface WriteRecord {
  schemaVersion: 1;
  requestId: string;
  collection: string;
  docId: string;
  baseVersion: number;
  before: WizDoc;
  proposed: WizDoc;
  operation: WizOp;
  status: WriteStatus;
  createdAt: string;
  updatedAt: string;
  confirmedVersion?: number;
  errorCode?: string;
}
const validRequestId = (value: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);

/** A private, durable audit record; never replay prepared/uncertain writes automatically. */
export function persistWriteRecord(directory: string, record: WriteRecord): void {
  if (!validRequestId(record.requestId)) throw new WizError("INVALID_INPUT", "写入请求标识无效。");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `${record.requestId}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(record));
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, destination);
    // Sync the directory entry too, so a process crash does not lose the rename.
    descriptor = openSync(directory, "r"); fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
  } catch {
    throw new WizError("WRITE_JOURNAL_ERROR", "写入日志无法保存，未确认的请求需要核对。", { requestId: record.requestId });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* Renamed or never created. */ }
  }
}

export function prepareWriteRecord(directory: string, input: Omit<WriteRecord, "schemaVersion" | "requestId" | "status" | "createdAt" | "updatedAt">): WriteRecord {
  const now = new Date().toISOString();
  const record: WriteRecord = { ...structuredClone(input), schemaVersion: 1, requestId: randomUUID(), status: "prepared", createdAt: now, updatedAt: now };
  persistWriteRecord(directory, record);
  return record;
}

export function discardWriteRecord(directory: string, requestId: string): void {
  if (!validRequestId(requestId)) throw new WizError("INVALID_INPUT", "写入请求标识无效。");
  try { unlinkSync(join(directory, `${requestId}.json`)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new WizError("WRITE_JOURNAL_ERROR", "已确认的写入日志无法删除。", { requestId });
  }
}

export function finishWriteRecord(directory: string, record: WriteRecord, status: Exclude<WriteStatus, "prepared">, details: Pick<WriteRecord, "confirmedVersion" | "errorCode"> = {}): WriteRecord {
  const next = { ...record, ...details, status, updatedAt: new Date().toISOString() };
  persistWriteRecord(directory, next);
  return next;
}

function readWriteRecord(directory: string, requestId: string): WriteRecord {
  if (!validRequestId(requestId)) throw new WizError("INVALID_INPUT", "写入请求标识无效。");
  try {
    const record = JSON.parse(readFileSync(join(directory, `${requestId}.json`), "utf8")) as WriteRecord;
    if (record.schemaVersion !== 1 || record.requestId !== requestId || !record.docId || !Number.isInteger(record.baseVersion) || !Array.isArray(record.before?.blocks) || !Array.isArray(record.proposed?.blocks) || !["prepared", "acknowledged", "rejected", "uncertain"].includes(record.status)) throw new Error("Invalid journal");
    return record;
  } catch { throw new WizError("WRITE_JOURNAL_NOT_FOUND", "写入记录不存在或无法读取。"); }
}

export type WriteSummary = Pick<WriteRecord, "requestId" | "docId" | "status" | "baseVersion" | "confirmedVersion" | "updatedAt" | "errorCode">;
function summary(record: WriteRecord): WriteSummary {
  const { requestId, docId, status, baseVersion, confirmedVersion, updatedAt, errorCode } = record;
  return { requestId, docId, status, baseVersion, updatedAt, ...(confirmedVersion === undefined ? {} : { confirmedVersion }), ...(errorCode === undefined ? {} : { errorCode }) };
}

/** Caller-facing status deliberately excludes private article content and operation data. */
export function inspectWriteJournal(directory: string, requestId: string): WriteSummary {
  return summary(readWriteRecord(directory, requestId));
}

export function listWriteJournal(directory: string): WriteSummary[] {
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  return names.filter(name => name.endsWith(".json") && validRequestId(name.slice(0, -5)))
    .map(name => readWriteRecord(directory, name.slice(0, -5))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary);
}
