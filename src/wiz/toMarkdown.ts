import { readReadingCardData } from "./readingCardData.js";
import type { TextSegment, WizBlock, WizDoc } from "./types.js";

export interface MarkdownOptions {
  /** Resolve an uploaded resource name to a public URL. External URLs are left intact. */
  resourceUrl?: (name: string) => string;
  wikiLinkUrl?: (id: string) => string;
}

export interface MarkdownResult {
  markdown: string;
  /** Lossy formatting and unsupported blocks are reported instead of silently dropped. */
  warnings: string[];
}

const string = (value: unknown) => typeof value === "string" ? value : "";
const integer = (value: unknown, fallback: number, max = 1_000_000) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;
const plainText = (segments?: TextSegment[]) => (segments ?? []).map(segment =>
  "insert" in segment && typeof segment.insert === "string" ? segment.insert : "").join("").replace(/\r\n?/g, "\n");

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]#|~]/g, "\\$&")
    .replace(/^( {0,3})([-+=])(?=\s|$)/gm, "$1\\$2")
    .replace(/^( {0,3}\d+)([.)])(?=\s|$)/gm, "$1\\$2")
    .replace(/^( {4,}|\t+)/gm, whitespace => whitespace.replace(/ /g, "&#32;").replace(/\t/g, "&#9;"));
}

function codeSpan(value: string): string {
  const text = value.replace(/\r\n?|\n/g, " ");
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(longest + 1);
  const padding = /^`|`$/.test(text) || /^ .+ $/.test(text) ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

function fencedCode(value: string, language = ""): string {
  const longest = Math.max(2, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(longest + 1);
  // A language name must not introduce another line or terminate the opening fence.
  const info = language === "null" ? "" : language.replace(/[^\w+#.-]/g, "").toLowerCase();
  return `${fence}${info}\n${value}\n${fence}`;
}

/** URLs are destinations, never raw HTML; executable schemes do not survive export. */
function destination(value: string): string | null {
  const url = value.trim();
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) return null;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1].toLowerCase();
  if (scheme && !["https", "http", "mailto", "tel", "wiz"].includes(scheme)) return null;
  return `<${url.replace(/[<>\\\s]/g, char => encodeURIComponent(char))}>`;
}

function json(value: unknown): string {
  // Snapshot values are JSON. Sorting object keys makes fallback output deterministic.
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, "en"))) : item, 2) ?? "null";
}

/** Convert the snapshot directly; no EditorView, DOM, React root or network is needed. */
export function wizDocToMarkdownResult(doc: WizDoc, options: MarkdownOptions = {}): MarkdownResult {
  const warnings = new Set<string>();
  const activeContainers = new Set<string>();
  const warn = (block: WizBlock, detail: string) => warnings.add(`${block.id}: ${detail}`);

  const link = (label: string, url: string, block: WizBlock, image = false) => {
    const target = destination(url);
    if (!target) {
      warn(block, "链接地址无效，已保留文字");
      return label;
    }
    return `${image ? "!" : ""}[${label}](${target})`;
  };
  const resource = (src: string) => /^[a-z][a-z\d+.-]*:|^\/\//i.test(src) ? src : options.resourceUrl?.(src) ?? src;

  function inline(segments: TextSegment[] | undefined, block: WizBlock): string {
    const runs: { text: string; attrs: Record<string, unknown> }[] = [];
    for (const segment of segments ?? []) {
      if (!("insert" in segment)) continue;
      const originalAttrs = segment.attributes ?? {};
      if (Object.keys(originalAttrs).some(key => /^(style-(?:bg-)?color|style-font)/.test(key))) {
        warn(block, "Markdown 不保留字体和颜色");
      }
      // Comments/history/colors must not break one continuous bold span into **a****b**.
      const attrs = originalAttrs.box ? originalAttrs : Object.fromEntries(
        ["style-bold", "style-italic", "style-strikethrough", "style-code", "style-underline", "style-sub", "style-super", "link"]
          .filter(key => originalAttrs[key]).map(key => [key, key === "link" ? originalAttrs[key] : true]),
      );
      let text = typeof segment.insert === "string" ? segment.insert.replace(/\r\n?/g, "\n") : "";
      if (typeof segment.insert !== "string" && !attrs.box) {
        warn(block, "不支持的行内对象已保留为 JSON");
        text = json(segment.insert);
      }
      const previous = runs.at(-1);
      // Delta can split an identical mark into several adjacent operations.
      if (previous && !attrs.box && json(previous.attrs) === json(attrs)) previous.text += text;
      else runs.push({ text, attrs });
    }
    return runs.map(({ text, attrs }) => {
      if (attrs.box && attrs.type === "br") return "  \n";
      if (attrs.box && attrs.type === "wiki-link") {
        const name = escapeText(string(attrs.name) || string(attrs.linkId) || "文档链接");
        const id = string(attrs.linkId);
        return id ? link(name, options.wikiLinkUrl?.(id) ?? `wiz://open_document?guid=${encodeURIComponent(id)}`, block) : name;
      }
      if (attrs.box && attrs.type === "math") return `$${string(attrs.tex) || string(attrs.src)}$`;
      if (attrs.box) {
        warn(block, `行内组件 ${string(attrs.type) || "unknown"} 已转换为文字`);
        return escapeText(string(attrs.text) || string(attrs.name) || text || `[${string(attrs.type) || "组件"}]`);
      }
      // Emphasis delimiters cannot enclose leading/trailing whitespace.
      return text.split("\n").map(line => {
        const [, lead, content, tail] = /^(\s*)(.*?)(\s*)$/.exec(line)!;
        if (!content) return line;
        let result = attrs["style-code"] ? codeSpan(content) : escapeText(content);
        if (!attrs["style-code"]) {
          if (attrs["style-bold"]) result = `**${result}**`;
          if (attrs["style-italic"]) result = `*${result}*`;
          if (attrs["style-strikethrough"]) result = `~~${result}~~`;
          if (attrs["style-underline"]) result = `<u>${result}</u>`;
          if (attrs["style-sub"]) result = `<sub>${result}</sub>`;
          if (attrs["style-super"]) result = `<sup>${result}</sup>`;
        }
        if (typeof attrs.link === "string") result = link(result, attrs.link, block);
        return escapeText(lead) + result + tail;
      }).join("  \n");
    }).join("");
  }

  function container(id: string, owner?: WizBlock): WizBlock[] {
    if (!Array.isArray(doc[id]) && owner) warn(owner, `缺少容器 ${id}`);
    return Array.isArray(doc[id]) ? doc[id] as WizBlock[] : [];
  }

  function renderContainer(id: string, owner: WizBlock): string {
    if (activeContainers.has(id)) {
      warn(owner, `循环引用容器 ${id} 已跳过`);
      return escapeText(`[循环引用: ${id}]`);
    }
    activeContainers.add(id);
    const result = renderBlocks(container(id, owner));
    activeContainers.delete(id);
    return result;
  }

  function codeText(block: WizBlock): string {
    return block.children?.length
      ? block.children.map(id => container(id, block).map(line => plainText(line.text)).join("\n")).join("\n")
      : string(block.code) || plainText(block.text);
  }

  function table(block: WizBlock): string {
    const ids = block.children ?? [];
    if (!ids.length) return "";
    const cols = integer(block.cols, ids.length, 200) || 1;
    const rows = integer(block.rows, 1, 200) || 1;
    if (Number(block.cols) > 200 || Number(block.rows) > 200) warn(block, "表格超过 200 行或列，超出单元格在表格后展开");
    const grid = Array.from({ length: rows }, () => Array<string | null>(cols).fill(null));
    const align = Array<string>(cols).fill("---");
    let index = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r][c] !== null) continue;
        const id = ids[index++];
        if (!id) continue;
        const colSpan = Math.min(integer(block[`${id}_colSpan`], 1) || 1, cols - c);
        const rowSpan = Math.min(integer(block[`${id}_rowSpan`], 1) || 1, rows - r);
        if (colSpan > 1 || rowSpan > 1) warn(block, "Markdown 表格不支持合并单元格，内容保留在左上格");
        for (let rr = r; rr < r + rowSpan; rr++) for (let cc = c; cc < c + colSpan; cc++) grid[rr][cc] = "";
        const blocks = container(id);
        // A Markdown table cell supports inline content only. Keep block boundaries as <br>.
        const value = blocks.length === 1 && blocks[0].type === "code"
          ? codeSpan(codeText(blocks[0])) : renderContainer(id, block).replace(/ {2}\n/g, "<br>").replace(/\n/g, "<br>");
        grid[r][c] = value.replace(/\\?\|/g, "\\|");
        if (r === 0) {
          align[c] = ({ left: ":---", center: ":---:", right: "---:" } as Record<string, string>)[string(block[`${id}_align`])] ?? "---";
        }
      }
    }
    const row = (values: (string | null)[]) => `| ${values.map(value => value ?? "").join(" | ")} |`;
    let result = [row(grid[0]), row(align), ...grid.slice(1).map(row)].join("\n");
    if (index < ids.length) {
      warn(block, "表格尺寸与单元格数不一致，多出的内容在表格后展开");
      result += `\n\n${ids.slice(index).map(id => renderContainer(id, block)).join("\n\n")}`;
    }
    return result;
  }

  function embed(block: WizBlock): string {
    const data = block.embedData ?? {};
    const type = block.embedType || "unknown";
    if (type === "hr") return "---";
    if (type === "toc") {
      warn(block, "目录已保留为 [toc] 标记，由 Markdown 渲染器生成");
      return "[toc]";
    }
    if (type === "math") return `$$\n${string(data.mathjaxText)}\n$$`;
    const diagramField = ({ mermaid: "mermaidText", plantuml: "plantumlText", flowchart: "flowchartText" } as Record<string, string>)[type];
    if (diagramField) return fencedCode(string(data[diagramField]), type === "flowchart" ? "flow" : type);
    if (type === "reading-card") {
      const card = readReadingCardData(data);
      return `> **${escapeText(card.title)}**\n>\n> ${escapeText(card.book)}\n>\n> 阅读进度：${card.current} / ${card.target}`;
    }
    const sources = Array.isArray(data.src) ? data.src.filter((src): src is string => typeof src === "string")
      : string(data.src) ? type === "image" ? string(data.src).split("|") : [string(data.src)] : [];
    const ready = sources.filter(src => !["loading", "progress", "error", "empty"].includes(src));
    const label = escapeText(string(data.fileName) || string(data.title) || ({ image: "图片", audio: "音频", video: "视频", office: "附件", webpage: "网页" } as Record<string, string>)[type] || type);
    if (ready.length) return ready.map(src => link(label, resource(src), block, type === "image")).join("\n\n");
    warn(block, `嵌入组件 ${type} 已保留为文字和 JSON`);
    return `${escapeText(`[嵌入: ${type}]`)}\n\n${fencedCode(json(data), "json")}`;
  }

  function renderBlock(block: WizBlock): string {
    let result: string;
    if (block.type === "code") result = fencedCode(codeText(block), string(block.language));
    else if (block.type === "table") result = table(block);
    else if (block.type === "embed") result = embed(block);
    else {
      result = inline(block.text, block);
      if (!["text", "list", "heading", "code-line"].includes(block.type)) {
        warn(block, `不支持的块类型 ${block.type} 已保留内容`);
        if (!result) result = fencedCode(json(block), "json");
        if (block.children?.length) result += `\n\n${block.children.map(id => renderContainer(id, block)).join("\n\n")}`;
      }
      const heading = integer(block.heading, block.type === "heading" ? 1 : 0, 6);
      if (heading) result = `${"#".repeat(heading)} ${result}`;
      if (block.type === "list") {
        const indent = "    ".repeat(Math.max(0, integer(block.level, 1, 20) - 1));
        const marker = block.textOnly ? "" : block.checkbox ? `- [${block.checkbox === "checked" ? "x" : " "}] `
          : block.ordered ? `${integer(block.start, 1, 999_999_999)}. ` : "- ";
        const lines = result.split("\n");
        result = lines.map((line, index) => indent + (index === 0 ? marker : " ".repeat(marker.length)) + line).join("\n");
      }
    }
    return block.quoted ? result.split("\n").map(line => line ? `> ${line}` : ">").join("\n") : result;
  }

  function renderBlocks(blocks: WizBlock[]): string {
    return blocks.map((block, index) => {
      const previous = blocks[index - 1];
      const sameList = block.type === "list" && previous?.type === "list" && !!block.quoted === !!previous.quoted
        && (!block.groupId || !previous.groupId || block.groupId === previous.groupId);
      return `${index === 0 ? "" : sameList ? "\n" : "\n\n"}${renderBlock(block)}`;
    }).join("");
  }

  const markdown = renderBlocks(Array.isArray(doc.blocks) ? doc.blocks : []).replace(/^\n+|\n+$/g, "");
  return { markdown: markdown ? `${markdown}\n` : "", warnings: [...warnings] };
}

export function wizDocToMarkdown(doc: WizDoc, options: MarkdownOptions = {}): string {
  return wizDocToMarkdownResult(doc, options).markdown;
}
