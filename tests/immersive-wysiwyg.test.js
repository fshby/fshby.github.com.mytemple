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

test("渲染范围收窄为标题/分隔线/围栏代码块，段落不动", () => {
  const body = fnBody(coreSrc, "collectMdBlockRanges(doc)");
  assert.match(body, /#\{1,6\}/, "应识别标题");
  assert.match(body, /```/, "应识别围栏代码块");
  assert.doesNotMatch(
    body,
    /^\s*if \(text\.trim\(\)\) \{/m,
    "不得把普通段落纳入块级替换（会影响行高与光标落点）",
  );
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

test("静态资源缓存版本已同步递增", () => {
  const coreVersion = htmlSrc.match(/editor-core\.js\?v=([\w-]+)/)?.[1];
  const appVersion = htmlSrc.match(/app\.js\?v=([\w-]+)/)?.[1];
  const cssVersion = htmlSrc.match(/styles\.css\?v=([\w-]+)/)?.[1];
  assert.ok(coreVersion && appVersion && cssVersion, "三处版本参数都应存在");
  assert.equal(coreVersion, appVersion, "editor-core 与 app.js 版本应一致");
  assert.match(appSrc, new RegExp(`editor-core\\.js\\?v=${coreVersion}`), "app.js 引用版本应同步");
});
