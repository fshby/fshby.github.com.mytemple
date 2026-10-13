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
(function () {
  "use strict";

  var CFG = window.__MT_CLOUD__ || {};
  var ASSET_V = "cloud-12";
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

  function rest(pathAndQuery) {
    return fetch(REST + pathAndQuery, { headers: HDR, cache: "no-store" }).then(function (res) {
      if (!res.ok) {
        var err = new Error("HTTP " + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  function qs(v) { return encodeURIComponent(String(v)); }

  function normPath(p) {
    var out = [];
    String(p || "").replace(/\\/g, "/").split("/").forEach(function (seg) {
      if (!seg || seg === ".") return;
      if (seg === "..") { out.pop(); return; }
      out.push(seg);
    });
    return out.join("/");
  }

  /** 与工作台 app.js 的 assetRelCandidates 同规则：外链一律不当作随分享带走的资源。 */
  function assetCandidates(ref, docRel) {
    var raw = String(ref || "").trim();
    if (!raw || /^(https?:|data:|blob:|mailto:|javascript:)/i.test(raw)) return [];
    var p = raw.split("#")[0].split("?")[0];
    try { p = decodeURIComponent(p); } catch (_) { /* 保留原样 */ }
    p = normPath(p);
    if (!p) return [];
    var out = [];
    var wsAsset = p.match(/^ws-asset\/[^/]+\/(.+)$/);
    if (wsAsset) out.push(normPath("source/" + wsAsset[1]));
    out.push(p);
    var dir = normPath(docRel || "").split("/").slice(0, -1).join("/");
    if (dir) out.push(normPath(dir + "/" + p));
    return out.filter(function (x, i, a) {
      return x && a.indexOf(x) === i && !x.split("/").some(function (s) { return s === ".." || s === "."; });
    });
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
          d.htmlBlob.text().then(resolve, reject);
        } else {
          resolve(d.html || "");
        }
      }
      w.addEventListener("message", onMsg);
      w.postMessage({ seq: seq, source: source, searchTerm: "", includeHtml: true, includeOutline: false });
    });
  }

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
        rows = await rest("/shared_assets?share_id=eq." + qs(id)
          + "&rel_path=eq." + qs(candidates[i]) + "&select=mime,bytes_b64&limit=1");
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
      rows = await rest("/shared_docs?id=eq." + qs(id)
        + "&select=id,owner_name,workspace,rel_path,title,content,created_at&limit=1");
    } catch (err) {
      fail("暂时打不开", "网络似乎不太顺畅，稍后再试一次吧。");
      return;
    }
    var row = rows && rows[0];
    if (!row) {
      fail();
      return;
    }

    var title = row.title || (row.rel_path || "").split("/").pop() || "分享的笔记";
    document.title = title + " · MyTemple 知识库";
    el.title.textContent = title;

    var bits = [];
    var where = [row.workspace, row.rel_path].filter(Boolean).join(" / ");
    if (where) bits.push(where);
    var when = fmtDate(row.created_at);
    if (when) bits.push(when);
    if (row.owner_name) bits.push("由 " + row.owner_name + " 分享");
    el.meta.textContent = bits.join(" · ");

    var html;
    try {
      html = await renderMarkdown(row.content || "");
    } catch (_) {
      html = '<pre class="fallback-pre">' + escapeHtml(row.content || "") + "</pre>";
    }
    el.body.innerHTML = html;
    el.loading.hidden = true;
    el.stage.hidden = false;

    await decorate(el.body);
    wireAssets(el.body, id, row.rel_path || "");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
