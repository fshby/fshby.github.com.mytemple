/**
 * 分享页：把一条分享快照渲染成移动端可读的页面。
 *
 * 数据通路刻意走**匿名 REST**（只带 publishableKey），不经 SDK、不要求登录：
 * 微信里的访客没有任何账号，这条链必须能在「未登录」身份下跑通。
 * 公开读由数据库侧的 RLS 策略保证（见 shared_docs / shared_assets 的策略注释）。
 *
 * 正文渲染复用工作台同一份 `markdown-worker.js`（同源自托管）—— 这样
 * 「在 App 里看」和「在微信里看」出自同一条渲染管线，不会两套观感各走各的。
 *
 * 图片：云存储对匿名访客不可读（官方明确不暴露公共地址），所以图片字节是
 * 随分享一起落在 `shared_assets` 里的 base64，这里按需（滚动到可见时才）拉取。
 */
// 引用解析 / 候选键来自单一实现源（shared/share-core.js → 本目录同名产物），
// 与桌面端、工作台三处共用同一份规则，不再各写一份靠人工对齐。
import { assetCandidates, HTML_DOC_EXT } from "./share-core.js?v=cloud-25";

(function () {
  "use strict";

  var CFG = window.__MT_CLOUD__ || {};
  var ASSET_V = "cloud-25";
  var ENDPOINT = String(CFG.endpoint || "").replace(/\/+$/, "");
  var REST = ENDPOINT + "/.cloud/database/rest/v1";
  var HDR = { apikey: CFG.publishableKey || "", "X-Wb-Webapp-Access-Key": CFG.publishableKey || "" };
  var VENDOR = "/vendor";
  var ASSET_NODE_MAX = 60;

  var el = {
    loading: document.getElementById("stateLoading"),
    gone: document.getElementById("stateGone"),
    goneTitle: document.getElementById("goneTitle"),
    goneDesc: document.getElementById("goneDesc"),
    stage: document.getElementById("stage"),
    title: document.getElementById("docTitle"),
    meta: document.getElementById("docMeta"),
    body: document.getElementById("docBody"),
    tocFab: document.getElementById("tocFab"),
    tocMask: document.getElementById("tocMask"),
    tocDrawer: document.getElementById("tocDrawer"),
    tocClose: document.getElementById("tocClose"),
    tocList: document.getElementById("tocList"),
  };

  function fail(title, desc) {
    el.loading.hidden = true;
    el.stage.hidden = true;
    el.gone.hidden = false;
    if (title) el.goneTitle.textContent = title;
    if (desc) el.goneDesc.textContent = desc;
  }

  function shareId() {
    var m = String(location.search || "").match(/[?&]d=([A-Za-z0-9_-]{6,64})/);
    return m ? m[1] : "";
  }

  /* 数据一律走 SECURITY DEFINER 的 RPC，不给匿名角色任何表级 SELECT：
   * 表级读策略只能约束「哪些行可见」，约束不了「能一次读多少 / 能不能不带条件全表 dump」。
   * 分享的保密模型建立在「链接 id 猜不到」上，所以只暴露「按精确 id 取单条」的入口。 */
  function rpc(name, body) {
    return fetch(REST + "/rpc/" + name, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, HDR),
      body: JSON.stringify(body || {}),
      cache: "no-store",
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error("HTTP " + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ── 独立 HTML 文档（.html/.htm/.xhtml）─────────────────────
   * 同步上来的网页文档不走 markdown 渲染，而是按原样装进沙箱 iframe。三条与工作台
   * 逐字同源的约束（改动任何一条都要同步改 cloud/app.js）：
   *   1) 沙箱令牌只保留脚本/表单/模态框，**绝不含 allow-same-origin**；
   *   2) srcdoc 前置高度上报脚本，否则长网页挤在固定小窗里嵌套滚动；
   *   3) 资源引用只能**字符串级**改写 —— 沙箱帧是 opaque origin，父页摸不到帧内 DOM。
   * 分享页的图片是随快照一起落在 shared_assets 里的 base64（云存储对匿名访客不可读），
   * 所以这里先把该分享的全部资源行取回来建 rel_path → data URL 映射，再改写。 */
  var HTML_DOC_SANDBOX = "allow-scripts allow-forms allow-modals";
  /* 「云端安全形态」标记（与 cloud/app.js 的 HTML_CLOUD_STRIP_MARK 同串）：推送时
   * 平台内容策略会拦下含 <script> / onclick= 的正文，工作台因此剥离后再写云端。
   * 分享页据此在说明栏提示访客「云端版不含脚本」。 */
  var HTML_CLOUD_STRIP_MARK = "<!-- mt-cloud-no-script -->";
  var HTML_FRAME_RESIZE_SCRIPT = '<script>(function(){function p(){var d=document.documentElement,b=document.body;var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);try{parent.postMessage({type:"mt-html-frame-height",h:Math.ceil(h)},"*")}catch(_){}}function s(){p();if(window.ResizeObserver){try{new ResizeObserver(p).observe(document.documentElement)}catch(_){}}else{setInterval(p,500)}}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",s)}else{s()}})();</script>';
  var HTML_ASSET_SRC_RE = /(<\s*(?:img|video|source)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;
  /* 帧高上限（与工作台 cloud/app.js 的 HTML_FRAME_MAX_HEIGHT 同值同义）。
   * 原先写死 20000px：长网页被截断，访客在外层滚一遍、帧内再滚一遍。 */
  var HTML_FRAME_MAX_HEIGHT = 200000;

  /** 引用 → 绝对地址；返回空串表示放弃改写（保持原样）。与工作台 rewriteHtmlAssetSrc 同源。 */
  function rewriteHtmlAssetSrc(html, lookup) {
    return String(html || "").replace(HTML_ASSET_SRC_RE, function (all, pre, q, val) {
      var url = "";
      try { url = lookup(val) || ""; } catch (_) { url = ""; }
      return url ? pre + q + url + q : all;
    });
  }

  /** 把这篇分享带走的全部图片读成 rel_path → data URL（一次请求，最多 60 张）。 */
  async function loadShareAssetMap(id) {
    var map = {};
    try {
      var rows = await rpc("get_shared_assets", { p_share_id: id, p_limit: ASSET_NODE_MAX });
      (rows || []).forEach(function (r) {
        if (r && r.rel_path && r.bytes_b64) {
          map[r.rel_path] = "data:" + (r.mime || "image/webp") + ";base64," + r.bytes_b64;
        }
      });
    } catch (_) { /* 取不到就保持相对引用（必然 404），不阻断阅读 */ }
    return map;
  }

  function renderHtmlDoc(container, source, docRel, assetMap) {
    var block = document.createElement("div");
    block.className = "html-doc-block";
    var bar = document.createElement("div");
    bar.className = "html-doc-bar";
    var label = document.createElement("span");
    label.className = "html-doc-label";
    label.textContent = "网页预览";
    var hint = document.createElement("span");
    hint.className = "html-doc-hint";
    var hasAsset = false;
    for (var k in assetMap) { if (Object.prototype.hasOwnProperty.call(assetMap, k)) { hasAsset = true; break; } }
    /* 正文若带「云端安全形态」标记（推送时按平台内容策略剥离过脚本），要说明白：
     * 否则动态内容不显示会被当成渲染坏了。标记由工作台 stripCloudUnsafeHtml 写入。 */
    var stripped = String(source || "").indexOf(HTML_CLOUD_STRIP_MARK) !== -1;
    hint.textContent = stripped
      ? "此文档含脚本，云端版已按平台安全策略移除"
      : (hasAsset ? "按网页原样加载；随分享带走的图片可正常显示" : "按网页原样加载；相对路径资源不可用");
    bar.appendChild(label);
    bar.appendChild(hint);

    var frame = document.createElement("iframe");
    frame.className = "html-doc-frame";
    frame.setAttribute("sandbox", HTML_DOC_SANDBOX);
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", "HTML 文档预览");
    var content = rewriteHtmlAssetSrc(source, function (ref) {
      var cands = assetCandidates(ref, docRel);
      for (var i = 0; i < cands.length; i++) {
        if (assetMap[cands[i]]) return assetMap[cands[i]];
      }
      return "";
    });
    frame.srcdoc = HTML_FRAME_RESIZE_SCRIPT + content;
    block.appendChild(bar);
    block.appendChild(frame);
    container.replaceChildren(block);
    decorateHtmlBlocks(container);
  }

  /* ── 内嵌网页卡片：全屏视图 ─────────────────────────────
   * 访客在微信里读到一篇 .html 笔记时，iframe 只有正文区那么宽（实测 356/390 ＝ 91.3%），
   * 且卡片外面还有说明栏与边框。全屏视图把这些外壳全部让出去，iframe 直接铺满视口。
   * 与工作台 cloud/app.js 的 openHtmlFrameFullscreen / decorateHtmlBlocks 同源：
   *   1) 全屏帧沿用同一 sandbox（借「放大」绕过限制是不允许的）；
   *   2) 全屏帧**不挂** html-inline-frame / html-doc-frame 类名 —— 那两类是高度上报的
   *      命中目标，带上就会被撑到内容高度，全屏就白开了；
   *   3) 按钮**常显**：这里主要服务手机与微信，触屏没有 hover。 */
  function openHtmlFrameFullscreen(iframe) {
    if (!iframe) return;
    var overlay = document.createElement("div");
    overlay.className = "html-frame-fullscreen-overlay";
    var closeBtn = document.createElement("button");
    closeBtn.className = "html-frame-fullscreen-close";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "退出全屏");
    closeBtn.textContent = "×";
    var full = document.createElement("iframe");
    full.srcdoc = iframe.srcdoc || iframe.getAttribute("srcdoc") || "";
    var inherited = iframe.getAttribute("sandbox");
    full.setAttribute("sandbox", inherited === null ? HTML_DOC_SANDBOX : inherited);
    full.setAttribute("referrerpolicy", "no-referrer");
    full.setAttribute("title", "HTML 全屏预览");
    overlay.appendChild(full);
    overlay.appendChild(closeBtn);

    var prevOverflow = document.body.style.overflow;
    function cleanup() {
      overlay.remove();
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    }
    function onKey(ev) { if (ev.key === "Escape") cleanup(); }
    closeBtn.addEventListener("click", cleanup);
    overlay.addEventListener("click", function (ev) { if (ev.target === overlay) cleanup(); });
    document.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
  }

  function decorateHtmlBlocks(container) {
    if (!container || typeof container.querySelectorAll !== "function") return;
    var blocks = container.querySelectorAll(".html-doc-block, .html-inline-block");
    Array.prototype.forEach.call(blocks, function (block) {
      if (block.querySelector(".html-frame-fullscreen-btn")) return;
      var iframe = block.querySelector("iframe.html-doc-frame, iframe.html-inline-frame");
      if (!iframe) return;
      var btn = document.createElement("button");
      btn.className = "html-frame-fullscreen-btn";
      btn.type = "button";
      btn.textContent = "放大";
      btn.title = "全屏查看这个网页";
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        openHtmlFrameFullscreen(iframe);
      });
      var bar = block.querySelector(":scope > .html-doc-bar");
      if (bar) bar.appendChild(btn);
      else block.appendChild(btn);
    });
  }

  /* ── Markdown：与工作台同一份 worker ───────────────────── */
  var worker = null;
  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker("/markdown-worker.js?v=" + ASSET_V + "&assets=" + VENDOR + "/");
    return worker;
  }

  function renderMarkdown(source) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = ensureWorker(); } catch (e) { reject(e); return; }
      var seq = Math.random().toString(36).slice(2);
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        w.removeEventListener("message", onMsg);
        reject(new Error("渲染超时"));
      }, 15000);
      function onMsg(e) {
        var d = e.data || {};
        if (d.seq !== seq || settled) return;
        settled = true;
        clearTimeout(timer);
        w.removeEventListener("message", onMsg);
        if (d.useBlob && d.htmlBlob) {
          d.htmlBlob.text().then(function (t) { resolve({ html: t, outline: d.outline || [] }); }, reject);
        } else {
          resolve({ html: d.html || "", outline: d.outline || [] });
        }
      }
      w.addEventListener("message", onMsg);
      // includeOutline：worker 顺带产出标题大纲，分享页用它渲染目录索引。
      w.postMessage({ seq: seq, source: source, searchTerm: "", includeHtml: true, includeOutline: true });
    });
  }

  /* ── 目录索引：标题大纲 → 浮动按钮 + 抽屉 ─────────────────
   * 工作台阅读区有左侧目录，分享页此前把 worker 产出的 outline 丢掉了。
   * 这里补齐：有标题才显示浮动按钮；点条目滚动到标题（heading id 由
   * worker 生成并写在渲染结果里，同源同构）；滚动时高亮当前所在小节。 */
  var tocState = { open: false, headings: [], ticking: false };

  function tocOpen() {
    tocState.open = true;
    el.tocDrawer.hidden = false;
    el.tocMask.hidden = false;
    // 下一帧再加类名，保证过渡动画生效
    requestAnimationFrame(function () {
      el.tocDrawer.classList.add("is-open");
      el.tocMask.classList.add("is-open");
    });
  }

  function tocClose() {
    tocState.open = false;
    el.tocDrawer.classList.remove("is-open");
    el.tocMask.classList.remove("is-open");
    var drawer = el.tocDrawer, mask = el.tocMask;
    setTimeout(function () {
      if (!tocState.open) { drawer.hidden = true; mask.hidden = true; }
    }, 220);
  }

  function tocScrollTo(id) {
    var target = document.getElementById(id);
    if (!target) return;
    tocClose();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderToc(outline) {
    var items = Array.isArray(outline) ? outline : [];
    if (!items.length) { el.tocFab.hidden = true; el.tocList.innerHTML = ""; return; }
    tocState.headings = items;
    var rows = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var level = Math.min(Math.max(Number(item.level) || 1, 1), 4);
      rows.push(
        '<button type="button" class="toc-item lv-' + level + '" data-toc-target="' + escapeHtml(item.id) + '" title="' + escapeHtml(item.title) + '">' +
        escapeHtml(item.title) + "</button>"
      );
    }
    el.tocList.innerHTML = rows.join("");
    el.tocFab.hidden = false;
  }

  function tocHighlight() {
    // 找到视口顶部之上最近的标题 = 当前小节
    var currentId = "";
    var fromTop = 90; // 略过顶部品牌条
    for (var i = 0; i < tocState.headings.length; i += 1) {
      var node = document.getElementById(tocState.headings[i].id);
      if (!node) continue;
      if (node.getBoundingClientRect().top <= fromTop) currentId = tocState.headings[i].id;
      else break;
    }
    var active = el.tocList.querySelector(".toc-item.is-active");
    if (active) active.classList.remove("is-active");
    if (currentId) {
      var next = el.tocList.querySelector('[data-toc-target="' + CSS.escape(currentId) + '"]');
      if (next) next.classList.add("is-active");
    }
  }

  window.addEventListener("scroll", function () {
    if (!tocState.headings.length || tocState.ticking) return;
    tocState.ticking = true;
    requestAnimationFrame(function () { tocHighlight(); tocState.ticking = false; });
  }, { passive: true });

  el.tocFab.addEventListener("click", tocOpen);
  el.tocClose.addEventListener("click", tocClose);
  el.tocMask.addEventListener("click", tocClose);
  el.tocList.addEventListener("click", function (event) {
    var btn = event.target.closest(".toc-item");
    if (btn) tocScrollTo(btn.getAttribute("data-toc-target"));
  });

  /* ── 内嵌网页卡片：帧内上报内容高度，这里把 iframe 撑到内容高度 ─────
   * worker 渲染的 ```html / chart 围栏 iframe 会在 srcdoc 最前置一段上报脚本。
   * 工作台侧（cloud/app.js 的 installHtmlFrameAutoHeight）一直有这段监听，
   * 分享页此前没有 —— iframe 保持浏览器默认 300×150，长网页只能在小窗里
   * 嵌套滚动（实机截图「显示不全」）。必须校验 event.source === frame.contentWindow，
   * 只认自家帧；高度 clamp 防异常值。 */
  (function installHtmlFrameAutoHeight() {
    window.addEventListener("message", function (event) {
      var d = event.data;
      if (!d || d.type !== "mt-html-frame-height") return;
      var h = Number(d.h);
      if (!isFinite(h) || h <= 0) return;
      var frames = document.querySelectorAll("iframe.html-inline-frame, iframe.html-doc-frame");
      Array.prototype.forEach.call(frames, function (frame) {
        if (!frame.isConnected || frame.contentWindow !== event.source) return;
        var clamped = Math.min(Math.max(Math.ceil(h) + 12, 240), HTML_FRAME_MAX_HEIGHT);
        frame.style.height = clamped + "px";
      });
    });
  })();

  /* ── 数学 / 图表：与工作台同一套自托管库 ───────────────── */
  function loadScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(true); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }

  function isDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  var katexReady = null;
  function loadKatex() {
    if (katexReady) return katexReady;
    katexReady = new Promise(function (resolve) {
      if (window.katex) return resolve(window.katex);
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = VENDOR + "/katex/katex.min.css?v=" + ASSET_V;
      document.head.appendChild(link);
      loadScript(VENDOR + "/katex/katex.min.js?v=" + ASSET_V).then(function () {
        resolve(window.katex || null);
      });
    });
    return katexReady;
  }

  var mermaidReady = null;
  function loadMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = new Promise(function (resolve) {
      if (window.mermaid) return resolve(window.mermaid);
      loadScript(VENDOR + "/mermaid/mermaid.min.js?v=" + ASSET_V).then(function () {
        resolve(window.mermaid || null);
      });
    });
    return mermaidReady;
  }

  async function decorate(root) {
    var mathNodes = root.querySelectorAll(".math-block[data-math], .math-inline[data-math]");
    if (mathNodes.length) {
      var katex = await loadKatex();
      if (katex) {
        mathNodes.forEach(function (node) {
          var src = node.getAttribute("data-math") || "";
          try {
            katex.render(src, node, {
              throwOnError: false,
              displayMode: node.classList.contains("math-block"),
              errorColor: "#ef4444",
            });
          } catch (_) { node.textContent = src; }
        });
      }
    }

    var blocks = root.querySelectorAll(".chart-block.mermaid-block .mermaid-container");
    if (blocks.length) {
      var mermaid = await loadMermaid();
      if (mermaid) {
        try {
          mermaid.initialize({ startOnLoad: false, theme: isDark() ? "dark" : "default", securityLevel: "loose" });
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
        } catch (_) { /* 初始化失败时下面的 render 会各自报错 */ }
        var uid = 0;
        for (var i = 0; i < blocks.length; i++) {
          var box = blocks[i];
          var srcEl = box.parentElement && box.parentElement.querySelector(".mermaid-source");
          if (!srcEl) continue;
          try {
            var out = await mermaid.render("mts-" + Date.now() + "-" + (++uid), srcEl.textContent || "");
            box.innerHTML = out.svg;
            var svgEl = box.querySelector("svg");
            if (svgEl) {
              var vb = (svgEl.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
              svgEl.removeAttribute("width");
              svgEl.removeAttribute("height");
              svgEl.style.width = "100%";
              svgEl.style.height = "auto";
              svgEl.style.display = "block";
              if (vb.length === 4 && vb[2] > 0) svgEl.style.maxWidth = Math.round(vb[2]) + "px";
              svgEl.style.margin = "0 auto";
            }
            srcEl.hidden = true;
          } catch (err) {
            box.innerHTML = '<div class="asset-missing">图表渲染失败</div>';
          }
        }
      }
    }

    // 内嵌网页（```html / chart 围栏）也挂「放大」
    decorateHtmlBlocks(root);

    // 代码块「复制」：markdown-worker 生成的按钮只有壳，这里补上行为。
    // 与工作台 cloud/app.js 同语义；分享页没有 toast，反馈直接写在按钮上。
    // 微信内置浏览器等非安全上下文没有 navigator.clipboard，退回 execCommand。
    Array.prototype.slice.call(root.querySelectorAll(".code-copy")).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var pre = btn.parentElement && btn.parentElement.querySelector("pre");
        if (!pre) return;
        var text = pre.innerText || pre.textContent || "";
        var original = btn.textContent;
        var done = function (ok) {
          btn.textContent = ok ? "已复制" : "复制失败";
          setTimeout(function () { btn.textContent = original; }, 1200);
        };
        var fallbackCopy = function () {
          try {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.setAttribute("readonly", "");
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand("copy");
            document.body.removeChild(ta);
            done(ok);
          } catch (_) { done(false); }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, fallbackCopy);
        } else {
          fallbackCopy();
        }
      });
    });
  }

  /* ── 图片：滚动到可见才逐张拉取 ─────────────────────────── */
  function markMissing(node) {
    node.classList.remove("asset-pending");
    var box = document.createElement("div");
    box.className = "asset-missing";
    box.textContent = "这张图片没有随分享一起带走";
    if (node.parentNode) node.parentNode.replaceChild(box, node);
  }

  async function loadAsset(id, node, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var rows;
      try {
        rows = await rpc("get_shared_asset", { p_share_id: id, p_rel_path: candidates[i] });
      } catch (_) { continue; }
      var row = rows && rows[0];
      if (!row || !row.bytes_b64) continue;
      node.classList.remove("asset-pending");
      node.setAttribute("src", "data:" + (row.mime || "image/webp") + ";base64," + row.bytes_b64);
      return;
    }
    markMissing(node);
  }

  function wireAssets(root, id, docRel) {
    var nodes = Array.prototype.slice.call(root.querySelectorAll("img[src], video[src]"))
      .slice(0, ASSET_NODE_MAX);
    var plan = [];
    nodes.forEach(function (node) {
      var cands = assetCandidates(node.getAttribute("src"), docRel);
      if (!cands.length) return;
      // 相对引用在分享页必然 404（没有本机文件也没有签名通道），先摘掉避免无谓请求
      node.removeAttribute("src");
      node.classList.add("asset-pending");
      plan.push({ node: node, cands: cands });
    });
    if (!plan.length) return;

    if (typeof IntersectionObserver !== "function") {
      plan.forEach(function (p) { loadAsset(id, p.node, p.cands); });
      return;
    }
    var start = function (p) {
      if (p.started) return;
      p.started = true;
      io.unobserve(p.node);
      loadAsset(id, p.node, p.cands);
    };
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var hit = plan.filter(function (p) { return p.node === en.target; })[0];
        if (hit) start(hit);
      });
    }, { rootMargin: "400px 0px" });
    plan.forEach(function (p) { io.observe(p.node); });
  }

  /* ── 主流程 ─────────────────────────────────────────────── */
  function fmtDate(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月 " + d.getDate() + " 日";
  }

  async function main() {
    var id = shareId();
    if (!id) {
      fail("链接不完整", "这个地址里没有有效的分享编号，可能是复制时被截断了。");
      return;
    }
    if (!ENDPOINT || !CFG.publishableKey) {
      fail("云端配置缺失", "页面没有取到云端地址，请稍后重试。");
      return;
    }

    var rows;
    try {
      rows = await rpc("get_shared_doc", { p_id: id });
    } catch (err) {
      fail("暂时打不开", "网络似乎不太顺畅，稍后再试一次吧。");
      return;
    }
    var row = rows && rows[0];
    if (!row) {
      // RPC 已按「未撤销 + 未过期」过滤，拿不到行 = 已删除 / 已过期 / 编号错误
      fail("这个分享链接已失效", "链接可能已到期自动失效，或被分享者删除。可以请对方重新分享一次。");
      return;
    }
    // 兜底：策略之外的二次校验（防止缓存/旧数据绕过 RLS）
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      fail("这个分享链接已失效", "链接已到期自动失效。可以请分享者重新分享一次。");
      return;
    }

    var title = row.title || (row.rel_path || "").split("/").pop() || "分享的笔记";
    document.title = title + " · MyTemple 知识库";
    el.title.textContent = title;

    /* 元数据只留「读这篇需要知道的」：分享时间与到期时间。
     * 分享者名字、工作区名、完整相对路径都属多余暴露（访客只需要读正文）。 */
    var bits = [];
    var when = fmtDate(row.created_at);
    if (when) bits.push(when + " 分享");
    // 让访客知道链接何时自动失效（永久链接不显示）
    if (row.expires_at) {
      var expDate = new Date(row.expires_at);
      if (!isNaN(expDate.getTime())) {
        bits.push(expDate.getFullYear() + "-" + (expDate.getMonth() + 1) + "-" + expDate.getDate() + " 到期");
      }
    }
    el.meta.textContent = bits.join(" · ");

    el.loading.hidden = true;
    el.stage.hidden = false;

    if (HTML_DOC_EXT.test(row.rel_path || "")) {
      // 独立 HTML 文档：按网页原样装进沙箱 iframe。图片是随快照带走的 base64，
      // 所以先把整份资源表取回来再改写（沙箱帧内父页摸不到 DOM，只能字符串级改）。
      var assetMap = await loadShareAssetMap(id);
      el.body.innerHTML = "";
      renderHtmlDoc(el.body, row.content || "", row.rel_path || "", assetMap);
      return;
    }

    var html, outline = [];
    try {
      var rendered = await renderMarkdown(row.content || "");
      html = rendered.html;
      outline = rendered.outline || [];
    } catch (_) {
      html = '<pre class="fallback-pre">' + escapeHtml(row.content || "") + "</pre>";
    }
    el.body.innerHTML = html;

    renderToc(outline);
    await decorate(el.body);
    wireAssets(el.body, id, row.rel_path || "");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
