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

test("mermaid 点击预览：克隆 SVG 并从 viewBox 恢复固有尺寸", () => {
  const body = fnBody(appSrc, 'svgEl.addEventListener("click", (e) => {');
  // 必须克隆而不是直接序列化页面内 SVG
  assert.match(body, /cloneNode\(true\)/, "应克隆 SVG 节点");
  // 必须从 viewBox 恢复 width/height
  assert.match(body, /getAttribute\("viewBox"\)/, "应读取 viewBox");
  assert.match(body, /setAttribute\("width"/, "应设置 width 属性");
  assert.match(body, /setAttribute\("height"/, "应设置 height 属性");
  // 必须移除页面内联样式（width:100% 等对独立图片无意义且可能干扰）
  assert.match(body, /removeAttribute\("style"\)/, "应移除内联 style");
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
  // 缩小/复位仍走 transform（缩小不损失细节）
  assert.match(body, /transform = `scale\(\$\{scale\}\) rotate\(\$\{rotation\}deg\)`/);
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
