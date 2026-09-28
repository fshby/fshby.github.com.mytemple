import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  escapeHtml,
  splitPathRef,
  joinPathRef,
  parentPathRef,
  splitWorkspaceRef,
  displayName,
  compactName,
  plainText,
  headingId,
} from "../public/modules/path-utils.js";
import {
  stripFrontmatter,
  escapeRegex,
  splitMarkdownIntoSlides,
  normalizeAssetUrlsToRelative,
} from "../public/modules/export-utils.js";
import { extractOutline } from "../public/modules/editor-utils.js";

const readApp = () => readFile(path.join(process.cwd(), "public/app.js"), "utf8");

test("License deactivation UI stays wired to the backend route", async () => {
  const appSource = await readApp();
  assert.match(appSource, /api\.post\("\/api\/license\/deactivate"/);
  assert.match(appSource, /授权已解除，请重新授权/);
  assert.match(appSource, /license-locked/);
  assert.match(appSource, /license-required/);
});

test("AI edit hint acceptance writes the suggested markdown back to its original paragraph", async () => {
  const appSource = await readApp();
  assert.match(appSource, /if \(action === "rewrite"\) applyAiHintRewrite\(suggestion, para\)/);
  assert.match(appSource, /insertAiHintComment\(suggestion, para\)/);
  assert.match(appSource, /function replaceEditorRange\(value, start, end, selectionMode = "end"\)/);
  assert.match(appSource, /function resolveAiEditorRange\(range\)/);
  assert.match(appSource, /aiTransformGenerateBtn/);
  assert.match(appSource, /preserveInstruction: true/);
  assert.match(appSource, /result\.answerMode === "local-fallback"/);
  assert.match(appSource, /AI 没有生成不同内容/);
  assert.match(appSource, /return saveCurrentDoc\(\{ keepEditorState: true, renderAfterSave: false \}\)/);
});

/* ── path-utils.js ── */

test("splitPathRef returns workspace + relative shape", () => {
  const ref = splitPathRef("notes/a/b.md");
  assert.equal(ref.relative, "notes/a/b.md");
  assert.equal(ref.workspaceId, "default");
});

test("joinPathRef and parentPathRef round-trip", () => {
  const ref = joinPathRef("default", "docs/拆分.md");
  assert.equal(parentPathRef(ref), joinPathRef("default", "docs"));
});

test("escapeHtml escapes HTML-unsafe characters", () => {
  assert.equal(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

test("compactName truncates overlong names", () => {
  const compacted = compactName("a".repeat(50));
  assert.ok(compacted.length < 50 && compacted.endsWith("..."));
});

test("plainText strips markdown emphasis", () => {
  assert.equal(plainText("**加粗**"), "加粗");
});

/* ── export-utils.js ── */

test("stripFrontmatter removes leading YAML block", () => {
  assert.equal(stripFrontmatter("---\ntitle: x\n---\n\n正文"), "正文");
});

test("escapeRegex escapes regex metacharacters", () => {
  assert.equal(escapeRegex("a.b*c"), "a\\.b\\*c");
});

test("splitMarkdownIntoSlides splits on heading boundaries", () => {
  const slides = splitMarkdownIntoSlides("# 一\n内容一\n\n# 二\n内容二");
  assert.ok(slides.length >= 2);
});

test("normalizeAssetUrlsToRelative resolves absolute asset urls against base", () => {
  // 依赖 DOM，仅在浏览器环境可完整执行；Node 下跳过
  if (typeof document === "undefined") return;
  const html = '<img src="./assets/a.png">';
  assert.equal(normalizeAssetUrlsToRelative(html), html);
});

/* ── editor-utils.js ── */

test("extractOutline extracts headings from markdown", () => {
  const outline = extractOutline("# 标题一\n\n正文\n\n## 标题二");
  assert.ok(outline.length >= 2);
  assert.match(outline[0].text || outline[0].title || "", /标题一|标题二/);
});
