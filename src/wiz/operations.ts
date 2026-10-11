import Delta from "quill-delta";
import { moveOp, type as json1 } from "ot-json1";
import { richTextSubtype } from "./richText.js";
import type { WizBlock, WizDoc } from "./types.js";

json1.registerSubtype(richTextSubtype);
export type WizOp = unknown[];

/** Change only fields owned by the proposed document; retained fields remain intact. */
function diffFields(path: (string | number)[], before: Record<string, unknown>, after: Record<string, unknown>): WizOp[] {
  const operations: WizOp[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldValue = before[key], newValue = after[key];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    if (oldValue && newValue && typeof oldValue === "object" && typeof newValue === "object" && !Array.isArray(oldValue) && !Array.isArray(newValue)) {
      operations.push(...diffFields([...path, key], oldValue as Record<string, unknown>, newValue as Record<string, unknown>));
    } else {
      operations.push([...path, key, { ...(oldValue === undefined ? {} : { r: true }), ...(newValue === undefined ? {} : { i: newValue }) }]);
    }
  }
  return operations;
}

/** Wiz JSON1 and rich-text diff, independent of the browser editor. Keep IDs when editing. */
export function diffWizDocuments(before: WizDoc, after: WizDoc): WizOp[] {
  const operations: WizOp[] = [];
  const oldFields = { ...before }, newFields = { ...after };
  const isContainer = (value: unknown): value is WizBlock[] => Array.isArray(value) && value.every(block => block && typeof block.id === "string" && typeof block.type === "string");
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[key], next = after[key];
    if (!isContainer(old) || !isContainer(next)) continue;
    delete oldFields[key]; delete newFields[key];
    const remaining = [...old];
    const wanted = new Set(next.map(block => block.id));
    for (let index = remaining.length - 1; index >= 0; index--) if (!wanted.has(remaining[index].id)) {
      operations.push([key, index, { r: true }]); remaining.splice(index, 1);
    }
    for (let index = 0; index < next.length; index++) {
      const block = next[index];
      const existing = remaining.findIndex(value => value.id === block.id);
      if (existing < 0) {
        operations.push([key, index, { i: block }]); remaining.splice(index, 0, block); continue;
      }
      if (existing !== index) {
        operations.push(moveOp([key, existing], [key, index]) as WizOp);
        remaining.splice(index, 0, remaining.splice(existing, 1)[0]);
      }
      const oldBlock = remaining[index];
      const oldProps = { ...oldBlock }, newProps = { ...block };
      if (Array.isArray(oldBlock.text) && Array.isArray(block.text)) {
        const edits = new Delta(oldBlock.text as any[]).diff(new Delta(block.text as any[])).ops;
        if (edits.length) operations.push([key, index, "text", { et: "rich-text", e: edits }]);
        delete oldProps.text; delete newProps.text;
      }
      operations.push(...diffFields([key, index], oldProps, newProps));
    }
  }
  return [...operations, ...diffFields([], oldFields, newFields)];
}

/** Submit all related edits as one atomic ShareDB operation. */
export function composeDocumentOps(operations: WizOp[]): WizOp | null {
  const compose = json1.compose!;
  let result = null as Parameters<typeof compose>[0];
  for (const operation of operations) result = compose(result, operation as Parameters<typeof compose>[1]);
  return result as WizOp | null;
}

export function applyDocumentOp(data: WizDoc, operation: WizOp): WizDoc {
  return json1.apply(data, operation as Parameters<typeof json1.apply>[1]) as WizDoc;
}
