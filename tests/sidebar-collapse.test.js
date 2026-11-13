// sidebar-collapse.test.js — Ctrl+Q 侧栏收起布局回归锁
//
// 背景（v2.3.12 用户实测）：Ctrl+Q 收起后「整个编辑区被隐藏」，窗口只剩背景。
// 根因不是合成器白屏，而是纯 CSS 布局缺陷：桌面宽度下收起态把 .sidebar 转成
// position:fixed（触缘浮出，脱离 app-shell 网格流），grid 自动布局随即把
// sidebar-resizer 顶进第 1 列、workspace 顶进第 2 列（8px→0 宽），第 3 列
// minmax(0,1fr) 空置 —— 编辑区宽度归零（实测收起态 readerPanel w=0）。
// 修复：桌面媒体块内把三列显式钉死（.sidebar=1 / .sidebar-resizer=2 /
// .workspace=3）。本测试锁住：钉死规则在源码与构建产物中都在、触缘浮出
// 特征仍在、移动端显式列位规则未被破坏。
// 真浏览器行为验收：.verify/sidebar-collapse-check.cjs（9 条）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const repoFile = (...p) => {
  const f = path.join(ROOT, ...p);
  assert.ok(fs.existsSync(f), `缺少文件 ${path.join(...p)}`);
  return fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
};

test("SidebarCollapse: 桌面媒体块内三列显式钉死（防 fixed 脱流挤位）", () => {
  const css = repoFile("frontend", "styles", "05-fallback-density.css");
  assert.match(css, /\.sidebar \{ grid-column: 1; \}/, "缺 .sidebar 列 1 钉死");
  assert.match(css, /\.sidebar-resizer \{ grid-column: 2; \}/, "缺 .sidebar-resizer 列 2 钉死");
  assert.match(css, /\.workspace \{ grid-column: 3; \}/, "缺 .workspace 列 3 钉死");
  // 三条钉死规则必须位于桌面媒体块（min-width: 861px）内——移动端单列布局不能被污染
  const mqStart = css.lastIndexOf("@media (min-width: 861px)");
  assert.ok(mqStart > 0, "缺桌面媒体块");
  const block = css.slice(mqStart);
  assert.ok(block.includes(".workspace { grid-column: 3; }"), "钉死规则不在桌面媒体块内");
});

test("SidebarCollapse: 收起态触缘浮出特征仍在（fixed + 热区状态机）", () => {
  const css = repoFile("frontend", "styles", "05-fallback-density.css");
  assert.match(css, /\.app-shell\.sidebar-collapsed:not\(\.immersive\) \.sidebar \{[\s\S]*?position: fixed;/,
    "收起态侧栏必须转 fixed（浮出特征）");
  assert.match(css, /\.app-shell\.sidebar-collapsed:not\(\.immersive\) \.sidebar-peek-zone \{/,
    "触缘热区规则必须在");
  assert.match(css, /:has\(\.sidebar-peek-zone:hover\)/, "hover 滑出状态机必须在");
});

test("SidebarCollapse: 构建产物 public/styles.css 同步包含钉死规则", () => {
  const css = repoFile("public", "styles.css");
  assert.match(css, /\.workspace \{ grid-column: 3; \}/, "styles.css 未重建（缺钉死规则）");
  assert.match(css, /\.sidebar \{ grid-column: 1; \}/, "styles.css 缺 .sidebar 列位");
});

test("SidebarCollapse: 移动端收起态显式列位规则保持不变", () => {
  const css = repoFile("frontend", "styles", "02-shell-editor.css");
  assert.match(css, /\.app-shell\.sidebar-collapsed \.workspace \{\s*\n\s*grid-column: 1;/,
    "移动端收起态 workspace 列 1 规则不能被移除");
});
