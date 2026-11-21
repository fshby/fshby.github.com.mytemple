/* 公式渲染性能层：KaTeX 结果缓存 + 视口外等高延后。
 * 双栏输入时预览是整篇 innerHTML 替换，同一公式会被反复排版：缓存命中后直接复用 HTML，
 * 视口外的块级公式先用上次实测高度占位，滚动到附近再由 IntersectionObserver 补回。
 * 行号同步、复制、打印、错误提示的功能语义与旧版一致。
 */
const _katexHtmlCache = new Map();
const _KATEX_CACHE_LIMIT = 400;
const _mathDeferredObservers = new WeakMap();
const _mathPerfStats = { cacheHits: 0, cacheMisses: 0, rendered: 0, deferred: 0, flushed: 0 };
if (typeof window !== "undefined") window.__mathPerfStats = _mathPerfStats;

export function mathCacheKey(math, isBlock) {
  return (isBlock ? "b:" : "i:") + math;
}

export function katexCacheGet(math, isBlock) {
  const key = mathCacheKey(math, isBlock);
  const cached = _katexHtmlCache.get(key);
  if (!cached) { _mathPerfStats.cacheMisses++; return null; }
  _mathPerfStats.cacheHits++;
  // 命中移到末尾，超限时淘汰最久未用的条目，长会话不会无限增长
  _katexHtmlCache.delete(key);
  _katexHtmlCache.set(key, cached);
  return cached;
}

export function katexCachePut(math, isBlock, html, height, error = false) {
  const key = mathCacheKey(math, isBlock);
  _katexHtmlCache.delete(key);
  _katexHtmlCache.set(key, { html, height, error });
  while (_katexHtmlCache.size > _KATEX_CACHE_LIMIT) {
    _katexHtmlCache.delete(_katexHtmlCache.keys().next().value);
  }
}

export function mathNearViewport(el) {
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;
  return rect.bottom >= -400 && rect.top <= vh + 400;
}

export function fillMathElement(el, cached) {
  el.innerHTML = cached.html;
  el.style.minHeight = "";
  el.style.boxSizing = "";
  el.style.color = cached.error ? "#ef4444" : "";
  el.removeAttribute("data-math-deferred");
}

export function deferredMathCache(el) {
  return _katexHtmlCache.get(mathCacheKey(el.getAttribute("data-math") || "", el.classList.contains("math-block")));
}

export function mathDeferredObserver(container) {
  let io = _mathDeferredObservers.get(container);
  if (io) return io;
  io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      io.unobserve(el);
      const cached = deferredMathCache(el);
      if (!cached) continue;
      fillMathElement(el, cached);
      _mathPerfStats.flushed++;
    }
  }, { rootMargin: "400px 0px" });
  _mathDeferredObservers.set(container, io);
  return io;
}

// 复制、打印前把延迟公式补回真实 DOM：剪贴板与纸面内容必须与优化前完全一致。
export function flushDeferredMath(root = document) {
  const nodes = [...root.querySelectorAll('[data-math-deferred="1"]')];
  if (typeof root.matches === "function" && root.matches('[data-math-deferred="1"]')) nodes.unshift(root);
  for (const el of nodes) {
    const cached = deferredMathCache(el);
    if (!cached) continue;
    fillMathElement(el, cached);
    _mathPerfStats.flushed++;
  }
}
document.addEventListener("copy", () => flushDeferredMath(), true);
document.addEventListener("beforeprint", () => flushDeferredMath(), true);

// KaTeX 字体异步加载：字体就绪后实测高度可能与回退字体略有差异，
// 统一刷新一次缓存高度，保证后续视口外等高占位与真实渲染严丝合缝。
function refreshMathCacheHeights() {
  for (const el of document.querySelectorAll(".math-block[data-math], .math-inline[data-math]")) {
    if (el.hasAttribute("data-math-deferred")) continue;
    const h = el.getBoundingClientRect().height;
    if (h <= 0) continue;
    const key = mathCacheKey(el.getAttribute("data-math") || "", el.classList.contains("math-block"));
    const cached = _katexHtmlCache.get(key);
    if (cached && Math.abs(cached.height - h) > 0.5) cached.height = h;
  }
}
if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(refreshMathCacheHeights);
    else setTimeout(refreshMathCacheHeights, 0);
  }).catch(() => {});
}

// 仅真浏览器回归脚本使用：便于对比缓存命中与节点量，不参与产品逻辑
if (typeof window !== "undefined") window.__mathCache = _katexHtmlCache;
