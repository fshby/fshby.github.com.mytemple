// 回归测试：本机 HTML 文档的打开 / 渲染，以及它对索引、沉浸模式、云同步的边界
//
// 背景（2026-10-13）：
//   `.html` 此前只能「源码 + 语法高亮」，阅读态与预览看不到网页效果；后端其实
//   早已把 html 当文本入库，卡点只在前端类型分派与沙箱。补渲染时必须同时守住
//   四条边界，否则「打开一个下载来的网页」会变成「在本机跑一段能读写知识库的脚本」：
//
//   1. 沙箱不含 allow-same-origin —— allow-scripts 与 allow-same-origin 同时给
//      等于没有沙箱（OWASP 反模式）。帧内会拿到同源权限：读 parent.document、
//      读 localStorage 里的登录态、直接同源请求 /api/save 与 /api/files。
//   2. 不给 allow-popups / allow-top-navigation，帧内不能弹窗或把整个应用导航走。
//   3. 检索用纯文本按扩展名分派（html 去标签），否则 `<div class="...">` 会成片
//      进入倒排索引，全局搜索全是标签噪音。
//   4. 沉浸模式的块级渲染只对 Markdown 生效。html **进云同步**，但必须带正文
//      大小上限，且云端按扩展名分派渲染（沙箱 iframe，不是 markdown 渲染）；
//      json / csv 仍排除（工作区里的 json 常是含 token 的配置文件）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

const appSrc = read("public/app.js");
const workerSrc = read("public/markdown-worker.js");
const cloudWorkerSrc = read("cloud/markdown-worker.js");
const cssSrc = read("public/styles.css");
const appRs = read("src-tauri/src/app.rs");
const cloudApp = read("cloud/app.js");
const cloudClient = read("public/modules/cloud-client.js");
const shareSrc = read("cloud/share.js");
const shareCss = read("cloud/share.css");

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

// fnBody 把「第一个 {」当函数体起点，遇到 `options = {}` 这类默认参数就会立刻收尾，
// 所以带对象参数的函数改用这个：传入以 `{` 结尾的完整签名，从那里开始配平。
function fnBodyAt(src, sig) {
  const i = src.indexOf(sig);
  assert.ok(i >= 0, `找不到 ${sig}`);
  return fnBody(src.slice(i + sig.length - 1), "");
}

test("HTML 文档有独立的类型识别与渲染入口（不复用 Markdown 管线）", () => {
  assert.match(appSrc, /currentIsHtml: false,/s, "state 必须有 currentIsHtml 字段");
  assert.ok(
    appSrc.includes("/\\.(html?|xhtml)$/i"),
    "扩展名正则须覆盖 .html / .htm / .xhtml",
  );
  const can = fnBody(appSrc, "function canPreviewAsHtml()");
  assert.match(can, /isHtmlDocPath\(state\.currentPath\)/, "判定依据必须是当前路径");
  assert.match(can, /if \(state\.currentIsMarkdown\) return false;/, "与 Markdown 互斥");
  assert.match(appSrc, /function renderHtmlPreview\(container, source, options = \{\}\)/);
});

test("openDoc 为 html 铺开双轨：编辑态源码 + 预览/阅读态网页", () => {
  assert.match(
    appSrc,
    /state\.currentIsHtml = !state\.currentIsMarkdown && isHtmlDocPath\(doc\.path\)/,
    "打开文档时要刷新类型标记",
  );
  const openDoc = fnBodyAt(appSrc, "async function openDoc(docPath, options = {}) {");
  assert.match(openDoc, /renderHtmlPreview\(els\.preview, doc\.content\)/, "编辑态预览要渲染网页");
  assert.match(
    openDoc,
    /renderHtmlPreview\(els\.markdownView, doc\.content, \{ defer: true \}\)/,
    "阅读态容器要渲染但延时装载",
  );
  assert.match(openDoc, /if \(state\.mode !== "edit"\) setMode\("edit"\)/, "html 与 JSON 一致：打开即编辑态");
});

test("内嵌网页沙箱必须不含 allow-same-origin", () => {
  const m = /const HTML_DOC_SANDBOX = "([^"]+)"/.exec(appSrc);
  assert.ok(m, "必须有统一的 HTML_DOC_SANDBOX 常量");
  const flags = m[1].split(/\s+/);
  assert.ok(flags.includes("allow-scripts"), "需要 allow-scripts 才能渲染带脚本的网页");
  assert.ok(
    !flags.includes("allow-same-origin"),
    "禁止 allow-same-origin：与 allow-scripts 同给等于没有沙箱，帧内可读 parent 与 localStorage",
  );
  assert.ok(!flags.includes("allow-popups"), "不得允许弹窗");
  assert.ok(!flags.includes("allow-top-navigation"), "不得允许把整个应用导航走");

  // 桌面端 / 云端 worker 里的 Markdown 内嵌 HTML 块同样不得残留旧组合。
  // 只看真正会写进 sandbox 属性的值 —— 注释里说明「不含 allow-same-origin」不算数。
  for (const [name, src] of [
    ["public/app.js", appSrc],
    ["public/markdown-worker.js", workerSrc],
    ["cloud/markdown-worker.js", cloudWorkerSrc],
  ]) {
    const attrs = [...src.matchAll(/sandbox="([^"]*)"/g)].map((x) => x[1]);
    const viaConst = [...src.matchAll(/setAttribute\("sandbox", ([^)]+)\)/g)].map((x) => x[1]);
    assert.ok(attrs.length + viaConst.length > 0, `${name} 找不到沙箱声明`);
    for (const v of attrs) {
      assert.ok(
        !v.includes("allow-same-origin"),
        `${name} 的 sandbox 属性不得含 allow-same-origin：${v}`,
      );
    }
    for (const v of viaConst) {
      assert.match(v, /HTML_DOC_SANDBOX/, `${name} 的 sandbox 必须来自统一常量：${v}`);
    }
  }

  // 「放大」全屏帧不得借机放宽沙箱：sandbox="" 也要原样继承
  assert.match(
    appSrc,
    /fullIframe\.setAttribute\(\s*"sandbox",\s*inheritedSandbox === null \? HTML_DOC_SANDBOX : inheritedSandbox,?\s*\)/,
    "全屏帧必须沿用同一沙箱（空值不得回退到放宽策略）",
  );
});

test("HTML 预览用 DOM 属性装载 srcdoc，不把内容拼进 HTML 字符串", () => {
  const body = fnBodyAt(appSrc, "function renderHtmlPreview(container, source, options = {}) {");
  assert.match(body, /frame\.setAttribute\("sandbox", HTML_DOC_SANDBOX\)/, "沙箱必须来自统一常量");
  assert.match(body, /frame\.srcdoc = HTML_FRAME_RESIZE_SCRIPT \+ content/, "srcdoc 必须用属性赋值（自动转义），并前置高度上报脚本");
  assert.doesNotMatch(body, /srcdoc="\$\{/, "禁止把用户 HTML 拼进标记字符串");
  assert.match(body, /container\.replaceChildren\(block\)/);
  assert.match(body, /decorateHtmlInlineBlocks\(container\)/, "复用「放大」按钮机制");
});

test("阅读态 iframe 延时装载：同一篇文档不同时跑两份脚本", () => {
  const body = fnBodyAt(appSrc, "function renderHtmlPreview(container, source, options = {}) {");
  assert.match(body, /container\.__pendingHtml = \{ frame, content: HTML_FRAME_RESIZE_SCRIPT \+ content \}/, "defer 时先挂起内容（含高度上报脚本）");
  const activate = fnBody(appSrc, "function activateDeferredHtml(container)");
  assert.match(activate, /pending\.frame\.srcdoc = pending\.content/);
  assert.match(activate, /pending\.frame\.isConnected/, "已移除的帧不得再装载");
  assert.match(
    appSrc,
    /if \(state\.currentIsHtml\) activateDeferredHtml\(els\.markdownView\)/,
    "切到阅读模式时才激活",
  );
  assert.match(
    appSrc,
    /renderHtmlPreview\(els\.markdownView, state\.currentContent, \{ defer: true, force: true \}\)/,
    "切回编辑态要卸掉后台 iframe（换回延时占位）",
  );
});

test("编辑内容变化时预览按指纹去重，不反复重建 iframe", () => {
  const body = fnBodyAt(appSrc, "function renderHtmlPreview(container, source, options = {}) {");
  assert.match(body, /const key = htmlDocDigest\(content\)/);
  assert.match(body, /if \(!options\.force && prev && prev\.dataset\.htmlKey === key\) return;/);
  assert.match(fnBody(appSrc, "function htmlDocDigest(text)"), /return `\$\{s\.length\}:/, "指纹需含长度");
});

test("预览开关与预览刷新对 html 放行", () => {
  const setPreview = fnBodyAt(appSrc, "function setPreviewVisible(visible, { automatic = false } = {}) {");
  assert.match(setPreview, /!canPreviewAsHtml\(\)/, "不得把 html 判成「预览不可用」");
  assert.match(
    fnBody(appSrc, "function renderCurrentPreviewNow("),
    /canPreviewAsHtml\(\)/,
    "同步刷新路径要处理 html",
  );
  assert.match(
    fnBody(appSrc, "async function renderCurrentPreviewAsync("),
    /canPreviewAsHtml\(\)/,
    "异步刷新路径要处理 html",
  );
});

test("沉浸模式的块级渲染只对 Markdown 生效", () => {
  assert.match(
    appSrc,
    /setWysiwygEnabled\?\.\(state\.immersive && state\.currentIsMarkdown\)/,
    "进入沉浸时块级渲染须绑定 Markdown",
  );
  assert.ok(
    !/setWysiwygEnabled\?\.\(true\)/.test(appSrc),
    "不得再无条件下开块级渲染（会把 html/代码按 Markdown 语义误解析）",
  );
  const openDoc = fnBodyAt(appSrc, "async function openDoc(docPath, options = {}) {");
  assert.match(
    openDoc,
    /if \(state\.immersive\) \{\s*try \{ els\.editor\.setWysiwygEnabled\?\.\(state\.currentIsMarkdown\); \} catch \(_\) \{\}\s*\}/,
    "沉浸模式下切换文档要同步开关块级渲染",
  );
});

test("检索用纯文本按扩展名分派：html 去标签，代码原样", () => {
  assert.match(appRs, /fn strip_html\(content: &str\) -> String/, "必须有 html → 纯文本实现");
  assert.match(appRs, /fn plain_text_for\(relative: &str, content: &str\) -> String/);
  assert.match(appRs, /"html" \| "htm" \| "xhtml" => strip_html\(content\)/);
  assert.match(appRs, /"md" \| "markdown" => strip_markdown\(content\)/);
  assert.match(appRs, /_ => content\.to_string\(\)/, "其余扩展名必须原样保留（代码文件）");

  const calls = [...appRs.matchAll(/plain_text_for\(/g)].length;
  assert.ok(calls >= 5, `plain_text_for 应有 1 处定义 + 4 处调用，实际 ${calls}`);

  assert.ok(
    !/let plain = strip_markdown\(content\);/.test(appRs),
    "build_file_entry 不得再无条件 strip_markdown（会抹掉代码里的 * [ ] #）",
  );
  assert.ok(
    !/entry\.plain = if normalized\.relative\.ends_with\("\.md"\)/.test(appRs),
    "保存路径不得再手写扩展名判断，必须走统一分派",
  );

  // strip_html 必须整块移除脚本与样式，而不是只剥标签
  const stripHtml = fnBody(appRs, "fn strip_html(content: &str) -> String");
  assert.match(stripHtml, /<script\\b/, "要整块删 script");
  assert.match(stripHtml, /<style\\b/, "要整块删 style");
  assert.match(stripHtml, /<!--/, "要删注释");
  assert.match(stripHtml, /character_reference|&#\\d\+;|&nbsp;/, "要处理实体");
});

test("HTML 文档标题取 <title>，不被正文里的 # 行误判", () => {
  assert.match(appRs, /matches!\(ext\.as_str\(\), "html" \| "htm" \| "xhtml"\)/, "标题来源按扩展名分派");
  const titleFn = fnBody(appRs, "fn extract_title(content: &str, fallback: &str) -> String");
  assert.match(titleFn, /<title\[\^>\]\*>/, "要读 <title>");
  assert.match(titleFn, /if trimmed\.starts_with\("# "\)/, "Markdown 仍走一级标题");
});

test("HTML 文档进入云同步；json / csv 仍排除，且整页 HTML 有正文上限", () => {
  // 2026-10-13 用户决策：桌面端本就把 .html 当一等公民（沙箱预览 + 去标签检索），
  // 同步白名单不跟上就会出现「本机能看、云端永远没有」。json 反向排除：工作区里的
  // json 常是含 token / 密钥的配置文件，自动上云等于开一条泄漏通道。
  for (const [name, src] of [
    ["cloud/app.js", cloudApp],
    ["public/modules/cloud-client.js", cloudClient],
  ]) {
    const m = /const TEXT_EXT = (\/[^\n]*?\/i);/.exec(src);
    assert.ok(m, `${name} 应有 TEXT_EXT 白名单`);
    assert.match(m[1], /md/, `${name} 仍须同步 Markdown`);
    assert.match(m[1], /html\?/, `${name} 的同步白名单必须放行 html（${m[1]}）`);
    assert.match(m[1], /xhtml/, `${name} 要连 .xhtml 一起放行（${m[1]}）`);
    assert.doesNotMatch(m[1], /json/, `${name} 不得放行 json：可能是含密钥的配置（${m[1]}）`);
    assert.doesNotMatch(m[1], /csv/, `${name} 不得放行 csv（${m[1]}）`);
    assert.match(src, /const HTML_DOC_EXT = \/\\\.\(html\?\|xhtml\)\$\/i;/,
      `${name} 需要独立的 HTML 文档判定（渲染分派用）`);
  }

  // 正文上限：documents.content 是 text 列，一篇几十 MB 的整页 HTML 会拖死列表与检索
  assert.match(cloudClient, /const HTML_DOC_MAX_BYTES = [\d_]+;/,
    "桌面内核必须有 HTML 正文上限");
  assert.match(cloudClient, /HTML_DOC_EXT\.test\(item\.rel\) && bytes > HTML_DOC_MAX_BYTES/,
    "超限的 HTML 必须在上传前拦掉，而不是传上去再说");
  assert.match(cloudClient, /HTML_DOC_MAX_BYTES \/ 1024/, "摘要里要报出上限值，便于用户判断");
});

test("云端两处 HTML 文档渲染：沙箱令牌与桌面端一致，且都用字符串级资源改写", () => {
  // 沙箱帧是 opaque origin → 父页摸不到帧内 DOM。markdown 正文那套「渲染后替换
  // img.src」对 HTML 文档**做不到**，只能塞进 srcdoc 之前做字符串级改写。
  const sandboxOf = (src) => {
    const m = /(?:const|var) HTML_DOC_SANDBOX = "([^"]+)";/.exec(src);
    assert.ok(m, "应有 HTML_DOC_SANDBOX 常量");
    return m[1];
  };
  const desk = sandboxOf(appSrc);
  assert.doesNotMatch(desk, /allow-same-origin/, "桌面端沙箱绝不含 allow-same-origin");
  for (const [name, src] of [["cloud/app.js", cloudApp], ["cloud/share.js", shareSrc]]) {
    assert.equal(sandboxOf(src), desk, `${name} 的沙箱令牌必须与桌面端逐字一致`);
    assert.match(src, /(?:const|var) HTML_FRAME_RESIZE_SCRIPT = '<script>/, `${name} 要注入高度上报脚本`);
    assert.match(src, /HTML_FRAME_RESIZE_SCRIPT \+ content/, `${name} 的 srcdoc 必须前置上报脚本`);
    assert.match(src, /function rewriteHtmlAssetSrc\(html, lookup\)/, `${name} 必须做字符串级资源改写`);
    assert.ok(src.includes("(?:img|video|source)"), `${name} 改写的标签集合要与 extractAssetRefs 一致`);
    assert.match(src, /iframe\.html-doc-frame/, `${name} 的高度监听要认 .html-doc-frame`);
  }
  // 样式：两处都要有 .html-doc-* 规则，否则 iframe 落到浏览器默认 300×150
  for (const [name, css] of [["cloud/styles.css", read("cloud/styles.css")], ["cloud/share.css", shareCss]]) {
    for (const cls of ["html-doc-block", "html-doc-bar", "html-doc-frame"]) {
      assert.match(css, new RegExp(`\\.${cls} \\{`), `${name} 缺 .${cls} 样式`);
    }
  }
});

/** 把某个文件里的「正则常量 + rewriteHtmlAssetSrc」抽出来单独求值（两个文件都是 IIFE，不能直接 import）。 */
function loadRewriter(src) {
  const i = src.indexOf("HTML_ASSET_SRC_RE = ");
  const j = src.indexOf("function rewriteHtmlAssetSrc");
  assert.ok(i >= 0 && j > i, "找不到 HTML_ASSET_SRC_RE / rewriteHtmlAssetSrc");
  const constLine = src.slice(i, src.indexOf("\n", i));
  // 花括号计数取函数全文：函数体里没有带花括号的字符串或正则，朴素计数即可
  let depth = 0, k = src.indexOf("{", j);
  for (let p = k; p < src.length; p += 1) {
    if (src[p] === "{") depth += 1;
    else if (src[p] === "}") { depth -= 1; if (depth === 0) { k = p; break; } }
  }
  const fnText = src.slice(j, k + 1);
  return new Function(`${constLine}\n${fnText}\nreturn rewriteHtmlAssetSrc;`)();
}

test("资源改写函数：两端行为一致，且不碰外链 / 不改写未命中的引用", () => {
  const work = loadRewriter(cloudApp);
  const share = loadRewriter(shareSrc);
  const resolve = (ref) => (ref === "source/shot.webp" ? "https://cdn.example.test/sig/x.webp" : "");

  const cases = [
    ['<img src="source/shot.webp">', '<img src="https://cdn.example.test/sig/x.webp">'],
    ["<img src='source/shot.webp'>", "<img src='https://cdn.example.test/sig/x.webp'>"],
    ['<video src="source/shot.webp" controls>', '<video src="https://cdn.example.test/sig/x.webp" controls>'],
    // 外链 / 未命中（本机没有这张图）必须原样保留：看不出改了，也不至于把内容改坏
    ['<img src="https://other.test/a.png">', '<img src="https://other.test/a.png">'],
    ['<img src="source/404.webp">', '<img src="source/404.webp">'],
    // 单双引号必须原样回填，否则 HTML 结构会被破坏
    ['<img alt="a" src="source/shot.webp" class="b">',
      '<img alt="a" src="https://cdn.example.test/sig/x.webp" class="b">'],
  ];
  for (const [input, want] of cases) {
    assert.equal(work(input, resolve), want, `工作台改写错误：${input}`);
    assert.equal(share(input, resolve), want, `分享页改写错误：${input}`);
  }
  // 两端逐例结果完全一致（同一篇笔记在两处渲染出同一个页面）
  for (const [input] of cases) {
    assert.equal(work(input, resolve), share(input, resolve), `两端改写结果分叉：${input}`);
  }
});

test("样式表提供 html-doc 预览块（含阅读态更高的视口）", () => {
  assert.match(cssSrc, /\.html-doc-block \{/, "缺 .html-doc-block 样式");
  assert.match(cssSrc, /\.html-doc-bar \{/, "缺说明栏样式");
  assert.match(cssSrc, /\.html-doc-frame \{/, "缺 iframe 样式");
  assert.match(cssSrc, /#markdownView > \.html-doc-block > \.html-doc-frame/, "阅读态要高一些");
});

test("全屏浮层样式不得带 .markdown-body 前缀（浮层挂在 body 下，带前缀永不匹配）", () => {
  // v2.1.41 真机回归：「放大」点了没反应 —— overlay 建了但选择器匹配不上，零尺寸不可见。
  for (const cls of [
    "html-inline-fullscreen-overlay",
    "html-inline-fullscreen-close",
  ]) {
    assert.doesNotMatch(
      cssSrc,
      new RegExp(`\\.markdown-body [^\\n{]*\\.${cls}`),
      `.${cls} 不能依赖 .markdown-body 祖先`,
    );
    assert.match(cssSrc, new RegExp(`\\.${cls} \\{`), `.${cls} 必须有顶层规则`);
  }
});

test("沙箱 iframe 高度自适应：帧内上报 + 父页监听（三端同一消息）", () => {
  // 帧内注入：worker 围栏（chart / html-inline）与 app.js 主线程围栏、html 文档预览
  for (const [name, src] of [
    ["public/markdown-worker.js", workerSrc],
    ["cloud/markdown-worker.js", cloudWorkerSrc],
    ["public/app.js", appSrc],
  ]) {
    assert.match(src, /mt-html-frame-height/, `${name} 应含高度上报消息类型`);
    assert.match(
      src,
      /HTML_FRAME_RESIZE_SCRIPT \+ (chartHtml|raw|content)/,
      `${name} 的 srcdoc 必须前置高度上报脚本`,
    );
  }
  // 父页监听：必须校验 event.source，防止外来消息乱调高度
  for (const [name, src] of [
    ["public/app.js", appSrc],
    ["cloud/app.js", cloudApp],
  ]) {
    assert.match(src, /installHtmlFrameAutoHeight/, `${name} 应安装高度监听`);
    const body = fnBody(src, "function installHtmlFrameAutoHeight");
    assert.match(body, /contentWindow !== event\.source/, `${name} 必须校验消息来源帧`);
    assert.match(body, /Math\.min\(Math\.max/, `${name} 高度必须 clamp`);
  }
});
