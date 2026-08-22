import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  csvToMarkdown,
  jsonToMarkdown,
  txtToMarkdown,
  htmlToMarkdown,
  markdownToTxt,
  markdownToHtml,
  exportFromMarkdown,
  importToMarkdown,
} from "../server/converter.js";
import { DocViewStore } from "../server/doc-views.js";

/* ── converter.js ── */

test("csvToMarkdown converts a simple CSV into a Markdown table", () => {
  const md = csvToMarkdown("name,age\nAlice,30\nBob,25");
  assert.match(md, /^\| name \| age \|/);
  assert.match(md, /^\| --- \| --- \|/m);
  assert.match(md, /\| Alice \| 30 \|/);
  assert.match(md, /\| Bob \| 25 \|/);
});

test("csvToMarkdown preserves quoted cells containing commas", () => {
  const md = csvToMarkdown('"last, full",age\n"Smith, John",30');
  assert.match(md, /\| last, full \| age \|/);
  assert.match(md, /\| Smith, John \| 30 \|/);
});

test("csvToMarkdown returns empty string for blank input", () => {
  assert.equal(csvToMarkdown(""), "");
  assert.equal(csvToMarkdown("\n  \n"), "");
});

test("jsonToMarkdown formats valid JSON into a fenced code block", () => {
  const md = jsonToMarkdown("data", '{"a": 1, "b": [2, 3]}');
  assert.match(md, /^# data\n\n```json\n[\s\S]+\n```$/);
  assert.match(md, /"a": 1/);
});

test("jsonToMarkdown falls back to raw text for invalid JSON", () => {
  const md = jsonToMarkdown("broken", "not json {");
  assert.match(md, /```json\nnot json \{\n```/);
});

test("txtToMarkdown wraps plain text under a heading with the file base name", () => {
  const md = txtToMarkdown("Notes.txt", "hello world");
  assert.equal(md, "# Notes.txt\n\nhello world");
});

test("htmlToMarkdown strips head/script/style and converts body to Markdown", () => {
  const html = '<!DOCTYPE html><html><head><title>x</title><style>p{}</style></head><body><script>var a;</script><h1>Title</h1><p>Paragraph with <a href="https://example.com">link</a>.</p></body></html>';
  const md = htmlToMarkdown(html);
  assert.match(md, /^# Title/);
  assert.match(md, /\[link\]\(https:\/\/example\.com\)/);
  assert.doesNotMatch(md, /<script|<style|<title|DOCTYPE/i);
});

test("htmlToMarkdown converts tables into Markdown table syntax", () => {
  const html = '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
  const md = htmlToMarkdown(html);
  assert.match(md, /\| A \| B \|/);
  assert.match(md, /\|---\|---\|/);
  assert.match(md, /\| 1 \| 2 \|/);
});

test("htmlToMarkdown returns placeholder heading for empty body", () => {
  const md = htmlToMarkdown("   ");
  assert.match(md, /^# 导入的 HTML/);
});

test("markdownToTxt strips frontmatter, headings, emphasis, links, images, lists and tables", () => {
  const md = `---
title: Test
tags:
  - one
---

# Main Heading

## Sub

**bold** and *italic* and _under_ and __strong__.

[link text](https://example.com) and ![alt](image.png)

- item one
- item two

1. first
2. second

> quoted text

| Col1 | Col2 |
| --- | --- |
| a | b |

\`\`\`js
const x = 1;
\`\`\`

inline \`code\` here.

---`;
  const txt = markdownToTxt(md);
  assert.doesNotMatch(txt, /title:|tags:|---/);
  assert.doesNotMatch(txt, /^#{1,6}\s/m);
  assert.doesNotMatch(txt, /\*\*|__|\*|_/);
  assert.doesNotMatch(txt, /\[|\]\(|!\[/);
  assert.doesNotMatch(txt, /^[-*+]\s|^\d+\.\s/m);
  assert.doesNotMatch(txt, /^>/m);
  assert.doesNotMatch(txt, /\|/);
  assert.doesNotMatch(txt, /```/);
  // Real content is preserved
  assert.match(txt, /Main Heading/);
  assert.match(txt, /bold/);
  assert.match(txt, /link text/);
  assert.match(txt, /item one/);
  assert.match(txt, /first/);
  assert.match(txt, /quoted text/);
  assert.match(txt, /const x = 1/);
  assert.match(txt, /inline code here/);
});

test("markdownToHtml wraps body with title, author and watermark when provided", () => {
  const md = "# Title\n\nParagraph.";
  const html = markdownToHtml(md, { title: "Doc", author: "Author", watermark: "WM" });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<h1 class="doc-title">Doc<\/h1>/);
  assert.match(html, /<p class="doc-author">Author<\/p>/);
  assert.match(html, /<div class="watermark">WM<\/div>/);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>Paragraph\.<\/p>/);
});

test("markdownToHtml omits title/author/watermark tags only when explicitly empty", () => {
  // 默认 title 为 "导出文档"，故 title 标签总会生成
  const defaultHtml = markdownToHtml("# H\n\ntext");
  assert.match(defaultHtml, /<h1 class="doc-title">导出文档<\/h1>/);
  assert.doesNotMatch(defaultHtml, /<p class="doc-author"/);
  assert.doesNotMatch(defaultHtml, /<div class="watermark"/);

  // 显式传空字符串才能省略 title 标签
  const stripped = markdownToHtml("# H\n\ntext", { title: "", author: "", watermark: "" });
  assert.doesNotMatch(stripped, /<h1 class="doc-title"/);
  assert.doesNotMatch(stripped, /<p class="doc-author"/);
  assert.doesNotMatch(stripped, /<div class="watermark"/);
});

test("markdownToHtml escapes HTML-unsafe title/author/watermark", () => {
  const html = markdownToHtml("x", { title: "<script>", author: "&", watermark: '"' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;/);
});

test("exportFromMarkdown dispatches to md/txt/html buffers with correct mime types", async () => {
  const md = "# Hello\n\nWorld";
  const mdOut = await exportFromMarkdown(md, "md");
  assert.equal(mdOut.mimeType, "text/markdown");
  assert.equal(mdOut.ext, "md");
  assert.equal(Buffer.from(mdOut.buffer).toString("utf8"), md);

  const txtOut = await exportFromMarkdown(md, "txt");
  assert.equal(txtOut.mimeType, "text/plain");
  assert.equal(txtOut.ext, "txt");
  assert.match(Buffer.from(txtOut.buffer).toString("utf8"), /Hello/);
  assert.doesNotMatch(Buffer.from(txtOut.buffer).toString("utf8"), /^#/);

  const htmlOut = await exportFromMarkdown(md, "html");
  assert.equal(htmlOut.mimeType, "text/html");
  assert.equal(htmlOut.ext, "html");
  assert.match(Buffer.from(htmlOut.buffer).toString("utf8"), /<!DOCTYPE html>/);
});

test("exportFromMarkdown rejects unsupported formats", async () => {
  await assert.rejects(() => exportFromMarkdown("x", "pdf"), /不支持的导出格式: pdf/);
});

test("importToMarkdown dispatches by extension and returns safe name + title", async () => {
  const txtRes = await importToMarkdown("My Notes.txt", Buffer.from("hello"));
  assert.match(txtRes.markdown, /^# My Notes\n\nhello/);
  assert.equal(txtRes.title, "My Notes");

  const jsonRes = await importToMarkdown("config.json", Buffer.from('{"k":1}'));
  assert.match(jsonRes.markdown, /^# config\n\n```json/);
  assert.equal(jsonRes.title, "config");

  const csvRes = await importToMarkdown("data.csv", Buffer.from("a,b\n1,2"));
  assert.match(csvRes.markdown, /\| a \| b \|/);
  assert.equal(csvRes.title, "data");

  const mdRes = await importToMarkdown("note.md", Buffer.from("# Existing\n\ntext"));
  assert.equal(mdRes.markdown, "# Existing\n\ntext");
  assert.equal(mdRes.title, "note");
});

test("importToMarkdown sanitises unsafe file name characters in the title", async () => {
  const res = await importToMarkdown("a:b\\c?d.txt", Buffer.from("x"));
  assert.equal(res.title, "a_b_c_d");
  assert.match(res.markdown, /^# a_b_c_d\n\nx/);
});

test("importToMarkdown creates a placeholder document for unsupported extensions", async () => {
  const res = await importToMarkdown("archive.zip", Buffer.from("binary-not-really-text"));
  assert.match(res.markdown, /^# archive\n\n> 此文件为 \.ZIP 格式/);
  assert.match(res.markdown, /大小: \d+ B/);
  assert.equal(res.title, "archive");
});

/* ── doc-views.js ── */

test("DocViewStore loads empty when the file does not exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-docviews-empty-"));
  try {
    const store = new DocViewStore(root);
    await store.load();
    assert.equal(store.snapshot().size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DocViewStore.record increments viewCount and updates viewedAt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-docviews-record-"));
  try {
    const store = new DocViewStore(root);
    await store.record("docs/a.md");
    await store.record("docs/a.md");
    await store.record("docs/b.md");
    const snap = store.snapshot();
    assert.equal(snap.get("docs/a.md").viewCount, 2);
    assert.ok(snap.get("docs/a.md").viewedAt > 0);
    assert.equal(snap.get("docs/b.md").viewCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DocViewStore.snapshot returns an independent copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-docviews-snap-"));
  try {
    const store = new DocViewStore(root);
    await store.record("docs/x.md");
    const snap = store.snapshot();
    snap.set("docs/injected.md", { viewedAt: 1, viewCount: 99 });
    assert.equal(store.snapshot().has("docs/injected.md"), false);
    assert.equal(store.snapshot().get("docs/x.md").viewCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DocViewStore.persist round-trips through a JSON file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-docviews-persist-"));
  try {
    const store = new DocViewStore(root);
    await store.record("docs/p1.md");
    await store.record("docs/p1.md");
    await store.record("docs/p2.md");
    await store.persist();

    const raw = await readFile(path.join(root, "doc-views.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed["docs/p1.md"].viewCount, 2);
    assert.equal(parsed["docs/p2.md"].viewCount, 1);

    // 新实例加载后应恢复相同状态
    const reloaded = new DocViewStore(root);
    await reloaded.load();
    assert.equal(reloaded.snapshot().get("docs/p1.md").viewCount, 2);
    assert.equal(reloaded.snapshot().get("docs/p2.md").viewCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DocViewStore.record ignores empty docPath", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-docviews-empty-path-"));
  try {
    const store = new DocViewStore(root);
    await store.record("");
    await store.record(null);
    await store.record(undefined);
    assert.equal(store.snapshot().size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DocViewStore tolerates a corrupted JSON file by starting empty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-docviews-corrupt-"));
  try {
    await writeFile(path.join(root, "doc-views.json"), "{not valid json", "utf8");
    const store = new DocViewStore(root);
    await store.load();
    assert.equal(store.snapshot().size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
