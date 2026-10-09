// 回归测试：沉浸式渲染（所见即所得）不得影响其它功能
// 背景：
//   参考站 MarkdownAssistant 的「沉浸」= 所见即所得编辑（ir 模式）。
//   本项目编辑器是 CodeMirror 包装，方案为「可动态开关的渲染扩展」，关键约束：
//     1. 扩展默认不启用（Compartment 装空扩展），编辑器行为与旧版逐字节一致；
//     2. 渲染器由宿主注入（injectRenderer），核心不得硬编码 app.js 的 renderMarkdown；
//     3. 开/关走 Compartment.reconfigure 热切换，不重建 EditorView；
//     4. 只对「光标不在其中的块」施加装饰，光标所在块保持源码可编辑；
//     5. 退出沉浸必须关闭渲染。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const coreSrc = readFileSync(new URL("../frontend/editor-core.js", import.meta.url), "utf8");
const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const cssSrc = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const htmlSrc = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

// 朴素花括号计数会被字符串/模板字符串/正则里的花括号骗到
// （如 `<span style="color:${value}">` 与 /^\{(\d+)\}|/），这里按 JS 词法跳过这些区段。
function fnBody(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `找不到 ${marker}`);
  const bodyStart = src.indexOf("{", start);

  // 判断某个 "/" 是正则字面量起始还是除号：看上一个有效字符能否结束表达式
  const canEndExpr = (ch) => /[A-Za-z0-9_$)\]}>"'`]/.test(ch || "");

  let depth = 0;
  let prev = "";
  for (let i = bodyStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === "/" && !canEndExpr(prev)) {
      // 正则字面量：跳过字符类与转义
      let j = i + 1;
      let inClass = false;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === "\\") { j++; continue; }
        if (c === "[") { inClass = true; continue; }
        if (c === "]") { inClass = false; continue; }
        if (c === "/" && !inClass) break;
        if (c === "\n") break;
      }
      if (j < src.length && src[j] === "/") {
        i = j;
        prev = "/";
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      for (let j = i + 1; j < src.length; j++) {
        if (src[j] === "\\") { j++; continue; }
        if (src[j] === ch) { i = j; break; }
      }
      prev = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error(`${marker} 花括号不配对`);
}

test("沉浸渲染扩展默认关闭：Compartment 初值为空扩展", () => {
  assert.match(coreSrc, /this\.wysiwygEnabled = false/, "构造函数应默认禁用沉浸渲染");
  assert.match(
    coreSrc,
    /this\.wysiwygCompartment\.of\(\[\]\)/,
    "初始扩展必须是空数组，确保不产生任何装饰",
  );
});

test("沉浸渲染走 Compartment 热切换，不重建 EditorView", () => {
  const body = fnBody(coreSrc, "setWysiwygEnabled(enabled)");
  assert.match(body, /Compartment|wysiwygCompartment\.reconfigure/, "必须用 Compartment 重配置");
  assert.match(body, /next \? this\.wysiwygExtension : \[\]/, "关闭时应恢复为空扩展");
  assert.doesNotMatch(body, /new EditorView/, "禁止重建 EditorView（会丢历史/选区/滚动）");
});

test("渲染器由宿主注入，核心不硬编码 renderMarkdown", () => {
  assert.match(coreSrc, /injectRenderer\(renderer\)/, "核心必须提供 injectRenderer 接口");
  const code = coreSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    code,
    /renderMarkdown/,
    "核心不得依赖 app.js 的具体渲染函数，否则耦合且难测试",
  );
  const appInject = appSrc.slice(appSrc.indexOf("els.editor = createMarkdownEditor"));
  assert.match(appInject.slice(0, 400), /injectRenderer/, "app.js 必须注入渲染器");
});

test("光标所在块保持源码：仅对非光标块施加装饰", () => {
  const body = fnBody(coreSrc, "compute(view) {");
  assert.match(body, /cursorLines/, "必须收集光标所在行");
  assert.match(body, /if \(hasCursor\) continue;/, "光标所在块必须跳过渲染，保持可编辑");
});

test("渲染范围覆盖各类块，但普通段落不动", () => {
  const body = fnBody(coreSrc, "collectMdBlockRanges(doc)");
  assert.match(body, /#\{1,6\}/, "应识别标题");
  assert.match(body, /`\{3,\}|~\{3,\}/, "应识别围栏代码块（``` 与 ~~~）");
  assert.match(body, /isMathFence/, "应识别多行数学公式块 $$...$$");
  assert.match(body, /isTableRow/, "应识别表格");
  assert.match(body, /isQuote/, "应识别引用 / 提示块（callout）");
  assert.match(body, /isListItem/, "应识别列表");
  assert.match(body, /isImageOnly/, "应识别独立图片行");
  assert.doesNotMatch(
    body,
    /^\s*if \(text\.trim\(\)\) \{/m,
    "不得把普通段落纳入块级替换（会影响行高与光标落点）",
  );
});

test("普通段落的行内样式标记走独立装饰（不参与块替换）", () => {
  // 背景：{bg:…}/{color:…}/{size:…} 出现在裸段落时永远显示源码（块渲染只覆盖 5 类块），
  // 用户看到「沉浸模式字体和背景没生效」。解法是 Decoration.replace 只替换标记字符范围，
  // 段落本身保持普通段落 —— 光标落点不受影响。
  const body = fnBody(coreSrc, "compute(view) {");
  assert.match(body, /InlineStyleWidget/, "应有行内样式 widget");
  assert.match(body, /scanInlineStyleTokens\(/, "应扫描行内样式标记");
  assert.match(body, /blockedLines/, "应避开已被块级渲染接管的行（防双重渲染）");
  // 行内装饰同样遵守「光标所在行保持源码」
  assert.match(body, /cursorLines\.has\(n\)\) continue;/, "光标所在行不得施加行内装饰");
  // 嵌套必须由花括号配对处理：简单正则 [^{}]* 只认最内层，外层 {size:18|…} 会泄漏成源码
  const scanner = fnBody(coreSrc, "function renderInlineStyleHtml(text)");
  assert.match(scanner, /depth \+= 1/, "应做花括号深度配对");
  assert.match(scanner, /close === -1/, "未闭合的半截标记应保持源码");
  assert.match(scanner, /escapeHtml\(/, "内容必须转义后才能拼进 HTML");
  // widget 与 app.js 的 styleToken 输出一致：color / bg / size 三类
  const widget = fnBody(coreSrc, "class InlineStyleWidget extends WidgetType");
  assert.match(widget, /mt-md-inline-style/, "widget 应携带行内样式容器类");
  assert.match(coreSrc, /"color:\$\{value\}"/, "color 标记输出内联颜色");
  assert.match(coreSrc, /background-color:\$\{value\}/, "bg 标记输出内联背景");
  assert.match(coreSrc, /font-size:\$\{value\}px/, "size 标记输出内联字号");
});

test("轻量模式的语法清零规则必须放行渲染容器", () => {
  // 背景：沉浸模式复用 lightweight-editor（复用其关闭语法高亮的规则），
  // 但那条规则原为「源码显示」设计，会把渲染结果里靠内联 style 生效的
  // 字体颜色/背景色一并 !important 清掉。必须在选择器层排除 .mt-md-wysiwyg。
  const resetBlock = cssSrc.slice(cssSrc.indexOf("body.lightweight-editor .cm-line span"));
  const selector = resetBlock.slice(0, resetBlock.indexOf("{"));
  assert.match(
    selector,
    /:not\(\.mt-md-wysiwyg\)/,
    "清零选择器必须排除 .mt-md-wysiwyg 容器，否则沉浸模式下颜色/背景色失效",
  );
  assert.match(
    selector,
    /:not\(\.mt-md-wysiwyg \*\)/,
    "还须排除容器内的所有后代，渲染结果的裸 span 靠内联 style 生效",
  );
  // 行内样式标记的容器同理（裸段落里 {bg:…} 的渲染结果也靠内联 style）
  assert.match(
    selector,
    /:not\(\.mt-md-inline-style\)/,
    "清零选择器必须排除 .mt-md-inline-style 容器",
  );
  assert.match(
    selector,
    /:not\(\.mt-md-inline-style \*\)/,
    "还须排除行内样式容器的所有后代",
  );
  // 行内语义标记（**粗** / `码` / [链接]()）的容器本身就是一个 span，
  // 若不清零放行，.markdown-body 提供的 strong/em/code/a 语义样式会连带失效。
  assert.match(
    selector,
    /:not\(\.mt-md-inline-mark\)/,
    "清零选择器必须排除 .mt-md-inline-mark 容器",
  );
  assert.match(
    selector,
    /:not\(\.mt-md-inline-mark \*\)/,
    "还须排除行内语义标记容器的所有后代",
  );
});

test("卡片渲染须走挂载后处理（KaTeX / Mermaid / 高亮）", () => {
  // 渲染结果为 HTML 字符串，公式与图表必须挂载到真实 DOM 后才能异步渲染。
  assert.match(coreSrc, /injectWidgetMountHook/, "核心须提供挂载后处理钩子");
  assert.match(coreSrc, /queueMicrotask/, "钩子须在 DOM 挂载后异步触发");
  const appInject = appSrc.slice(appSrc.indexOf("injectWidgetMountHook"));
  const snippet = appInject.slice(0, 700);
  assert.match(snippet, /renderMathInPreview/, "必须接入公式渲染");
  assert.match(snippet, /renderChartsInPreview/, "必须接入图表渲染");
  assert.match(snippet, /highlightCodeBlocks/, "必须接入代码高亮");
  assert.match(snippet, /processJsonCodeBlocks/, "必须接入 JSON 代码块树形视图");
  // 四条链路的顺序须与预览栏 swapPreviewHtml 保持一致，避免两套渲染分叉
  assert(
    snippet.indexOf("renderChartsInPreview") < snippet.indexOf("renderMathInPreview"),
    "图表渲染应先于公式渲染（与预览栏一致）",
  );
});

test("挂载钩子必须逐卡片注入，而非全局共享单例", () => {
  // 每个 widget 各自持有 mount 回调，避免多个卡片复用时丢钩子
  const body = fnBody(coreSrc, "compute(view) {");
  assert.match(body, /new MarkdownPreviewWidget\(html, signature, mount\(\)\)/, "widget 应带 mount 回调");
  const ext = fnBody(coreSrc, "buildMarkdownWysiwygExtension(getRenderer, isEnabled, onWidgetMount)");
  assert.match(ext, /const mount = \(\) =>/, "应由 onWidgetMount 派生 mount 工厂");
});

test("退出沉浸必须关闭所见即所得渲染", () => {
  const body = fnBody(appSrc, "function setImmersiveEditing(enabled)");
  assert.match(body, /setWysiwygEnabled\?\.\(true\)/, "进入沉浸应开启渲染");
  assert.match(body, /setWysiwygEnabled\?\.\(false\)/, "退出沉浸应关闭渲染");
});

test("沉浸排版样式限定在 .app-shell.immersive 作用域内", () => {
  assert.match(cssSrc, /\.app-shell\.immersive \.mt-md-wysiwyg/, "渲染样式必须限定沉浸作用域");
  // 不得出现脱离 immersive 作用域的裸 .mt-md-wysiwyg 规则
  const bare = cssSrc.match(/^\.mt-md-wysiwyg/gm);
  assert.equal(bare, null, "存在未限定作用域的 .mt-md-wysiwyg 规则，会影响普通编辑态");
});

test("沉浸渲染容器必须携带 markdown-body 类以复用预览排版", () => {
  // 背景：预览面板（#preview / #markdownView）的排版规则 400+ 条全部以 .markdown-body 开头
  // （图片限宽限高、表格边框与内边距、代码块底色、引用缩进、链接取主题色、按主题微调…）。
  // 沉浸容器若只叫 .mt-md-wysiwyg，这些规则一条都匹配不上：
  //   img  -> max-width:none / max-height:none / display:inline（图片按原始像素硬渲染）
  //   table-> border-collapse:separate 且宽度塌成细条；th/td -> padding:1px / border:0
  //   pre  -> 背景透明、padding:0、圆角:0；a -> UA 默认蓝 rgb(0,0,238)
  //   p/li -> line-height 退回 normal
  // 实测：加类前 19/19 项与预览不一致，加类后 0/19。
  assert.match(
    coreSrc,
    /wrap\.className\s*=\s*"mt-md-wysiwyg markdown-body"/,
    "渲染容器必须同时带 mt-md-wysiwyg 与 markdown-body 两个类",
  );
});

test("沉浸容器级属性必须被中和，避免 markdown-body 的限宽/居中影响沉浸布局", () => {
  // .markdown-body 自带 width:min(920px,…) / margin:0 auto / padding / font-size / line-height，
  // 这些是「容器级」属性，加到 widget 上会把沉浸正文挤窄、产生额外留白。
  // 必须有一条更高优先级的规则把它们还原成继承值。
  const idx = cssSrc.indexOf(".app-shell.immersive .cm-line .mt-md-wysiwyg.markdown-body");
  assert.ok(idx >= 0, "必须存在沉浸容器的容器级属性中和规则");
  const block = cssSrc.slice(idx, cssSrc.indexOf("}", idx) + 1);
  for (const decl of [
    /width:\s*auto/,
    /max-width:\s*none/,
    /margin:\s*0/,
    /padding:\s*0/,
    /font-size:\s*inherit/,
    // 行高必须继承编辑器行盒。自 PR-2 度量统一后，--prose-leading 已是
    // #editor / .cm-content / .markdown-body 三处唯一出处，继承即等于阅读栏比例；
    // 反向契约：此处不得再写死 1.82 之类的字面量，否则光标移入/移出时该行会变脸。
    /line-height:\s*inherit/,
  ]) {
    assert.match(block, decl, `容器级属性未中和：${decl}`);
  }
  assert.doesNotMatch(
    block,
    /line-height:\s*1\.\d+/,
    "容器行高不得写死字面量，必须继承统一的 --prose-leading",
  );
  // 中和规则必须比 .markdown-body 更晚出现（同权重下后者覆盖前者）
  assert.ok(
    idx > cssSrc.indexOf(".markdown-body {"),
    "中和规则必须位于 .markdown-body 容器级规则之后，否则会被覆盖",
  );
});

test("沉浸模式不得重复定义 .markdown-body 已提供的元素级排版", () => {
  // 历史教训：此前手写过 h1~h6 / p / ul / li / blockquote / pre / code / table / th / td
  // 共 10 类元素的规则，其中 pre 背景、table collapse、th/td padding 等声明
  // 因被轻量模式的 revert 规则反制而从未生效（写了等于没写），属于无效功。
  // 现在统一由 .markdown-body 提供，禁止再出现这些重复定义。
  for (const el of ["pre", "table", "blockquote", "code"]) {
    const re = new RegExp(`^\\s*\\.app-shell\\.immersive \\.mt-md-wysiwyg ${el}\\s*[,{]`, "m");
    assert.doesNotMatch(
      cssSrc,
      re,
      `不应再手写 .mt-md-wysiwyg ${el} 的规则，请交给 .markdown-body`,
    );
  }
});

test("渲染容器内必须用 revert 还原语义样式，且不得写死具体值", () => {
  const idx = cssSrc.indexOf("body.lightweight-editor .cm-line .mt-md-wysiwyg,");
  assert.ok(idx >= 0, "必须存在渲染容器的还原规则");
  const block = cssSrc.slice(idx, cssSrc.indexOf("}", idx) + 1);
  assert.match(block, /color: revert/, "颜色应交回内联 style / UA 默认");
  assert.match(block, /font-weight: revert/, "字重应还原为标签语义（strong 加粗）");
  assert.match(block, /text-decoration: revert/, "下划线/删除线应还原为标签语义");
  // 关键回归点：写死具体值会盖掉 <mark> 的 UA 默认黄底
  assert.doesNotMatch(
    block,
    /background-color:\s*(transparent|inherit)\s*;/,
    "不得写死 background-color，否则会盖掉 <mark> 的默认高亮底色",
  );
  assert.match(block, /background-color: revert/, "背景色必须退回到 UA 默认 / 内联样式");
});

test("静态资源缓存版本已同步递增", () => {
  const coreVersion = htmlSrc.match(/editor-core\.js\?v=([\w-]+)/)?.[1];
  const appVersion = htmlSrc.match(/app\.js\?v=([\w-]+)/)?.[1];
  const cssVersion = htmlSrc.match(/styles\.css\?v=([\w-]+)/)?.[1];
  assert.ok(coreVersion && appVersion && cssVersion, "三处版本参数都应存在");
  assert.equal(coreVersion, appVersion, "editor-core 与 app.js 版本应一致");
  assert.match(appSrc, new RegExp(`editor-core\\.js\\?v=${coreVersion}`), "app.js 引用版本应同步");
});

// ── 企业级文档排版（居中版心） ─────────────────────────────────────────────
// 背景：旧版沉浸正文按视口全宽左对齐铺满（padding-inline 仅 4~6px），
// 行号栏常驻左缘 —— 观感是「代码编辑器」而不是「文档」。
// 现改为：正文收进固定阅读测度并水平居中、行号栏隐藏、块间空行收缩。

test("沉浸正文栏必须收进固定阅读测度并水平居中", () => {
  const idx = cssSrc.indexOf(".app-shell.immersive #editor .cm-content");
  assert.ok(idx >= 0, "必须存在沉浸正文容器规则");
  const block = cssSrc.slice(idx, cssSrc.indexOf("}", idx) + 1);
  // 百分比 padding 相对滚动视口解析：宽屏时正文栏 = 版心宽并水平居中
  assert.match(
    block,
    /padding:\s*36px\s+max\(calc\(var\(--prose-gutter\)\s*\/\s*2\),\s*calc\(\(100% - var\(--mt-immersive-measure\)\)\s*\/\s*2\)\)\s+55vh/,
    "必须用对称 padding 实现居中版心，且保留顶部 36px 与底部 55vh 滚动余量",
  );
  // 顶部留白与预览一致（36px），不得回到 24px
  assert.doesNotMatch(block, /padding:\s*24px/, "顶部留白不得退回 24px");
});

test("沉浸字号必须与版心同乘 --prose-scale，不得再设 max() 下限", () => {
  // 历史缺陷：font-size: max(16px, calc(var(--doc-font-size) * 1.04))
  // —— 文档字号 ≤15.4px 时正文被强制放大到 16px，而版心不变，换行与阅读栏错位。
  const idx = cssSrc.indexOf(".app-shell.immersive #editor .cm-content");
  const block = cssSrc.slice(idx, cssSrc.indexOf("}", idx) + 1);
  assert.match(
    block,
    /font-size:\s*calc\(var\(--prose-size\)\s*\*\s*var\(--prose-scale\)\)/,
    "沉浸字号必须是 --prose-size × --prose-scale（与版心同源等比）",
  );
  assert.doesNotMatch(
    block,
    /^\s*font-size:[^;]*max\(\s*16px/m,
    "不得保留 max(16px, …) 下限，它会让小字号用户的设置失效",
  );
  assert.match(block, /line-height:\s*var\(--prose-leading\)/, "沉浸正文行高必须引用 --prose-leading");
});

test("沉浸版心测度必须与阅读栏同源（同一令牌 × 同一放大系数）", () => {
  // 阅读/预览 .markdown-body 的宽 = min(--prose-measure, 100% - --prose-gutter)；
  // 沉浸正文字号是阅读的 --prose-scale 倍，测度同步放大同一系数，
  // 两种视图每行字符数一致（换行位置对齐），实测两侧均为 53.75em。
  assert.match(
    cssSrc,
    /--mt-immersive-measure:\s*calc\(var\(--prose-measure\)\s*\*\s*var\(--prose-scale\)\)/,
    "版心测度必须是 --prose-measure × --prose-scale（与阅读栏同源）",
  );
  // 阅读版心必须取自同一令牌，不得再写死像素
  assert.match(
    cssSrc,
    /\.markdown-body\s*\{[^}]*width:\s*min\(var\(--prose-measure\),\s*calc\(100% - var\(--prose-gutter\)\)\)/,
    "阅读版心必须引用 --prose-measure / --prose-gutter",
  );
  assert.doesNotMatch(cssSrc, /width:\s*min\(920px/, "不应再出现写死的 920px 版心");
});

test("沉浸模式必须隐藏行号/折叠栏", () => {
  const idx = cssSrc.indexOf(".app-shell.immersive #editor .cm-gutters");
  assert.ok(idx >= 0, "必须存在沉浸模式隐藏行号栏的规则");
  const block = cssSrc.slice(idx, cssSrc.indexOf("}", idx) + 1);
  assert.match(block, /display:\s*none/, "行号/折叠栏应整体隐藏");
  // 作用域必须限定在 immersive，普通编辑态的行号不得受影响
  const plainGutter = cssSrc.indexOf("#editor .cm-gutters");
  assert.ok(plainGutter >= 0 && plainGutter < idx, "普通编辑态的行号栏规则必须仍然存在");
});

test("块间空行必须收缩到与预览段落间距一致，但不得归零", () => {
  const idx = cssSrc.indexOf(".app-shell.immersive #editor .cm-line:has(> br:only-child)");
  assert.ok(idx >= 0, "必须存在空行收缩规则（CodeMirror 只给空行渲染唯一 <br>）");
  const block = cssSrc.slice(idx, cssSrc.indexOf("}", idx) + 1);
  assert.match(block, /line-height:\s*var\(--mt-immersive-blank-line\)/, "空行行高必须走变量");
  // 变量必须定义为 16px（≈预览段落间距 1em）；写 0 会得到不可见的光标
  assert.match(cssSrc, /--mt-immersive-blank-line:\s*16px/, "空行行高必须为 16px");
  assert.doesNotMatch(
    block,
    /height:\s*0|line-height:\s*0/,
    "空行不得归零：0 高行会让光标消失、无法点击定位",
  );
  // :has 不被支持时整条规则被丢弃，空行退回整行高 —— 平滑降级，无需 JS 兜底
  assert.match(block, /:has\(> br:only-child\)/, "必须用 br:only-child 精确匹配空行");
});

test("窄屏下沉浸正文只保留贴边可读宽度", () => {
  const mq = cssSrc.slice(cssSrc.indexOf("@media (max-width: 720px)"));
  const block = mq.slice(mq.indexOf(".app-shell.immersive #editor .cm-content"));
  assert.match(block, /padding-inline:\s*14px/, "窄屏应使用 14px 贴边留白");
});

// ── 公式渲染（沉浸不渲染的两个根因） ────────────────────────────────────────
// 背景：沉浸模式里公式完全不显示，实测有四块含公式的段落只有最后一块渲染出 KaTeX，
// 其余三块的 <span> 子元素数为 0（完全空白），且移动光标后仍不自愈。
// 两个独立根因：① 渲染序号是全局变量，同帧并发的块互相顶掉；
//              ② 普通段落里的 $…$ 从不进入渲染管线（块级渲染刻意不收普通段落）。

test("公式渲染序号按容器记账，沉浸多块并发不再互相顶掉", () => {
  assert.doesNotMatch(appSrc, /let _mathRenderSeq\b/, "不得再使用全局渲染序号");
  const body = fnBody(appSrc, "async function renderMathInPreview(container)");
  assert.match(body, /_mathRenderSeqs/, "应按容器维度记账（WeakMap）");
  assert.match(body, /const seq = \(_mathRenderSeqs\.get\(container\) \|\| 0\) \+ 1/, "序号应从容器自身累加");
  assert.match(body, /_mathRenderSeqs\.set\(container, seq\)/, "新序号应写回容器");
  assert.match(body, /const stale = \(\) => _mathRenderSeqs\.get\(container\) !== seq/, "过期判定只比对本容器");
  assert.doesNotMatch(body, /seq !== _mathRenderSeq\b/, "不得再与全局序号比较");
  // querySelectorAll 不含容器自身：段落内行内公式的挂载钩子收到的就是该元素本身
  assert.match(body, /container\.matches\(selector\)/, "待渲染集合必须包含容器自身，否则行内公式永远渲染不出来");
});

test("普通段落里的行内公式走独立装饰（不参与块替换）", () => {
  assert.match(coreSrc, /class InlineMathWidget extends WidgetType/, "应有行内公式 widget");
  assert.match(coreSrc, /function scanInlineMathTokens\(/, "应有行内公式扫描器");
  const body = fnBody(coreSrc, "compute(view) {");
  assert.match(body, /scanInlineMathTokens\(/, "应扫描行内公式");
  assert.match(body, /new InlineMathWidget\(/, "应产出行内公式装饰");
  // 同一段文本上的替换装饰重叠会让 CodeMirror 直接抛错
  assert.match(body, /claimed\.some\(/, "样式标记与公式标记范围重叠时必须让路");

  const widget = fnBody(coreSrc, "class InlineMathWidget extends WidgetType");
  assert.match(widget, /math-inline mt-md-inline-math/, "widget 须产出 .math-inline[data-math]（宿主按此渲染 KaTeX）");
  assert.match(widget, /setAttribute\("data-math", this\.latex\)/, "须携带 data-math");
  // 关键回归点：不能改用 display:block 的 .math-block，那会在段落文本行里插一个块级盒子，
  // 把一行劈成「公式前 / 公式后」两个匿名块。独占一行居中的 $$…$$ 由块级识别接管。
  assert.doesNotMatch(widget, /className\s*=\s*"[^"]*math-block/, "不得用 display:block 的 math-block 撑断段落行");
  assert.match(widget, /queueMicrotask/, "须在挂载后异步触发宿主渲染");
  assert.match(widget, /this\.source/, "未渲染前应显示用户写的原始源码（含定界符）");

  const scanner = fnBody(coreSrc, "function scanInlineMathTokens(text)");
  assert.ok(scanner.includes('text[i - 1] === "\\\\"'), "应跳过反斜杠转义的 \\$");
  assert.match(scanner, /\\s\/\.test\(text\[open\]\)/, "开场定界符右侧不得为空白（避免「售价 $ 5 元」误判）");
  assert.match(scanner, /close === -1\) break/, "未闭合的半截公式应保持源码");
});

test("Worker 侧 escapeHtml 保留 NUL 占位符边界", () => {
  // 跨行块级公式的占位符是 `\u0000MBLK_n_MBLK\u0000`；旧 escapeHtml 把 NUL 一并剥离，
  // 还原正则匹配不到 → 阅读栏直接显示字面量 MBLK_0_MBLK。
  const workerSrc = readFileSync(new URL("../public/markdown-worker.js", import.meta.url), "utf8");
  const body = fnBody(workerSrc, "function escapeHtml(value)");
  assert.ok(!body.includes("\\u0000-\\u0008"), "控制字符剥离不得从 U+0000 开始");
  assert.ok(body.includes("\\u0001-\\u0008"), "应从 U+0001 起剥离，保留 NUL");
  assert.match(workerSrc, /\\u0000MBLK_/, "占位符 token 仍以 NUL 为边界");
});

// ── 图表排版（过大 / 占位） ────────────────────────────────────────────────
// 背景：mermaid 出图后页面 CSS 直接 width:100%，中文 4 节点流程图被从 266px 拉到 922px
// （3.27×，标签字号相当于正文 3 倍），再被 70vh 容器截断；
// 同时 _mermaidRenderSeq 全局序号让同批 4 个图表只出 1 个，其余永久停在加载占位。

test("图表渲染序号按容器记账，沉浸多图并发不再只出一个", () => {
  assert.doesNotMatch(appSrc, /let _mermaidRenderSeq\b/, "不得再使用全局渲染序号");
  const preview = fnBody(appSrc, "async function renderChartsInPreview(");
  assert.match(preview, /_chartRenderSeqs/, "预览路径应按容器记账");
  assert.match(preview, /const isCurrent = \(\) =>/, "应派生 isCurrent 判定");
  assert.doesNotMatch(preview, /seq === _mermaidRenderSeq\b/, "不得再与全局序号比较");
  const print = fnBody(appSrc, "async function materializePrintArtifacts(");
  assert.match(print, /_chartRenderSeqs/, "打印路径同样按容器记账");
  assert.doesNotMatch(print, /seq === _mermaidRenderSeq\b/, "打印路径也不得再与全局序号比较");
});

test("Mermaid 图表不再强制拉满版心，以自然尺寸为上限", () => {
  assert.match(appSrc, /function naturalSvgWidth\(svgEl\)/, "应有自然尺寸计算函数");
  const helper = fnBody(appSrc, "function naturalSvgWidth(svgEl)");
  assert.match(helper, /getAttribute\("viewBox"\)/, "自然宽度取自修正后的 viewBox（已双向夹紧）");
  for (const [name, marker] of [
    ["预览", "async function renderChartsInPreview("],
    ["打印", "async function materializePrintArtifacts("],
  ]) {
    const body = fnBody(appSrc, marker);
    assert.match(body, /naturalSvgWidth\(svgEl\)/, `${name}路径应计算自然宽度`);
    assert.match(body, /style\.maxWidth = `\$\{Math\.round\(naturalW\)\}px`/, `${name}路径应以自然宽度为 max-width 上限`);
    assert.match(body, /style\.margin = "0 auto"/, `${name}路径应让小于版心的图表水平居中`);
  }
});

test("Mermaid 渲染 id 必须全局唯一，且渲染串行化", () => {
  // 背景：mermaid 会把生成的根 <svg> id 设为调用时传入的 id，并在下一次 render 结束时
  // 按 `#id` 删除该元素。旧 id `mermaid-svg-${Date.now()}-${i}-${seq}` 在沉浸模式下
  // i/seq 恒为 0/1，同帧并发落在同一毫秒 → id 相同 → 后一次渲染把前一次已写入正文的
  // 图表从 DOM 里删掉，实测 4 张图只剩 1 张。串行化则是修 mermaid.render 本身的并发不安全
  // （实测 4 张同帧渲染：1 张悬挂占位、1 张量出 2412×512 失真 viewBox）。
  assert.doesNotMatch(appSrc, /const id = `mermaid-svg-\$\{Date\.now\(\)\}/, "渲染 id 不得再用 Date.now()（同帧并发会碰撞）");
  assert.match(appSrc, /let _mermaidRenderUid = 0/, "应使用全局自增 id");
  assert.match(appSrc, /mermaid-svg-\$\{\+\+_mermaidRenderUid\}/, "预览路径 id 应全局自增");
  assert.match(appSrc, /print-mermaid-\$\{\+\+_mermaidRenderUid\}/, "打印路径 id 应全局自增");
  assert.match(appSrc, /function renderMermaidSerialized\(/, "应有 mermaid 渲染串行化入口");
  const ser = fnBody(appSrc, "function renderMermaidSerialized(");
  assert.match(ser, /_mermaidRenderChain\.then/, "真正的 render 应挂在串行链上");
  assert.match(ser, /_mermaidRenderChain = task\.then\(\(\) => \{\}, \(\) => \{\}\)/, "成败都要放行链条（一次失败不得堵死后续）");
  assert.match(ser, /Mermaid 渲染超时/, "应有兜底超时，卡死的图不得永久堵住队列");
  const preview = fnBody(appSrc, "async function renderChartsInPreview(");
  const print = fnBody(appSrc, "async function materializePrintArtifacts(");
  assert.match(preview, /renderMermaidSerialized\(mermaid, id, rawDef\)/, "预览路径应走串行化渲染");
  assert.match(print, /renderMermaidSerialized\(mermaid, id, rawDef\)/, "打印路径应走串行化渲染");
});

test("沉浸模式：多行块占位行收缩 + 图表错误区限高", () => {
  // 多行块除首行外都是 MarkdownBlankWidget(<span class="mt-md-blank">)，不是 <br>，
  // :has(> br:only-child) 命中不了 → 每行仍占整行高，块底拖出上百像素空白。
  const blankIdx = cssSrc.indexOf(".app-shell.immersive #editor .cm-line:has(> .mt-md-blank)");
  assert.ok(blankIdx >= 0, "多行块占位行必须纳入空行收缩");
  const blankBlock = cssSrc.slice(blankIdx, cssSrc.indexOf("}", blankIdx) + 1);
  assert.match(blankBlock, /line-height:\s*var\(--mt-immersive-blank-line\)/, "占位行行高须收缩");

  const errIdx = cssSrc.indexOf(".app-shell.immersive .mt-md-wysiwyg .chart-error");
  assert.ok(errIdx >= 0, "沉浸模式必须限制图表错误区高度");
  const errBlock = cssSrc.slice(errIdx, cssSrc.indexOf("}", errIdx) + 1);
  assert.match(errBlock, /max-height:\s*\d+px/, "错误区须限高（几十行英文报错会占满一屏）");
  assert.match(errBlock, /overflow:\s*auto/, "错误区须允许内部滚动");
});

// ===========================================================================
// PR-3 · 沉浸模式补全：行内语义标记 + 正文字体 + 块间距令牌
// ===========================================================================

// editor-core.js 的这段实现只依赖 escapeHtml 与 WidgetType，两者都能在测试里补齐，
// 因此直接切出源码片段求值 —— 验证的是「真实行为」，而不是「代码长什么样」。
function loadInlineMarkModule() {
  const start = coreSrc.indexOf("const INLINE_MARK_MAX_DEPTH");
  const end = coreSrc.indexOf("class MarkdownPreviewWidget");
  assert.ok(start >= 0 && end > start, "找不到行内语义标记渲染模块");
  const chunk = coreSrc.slice(start, end);
  const shim = [
    "class WidgetType {}",
    "function escapeHtml(value) {",
    "  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')",
    "    .replaceAll('>', '&gt;').replaceAll('\\\"', '&quot;');",
    "}",
  ].join("\n");
  const factory = new Function(
    `${shim}\n${chunk}\nreturn { scanInlineMarkTokens, renderInlineMarkHtml, safeInlineUrl };`,
  );
  return factory();
}

test("PR-3：行内语义标记六类语法的渲染结果", () => {
  const { renderInlineMarkHtml } = loadInlineMarkModule();
  assert.equal(renderInlineMarkHtml("**粗**"), "<strong>粗</strong>");
  assert.equal(renderInlineMarkHtml("*斜*"), "<em>斜</em>");
  assert.equal(renderInlineMarkHtml("_斜_"), "<em>斜</em>");
  assert.equal(renderInlineMarkHtml("`码`"), "<code>码</code>");
  assert.equal(renderInlineMarkHtml("~~删~~"), "<del>删</del>");
  assert.equal(renderInlineMarkHtml("==亮=="), "<mark>亮</mark>");
  const link = renderInlineMarkHtml("[官网](https://example.com)");
  assert.match(link, /<a class="mt-md-inline-link"/, "外链须产出锚点");
  assert.match(link, /data-href="https:\/\/example\.com"/, "外链地址写入 data-href，不写 href 以免 WebView 内部跳转");
  assert.doesNotMatch(link, /\shref="https/, "不得写 href 属性");
  assert.match(link, />官网<\/a>/, "锚点文字保留");
  // 未含标记的普通文本等价于 HTML 转义
  assert.equal(renderInlineMarkHtml("普通 a < b"), "普通 a &lt; b");
});

test("PR-3：行内语义标记的保守规则（转义 / 未闭合 / 非外链一律不误伤）", () => {
  const { renderInlineMarkHtml, safeInlineUrl } = loadInlineMarkModule();
  // 未闭合 → 保持源码
  assert.equal(renderInlineMarkHtml("**没闭合"), "**没闭合");
  assert.equal(renderInlineMarkHtml("~~没闭合"), "~~没闭合");
  assert.equal(renderInlineMarkHtml("==没闭合"), "==没闭合");
  // 反斜杠转义 → 不渲染，且还原为字面字符
  assert.equal(renderInlineMarkHtml("\\*不是斜体\\*"), "*不是斜体*");
  assert.equal(renderInlineMarkHtml("\\`不是代码\\`"), "`不是代码`");
  // 定界符内侧是空白 → 保持源码
  assert.equal(renderInlineMarkHtml("* 不是斜体 *"), "* 不是斜体 *");
  // snake_case 标识符不得被判成斜体
  assert.equal(renderInlineMarkHtml("foo_bar_baz"), "foo_bar_baz");
  // 行内代码优先级最高：内部不再解析其它标记
  assert.equal(renderInlineMarkHtml("`**不是粗体**`"), "<code>**不是粗体**</code>");
  // 非白名单协议只保留文字，不生成可点击元素
  assert.equal(renderInlineMarkHtml("[x](ftp://a.com/b)"), "x");
  assert.doesNotMatch(renderInlineMarkHtml("[x](../相对路径.md)"), /<a /, "相对路径不得渲染为链接");
  assert.doesNotMatch(renderInlineMarkHtml("[x](javascript:alert(1))"), /<a /, "脚本协议必须拒绝");
  assert.equal(safeInlineUrl("javascript:alert(1)"), "");
  assert.equal(safeInlineUrl("data:text/html,x"), "");
  assert.equal(safeInlineUrl("https://a.com"), "https://a.com");
  assert.equal(safeInlineUrl("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(safeInlineUrl("tel:+8613800000000"), "tel:+8613800000000");
});

test("PR-3：行内语义标记可嵌套、范围互不重叠且递归有上限", () => {
  const { renderInlineMarkHtml, scanInlineMarkTokens } = loadInlineMarkModule();
  assert.equal(
    renderInlineMarkHtml("**粗 `码` 体**"),
    "<strong>粗 <code>码</code> 体</strong>",
    "加粗内可嵌套行内代码",
  );
  assert.equal(
    renderInlineMarkHtml("==亮 `码`==\n".trim()),
    "<mark>亮 <code>码</code></mark>",
    "高亮内可嵌套行内代码",
  );
  // 外层被内层包裹时，内层的「不再解析」规则优先：代码里的 ** 必须保持字面
  assert.equal(renderInlineMarkHtml("`**x**`"), "<code>**x**</code>");
  const toks = scanInlineMarkTokens("a **b** c `d` e");
  assert.equal(toks.length, 2);
  for (let i = 1; i < toks.length; i += 1) {
    assert.ok(
      toks[i - 1].to <= toks[i].from,
      "扫描结果必须互不重叠（重叠的 replace 装饰会让 CodeMirror 直接抛错）",
    );
    assert.ok(toks[i - 1].from <= toks[i].from, "结果须按位置升序");
  }
  assert.match(coreSrc, /INLINE_MARK_MAX_DEPTH/, "必须有递归深度上限");
  // 极深嵌套不得抛异常（超深应退化为纯文本）
  assert.equal(typeof renderInlineMarkHtml("*".repeat(24) + "x"), "string");
});

test("PR-3：行内语义标记接入装饰构建器，并与样式标记/行内公式共享占位", () => {
  const builder = fnBody(coreSrc, "compute(view) {");
  assert.match(builder, /scanInlineMarkTokens\(text\)/, "构建器须调用行内语义标记扫描");
  assert.match(builder, /new InlineMarkWidget\(/, "须替换为行内语义标记 widget");
  assert.match(builder, /overlapsClaimed/, "须与样式标记/行内公式共用重叠判定");
  // 同一段文本只能有一个替换装饰：优先级须为 样式标记 > 行内公式 > 语义标记
  const styleIdx = builder.indexOf("scanInlineStyleTokens");
  const mathIdx = builder.indexOf("scanInlineMathTokens");
  const markIdx = builder.indexOf("scanInlineMarkTokens");
  assert.ok(styleIdx >= 0 && mathIdx > styleIdx && markIdx > mathIdx, "优先级须为 样式标记 > 行内公式 > 语义标记");
  // widget 必须参与 DOM 复用判断，否则每次重渲染都替换节点
  const widget = fnBody(coreSrc, "class InlineMarkWidget extends WidgetType");
  assert.match(widget, /eq\(other\)/, "widget 须实现 eq 以复用 DOM");
  assert.match(widget, /other\.key === this\.key/, "复用判据须基于内容 key");
  assert.match(widget, /mt-md-inline-mark markdown-body/, "容器须同挂 markdown-body 以复用预览排版");
});

test("PR-3：行内渲染容器在沉浸模式下中和容器级属性并改用正文字体", () => {
  const idx = cssSrc.indexOf(".app-shell.immersive .cm-line .mt-md-inline-mark.markdown-body");
  assert.ok(idx >= 0, "必须有行内语义标记容器的中和规则");
  const block = cssSrc.slice(idx, cssSrc.indexOf("}", idx) + 1);
  assert.match(block, /width:\s*auto/, "版心宽度必须中和");
  assert.match(block, /max-width:\s*none/, "最大宽度必须中和");
  assert.match(block, /padding:\s*0/, "36px/80px 内边距必须中和");
  assert.match(
    block,
    /^\s*font-size:\s*inherit;/m,
    "行内片段字号必须继承编辑器行盒（沉浸字号 = 正文 × --prose-scale），否则同一句话里字号不一致",
  );
  assert.match(block, /line-height:\s*inherit/, "行高必须继承");
  assert.doesNotMatch(
    block,
    /^\s*font-size:\s*var\(--prose-size\)/m,
    "不得沿用 .markdown-body 的正文绝对字号",
  );
  // 字体：与块级渲染容器同源，避免同一文档出现两种 font-family
  const fontIdx = cssSrc.search(
    /\.app-shell\.immersive \.cm-line \.mt-md-inline-mark,\s*\n\s*\.app-shell\.immersive \.cm-line \.mt-md-inline-style \{/,
  );
  assert.ok(fontIdx >= 0, "行内语义标记与行内样式标记必须显式声明正文字体");
  const fontBlock = cssSrc.slice(fontIdx, cssSrc.indexOf("}", fontIdx) + 1);
  assert.match(fontBlock, /font-family:\s*var\(--prose-font\)/, "须使用 --prose-font");
});

test("PR-3：块级与行内渲染容器的正文字体必须同源且跟随用户设置", () => {
  // --prose-font / --font-sans 都必须映射到用户可配置的 --app-font-family
  assert.match(cssSrc, /--prose-font:\s*var\(--app-font-family\)/, "--prose-font 必须跟随用户字体设置");
  assert.match(cssSrc, /--font-sans:\s*var\(--app-font-family\)/, "--font-sans 必须跟随用户字体设置");
  // 块级渲染容器沿用 --font-sans（含兜底栈），行内容器用 --prose-font，两者最终指向同一栈
  const idx = cssSrc.indexOf(".app-shell.immersive .mt-md-wysiwyg {");
  assert.ok(idx >= 0, "找不到块级渲染容器基座规则");
  const block = cssSrc.slice(idx, cssSrc.indexOf("}", idx) + 1);
  assert.match(block, /font-family:\s*var\(--font-sans/, "块级渲染容器须使用无衬线字体（不得继承 #editor 的等宽栈）");
  // 宿主确实把用户设置写到 :root 上
  assert.match(appSrc, /setProperty\(\s*"--app-font-family"/, "宿主须把用户字体设置写到 :root");
});

test("PR-3：渲染块块间距改由令牌控制", () => {
  assert.match(cssSrc, /--prose-block-gap:\s*1em/, "须有段落块间距令牌");
  assert.match(cssSrc, /--prose-block-gap-fixed:\s*16px/, "须有块级容器间距令牌");
  assert.match(
    cssSrc,
    /\.markdown-body p \{\s*margin:\s*0 0 var\(--prose-block-gap\);\s*\}/,
    "段落间距须引用令牌",
  );
  assert.doesNotMatch(cssSrc, /\.markdown-body p \{\s*margin:\s*0 0 1em;\s*\}/, "不得再写死 1em");
  const fixedUses = (cssSrc.match(/var\(--prose-block-gap-fixed\)/g) || []).length;
  assert.ok(fixedUses >= 5, `引用块间距令牌的规则应≥5 处（引用/提示/表格/图片/图表），实际 ${fixedUses}`);
  // 引用、表格、图片、图表都不得再写死 16px/18px
  assert.doesNotMatch(cssSrc, /\.markdown-body blockquote \{\s*margin:\s*16px 0;/, "引用块间距须走令牌");
  assert.doesNotMatch(cssSrc, /\.markdown-table-wrap \{\s*width:\s*100%;\s*margin:\s*18px 0;/, "表格容器间距须走令牌");
  assert.doesNotMatch(cssSrc, /\.chart-block \{\s*margin:\s*16px 0;/, "图表容器间距须走令牌");
});

test("PR-3：沉浸渲染结果的外链点击桥已接到宿主", () => {
  assert.match(appSrc, /window\.__mtOpenExternal = /, "宿主必须暴露外链打开桥");
  const bridge = fnBody(appSrc, "window.__mtOpenExternal = async function");
  assert.match(bridge, /\/api\/open-url/, "复用统一的外链打开路由");
  assert.match(bridge, /https\?:\|mailto:\|tel:/, "只放行 http/https/mailto/tel");
  assert.match(bridge, /window\.open\(href, "_blank", "noopener,noreferrer"\)/, "失败须回退到新标签打开");
  const widget = fnBody(coreSrc, "class InlineMarkWidget extends WidgetType");
  assert.match(widget, /__mtOpenExternal/, "行内链接组件须调用宿主桥");
  assert.match(widget, /!event\.ctrlKey && !event\.metaKey/, "Ctrl/Cmd + 点击才打开外链，普通点击仍用于定位光标");
  assert.match(widget, /ignoreEvent\(\)[\s\S]*return false/, "须把普通点击交还编辑器");
});
