// 回归测试：Mermaid 图表放大预览的完整性与清晰度
// 背景：
//   1. 页面内渲染时会移除 SVG 的 width/height 属性（交给 CSS 自适应），
//      若直接序列化该 SVG 用于弹窗预览，会得到无固有尺寸的 SVG，
//      独立作为 <img> 加载时按浏览器默认 300×150 渲染 → 图表被裁切（显示不完整）。
//   2. 预览缩放若用 transform: scale()，SVG 只按初始布局尺寸光栅化一次再拉伸纹理 → 放大模糊。
// 修复约定：
//   - 点击序列化时克隆 SVG，从 viewBox 恢复 width/height，并移除页面内联 style；
//   - applyImagePreviewTransform 对 SVG data URL 且 scale>1 时改写布局 width（浏览器重新光栅化）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

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

test("mermaid 点击预览：克隆 SVG 并按「紧扣内容」的 viewBox 恢复固有尺寸", () => {
  const body = fnBody(appSrc, 'svgEl.addEventListener("click", (e) => {');
  // 必须克隆而不是直接序列化页面内 SVG
  assert.match(body, /cloneNode\(true\)/, "应克隆 SVG 节点");
  // 必须经由 tightViewBoxForSerialize 取得固有尺寸：
  // 运行时 viewBox 可能被异常 getBBox 撑大（图钉在画布角落、放大放不大的根因），
  // 盲信当前 viewBox 会把「大白纸」尺寸带进预览；盲信 data-mt-raw-viewbox 同样可能被污染。
  assert.match(body, /tightViewBoxForSerialize\(svgEl\)/, "应使用紧致 viewBox 计算固有尺寸");
  assert.match(body, /setAttribute\("width"/, "应设置 width 属性");
  assert.match(body, /setAttribute\("height"/, "应设置 height 属性");
  // 必须移除页面内联样式（width:100% 等对独立图片无意义且可能干扰）
  assert.match(body, /removeAttribute\("style"\)/, "应移除内联 style");
  // 快照标记不得流入序列化产物
  assert.match(body, /removeAttribute\("data-mt-raw-viewbox"\)/, "应移除 raw viewBox 标记");
  // 序列化的必须是克隆节点
  assert.match(body, /serializeToString\(clone\)/, "应序列化克隆节点");
  // 不允许再直接序列化原 svgEl
  assert.doesNotMatch(body, /serializeToString\(svgEl\)/, "不得直接序列化页面内 SVG");
});

test("mermaid 点击预览：不得在原 SVG 上残留 width/height 属性修改", () => {
  // 序列化分支内不应调用 svgEl.setAttribute（克隆对象除外），避免影响页面内布局
  const body = fnBody(appSrc, 'svgEl.addEventListener("click", (e) => {');
  assert.doesNotMatch(body, /svgEl\.setAttribute\(/, "不得修改原 SVG 属性");
});

test("图片预览缩放：矢量图放大走布局宽度分支", () => {
  const body = fnBody(appSrc, "function applyImagePreviewTransform()");
  assert.match(body, /data:image\/svg\+xml/, "应识别 SVG data URL");
  assert.match(
    body,
    /scale > 1 && img\.naturalWidth > 0/,
    "放大时应有矢量分支判定（scale>1 且已加载）"
  );
  assert.match(body, /img\.style\.width = /, "矢量放大应改布局宽度以重新光栅化");
  assert.match(body, /img\.style\.maxWidth = "none"/, "放大时应解除 CSS 宽度上限");
  // 缩小/复位仍走 transform（缩小不损失细节）；pan 平移在最前
  assert.match(body, /transform = `\$\{pan\} scale\(\$\{scale\}\) rotate\(\$\{rotation\}deg\)`/);
});

test("图片预览：打开与关闭都重置矢量缩放残留样式", () => {
  const openBody = fnBody(appSrc, "function openImagePreview(");
  const closeBody = fnBody(appSrc, "function closeImagePreview(");
  for (const [name, body] of [["open", openBody], ["close", closeBody]]) {
    assert.match(body, /img\.style\.width = ""/, `${name}ImagePreview 应重置 width`);
    assert.match(body, /img\.style\.maxWidth = ""/, `${name}ImagePreview 应重置 maxWidth`);
    assert.match(body, /img\.style\.height = ""/, `${name}ImagePreview 应重置 height`);
  }
});

test("mermaid CDN：锁定精确版本并带缓存破坏参数", () => {
  // 范围 URL（mermaid@10）永不变化 → WebView2 磁盘缓存会长期持有旧版本，
  // 早期 10.x 有 flowchart 底部裁切 bug，且 10.x 不支持 architecture-beta。
  assert.doesNotMatch(appSrc, /mermaid@10\//, "不得使用 mermaid@10 范围 URL");
  assert.doesNotMatch(appSrc, /mermaid@11\/dist/, "不得使用 mermaid@11 范围 URL（同样有缓存问题）");
  assert.match(appSrc, /mermaid@11\.\d+\.\d+\/dist\/mermaid\.min\.js\?v=/, "应锁定精确版本并带 ?v= 缓存破坏");
});

test("mermaid 渲染后：viewBox 双向夹紧（贴合内容且不被异常 bbox 撑大）", () => {
  const fitBody = fnBody(appSrc, "function fitViewBoxToContent(");
  const fixBody = fnBody(appSrc, "function fixMermaidViewBox(");
  const bboxBody = fnBody(appSrc, "function visibleBBoxOf(");
  assert.match(fixBody, /fitViewBoxToContent\(svgEl\)/, "fix 应委托给内容贴合计算");
  assert.match(bboxBody, /getBBox\(\)/, "内容边界应来自 getBBox");
  assert.match(fitBody, /visibleBBoxOf\(svgEl\)/, "贴合计算应使用可见内容边界");
  assert.match(fitBody, /MERMAID_MAX_GROW/, "应有外扩上限常量（防异常 bbox）");
  assert.match(fixBody, /setAttribute\("viewBox"/, "应写回 viewBox");
  // 关键语义：内容包围盒远超原始 viewBox（getBBox 不可信，如 gantt 隐藏内容）时
  // 必须回退 mermaid 原始 viewBox，而不是照单全收
  assert.match(fitBody, /return `\$\{raw\[0\]\} \$\{raw\[1\]\} \$\{raw\[2\]\} \$\{raw\[3\]\}`/, "超限时应回退原始 viewBox");
  // 渲染时必须先留存 mermaid 原始 viewBox 快照（供夹紧与序列化对照）
  assert.match(appSrc, /function markRawViewBox\(/, "应存在原始 viewBox 快照函数");
  assert.match(appSrc, /markRawViewBox\(_svgForFix\)/, "预览路径应先打快照再修正");
  assert.match(appSrc, /markRawViewBox\(svgEl\)/, "打印路径应先打快照再修正");
  // 两处渲染路径（预览 + 打印）都要接入
  const previewFn = fnBody(appSrc, "async function renderChartsInPreview(");
  const printFn = fnBody(appSrc, "async function materializePrintArtifacts(");
  const previewCall = /fixMermaidViewBox\(/.test(previewFn) || appSrc.includes("fixMermaidViewBox(_svgForFix)");
  const printCall = /fixMermaidViewBox\(svgEl\)/.test(printFn);
  assert.ok(previewCall, "预览路径应调用 fixMermaidViewBox");
  assert.ok(printCall, "打印路径应调用 fixMermaidViewBox");
  // 渲染前等字体就绪（mermaid 对中文标签的自测量随字体时序漂移的根源）
  assert.match(previewFn, /document\.fonts\.ready/, "渲染前应等待字体就绪");
});

test("mermaid 序列化：viewBox 计算为纯函数并优先贴合内容", () => {
  const body = fnBody(appSrc, "function tightViewBoxForSerialize(");
  const bboxBody = fnBody(appSrc, "function visibleBBoxOf(");
  assert.match(body, /fitViewBoxToContent\(svgEl\)/, "优先用内容贴合结果");
  assert.match(bboxBody, /getBBox\(\)/, "兜底可见内容边界仍来自 getBBox");
  assert.match(body, /visibleBBoxOf\(svgEl\)/, "贴合不可用时兜底可见内容边界");
  assert.match(body, /rawViewBoxOf\(svgEl\)/, "最后才回退原始 viewBox");
});

test("预览序列化：SVG 铺白色背景（弹窗黑底不透出）", () => {
  const body = fnBody(appSrc, 'svgEl.addEventListener("click", (e) => {');
  assert.match(body, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "rect"\)/, "应创建背景 rect");
  assert.match(body, /setAttribute\("fill", "#ffffff"\)/, "背景应为白色");
  assert.match(body, /insertBefore\(bgRect/, "背景应插在首个子节点");
});

test("预览弹窗：放大后支持拖拽平移", () => {
  assert.match(appSrc, /pointerdown/, "应有 pointerdown 拖拽起始");
  assert.match(appSrc, /pointermove/, "应有 pointermove 拖拽更新");
  assert.match(appSrc, /imagePreviewState\.tx/, "平移状态 tx 应存在");
  assert.match(appSrc, /translate\(\$\{tx\}px, \$\{ty\}px\)/, "transform 应包含平移");
  // 打开/关闭/重置都要清零平移
  for (const marker of ["function openImagePreview(", "function closeImagePreview("]) {
    const body = fnBody(appSrc, marker);
    assert.match(body, /imagePreviewState\.tx = 0/, `${marker} 应重置平移`);
  }
});

test("架构图模板：使用 mermaid@11 实测通过的合法语法", () => {
  const m = appSrc.match(/"architecture-beta": `([^`]+)`/);
  assert.ok(m, "应存在 architecture-beta 模板");
  const tpl = m[1];
  // 旧模板的错误语法不得回归：flowchart 式 group...end 与 A[X] --> B[Y] 边
  assert.doesNotMatch(tpl, /-->\s*\w+\[/, "不得使用 flowchart 式边语法（architecture lexer 不认）");
  assert.doesNotMatch(
    tpl.replace(/^.*%%.*$/gm, ""), // %% 注释行允许中文说明
    /[\u4e00-\u9fff]/,
    "architecture-beta 不支持中文标签，模板正文不得含中文"
  );
  assert.match(tpl, /service \w+\[\w+\]/, "应使用 service 声明");
  assert.match(tpl, /\w+:[RLTB]\s*-->\s*[RLTB]:\w+/, "应使用 architecture 方向式边语法");
  assert.match(tpl, /%%/, "应保留中文说明注释（lexer 允许 %% 注释）");
  assert.doesNotMatch(tpl, /\[\(/, "圆柱形 [(DB)] 语法 architecture-beta 不支持");
});
