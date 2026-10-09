// 回归测试：PR-4「交互与密度」改动不得破坏主体功能，且不得回退到「隐藏内容」的方案。
// 约束（与审计报告第 10 节一致）：
//   全部为展示层调整 —— 不改类名契约、不改 DOM 结构、不改任何 JS 逻辑与路由。
// 因此这里的断言分成两类：
//   ① 观感契约：五态 / 焦点环 / 命中区 / 密度令牌必须存在且互相自洽；
//   ② 反回退契约：不得把工具藏进隐藏滚动区、不得收起核心状态项、不得靠颜色单独表达禁用。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cssSrc = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const htmlSrc = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const PR4_START = cssSrc.indexOf("PR-4 · 交互与密度");
assert.ok(PR4_START >= 0, "找不到 PR-4 区块");

// 注释里会正当地提到「现状是 overflow-x:auto」「#editor 自带反馈」等字样，
// 落在断言窗口里会造成假阳性/假阴性，因此先在无注释文本上做匹配。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const pr4 = stripComments(cssSrc.slice(PR4_START));

/** 取「包含某条声明」的最近一层规则块（含选择器）。 */
function enclosingBlock(src, fragment) {
  const i = src.indexOf(fragment);
  assert.ok(i >= 0, `找不到片段 ${fragment}`);
  const open = src.lastIndexOf("{", i);
  assert.ok(open >= 0, `片段 ${fragment} 不在任何规则块内`);
  const close = src.indexOf("}", i);
  assert.ok(close > open, `片段 ${fragment} 所在规则块未闭合`);
  return src.slice(src.lastIndexOf("}", open) + 1, close + 1);
}

/** 取「从选择器到其规则体」的完整规则文本，selector 需带 `{`（形如 `.foo {`）。 */
function ruleBlock(src, selector) {
  const i = src.indexOf(selector);
  assert.ok(i >= 0, `找不到规则 ${selector}`);
  const close = src.indexOf("}", i);
  assert.ok(close > i, `规则 ${selector} 未闭合`);
  return src.slice(i, close + 1);
}

// ── 1. 五态令牌 ───────────────────────────────────────────────────────────

test("PR-4：控件五态令牌覆盖全部主题作用域（var() 在声明所在元素解析）", () => {
  const block = enclosingBlock(pr4, "--ctl-bg:");
  for (const sel of [
    ":root",
    'body[data-theme="dark"]',
    'body[data-theme="eye"]',
    'body[data-theme="glow"]',
    'body[data-theme="image"]',
  ]) {
    assert.ok(
      block.includes(sel),
      `五态令牌必须同时覆盖 ${sel} —— 只写 :root 会让深色主题锁死浅色值`,
    );
  }
  assert.match(block, /--ctl-bg-hover:/, "须有 hover 底色");
  assert.match(block, /--ctl-bg-active:/, "须有按下底色");
  assert.match(block, /--ctl-fg-muted:/);
  assert.match(block, /--ctl-disabled-opacity:/);
  // 五态开关必须走 Layer 0 的时长/缓动令牌，而不是各写各的毫秒数
  assert.match(block, /--ctl-transition:[\s\S]*var\(--dur-1\)\s*var\(--ease-standard\)/);
  assert.match(block, /--ctl-transition:[\s\S]*var\(--dur-2\)\s*var\(--ease-standard\)/);
});

test("PR-4：中性控件补齐 hover / 按下 / 禁用三态，且不覆盖语义色控件", () => {
  // hover
  assert.match(
    pr4,
    /\.toolbar button:not\(\.danger\):not\(\.active\):hover[\s\S]*?background-color:\s*var\(--ctl-bg-hover\)/,
    "顶栏中性按钮须有 hover 反馈",
  );
  // 按下
  assert.match(pr4, /:active[\s\S]*?background-color:\s*var\(--ctl-bg-active\)/);
  assert.match(pr4, /transform:\s*translateY\(0\.5px\)/, "按下须有位移线索（不足以引起布局抖动）");
  // 禁用：必须给出「非颜色」线索，不能只靠颜色变浅
  const disabled = enclosingBlock(pr4, ":disabled");
  assert.match(disabled, /opacity:\s*var\(--ctl-disabled-opacity\)/);
  assert.match(disabled, /cursor:\s*not-allowed/);
  assert.match(disabled, /filter:\s*saturate\(0\.5\)/);
  assert.match(disabled, /transform:\s*none/);
  // 语义色控件必须被排除在「中性底色」之外，否则 danger/active 会被冲淡
  assert.match(pr4, /\.toolbar button:not\(\.danger\):not\(\.active\)/, "danger/active 须排除在中性态之外");
});

// ── 2. 全局焦点环 ─────────────────────────────────────────────────────────

test("PR-4：全局键盘焦点环压过既有的 outline:none", () => {
  const ring = ruleBlock(pr4, ":where(a[href]");
  assert.match(ring, /:where\(/, "须用 :where() 把特异度压到 0，避免与既有品牌化焦点样式抢优先级");
  assert.match(ring, /outline:\s*2px solid var\(--focus-ring\) !important/);
  assert.match(ring, /outline-offset:\s*2px !important/);
  assert.ok(/--focus-ring:/.test(cssSrc), "--focus-ring 须有定义");
  // 兜底选择器必须覆盖常见可聚焦控件
  for (const sel of ["a[href]", "button", "input", "select", "textarea", '[tabindex]:not([tabindex="-1"])']) {
    assert.ok(ring.includes(sel), `焦点环兜底须覆盖 ${sel}`);
  }
  // 编辑器本体自带光标反馈，须刻意排除，避免光标处出现外框
  assert.doesNotMatch(ring, /#editor/, "编辑器本体不应被套上全局焦点环");
});

// ── 3. 分隔条命中区 ───────────────────────────────────────────────────────

test("PR-4：分隔条命中区放大到 10px 且不改动网格列宽", () => {
  const side = ruleBlock(pr4, ".sidebar-resizer::after");
  assert.match(side, /position:\s*absolute/, "命中区须用伪元素外扩，而不是撑宽元素本身");
  assert.match(side, /width:\s*10px/);
  const split = ruleBlock(pr4, ".editor-splitter::after");
  assert.match(split, /width:\s*10px/);
  // 布局不变：编辑器三栏网格的列宽仍是 220px / 3px / 1fr / 3px / 1fr
  assert.match(
    cssSrc,
    /grid-template-columns:\s*220px 3px minmax\(0, 1fr\) 3px minmax\(0, 1fr\)/,
    "命中区不得靠改网格列宽实现（那会改变布局）",
  );
  // 悬停 / 拖动须有回执，避免「点了却没反应」
  assert.match(pr4, /\.sidebar-resizer\.dragging::after/);
  assert.match(pr4, /\.editor-splitter\.dragging::after/);
});

// ── 4. 工具栏不再隐藏内容 ─────────────────────────────────────────────────

test("PR-4：编辑器工具栏改为换行显示，不再把控件藏在滚动区后面", () => {
  const tb = ruleBlock(pr4, ".editor-toolbar {");
  assert.match(tb, /overflow:\s*visible/);
  assert.match(tb, /flex-wrap:\s*wrap/);
  assert.match(tb, /height:\s*auto/, "工具栏须随内容自适应高度（否则换行后会被裁切）");
  assert.doesNotMatch(
    tb,
    /overflow(-x)?:\s*(auto|scroll)/,
    "不得再让控件藏进（Windows 上默认不可见的）横向滚动区",
  );
  assert.match(tb, /align-content:\s*center/);
  assert.match(tb, /column-gap:\s*4px/);
  // 收紧水平内边距，使 21 个控件在 1440px 下回到单行
  assert.match(pr4, /padding-inline:\s*7px/, "须收紧内边距以把单行容量补回来");
});

// ── 5. 状态栏：令牌自洽 + 栅格预留 ────────────────────────────────────────

test("PR-4：状态栏高度令牌同时约束栅格预留与状态栏本身", () => {
  assert.equal(
    (cssSrc.match(/--status-bar-h:\s*26px/g) || []).length,
    1,
    "--status-bar-h 应当只定义一次，避免两处写死后走偏",
  );
  // 状态栏是绝对定位、不参与栅格流：第三行必须显式预留，写 auto 会塌成 0
  const panel = ruleBlock(pr4, ".editor-panel {");
  assert.match(
    panel,
    /grid-template-rows:\s*auto minmax\(0, 1fr\) var\(--status-bar-h\)/,
    "第三行须按 --status-bar-h 预留",
  );
  assert.doesNotMatch(
    panel,
    /grid-template-rows:\s*auto minmax\(0, 1fr\) auto/,
    "第三行不得为 auto —— 会把编辑区顶到状态栏底下",
  );
  // 状态栏自身也吃同一个令牌
  const sbBlock = ruleBlock(pr4, ".status-bar {");
  assert.match(sbBlock, /height:\s*var\(--status-bar-h\)/);
  assert.match(sbBlock, /min-height:\s*var\(--status-bar-h\)/);
  assert.match(
    sbBlock,
    /box-sizing:\s*border-box/,
    "须 border-box，否则 padding/border 会把实际高度撑到与栅格预留不一致",
  );
});

// ── 6. 状态栏：密度收敛 + 核心项永不收起 ─────────────────────────────────

test("PR-4：状态栏密度收敛到 12px，且核心 4 项在任何宽度都不收起", () => {
  assert.match(ruleBlock(pr4, ".status-bar {"), /font-size:\s*var\(--fs-xs\)/, "字号须提升到 --fs-xs（12px）");

  const core = ["docName", "wordCount", "cursor", "lastSave"];
  for (const field of core) {
    assert.doesNotMatch(
      pr4,
      new RegExp(`\\[data-status-field="${field}"\\][^{}]*\\{[^}]*display:\\s*none`),
      `核心项 ${field} 不得被收起（否则关键信息在窄窗口消失）`,
    );
  }
  const secondary = ["pomodoro", "systemTime", "created", "encoding"];
  for (const field of secondary) {
    assert.match(pr4, new RegExp(`\\[data-status-field="${field}"\\]`), `次要项 ${field} 应有按优先级收起的规则`);
    // 收起条目时必须同时收起它前面的分隔线，否则出现「| |」两个竖线
    assert.match(
      pr4,
      new RegExp(`\\.status-sep:has\\(\\+\\s*\\[data-status-field="${field}"\\]\\)`),
      `收起 ${field} 时须同步用 :has(+ …) 收起它前面的分隔线`,
    );
  }
  // 长文档名应省略而不是把后续条目挤出可视区
  assert.match(pr4, /text-overflow:\s*ellipsis/);
  assert.match(pr4, /\.status-item[\s\S]*?min-width:\s*0/, "状态条目须允许收缩");
});

// ── 7. 动效与 reduced-motion ─────────────────────────────────────────────

test("PR-4：动效三档落到控件，且 reduced-motion 覆盖关键帧动画而不只是过渡", () => {
  assert.match(pr4, /transition-duration:\s*var\(--dur-1\)/);
  assert.match(pr4, /transition-duration:\s*var\(--dur-2\)/);
  const i = cssSrc.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(i >= 0, "找不到 reduced-motion 媒体查询");
  const block = cssSrc.slice(i, cssSrc.indexOf("\n}", i) + 2);
  assert.match(block, /animation-duration:\s*0\.01ms !important/, "必须让关键帧动画也停下来");
  assert.match(block, /animation-iteration-count:\s*1 !important/);
  assert.match(block, /animation-delay:\s*0ms !important/);
  assert.match(block, /transition-duration:\s*0\.01ms !important/);
  assert.match(block, /scroll-behavior:\s*auto !important/);
});

// ── 8. 模式切换：观感变、DOM 与逻辑不变 ───────────────────────────────────

test("PR-4：模式切换改为分段控件观感，但不改 DOM 与 JS", () => {
  const sw = ruleBlock(pr4, ".view-mode-switch {");
  assert.match(sw, /box-shadow:\s*inset/, "容器须下沉（内阴影）以形成分段控件的凹槽");
  assert.match(
    ruleBlock(pr4, ".view-mode-switch button.active {"),
    /box-shadow:/,
    "选中段须上浮",
  );
  assert.match(ruleBlock(pr4, ".view-mode-switch button {"), /border-radius:\s*calc\(var\(--radius-2\) - 2px\)/, "内段圆角须比容器小一档");
  // DOM 未变：仍是 role="group" + button，没有被改成 tablist/radio
  assert.match(htmlSrc, /class="view-mode-switch" role="group"/, "模式切换的 DOM 角色不得改动");
  assert.doesNotMatch(htmlSrc, /view-mode-switch" role="tablist"/);
  assert.doesNotMatch(htmlSrc, /view-mode-switch[\s\S]{0,200}role="tab"/, "不得引入 tab 角色（会改变交互契约）");
  // JS 未新增分段控件相关逻辑
  assert.doesNotMatch(appSrc, /segmentedControl|modeSegmented/, "不得为此新增 JS 逻辑");
});
