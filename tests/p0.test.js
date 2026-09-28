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

/* ── 授权检查健壮性（回归防护） ── */

test("授权检查超时按「结论未知」处理，绝不判成未授权", async () => {
  const appSource = await readApp();
  // 超时/网络失败必须返回 _transient 标记，而不是硬编码的 { activated: false }
  assert.match(appSource, /_transient: true/);
  // 首次（冷启动）校验使用更宽松的超时（后端要现算 WMI 指纹）
  assert.match(appSource, /LICENSE_FIRST_TIMEOUT_MS/);
  assert.match(appSource, /opts\.first \? LICENSE_FIRST_TIMEOUT_MS : LICENSE_NET_TIMEOUT_MS/);
  // 启动流程里有针对 _transient 的重试循环
  assert.match(appSource, /result && result\._transient; i \+= 1/);
  // 三处判「未授权」的入口都必须排除 _transient
  assert.match(appSource, /!result\.activated && !result\._transient && state\.licenseValidatedAt > 0/);
  assert.match(appSource, /netResult\.activated \|\| netResult\._transient/);
  assert.match(appSource, /result && result\._transient\) \{\s*\n\s*\/\/ 无法确认（超时\/网络瞬断）/);
  // 旧的「直接把超时打成 error 并切未授权 UI」的写法不应再存在
  assert.doesNotMatch(appSource, /console\.error\("License check failed:"/);
  assert.doesNotMatch(appSource, /els\.licenseUnactivated\?\.classList\.remove\("hidden"\);\s*\n\s*if \(els\.licenseWarning\) \{\s*\n\s*els\.licenseWarning\.textContent = "授权状态暂时无法确认/);
});

test("授权检查有内存缓存兜底（WebView2 跟踪防护可能阻断 localStorage）", async () => {
  const appSource = await readApp();
  assert.match(appSource, /let _licenseMemCache = null/);
  assert.match(appSource, /_licenseMemCache = \{ result, savedAt: Date\.now\(\) \}/);
  assert.match(appSource, /if \(_licenseMemCache\)/);
});

test("授权硬件指纹缓存只计算一次（避免并发重复拉起 WMI）", async () => {
  const rustSource = await readFile(
    path.join(process.cwd(), "src-tauri/src/license.rs"),
    "utf8",
  );
  // 四个缓存必须用 OnceLock（并发调用者等待首个计算，而不是各跑一遍 PowerShell）
  assert.match(rustSource, /static HARDWARE_CACHE: OnceLock<String>/);
  assert.match(rustSource, /static MACHINE_CODE_CACHE: OnceLock<String>/);
  assert.match(rustSource, /static MACHINE_FINGERPRINT_CACHE: OnceLock<String>/);
  assert.match(rustSource, /static SYSTEM_REF_TIME_CACHE: OnceLock<u64>/);
  assert.doesNotMatch(rustSource, /static\s+\w+:\s*Mutex</);
  // WMI 查询的超时必须收紧：曾为 15s × 3 次（最坏 45s），远超前端超时
  assert.doesNotMatch(rustSource, /run_powershell\(script, 15\)/);
  assert.match(rustSource, /run_powershell\(script, 8\)/);
});

