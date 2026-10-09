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
    // 行高必须固定为文档正文比例 1.82（与预览面板 .markdown-body 一致），
    // 不能 inherit —— 编辑器 #editor 是 1.76（为源码可读性调过），
    // 继承会让沉浸正文行高比预览低 3.3%，实测可得 29.952px vs 29.12px。
    /line-height:\s*1\.82/,
  ]) {
    assert.match(block, decl, `容器级属性未中和：${decl}`);
  }
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
    /padding:\s*36px\s+max\(24px,\s*calc\(\(100% - var\(--mt-immersive-measure\)\) \/ 2\)\)\s+55vh/,
    "必须用对称 padding 实现居中版心，且保留顶部 36px 与底部 55vh 滚动余量",
  );
  // 顶部留白与预览一致（36px），不得回到 24px
  assert.doesNotMatch(block, /padding:\s*24px/, "顶部留白不得退回 24px");
});

test("沉浸版心测度必须与预览面板同源（920px 并按 1.04 字号比放大）", () => {
  // 预览 .markdown-body 用 min(920px, …)；沉浸正文字号是预览的 1.04 倍，
  // 测度同步放大 1.04 才能保证两种视图每行字符数一致（换行位置对齐）。
  assert.match(
    cssSrc,
    /--mt-immersive-measure:\s*calc\(920px \* 1\.04\)/,
    "版心测度必须是 920px * 1.04（与预览同源）",
  );
  // 预览面板的 920px 阅读测度不得被改动
  assert.match(cssSrc, /\.markdown-body \{\r?\n  width: min\(920px/);
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
