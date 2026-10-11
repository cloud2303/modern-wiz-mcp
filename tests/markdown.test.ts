import assert from "node:assert/strict";
import test from "node:test";
import { WizError } from "../src/errors.js";
import { importMarkdown, planArticleUpdate } from "../src/wiz/markdown.js";
import { wizDocToMarkdown, wizDocToMarkdownResult } from "../src/wiz/toMarkdown.js";
import type { WizBlock, WizDoc } from "../src/wiz/types.js";

const plain = (block: WizBlock) => (block.text ?? []).map(op => "insert" in op && typeof op.insert === "string" ? op.insert : "").join("");
const error = (code: string) => (value: unknown) => value instanceof WizError && value.code === code;

test("supported Markdown has stable canonical output, official heading/list/quote structures and marks", () => {
  const input = "# 标题\n\n**粗体** *斜体* ~~删除~~ `a*b` [链接](https://example.com/a) <u>下划线</u> H<sub>2</sub> x<sup>2</sup>\n\n3. 第一项\n4. 第二项\n\n- 普通列表\n- [x] 已完成\n- [ ] 待完成\n\n> 引用\n> 第二行\n\n---\n\n![图片](https://example.com/image.png)\n";
  const doc = importMarkdown(input);
  assert.equal(doc.blocks[0].type, "text");
  assert.equal(doc.blocks[0].heading, 1);
  const ordered = doc.blocks.filter(block => block.type === "list" && block.ordered);
  assert.deepEqual(ordered.map(block => block.start), [3, 4]);
  assert.equal(ordered[0].groupId, ordered[1].groupId);
  assert.equal(ordered[0].level, 1);
  assert.deepEqual(doc.blocks.filter(block => block.checkbox).map(block => block.checkbox), ["checked", "unchecked"]);
  const quoted = doc.blocks.find(block => block.quoted)!;
  assert.ok(quoted.text?.some(op => "insert" in op && op.attributes?.type === "br"));
  const markdown = wizDocToMarkdownResult(doc);
  assert.deepEqual(markdown.warnings, []);
  assert.equal(wizDocToMarkdown(importMarkdown(markdown.markdown)), markdown.markdown);
});

test("nested lists retain nesting and ordered list starts", () => {
  const doc = importMarkdown("5. parent\n    - nested one\n    - nested two\n6. next\n");
  assert.deepEqual(doc.blocks.map(block => [block.level, block.ordered, block.start]), [[1, true, 5], [2, false, 1], [2, false, 2], [1, true, 6]]);
  assert.equal(doc.blocks[0].groupId, doc.blocks[3].groupId);
  assert.equal(doc.blocks[1].groupId, doc.blocks[2].groupId);
  assert.equal(wizDocToMarkdown(importMarkdown(wizDocToMarkdown(doc))), wizDocToMarkdown(doc));
});

test("table cells and code lines use top-level child containers and roundtrip", () => {
  const doc = importMarkdown("| left | right |\n| :--- | ---: |\n| **bold**<br>next | `a\\|b` |\n\n```ts\nconst a = 1;\n\nconsole.log(a);\n```\n");
  const [table, code] = doc.blocks;
  assert.equal(table.type, "table");
  assert.equal(table.cols, 2);
  assert.equal(table.rows, 2);
  assert.equal(table.children!.length, 4);
  assert.equal(table[`${table.children![0]}_align`], "left");
  assert.equal(table[`${table.children![1]}_align`], "right");
  assert.ok(Array.isArray(doc[table.children![0]]));
  assert.equal(code.type, "code");
  assert.equal(code.language, "ts");
  assert.deepEqual((doc[code.children![0]] as WizBlock[]).map(line => [line.type, plain(line)]), [["code-line", "const a = 1;"], ["code-line", ""], ["code-line", "console.log(a);"]]);
  const first = wizDocToMarkdown(doc);
  assert.equal(wizDocToMarkdown(importMarkdown(first)), first);
});

test("unchanged and edited blocks preserve IDs, hidden fields, comments and unknown roots", () => {
  const doc = importMarkdown("# title\n\nold word and unchanged tail\n\nlast\n");
  doc.meta = { title: "server title", version: 900, custom: { value: true } };
  doc.comments = { c1: { id: "c1", abstract: "keep" } };
  doc.customRoot = { attachment: "retain" };
  doc.authors = ["u1"];
  doc.blocks[0].editorPrivate = { color: "pink" };
  doc.blocks[1].comments = ["c1"];
  doc.blocks[1].editorPrivate = 123;
  doc.blocks[1].text = [{ insert: "old word and " }, { insert: "unchanged tail", attributes: { customInline: "keep", "style-bold": true } }];
  const original = structuredClone(doc);
  const updated = planArticleUpdate(doc, { markdown: "# title\n\nnew word and **unchanged tail**\n\nlast\n", expectedVersion: 2 });
  assert.deepEqual(doc, original, "planning must not mutate the snapshot");
  assert.deepEqual(updated.blocks.map(block => block.id), doc.blocks.map(block => block.id));
  assert.deepEqual(updated.blocks[0], doc.blocks[0]);
  assert.deepEqual(updated.blocks[2], doc.blocks[2]);
  assert.equal(updated.blocks[1].editorPrivate, 123);
  assert.deepEqual(updated.blocks[1].comments, ["c1"]);
  assert.ok(updated.blocks[1].text?.some(op => "insert" in op && op.attributes?.customInline === "keep"));
  assert.deepEqual(updated.meta, doc.meta);
  assert.deepEqual(updated.comments, doc.comments);
  assert.deepEqual(updated.customRoot, doc.customRoot);
  assert.deepEqual(updated.authors, ["u1"]);
});

test("format-only changes preserve unknown inline attributes", () => {
  const doc: WizDoc = { blocks: [{ id: "b", type: "text", text: [{ insert: "same", attributes: { "comment-c": true, customInline: 1 } }] }], comments: { c: { id: "c" } } };
  const result = planArticleUpdate(doc, { markdown: "**same**" });
  assert.deepEqual(result.blocks[0].text, [{ insert: "same", attributes: { "style-bold": true, "comment-c": true, customInline: 1 } }]);
});

test("new blocks around unchanged blocks do not replace their identities", () => {
  const doc = importMarkdown("one\n\ntwo\n\nthree");
  const updated = planArticleUpdate(doc, { markdown: "new first\n\none\n\ninserted middle\n\ntwo\n\nthree\n\nnew last" });
  assert.deepEqual(updated.blocks.filter(block => ["one", "two", "three"].includes(plain(block))).map(block => block.id), doc.blocks.map(block => block.id));
});

test("changed table cells/code lines reuse parent, container and unchanged nested IDs", () => {
  const doc = importMarkdown("| a | b |\n| --- | --- |\n| c | d |\n\n```js\nold\nkeep\n```\n");
  const [table, code] = doc.blocks;
  const oldCell = (doc[table.children![2]] as WizBlock[])[0];
  oldCell.comments = ["c"];
  oldCell.custom = "retained";
  const updated = planArticleUpdate(doc, { markdown: "| a | b |\n| --- | --- |\n| changed | d |\n\n```js\nnew\nkeep\n```\n" });
  assert.equal(updated.blocks[0].id, table.id);
  assert.deepEqual(updated.blocks[0].children, table.children);
  assert.equal(updated.blocks[1].id, code.id);
  assert.deepEqual(updated.blocks[1].children, code.children);
  assert.equal((updated[table.children![2]] as WizBlock[])[0].id, oldCell.id);
  assert.equal((updated[table.children![2]] as WizBlock[])[0].custom, "retained");
  assert.deepEqual((updated[table.children![2]] as WizBlock[])[0].comments, ["c"]);
  assert.equal((updated[code.children![0]] as WizBlock[])[1].id, (doc[code.children![0]] as WizBlock[])[1].id);
});

test("exact edits compose Delta and preserve all surrounding styles and comment metadata", () => {
  const doc: WizDoc = { blocks: [{ id: "b", type: "text", custom: { a: 1 }, comments: ["c"], text: [
    { insert: "before " }, { insert: "old", attributes: { "style-bold": true, link: "https://example.com", "comment-c": true } },
    { insert: " after", attributes: { "style-italic": true } },
  ] }], meta: { title: "keep" }, comments: { c: { id: "c" } } };
  const original = structuredClone(doc);
  const updated = planArticleUpdate(doc, { edits: [{ blockId: "b", oldText: "old", newText: "new longer" }] });
  assert.deepEqual(doc, original);
  assert.deepEqual(updated.blocks[0], { ...original.blocks[0], text: [
    { insert: "before " }, { insert: "new longer", attributes: { "style-bold": true, link: "https://example.com", "comment-c": true } },
    { insert: " after", attributes: { "style-italic": true } },
  ] });
  assert.deepEqual(updated.meta, doc.meta);
  assert.deepEqual(updated.comments, doc.comments);
});

test("exact edits find nested table/code blocks and reject ambiguous/missing text and blocks", () => {
  const doc = importMarkdown("| a | b |\n| --- | --- |\n| c | d |\n\n```js\nold\n```\n");
  const tableId = (doc[doc.blocks[0].children![2]] as WizBlock[])[0].id;
  const codeId = (doc[doc.blocks[1].children![0]] as WizBlock[])[0].id;
  const updated = planArticleUpdate(doc, { edits: [{ blockId: tableId, oldText: "c", newText: "cell" }, { blockId: codeId, oldText: "old", newText: "new" }] });
  assert.equal(plain((updated[doc.blocks[0].children![2]] as WizBlock[])[0]), "cell");
  assert.equal(plain((updated[doc.blocks[1].children![0]] as WizBlock[])[0]), "new");
  const repeated = importMarkdown("aaaa");
  assert.throws(() => planArticleUpdate(repeated, { edits: [{ blockId: repeated.blocks[0].id, oldText: "aa", newText: "b" }] }), error("AMBIGUOUS_EDIT"));
  assert.throws(() => planArticleUpdate(repeated, { edits: [{ blockId: repeated.blocks[0].id, oldText: "missing", newText: "b" }] }), error("TEXT_NOT_FOUND"));
  assert.throws(() => planArticleUpdate(repeated, { edits: [{ blockId: "missing", oldText: "a", newText: "b" }] }), error("BLOCK_NOT_FOUND"));
});

test("unchanged image with private media data survives a full Markdown update", () => {
  const doc = importMarkdown("before\n\n![图片](https://example.com/a.png)\n\nafter");
  doc.blocks[1].embedData!.privateMediaHash = "abc";
  doc.blocks[1].comments = ["media-comment"];
  const updated = planArticleUpdate(doc, { markdown: "changed before\n\n![图片](https://example.com/a.png)\n\nafter" });
  assert.deepEqual(updated.blocks[1], doc.blocks[1]);
});

test("current article resource URLs resolve to stored names and preserve private image data", () => {
  const doc = importMarkdown("![图片](internal%20name.png)");
  doc.blocks[0].embedData!.src = "internal name.png";
  doc.blocks[0].embedData!.privateMediaHash = "keep";
  const updated = planArticleUpdate(doc, { markdown: "![图片](wiz://resources/doc-1/internal%20name.png)", resourceDocId: "doc-1" });
  assert.deepEqual(updated, doc);
  assert.throws(() => planArticleUpdate(doc, { markdown: "![图片](wiz://resources/doc-2/internal%20name.png)", resourceDocId: "doc-1" }), error("UNSUPPORTED_MARKDOWN"));
  assert.throws(() => planArticleUpdate(doc, { markdown: "![图片](wiz://resources/doc-1/not-present.png)", resourceDocId: "doc-1" }), error("UNSUPPORTED_MARKDOWN"));
});

test("full replacements refuse media deletion/conversion, comment removal and unknown data loss", () => {
  const media = importMarkdown("before\n\n![图片](https://example.com/a.png)\n\nafter");
  assert.throws(() => planArticleUpdate(media, { markdown: "before\n\nafter" }), error("UNSAFE_REPLACEMENT"));
  assert.throws(() => planArticleUpdate(media, { markdown: "before\n\n![图片](https://example.com/new.png)\n\nafter" }), error("UNSAFE_REPLACEMENT"));
  const comments = importMarkdown("remove\n\nkeep");
  comments.blocks[0].comments = ["c"];
  assert.throws(() => planArticleUpdate(comments, { markdown: "keep" }), error("UNSAFE_REPLACEMENT"));
  assert.throws(() => planArticleUpdate(comments, { markdown: "# remove\n\nkeep" }), error("UNSAFE_REPLACEMENT"));
  const custom = importMarkdown("remove\n\nkeep");
  custom.blocks[0].privateLayout = { a: 1 };
  assert.throws(() => planArticleUpdate(custom, { markdown: "keep" }), error("UNSAFE_REPLACEMENT"));
  const inline = importMarkdown("private text");
  inline.blocks[0].text![0] = { insert: "private text", attributes: { customStyle: "keep" } };
  assert.throws(() => planArticleUpdate(inline, { markdown: "different text" }), error("UNSAFE_REPLACEMENT"));
  const unsupportedDoc: WizDoc = { blocks: [{ id: "u", type: "embed", embedType: "future-plugin", embedData: { secret: true } }] };
  assert.throws(() => planArticleUpdate(unsupportedDoc, { markdown: "ordinary prose" }), error("UNSAFE_REPLACEMENT"));
  const privateDelta: WizDoc = { blocks: [{ id: "b", type: "text", text: [{ insert: "private", futureField: 123 } as any] }] };
  assert.deepEqual(planArticleUpdate(privateDelta, { markdown: "private" }), privateDelta);
  assert.throws(() => planArticleUpdate(privateDelta, { markdown: "new" }), error("UNSAFE_REPLACEMENT"));
  assert.throws(() => planArticleUpdate(privateDelta, { edits: [{ blockId: "b", oldText: "private", newText: "new" }] }), error("UNSAFE_EDIT"));
  const privateRule: WizDoc = { blocks: [{ id: "rule", type: "embed", embedType: "hr", embedData: { future: true } }, { id: "t", type: "text", text: [{ insert: "keep" }] }] };
  assert.deepEqual(planArticleUpdate(privateRule, { markdown: "---\n\nkeep" }), privateRule);
  assert.throws(() => planArticleUpdate(privateRule, { markdown: "keep" }), error("UNSAFE_REPLACEMENT"));
});

test("unsupported Markdown and unsafe HTML/URLs fail explicitly, code stays inert", () => {
  for (const markdown of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<u onclick=alert(1)>x</u>", "<div>x</div>", "[[wiki]]", "$math$", "$$\nmath\n$$", "```js {run}\nx\n```", "> > nested", "- first\n\n  second", "| a | b |\n| --- | --- |\n| extra | three | cells |"] ) {
    assert.throws(() => importMarkdown(markdown), error("UNSUPPORTED_MARKDOWN"), markdown);
  }
  const doc = importMarkdown("```js\nprocess.exit(1)\n```\n\n`<script>alert(1)</script>`");
  assert.equal(plain((doc[doc.blocks[0].children![0]] as WizBlock[])[0]), "process.exit(1)");
  assert.equal(plain(importMarkdown("$5 and $10").blocks[0]), "$5 and $10");
  assert.throws(() => importMarkdown("[x](javascript:alert%281%29)"), error("UNSUPPORTED_MARKDOWN"));
});

test("invalid update shapes and cyclic documents fail without changing input", () => {
  const doc = importMarkdown("content");
  assert.throws(() => planArticleUpdate(doc, {}), error("INVALID_UPDATE"));
  assert.throws(() => planArticleUpdate(doc, { markdown: "content", edits: [] }), error("INVALID_UPDATE"));
  assert.throws(() => planArticleUpdate(doc, { edits: [] }), error("INVALID_UPDATE"));
  assert.throws(() => planArticleUpdate(doc, { markdown: "  " }), error("INVALID_UPDATE"));
  assert.throws(() => planArticleUpdate(doc, { markdown: "content", expectedVersion: -1 }), error("INVALID_UPDATE"));
  const cycle: WizDoc = { blocks: [{ id: "b", type: "code", children: ["c"] }], c: [{ id: "c1", type: "code", children: ["c"] }] };
  assert.throws(() => planArticleUpdate(cycle, { edits: [{ blockId: "b", oldText: "x", newText: "y" }] }), error("INVALID_DOCUMENT"));
});
