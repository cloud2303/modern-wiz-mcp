import { randomUUID } from "node:crypto";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import Delta from "quill-delta";
import { WizError } from "../errors.js";
import type { TextSegment, WizBlock, WizDoc } from "./types.js";

const parser = new MarkdownIt({ html: true, linkify: false, typographer: false });
// Tokenize even invalid destinations so our importer can report them instead of turning a link into prose.
parser.validateLink = () => true;
const id = () => randomUUID();
const marks = new Set(["style-bold", "style-italic", "style-strikethrough", "style-code", "style-underline", "style-sub", "style-super", "link"]);
const structuralFields = new Set(["id", "type", "text", "heading", "quoted", "level", "ordered", "groupId", "start", "textOnly", "checkbox", "children", "language", "code", "rows", "cols", "embedType", "embedData"]);
const textTypes = new Set(["text", "heading", "list", "code-line"]);
const unsupported = (feature: string): never => { throw new WizError("UNSUPPORTED_MARKDOWN", `Markdown 格式不受支持：${feature}。请使用受支持的 Markdown 或块内 edits。`); };
const unsafe = (block: WizBlock, reason: string): never => { throw new WizError("UNSAFE_REPLACEMENT", `块 ${block.id} ${reason}，不能安全地整篇替换；请使用 blockId + oldText + newText 的 edits。`, { blockId: block.id }); };
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const clone = <T>(value: T): T => structuredClone(value);

function safeUrl(value: string): string {
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1].toLowerCase();
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || (scheme && !["https", "http", "mailto", "tel", "wiz"].includes(scheme))) unsupported("链接协议");
  return value;
}

interface ListState { level: number; ordered: boolean; groupId: string; start: number; used: boolean }
type InlinePart = { text: TextSegment[] } | { image: WizBlock };

/** Parse Markdown into the editor's block/container model without a DOM or code execution. */
export function importMarkdown(markdown: string): WizDoc {
  if (typeof markdown !== "string" || !markdown.trim()) throw new WizError("INVALID_UPDATE", "Markdown 内容不能为空。");
  if (markdown.length > 2_000_000) throw new WizError("INVALID_UPDATE", "Markdown 内容超过 2 MB 限制。");
  const doc: WizDoc = { blocks: [], comments: {}, meta: {} };
  const source = markdown.replace(/\r\n?/g, "\n"), sourceLines = source.split("\n");
  const tokens = parser.parse(source, {});
  let position = 0;

  function inline(children: Token[]): InlinePart[] {
    const parts: InlinePart[] = [];
    let delta = new Delta();
    const stack: { key: string; value: unknown }[] = [];
    const attributes = () => Object.fromEntries(stack.map(({ key, value }) => [key, value]));
    const flush = () => { if (delta.ops.length) parts.push({ text: delta.ops as TextSegment[] }); delta = new Delta(); };
    const open = (key: string, value: unknown = true) => stack.push({ key, value });
    const close = (key: string) => { if (stack.at(-1)?.key !== key) unsupported("不配对的行内格式"); stack.pop(); };
    const linebreak = () => delta.insert(" ", { box: true, type: "br", text: "\n", id: id() });
    for (const token of children) {
      const { type, content } = token;
      if (type === "text") {
        // These Wiz extensions require structured boxes; do not silently import them as prose.
        if (/\[\[[\s\S]+?\]\]|\$\$|(?:^|[^\\])\$[^$\n]+\$(?!\d)/.test(content)) unsupported("数学公式或 Wiki 链接");
        delta.insert(content, attributes());
      } else if (type === "softbreak" || type === "hardbreak") linebreak();
      else if (type === "strong_open") open("style-bold");
      else if (type === "strong_close") close("style-bold");
      else if (type === "em_open") open("style-italic");
      else if (type === "em_close") close("style-italic");
      else if (type === "s_open") open("style-strikethrough");
      else if (type === "s_close") close("style-strikethrough");
      else if (type === "code_inline") delta.insert(content, { ...attributes(), "style-code": true });
      else if (type === "link_open") {
        if (token.attrGet("title")) unsupported("链接 title 属性");
        open("link", safeUrl(token.attrGet("href") ?? ""));
      } else if (type === "link_close") close("link");
      else if (type === "image") {
        if (stack.length) unsupported("带行内格式或外层链接的图片");
        flush();
        const alt = (token.children ?? []).map(child => child.content).join("");
        parts.push({ image: { id: id(), type: "embed", embedType: "image", embedData: {
          src: safeUrl(token.attrGet("src") ?? ""), ...(alt ? { fileName: alt } : {}),
          ...(token.attrGet("title") ? { title: token.attrGet("title") } : {}),
        } } });
      } else if (type === "html_inline") {
        if (/^<br\s*\/?\s*>$/i.test(content)) linebreak();
        else {
          const match = /^<(\/)?(u|sub|sup)>$/i.exec(content);
          if (!match) unsupported("HTML（仅支持无属性的 u/sub/sup/br）");
          const key = ({ u: "style-underline", sub: "style-sub", sup: "style-super" } as Record<string, string>)[match![2].toLowerCase()];
          if (match![1]) close(key); else open(key);
        }
      } else unsupported(`行内 ${type}`);
    }
    if (stack.length) unsupported("未闭合的行内格式");
    flush();
    return parts.length ? parts : [{ text: [] }];
  }

  function addInline(target: WizBlock[], children: Token[], props: Partial<WizBlock> = {}, list?: ListState) {
    const parts = inline(children);
    if (list && parts.some(part => "image" in part)) unsupported("列表内图片");
    if (props.heading && parts.some(part => "image" in part)) unsupported("标题内图片");
    for (const part of parts) {
      if ("image" in part) target.push({ ...part.image, ...props });
      else {
        const block: WizBlock = { id: id(), type: list ? "list" : "text", text: part.text, ...props };
        if (list) {
          Object.assign(block, { level: list.level, ordered: list.ordered, groupId: list.groupId, start: list.start });
          if (list.used) block.textOnly = true;
          else {
            const first = block.text?.[0];
            if (first && "insert" in first && typeof first.insert === "string") {
              const task = /^\[([ xX])\](?: |$)/.exec(first.insert);
              if (task) { block.checkbox = task[1].toLowerCase() === "x" ? "checked" : "unchecked"; first.insert = first.insert.slice(task[0].length); }
            }
          }
          list.used = true;
        }
        target.push(block);
      }
    }
  }

  function parseBlocks(target: WizBlock[], end?: string, quoted = false, list?: ListState) {
    while (position < tokens.length) {
      const token = tokens[position++];
      if (token.type === end) return;
      if (token.type === "paragraph_open" || token.type === "heading_open") {
        if (list?.used) unsupported("列表项内多段内容");
        const value = tokens[position++];
        if (value?.type !== "inline") unsupported("段落结构");
        const heading = token.type === "heading_open" ? Number(token.tag.slice(1)) : undefined;
        if (value.content.trim().toLowerCase() === "[toc]") {
          if (list) unsupported("列表内目录");
          target.push({ id: id(), type: "embed", embedType: "toc", embedData: {}, ...(quoted ? { quoted: true } : {}) });
        } else addInline(target, value.children ?? [], { ...(heading ? { heading } : {}), ...(quoted ? { quoted: true } : {}) }, list);
        if (tokens[position++]?.type !== token.type.replace("_open", "_close")) unsupported("段落结构");
      } else if (token.type === "blockquote_open") {
        if (quoted || list) unsupported("嵌套引用或列表内引用");
        parseBlocks(target, "blockquote_close", true);
      } else if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
        const ordered = token.type === "ordered_list_open", groupId = id();
        let number = Number(token.attrGet("start") ?? 1);
        const closeType = token.type.replace("_open", "_close");
        while (position < tokens.length && tokens[position].type !== closeType) {
          if (tokens[position++]?.type !== "list_item_open") unsupported("列表结构");
          const state: ListState = { level: (list?.level ?? 0) + 1, ordered, groupId, start: number++, used: false };
          if (state.level > 20) unsupported("超过 20 级的列表");
          parseBlocks(target, "list_item_close", quoted, state);
          if (!state.used) addInline(target, [], quoted ? { quoted: true } : {}, state);
        }
        if (tokens[position++]?.type !== closeType) unsupported("未闭合列表");
      } else if (token.type === "fence" || token.type === "code_block") {
        if (list) unsupported("列表内代码块");
        const language = token.info.trim();
        if (language && !/^[\w+#.-]+$/.test(language)) unsupported("代码块附加属性");
        const value = token.content.replace(/\n$/, "");
        const field = ({ mermaid: "mermaidText", plantuml: "plantumlText", flow: "flowchartText", flowchart: "flowchartText" } as Record<string, string>)[language];
        if (field) target.push({ id: id(), type: "embed", embedType: language === "flow" ? "flowchart" : language, embedData: { [field]: value }, ...(quoted ? { quoted: true } : {}) });
        else {
          const container = id();
          doc[container] = value.split("\n").map(line => ({ id: id(), type: "code-line", text: line ? [{ insert: line }] : [] }));
          target.push({ id: id(), type: "code", language: language || null, children: [container], ...(quoted ? { quoted: true } : {}) });
        }
      } else if (token.type === "table_open") {
        if (list) unsupported("列表内表格");
        const table: WizBlock = { id: id(), type: "table", children: [], rows: 0, cols: 0, ...(quoted ? { quoted: true } : {}) };
        let columns = 0;
        const tableTokens = new Set(["thead_open", "thead_close", "tbody_open", "tbody_close", "th_close", "td_close", "tr_close"]);
        while (position < tokens.length && tokens[position].type !== "table_close") {
          const cell = tokens[position++];
          if (cell.type === "tr_open") { table.rows = Number(table.rows) + 1; columns = 0; }
          else if (cell.type === "th_open" || cell.type === "td_open") {
            const content = tokens[position++];
            if (content?.type !== "inline") unsupported("表格单元格结构");
            const container = id(), blocks: WizBlock[] = [];
            addInline(blocks, content.children ?? []);
            doc[container] = blocks;
            table.children!.push(container);
            const align = /^text-align:(left|center|right)$/.exec(cell.attrGet("style") ?? "")?.[1];
            if (align) table[`${container}_align`] = align;
            columns++;
            table.cols = Math.max(Number(table.cols), columns);
          } else if (!tableTokens.has(cell.type)) unsupported(`表格内 ${cell.type}`);
        }
        if (tokens[position++]?.type !== "table_close" || table.children!.length !== Number(table.rows) * Number(table.cols)) unsupported("不规则表格");
        if (Number(table.cols) > 200 || Number(table.rows) > 200) unsupported("超过 200 行或列的表格");
        if (token.map) {
          for (const line of sourceLines.slice(token.map[0], token.map[1])) {
            // CommonMark table pipes must be escaped even inside a code span. markdown-it
            // otherwise pads/truncates rows, which would silently lose article content.
            let cells = 1;
            const raw = line.trim().replace(/^>\s*/, "");
            for (let n = 0; n < raw.length; n++) { if (raw[n] === "\\") n++; else if (raw[n] === "|") cells++; }
            if (raw.startsWith("|")) cells--;
            if (raw.endsWith("|") && !raw.endsWith("\\|")) cells--;
            if (cells !== Number(table.cols)) unsupported("表格行列数不一致（单元格内竖线请使用 \\|）");
          }
        }
        target.push(table);
      } else if (token.type === "hr") {
        if (list) unsupported("列表内分隔线");
        target.push({ id: id(), type: "embed", embedType: "hr", embedData: {}, ...(quoted ? { quoted: true } : {}) });
      } else unsupported(token.type === "html_block" ? "HTML 块" : token.type);
    }
    if (end) unsupported(`缺少 ${end}`);
  }
  parseBlocks(doc.blocks);
  return doc;
}

function container(doc: WizDoc, key: string): WizBlock[] {
  if (!Array.isArray(doc[key])) throw new WizError("INVALID_DOCUMENT", `文档容器 ${key} 缺失或损坏。`);
  return doc[key] as WizBlock[];
}

function visit(doc: WizDoc, callback: (block: WizBlock) => void) {
  const active = new Set<string>(), seen = new Set<string>();
  function blocks(values: WizBlock[]) {
    for (const block of values) {
      if (!block || typeof block.id !== "string" || seen.has(block.id)) throw new WizError("INVALID_DOCUMENT", "文档含无效或重复 blockId。");
      seen.add(block.id); callback(block);
      for (const key of block.children ?? []) {
        if (active.has(key)) throw new WizError("INVALID_DOCUMENT", "文档容器存在循环引用。");
        active.add(key); blocks(container(doc, key)); active.delete(key);
      }
    }
  }
  blocks(doc.blocks);
}

function textChars(segments: TextSegment[] = []): { value: string; attrs: Record<string, unknown> }[] {
  const chars: { value: string; attrs: Record<string, unknown> }[] = [];
  for (const segment of segments) {
    if (!("insert" in segment)) throw new WizError("INVALID_DOCUMENT", "文本快照包含非 insert 操作。");
    const attrs = segment.attributes ?? {};
    const value = attrs.box && attrs.type === "br" ? "\n" : typeof segment.insert === "string" ? segment.insert : "\ufffc";
    // Quill/ShareDB offsets count UTF-16 units, including each half of a surrogate pair.
    for (let index = 0; index < value.length; index++) chars.push({ value: value[index], attrs });
  }
  return chars;
}

function visibleAttributes(attrs: Record<string, unknown>) {
  if (attrs.box && attrs.type !== "br") return attrs;
  return Object.fromEntries(Object.entries(attrs).filter(([key, value]) => marks.has(key) && value).map(([key, value]) => [key, key === "link" ? value : true]));
}

function signature(block: WizBlock, doc: WizDoc): string {
  const delta = new Delta();
  for (const char of textChars(block.text)) delta.insert(char.value, visibleAttributes(char.attrs));
  const common = { quoted: !!block.quoted };
  if (textTypes.has(block.type)) return stable({ ...common, type: block.type === "heading" ? "text" : block.type, text: delta.ops,
    heading: block.heading ?? (block.type === "heading" ? 1 : 0), ...(block.type === "list" ? {
      level: block.level ?? 1, ordered: !!block.ordered, start: block.start ?? 1, textOnly: !!block.textOnly, checkbox: block.checkbox ?? null,
    } : {}) });
  if (block.type === "code") return stable({ ...common, type: "code", language: block.language || null,
    children: (block.children ?? []).map(key => container(doc, key).map(line => signature(line, doc))), code: block.children?.length ? "" : block.code ?? "" });
  if (block.type === "table") return stable({ ...common, type: "table", cols: block.cols, rows: block.rows,
    children: (block.children ?? []).map(key => ({ align: block[`${key}_align`] ?? null, colSpan: block[`${key}_colSpan`] ?? 1, rowSpan: block[`${key}_rowSpan`] ?? 1,
      blocks: container(doc, key).map(child => signature(child, doc)) })) });
  if (block.type === "embed" && block.embedType === "image") return stable({ ...common, type: "embed", embedType: "image",
    src: block.embedData?.src, label: block.embedData?.fileName || block.embedData?.title || "图片" });
  if (block.type === "embed" && block.embedType === "hr") return stable({ ...common, type: "embed", embedType: "hr" });
  if (block.type === "embed") return stable({ ...common, type: "embed", embedType: block.embedType, embedData: block.embedData });
  return stable(block);
}

const extras = (attrs: Record<string, unknown>) => Object.fromEntries(Object.entries(attrs).filter(([key]) => !marks.has(key) && !(attrs.type === "br" && ["box", "type", "text", "id"].includes(key))));

function hasComments(block: WizBlock): boolean {
  return !!block.comments?.length || (block.text ?? []).some(segment => "insert" in segment && Object.keys(segment.attributes ?? {}).some(key => /^comment(?:-|Id$)/.test(key)));
}

function deletionSafe(block: WizBlock, doc: WizDoc) {
  if (!textTypes.has(block.type) && !["code", "table"].includes(block.type) && !(block.type === "embed" && block.embedType === "hr")) unsafe(block, "含富媒体或不支持的结构");
  if (hasComments(block)) unsafe(block, "含评论锚点");
  if (block.type === "embed" && Object.keys(block.embedData ?? {}).length) unsafe(block, "含无法重建的嵌入数据");
  if (Object.keys(block).some(key => !structuralFields.has(key) && key !== "comments" && !block.children?.some(child => key === `${child}_align`))) unsafe(block, "含无法重建的编辑器属性");
  if ((block.text ?? []).some(segment => Object.keys(segment).some(key => key !== "insert" && key !== "attributes")
    || ("insert" in segment && (typeof segment.insert !== "string" || Object.keys(extras(segment.attributes ?? {})).length)))) unsafe(block, "含无法重建的行内数据");
  for (const key of block.children ?? []) for (const child of container(doc, key)) deletionSafe(child, doc);
}

/** Preserve invisible inline metadata on retained characters; reject its destruction. */
function preserveText(before: WizBlock, next: WizBlock): TextSegment[] {
  if ((before.text ?? []).some(segment => Object.keys(segment).some(key => key !== "insert" && key !== "attributes"))) unsafe(before, "含未知文本操作属性");
  const oldChars = textChars(before.text), newChars = textChars(next.text);
  const changes = new Delta().insert(oldChars.map(char => char.value).join("")).diff(new Delta().insert(newChars.map(char => char.value).join("")));
  const origins: (number | undefined)[] = [];
  let offset = 0;
  for (const op of changes.ops) {
    if (typeof op.retain === "number") { for (let n = 0; n < op.retain; n++) origins.push(offset++); }
    else if (typeof op.delete === "number") {
      if (oldChars.slice(offset, offset + op.delete).some(char => Object.keys(extras(char.attrs)).length || (char.attrs.box && char.attrs.type !== "br"))) unsafe(before, "的文本修改会删除评论或未知行内数据");
      offset += op.delete;
    } else if (typeof op.insert === "string") for (let n = 0; n < op.insert.length; n++) origins.push(undefined);
  }
  // Delta.diff omits the final unchanged retain (and is empty for formatting-only changes).
  while (offset < oldChars.length) origins.push(offset++);
  const result = new Delta();
  newChars.forEach((char, index) => {
    const origin = origins[index], metadata = origin === undefined ? {} : extras(oldChars[origin].attrs);
    if (char.attrs.box) {
      // Reuse the existing br box ID where this newline has not changed.
      const old = origin === undefined ? undefined : oldChars[origin];
      result.insert(" ", { ...char.attrs, ...metadata, ...(old?.attrs.type === "br" ? { id: old.attrs.id } : {}) });
    } else result.insert(char.value, { ...char.attrs, ...metadata });
  });
  return result.ops as TextSegment[];
}

function orderedMatches(old: string[], next: string[]): Map<number, number> {
  const matches = new Map<number, number>();
  if (old.length * next.length <= 1_000_000) {
    const width = next.length + 1, dp = new Uint32Array((old.length + 1) * width);
    for (let a = old.length - 1; a >= 0; a--) for (let b = next.length - 1; b >= 0; b--)
      dp[a * width + b] = old[a] === next[b] ? 1 + dp[(a + 1) * width + b + 1] : Math.max(dp[(a + 1) * width + b], dp[a * width + b + 1]);
    let a = 0, b = 0;
    while (a < old.length && b < next.length) {
      if (old[a] === next[b]) { matches.set(b++, a++); }
      else if (dp[(a + 1) * width + b] >= dp[a * width + b + 1]) a++; else b++;
    }
  } else {
    // Bound reconciliation memory for very long articles; order still cannot cross.
    const positions = new Map<string, number[]>();
    old.forEach((key, index) => { const values = positions.get(key) ?? []; values.push(index); positions.set(key, values); });
    let cursor = 0;
    next.forEach((key, index) => { const values = positions.get(key); while (values?.length && values[0] < cursor) values.shift(); if (values?.length) { const match = values.shift()!; matches.set(index, match); cursor = match + 1; } });
  }
  return matches;
}

function replaceMarkdown(before: WizDoc, parsed: WizDoc): WizDoc {
  const result = clone(before), groupIds = new Map<string, string>();
  function addNew(block: WizBlock): WizBlock {
    const fresh = clone(block);
    for (const key of fresh.children ?? []) result[key] = container(parsed, key).map(addNew);
    if (fresh.type === "list" && fresh.groupId && groupIds.has(fresh.groupId)) fresh.groupId = groupIds.get(fresh.groupId);
    return fresh;
  }
  function merge(old: WizBlock, next: WizBlock): WizBlock {
    if (signature(old, before) === signature(next, parsed)) {
      if (next.type === "list" && next.groupId && old.groupId) groupIds.set(next.groupId, old.groupId);
      return clone(old);
    }
    if (textTypes.has(old.type) && textTypes.has(next.type)) {
      if ((old.type === "list") !== (next.type === "list") || (old.heading ?? 0) !== (next.heading ?? 0) || !!old.quoted !== !!next.quoted) {
        if (hasComments(old)) unsafe(old, "的类型转换会影响评论");
      }
      const value: WizBlock = { ...clone(old), ...clone(next), id: old.id, text: preserveText(old, next) };
      for (const key of ["heading", "quoted", "level", "ordered", "groupId", "start", "textOnly", "checkbox"]) if (!(key in next)) delete value[key];
      if (next.type === "list" && next.groupId) {
        if (old.groupId) groupIds.set(next.groupId, old.groupId);
        value.groupId = groupIds.get(next.groupId) ?? next.groupId;
      }
      return value;
    }
    if (old.type === next.type && ["code", "table"].includes(old.type)) {
      if (old.type === "table" && (old.cols !== next.cols || old.rows !== next.rows || old.children?.length !== next.children?.length
        || old.children?.some(key => Number(old[`${key}_colSpan`] ?? 1) !== 1 || Number(old[`${key}_rowSpan`] ?? 1) !== 1))) unsafe(old, "需要改变表格尺寸或合并单元格");
      if (!old.children?.length || old.children.length !== next.children?.length) unsafe(old, "需要改变容器结构");
      const oldChildren = old.children!;
      const value: WizBlock = { ...clone(old), ...clone(next), id: old.id, children: [...oldChildren] };
      oldChildren.forEach((key, index) => {
        const newKey = next.children![index];
        result[key] = reconcile(container(before, key), container(parsed, newKey));
        if (old.type === "table") {
          delete value[`${newKey}_align`];
          if (next[`${newKey}_align`] === undefined) delete value[`${key}_align`]; else value[`${key}_align`] = next[`${newKey}_align`];
        }
      });
      return value;
    }
    deletionSafe(old, before);
    return addNew(next);
  }
  function reconcile(old: WizBlock[], next: WizBlock[]): WizBlock[] {
    const matched = orderedMatches(old.map(block => signature(block, before)), next.map(block => signature(block, parsed)));
    const output: WizBlock[] = [];
    let oldOffset = 0, nextOffset = 0;
    function gap(oldEnd: number, nextEnd: number) {
      const count = Math.min(oldEnd - oldOffset, nextEnd - nextOffset);
      for (let n = 0; n < count; n++) output.push(merge(old[oldOffset++], next[nextOffset++]));
      while (oldOffset < oldEnd) deletionSafe(old[oldOffset++], before);
      while (nextOffset < nextEnd) output.push(addNew(next[nextOffset++]));
    }
    for (const [newIndex, oldIndex] of matched) { gap(oldIndex, newIndex); output.push(merge(old[oldOffset++], next[nextOffset++])); }
    gap(old.length, next.length);
    return output;
  }
  result.blocks = reconcile(before.blocks, parsed.blocks);
  // A new leading list item can precede the first old item which supplied the group ID.
  visit(result, block => { if (block.type === "list" && block.groupId && groupIds.has(block.groupId)) block.groupId = groupIds.get(block.groupId); });
  return result;
}

export interface ArticleUpdateInput {
  markdown?: string;
  edits?: Array<{ blockId: string; oldText: string; newText: string }>;
  expectedVersion?: number;
  /** Resolve only this article's resource URLs back to names used in its editor snapshot. */
  resourceDocId?: string;
}

/** Produce a candidate snapshot. Persistence/ShareDB acknowledgement belongs to the repository. */
export function planArticleUpdate(before: WizDoc, input: ArticleUpdateInput): WizDoc {
  const full = input.markdown !== undefined, partial = input.edits !== undefined;
  if (full === partial || (partial && !input.edits?.length)) throw new WizError("INVALID_UPDATE", "必须提供非空 markdown 或 edits，且不能同时提供。");
  // ShareDB doc.version is checked by the repository; meta.version is a different field.
  if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0))
    throw new WizError("INVALID_UPDATE", "expectedVersion 必须是非负整数。");
  visit(before, () => {});
  if (full) {
    const parsed = importMarkdown(input.markdown!);
    const existingResources = new Set<string>();
    if (input.resourceDocId) visit(before, block => {
      if (block.type !== "embed" || block.embedType !== "image") return;
      const src = block.embedData?.src;
      const names = Array.isArray(src) ? src : typeof src === "string" ? src.split("|") : [];
      for (const name of names) if (typeof name === "string" && !/^[a-z][a-z\d+.-]*:|^\/\//i.test(name)) existingResources.add(name);
    });
    if (input.resourceDocId) visit(parsed, block => {
      if (block.type !== "embed" || block.embedType !== "image" || typeof block.embedData?.src !== "string" || !block.embedData.src.startsWith("wiz://resources/")) return;
      let parsedUrl: URL;
      try { parsedUrl = new URL(block.embedData.src); } catch { unsupported("内部图片地址"); }
      const parts = parsedUrl!.pathname.split("/").filter(Boolean);
      try {
        if (parts.length !== 2 || decodeURIComponent(parts[0]) !== input.resourceDocId || parsedUrl!.search || parsedUrl!.hash) unsupported("属于另一篇文章或结构无效的内部图片地址");
        const name = decodeURIComponent(parts[1]);
        if (!existingResources.has(name)) unsupported("文章内不存在的内部图片资源");
        block.embedData.src = name;
      } catch (failure) { if (failure instanceof WizError) throw failure; unsupported("内部图片地址编码"); }
    });
    return replaceMarkdown(before, parsed);
  }
  const result = clone(before), blocks = new Map<string, WizBlock>();
  visit(result, block => blocks.set(block.id, block));
  for (const edit of input.edits!) {
    if (!edit || typeof edit.blockId !== "string" || typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string") throw new WizError("INVALID_UPDATE", "blockId、非空 oldText 和 newText 必须是字符串。");
    const block = blocks.get(edit.blockId);
    if (!block) throw new WizError("BLOCK_NOT_FOUND", `找不到块 ${edit.blockId}。`, { blockId: edit.blockId });
    if (!Array.isArray(block.text)) throw new WizError("BLOCK_NOT_TEXT", `块 ${edit.blockId} 没有可编辑文本。`);
    if (block.text.some(segment => Object.keys(segment).some(key => key !== "insert" && key !== "attributes"))) throw new WizError("UNSAFE_EDIT", "块含未知文本操作属性，不能安全地应用 Delta。");
    const snapshot = new Delta(block.text as any[]);
    const source = snapshot.ops.map(op => typeof op.insert === "string" ? op.insert : "\ufffc").join("");
    const index = source.indexOf(edit.oldText);
    if (index < 0) throw new WizError("TEXT_NOT_FOUND", `块 ${edit.blockId} 中未找到 oldText。`, { blockId: edit.blockId });
    if (source.indexOf(edit.oldText, index + 1) >= 0) throw new WizError("AMBIGUOUS_EDIT", `块 ${edit.blockId} 中 oldText 出现多次，请提供更长的唯一文本。`, { blockId: edit.blockId });
    const touched = snapshot.slice(index, index + edit.oldText.length).ops;
    if (touched.some(op => typeof op.insert !== "string" || op.attributes?.box)) throw new WizError("UNSAFE_EDIT", "精确替换不能覆盖行内组件或换行 box。");
    const attrs = { ...(touched[0]?.attributes ?? {}) };
    for (const op of touched) for (const [key, value] of Object.entries(extras(op.attributes ?? {}))) {
      if (key in attrs && stable(attrs[key]) !== stable(value)) throw new WizError("UNSAFE_EDIT", "替换范围跨越不同评论或未知行内属性，请缩小范围。");
      attrs[key] = value;
    }
    if (!edit.newText && Object.keys(extras(attrs)).length) throw new WizError("UNSAFE_EDIT", "不能删除含评论或未知行内属性的文本。");
    if (block.type === "code-line" && /[\r\n]/.test(edit.newText)) throw new WizError("UNSAFE_EDIT", "code-line 内不能插入多行文本，请分别编辑代码行。");
    const change = new Delta().retain(index).delete(edit.oldText.length);
    edit.newText.replace(/\r\n?/g, "\n").split("\n").forEach((line, n) => {
      if (n) change.insert(" ", { ...attrs, box: true, type: "br", text: "\n", id: id() });
      if (line) change.insert(line, attrs);
    });
    block.text = snapshot.compose(change).ops as TextSegment[];
  }
  return result;
}
