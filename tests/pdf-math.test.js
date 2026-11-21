// PDF/HTML 导出公式一比一回归：必须使用官方 KaTeX CSS + 内联字体，而非手写子集。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const modSrc = readFileSync(new URL("../public/modules/print-katex.js", import.meta.url), "utf8");
const cssSrc = readFileSync(new URL("../public/vendor/katex/katex.min.css", import.meta.url), "utf8");

function fnBody(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `找不到 ${marker}`);
  const bodyStart = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c; i++;
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

test("导出模块内联官方 KaTeX CSS 与全部 woff2 字体", () => {
  assert.match(modSrc, /fetch\(CSS_URL\)/, "必须读取官方完整 CSS，而非手写子集");
  assert.match(modSrc, /matchAll\(/, "必须枚举 CSS 引用的每个字体");
  assert.match(modSrc, /data:font\/woff2;base64,/, "字体必须转 data URI 内联，about:blank 才能加载");
  assert.match(modSrc, /css\.split\("url\(fonts\/" \+ name \+ "\)"\)/, "必须逐个替换字体引用");
  const fontRefs = [...cssSrc.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map((m) => m[1]);
  assert.ok(fontRefs.length >= 20, `官方 CSS 应引用全部字体，实际 ${fontRefs.length}`);
});

test("PDF 与 HTML 导出都加载官方样式并替换手写子集", () => {
  const pdf = fnBody(appSrc, "async function buildDocumentPrintHtmlRendered()");
  const html = fnBody(appSrc, "async function buildExportableHtml(");
  assert.match(pdf, /await ensurePrintKatexCss\(\)/, "PDF 导出必须加载官方样式");
  assert.match(html, /await ensurePrintKatexCss\(\)/, "HTML 导出必须加载官方样式");
  const replaces = appSrc.match(/PRINT_STYLES\.replace\(KATEX_PRINT_CSS, currentPrintKatexCss\)/g) || [];
  assert.equal(replaces.length, 2, "PDF 与 HTML 两处导出都必须替换手写子集");
});

test("官方样式加载失败时降级不阻断导出", () => {
  const ensure = fnBody(appSrc, "async function ensurePrintKatexCss()");
  assert.match(ensure, /try \{/, "加载失败必须捕获");
  assert.match(ensure, /catch \(_err\)/, "必须降级");
  assert.match(modSrc, /_cssPromise = null; throw err/, "模块失败后须清空缓存允许重试");
});
