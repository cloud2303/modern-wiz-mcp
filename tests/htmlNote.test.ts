import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlNoteToMarkdown } from "../src/wiz/htmlNote.js";

const resource = (name: string) => `wiz://resources/doc/${name}`;

test("traditional note html keeps headings, links, local images and drops scripts", () => {
  const html = `<body><h2>标题</h2><p>见 <a href="https://example.com/a">链接</a> 和 <a href="javascript:alert(1)">文字</a></p><ul><li>一项</li></ul><img alt="图" src="index_files/a b.png"><img src="https://example.com/b.png"><style>p{}</style></body>`;
  const result = htmlNoteToMarkdown(html, resource);
  assert.match(result.markdown, /^## 标题\n\n见 \[链接\]\(https:\/\/example\.com\/a\) 和 文字/);
  assert.match(result.markdown, /- 一项/);
  assert.match(result.markdown, /!\[图\]\(wiz:\/\/resources\/doc\/a b\.png\)/);
  assert.match(result.markdown, /!\[]\(https:\/\/example\.com\/b\.png\)/);
  assert.equal(result.markdown.includes("alert"), false);
  assert.equal(result.markdown.includes("p{}"), false);
});