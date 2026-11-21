/* 导出用 KaTeX 样式：官方完整 CSS + 字体 data URI 内联。
 * PDF 打印 iframe（about:blank）与离线 HTML 导出都拿这份，
 * 保证公式排版与在线预览一比一；手写 CSS 子集会让分数/根号彻底错位。
 * 仅在用户导出时按需加载并缓存，不占首屏体积预算。
 */
const CSS_URL = "/vendor/katex/katex.min.css?v=20261121-b2f131c7";
let _cssPromise = null;

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 返回可直接内联到 <style> 的完整 KaTeX CSS（字体已转 data URI，无外部依赖）。 */
export function loadPrintKatexCss() {
  if (_cssPromise) return _cssPromise;
  _cssPromise = (async () => {
    const res = await fetch(CSS_URL);
    if (!res.ok) throw new Error("官方 KaTeX 样式加载失败：" + res.status);
    let css = await res.text();
    const names = [...new Set([...css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map((m) => m[1]))];
    const pairs = await Promise.all(names.map(async (name) => {
      const r = await fetch("/vendor/katex/fonts/" + name);
      if (!r.ok) throw new Error("KaTeX 字体加载失败：" + name);
      return [name, "data:font/woff2;base64," + bytesToBase64(new Uint8Array(await r.arrayBuffer()))];
    }));
    for (const [name, dataUrl] of pairs) {
      css = css.split("url(fonts/" + name + ")").join('url("' + dataUrl + '")');
    }
    return css;
  })();
  // 失败不锁死缓存，下次导出可重试
  return _cssPromise.catch((err) => { _cssPromise = null; throw err; });
}
