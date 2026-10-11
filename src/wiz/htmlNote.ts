import { WizError } from "../errors.js";

type ElementNode = { tag: string; attrs: Record<string, string>; children: Node[] };
type Node = ElementNode | string;
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const skippedTags = new Set(["script", "style", "noscript", "head", "svg", "iframe", "object"]);
const namedEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decode(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, entity: string) => {
    if (entity[0] !== "#") return namedEntities[entity.toLowerCase()] ?? all;
    const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
  });
}

function attributes(source: string) {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) attrs[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  return attrs;
}

function parseHtml(html: string) {
  const root: ElementNode = { tag: "root", attrs: {}, children: [] };
  const stack = [root];
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      const text = decode(html.slice(index, next < 0 ? html.length : next));
      if (text) stack.at(-1)!.children.push(text);
      index = next < 0 ? html.length : next;
      continue;
    }
    const close = html.indexOf(">", index + 1);
    if (close < 0) break;
    const raw = html.slice(index + 1, close).trim();
    index = close + 1;
    if (!raw) continue;
    if (raw.startsWith("/") || raw.startsWith("?")) {
      const tag = raw.replace(/^[/?]/, "").trim().split(/\s/)[0]?.toLowerCase();
      while (stack.length > 1 && stack.at(-1)!.tag !== tag) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const split = body.search(/\s/);
    const tag = (split < 0 ? body : body.slice(0, split)).toLowerCase();
    if (skippedTags.has(tag)) {
      if (!voidTags.has(tag) && !selfClosing) {
        const end = html.toLowerCase().indexOf(`</${tag}`, index);
        index = end < 0 ? html.length : html.indexOf(">", end) + 1;
      }
      continue;
    }
    const element: ElementNode = { tag, attrs: attributes(split < 0 ? "" : body.slice(split)), children: [] };
    stack.at(-1)!.children.push(element);
    if (!voidTags.has(tag) && !selfClosing) stack.push(element);
  }
  return root.children;
}

function safeHttp(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" || url.protocol === "tel:" ? value : "";
  } catch { return ""; }
}

function resourceTarget(src: string, resourceUrl: (name: string) => string) {
  const value = src.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || /^javascript:/i.test(value) || /^data:/i.test(value)) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const name = decodeURIComponent(value.split(/[?#]/)[0].replace(/\\/g, "/")).split("/").filter(Boolean).at(-1) ?? "";
  if (!name || name === "." || name === ".." || name.includes("..")) return "";
  return resourceUrl(name);
}

/** Traditional Wiz HTML becomes readable Markdown. Images stay as references. */
export function htmlNoteToMarkdown(html: string, resourceUrl: (name: string) => string) {
  if (html.length > 2_000_000) throw new WizError("UNSUPPORTED_NOTE", "传统笔记正文超过读取限制。");
  const warnings: string[] = [];
  const noted = new Set<string>();
  const warn = (message: string) => { if (!noted.has(message)) { noted.add(message); warnings.push(message); } };
  const render = (nodes: Node[], pre = false): string => {
    let text = "";
    for (const node of nodes) {
      if (typeof node === "string") { text += pre ? node : node.replace(/\s+/g, " "); continue; }
      const { tag, attrs, children } = node;
      if (tag === "br") { text += "\n"; continue; }
      if (tag === "hr") { text += "\n\n---\n\n"; continue; }
      if (tag === "img") {
        const target = resourceTarget(attrs.src ?? "", resourceUrl);
        if (target) text += `![${(attrs.alt ?? "").replace(/\]/g, "")}](${target})`;
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        const items = children.filter((child): child is ElementNode => typeof child !== "string" && child.tag === "li");
        const list = items.map((item, index) => `${tag === "ol" ? `${index + 1}. ` : "- "}${render(item.children).trim().replace(/\n+/g, "\n").replace(/\n/g, "\n  ")}`).join("\n");
        text += `\n\n${list}\n\n`;
        continue;
      }
      const inner = render(children, pre || tag === "pre");
      if (/^h[1-6]$/.test(tag)) text += `\n\n${"#".repeat(Number(tag[1]))} ${inner.replace(/\s+/g, " ").trim()}\n\n`;
      else if (tag === "p" || tag === "div" || tag === "blockquote" || tag === "tr") text += `\n\n${inner.trim()}\n\n`;
      else if (tag === "pre") text += `\n\n\`\`\`\n${inner.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`;
      else if (tag === "code" && !pre) text += `\`${inner.trim()}\``;
      else if (tag === "strong" || tag === "b") text += `**${inner.trim()}**`;
      else if (tag === "em" || tag === "i") text += `*${inner.trim()}*`;
      else if (tag === "table") { warn("表格已按文本读出。"); text += `\n\n${inner.trim()}\n\n`; }
      else if (tag === "a") {
        const href = safeHttp(attrs.href ?? "");
        const label = inner.replace(/\s+/g, " ").trim();
        text += href && label ? `[${label}](${href})` : label;
      } else text += inner;
    }
    return text;
  };
  const markdown = render(parseHtml(html)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!markdown) warn("传统笔记正文里没有可读取的文字。");
  return { markdown, warnings };
}
