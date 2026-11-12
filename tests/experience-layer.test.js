/* 回归锁：借鉴 Arc/ArcMD 的「体验层」必须一直停留在体验层。
 *
 * 这些断言不是为了好看，是为了防止后来者把空间美学做成「改主题令牌 / 加轮询 /
 * 加常驻 GPU 图层 / 加第三方库」，从而把 5MB 级首屏和输入响应拖垮。
 * 行为验收在 .verify/experience-layer-check.cjs（真浏览器 11 条）与
 * .verify/perf-budget-check.cjs（9 条性能预算），这里只锁源码形态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");

const tokens = read("frontend/styles/01-tokens-theme.css");
const layer05 = read("frontend/styles/05-fallback-density.css");
const appJs = read("public/app.js");
const accentMod = read("public/modules/workspace-accent.js");
const indexHtml = read("public/index.html");
const stylesArtifact = read("public/styles.css");

/** 只取本次追加的体验层块，避免把既有规则算进来。 */
const block = layer05.slice(layer05.indexOf("/* ── 体验层增强"));
/** 抹注释后再做「禁用属性」检查，避免注释里的说明文字造成误报。 */
const blockCode = block.replace(/\/\*[\s\S]*?\*\//g, "");

test("空间色：4 个令牌在 :root 有兜底定义，且新样式只引用 --ws-accent*", () => {
  for (const token of ["--ws-accent", "--ws-accent-soft", "--ws-accent-wash", "--ws-accent-line"]) {
    assert.match(tokens, new RegExp(`${token}\\s*:`), `缺少兜底令牌 ${token}（var() 会悬空）`);
  }
  // 严禁覆盖 --accent：主题契约 + 令牌基线要求主题色只由 body[data-theme] 决定
  const rootBlock = tokens.slice(0, tokens.indexOf('body[data-theme="dark"]'));
  assert.doesNotMatch(rootBlock, /--ws-accent[^:]*:\s*[^;]*--accent\s*:/, "不得在新块里重定义 --accent");
  assert.doesNotMatch(block, /--accent\s*:/, "体验层不得覆盖 --accent（会破坏 4 主题令牌基线）");
  for (const token of ["--ws-accent", "--ws-accent-soft", "--ws-accent-wash", "--ws-accent-line"]) {
    assert.ok(stylesArtifact.includes(token), `产物里缺少 ${token}`);
  }
});

test("空间色：由 id 稳定哈希得出，偏好只存 localStorage，无后端字段/无网络", () => {
  assert.match(accentMod, /FNV|Math\.imul\(h, 16777619\)/, "颜色必须由 id 稳定哈希（同一工作区跨设备同色）");
  assert.match(accentMod, /const STORAGE_KEY = "mtWorkspaceAccents"/, "偏好键固定");
  assert.match(accentMod, /localStorage\.getItem\(STORAGE_KEY\)/, "偏好只从 localStorage 读");
  assert.doesNotMatch(accentMod, /fetch\(|XMLHttpRequest|\/api\//, "空间色不得引入任何网络请求");
  assert.equal((accentMod.match(/id:\s*"/g) || []).length, 6, "色板必须恰好 6 枚");
});

test("侧栏触缘浮出是纯 CSS 状态机：零 JS 监听、零定时器、零常驻 GPU 层", () => {
  assert.match(block, /:has\(\.sidebar-peek-zone:hover\)/, "必须有热区 :has 状态机");
  assert.match(block, /:has\(\.sidebar:hover\)/, "滑出后靠侧栏 hover 保持，避免收不回来");
  const jsBlock = appJs.slice(appJs.indexOf("/* ══ 体验层："), appJs.indexOf("initExperienceLayer();"));
  assert.doesNotMatch(jsBlock, /pointerenter|pointermove|mousemove|setInterval|setTimeout\(/, "浮出不得依赖 JS 指针监听/轮询");
  assert.doesNotMatch(blockCode, /will-change|backdrop-filter/, "不得为常年隐藏的浮层常驻 GPU 图层");
  assert.match(block, /@media \(min-width: 861px\)/, "只在桌面宽度生效，窄屏不得盖住正文");
  assert.match(indexHtml, /id="sidebarPeekZone"/, "缺少热区 DOM");
});

test("文档卡片用伪元素，不改 .markdown-body 的宽/内边距/行高", () => {
  assert.match(block, /#readerPanel\.reader-panel::before/, "卡片必须是伪元素");
  assert.match(block, /pointer-events:\s*none/, "卡片不得拦截正文交互");
  const proseIdx = tokens.indexOf("width: min(var(--prose-measure)");
  assert.ok(proseIdx > 0, "找不到三视图共用的版心宽度令牌");
  const proseRule = tokens.slice(proseIdx - 160, proseIdx + 400);
  assert.match(proseRule, /width:\s*min\(var\(--prose-measure\)/, "版心宽度令牌不得被改动");
  assert.match(proseRule, /line-height:\s*var\(--prose-leading\)/, "行高令牌不得被改动");
});

test("表达力元素只走 CSS，不动三端 markdown 渲染器与工具栏", () => {
  assert.match(block, /mark:not\(\.search-hit\)/, "高亮笔视觉规则");
  assert.match(block, /code-block::before/, "代码块顶线");
  assert.match(block, /tbody tr:nth-child\(even\)/, "表格呼吸感");
  // 本轮不改渲染器：三份 renderMarkdown 实现与编辑器核心产物保持原样
  assert.equal(read("public/markdown-worker.js"), read("cloud/markdown-worker.js"), "三端渲染器仍须逐字节一致");
  assert.doesNotMatch(accentMod, /renderMarkdown/, "空间色模块不得介入渲染管线");
});

test("体积预算：体验层增量受控（基线 + 小幅余量）", () => {
  const css = statSync(new URL("public/styles.css", ROOT)).size;
  const js = statSync(new URL("public/app.js", ROOT)).size;
  assert.ok(css < 392_000, `styles.css ${css}B 超预算 392000B`);
  assert.ok(js < 792_000, `app.js ${js}B 超预算 792000B`);
  assert.ok(statSync(new URL("public/editor-core.js", ROOT)).size < 600_000, "编辑器核心本轮不应变化");
});

test("挂载点：只增调用，不修改既有 handler 的内部逻辑", () => {
  assert.match(appJs, /from "\.\/modules\/workspace-accent\.js"/, "缺少模块导入");
  assert.match(appJs, /syncWorkspaceAccentFromTree\(nodes\)/, "树渲染时同步空间色");
  assert.match(appJs, /applyActiveWorkspaceAccent\(\)/, "打开文档时同步空间色");
  assert.match(appJs, /renderWsAccentPicker\(\)/, "工作路径弹窗渲染色板");
  assert.match(indexHtml, /id="wsAccentPicker"/, "缺少色板容器");
  // 委托监听必须 passive + capture，且不改 state.activeWorkspaceId
  const listener = appJs.slice(appJs.indexOf('els.tree?.addEventListener("click"'), appJs.indexOf('els.wsAccentPicker?.addEventListener'));
  assert.match(listener, /capture: true, passive: true/, "委托监听必须 passive");
  assert.doesNotMatch(listener, /state\.activeWorkspaceId\s*=/, "不得在委托监听里改写工作区状态");
});
