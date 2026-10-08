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

function fnBody(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `找不到 ${marker}`);
  const bodyStart = src.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
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
