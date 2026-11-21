// 公式渲染性能优化回归：缓存复用 + 视口外延后 + 密集文档合成层降级。
// 约束：任何改动都不能改变公式内容、复制/打印结果、行号同步与错误提示。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const modSrc = readFileSync(new URL("../public/modules/math-perf.js", import.meta.url), "utf8");
const cssSrc = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

function fnBody(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `找不到 ${marker}`);
  const bodyStart = src.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(bodyStart + 1, i); }
  }
  throw new Error(`函数体未闭合: ${marker}`);
}

const body = fnBody(appSrc, "async function renderMathInPreview(container)");

test("公式渲染结果按源码与 displayMode 缓存，命中后不再重复 KaTeX 排版", () => {
  assert.match(appSrc, /from "\.\/modules\/math-perf\.js/, "性能层必须独立成模块，主文件体积预算不受冲击");
  assert.match(modSrc, /const _katexHtmlCache = new Map\(\)/, "必须有渲染结果缓存");
  assert.match(modSrc, /function mathCacheKey\(math, isBlock\)/, "缓存键必须区分公式源码与块/行内模式");
  assert.match(body, /const cached = katexCacheGet\(math, isBlock\)/, "渲染入口必须查缓存");
  assert.match(body, /if \(!pending\.length\) return/, "全部命中时不得再进入 KaTeX 加载与渲染");
  assert.match(body, /katex\.render\(math, el, /, "未命中仍须走原渲染路径（新公式正常显示）");
});

test("视口外块级公式等高延后，行内与离屏容器保持即时渲染", () => {
  assert.match(body, /container === els\.preview \|\| container === els\.markdownView/,
    "延迟只允许主阅读/预览容器；导出 stage 与沉浸块必须完整渲染");
  assert.match(body, /isBlock && cached\.height > 0 && io && !mathNearViewport\(el\)/,
    "只有已有实测高度且远离视口的块级公式才延后");
  assert.match(body, /el\.style\.minHeight = cached\.height \+ "px"/, "占位必须等高，保证行号 offsetTop 不变");
  assert.match(body, /el\.style\.boxSizing = "border-box"/, "等高占位不受站点 box-sizing 影响");
  assert.match(modSrc, /document\.fonts\.ready/, "字体异步加载完成后必须刷新实测高度");
});

test("复制/打印/滚动前补齐延后公式，功能与旧版一致", () => {
  assert.match(modSrc, /document\.addEventListener\("copy", \(\) => flushDeferredMath\(\), true\)/,
    "剪贴板内容必须含完整公式");
  assert.match(modSrc, /document\.addEventListener\("beforeprint", \(\) => flushDeferredMath\(\), true\)/,
    "打印/导出必须含完整公式");
  assert.match(body, /flushDeferredMath\(container\);[\s\S]*io\.disconnect\(\)/,
    "同容器重建前必须先补齐旧延迟项，避免永久空白");
  assert.match(modSrc, /new IntersectionObserver\(/, "进入视口前必须自动补回");
  assert.match(modSrc, /rootMargin: "400px 0px"/, "提前 400px 触发，避免用户看到填空瞬间");
});

test("错误公式的红色提示随缓存复用一并保留", () => {
  assert.match(modSrc, /el\.style\.color = cached\.error \? "#ef4444" : ""/,
    "错误态必须随缓存恢复，不能因复用丢失提示");
  assert.match(body, /katexCachePut\(math, isBlock, el\.innerHTML, 0, true\)/, "渲染异常须标记为错误态");
});

test("五端 KaTeX 只输出视觉 HTML，公式语义由 aria-label 承载", () => {
  const files = ["../public/app.js", "../public/guest.js", "../cloud/app.js", "../cloud/share.js"];
  let calls = 0;
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const m of src.matchAll(/katex\.render\(/g)) {
      calls++;
      const chunk = src.slice(m.index, m.index + 600);
      assert.match(chunk, /output:\s*["']html["']/, `${f} 的 KaTeX 渲染必须关闭隐藏 MathML 副本`);
      assert.match(chunk, /aria-label/, `${f} 必须以 aria-label 保留公式无障碍语义`);
    }
  }
  assert.equal(calls, 5, "桌面导出/预览、访客页、云端主站与分享页共 5 处渲染入口");
});

test("公式密集文档按需关闭预览常驻合成层，普通文档不受影响", () => {
  assert.match(body, /mathElements\.length >= 16\) document\.body\.classList\.add\("math-dense"\)/,
    "仅公式密集时降级，普通文档保持原有毛玻璃");
  assert.match(appSrc, /classList\.remove\("math-dense"\)/, "切换到普通文档必须恢复原样式");
  const rule = cssSrc.match(/body\.math-dense #preview\s*\{([^}]*)\}/);
  assert.ok(rule, "合并后的 styles.css 必须含 math-dense 覆盖规则");
  assert.match(rule[1], /backdrop-filter:\s*none/, "密集文档关闭预览模糊层");
  assert.match(rule[1], /will-change:\s*auto/, "密集文档取消滚动常驻缓存");
});
