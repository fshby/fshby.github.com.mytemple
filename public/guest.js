// guest.js — 局域网访客页
//
// 流程：PIN 配对门（/api/lan/verify）→ token 存 localStorage →
//       工作区标签 + 文档树 + 编辑/预览双视图 →
//       保存走 /api/save（baseHash 乐观锁，冲突时给「保留我的/加载最新」二选一）。
// 预览管线与桌面端 app.js 同源策略：
//       markdown-worker（含 chart/html 沙箱帧）→ KaTeX → Mermaid（串行 + 可见性等待 +
//       自测量塌缩防护）→ hljs 代码高亮 → 图片/视频经 /source/<wsId>/… 资产端点。
// 所有请求带 X-Lan-Token 头；无任何 Tauri / 云端依赖、无任何外链。

import { createMarkdownEditor } from "/editor-core.js?v=20261113-7a7b96d8";

const TOKEN_KEY = "mt-lan-token";
// 第三方库缓存戳：与桌面端同源自托管（public/vendor），戳由 npm run stamp 统一维护
const ASSET_V = "20261112-7da9beff";
// 沙箱帧高度上限：三端（桌面/云端/访客）同值的可放长常量（tests/lan-share.test.js 有锁）
const HTML_FRAME_MAX_HEIGHT = 200000;

const els = {
  gate: document.getElementById("gate"),
  gateForm: document.getElementById("gateForm"),
  pinInput: document.getElementById("pinInput"),
  gateSubmit: document.getElementById("gateSubmit"),
  gateError: document.getElementById("gateError"),
  app: document.getElementById("app"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  sidebar: document.getElementById("sidebar"),
  wsTabs: document.getElementById("wsTabs"),
  tree: document.getElementById("tree"),
  docTitle: document.getElementById("docTitle"),
  editViewBtn: document.getElementById("editViewBtn"),
  previewViewBtn: document.getElementById("previewViewBtn"),
  searchInput: document.getElementById("searchInput"),
  newDocBtn: document.getElementById("newDocBtn"),
  saveBtn: document.getElementById("saveBtn"),
  roBadge: document.getElementById("roBadge"),
  roBanner: document.getElementById("roBanner"),
  editorHost: document.getElementById("editorHost"),
  readerHost: document.getElementById("readerHost"),
  markdownView: document.getElementById("markdownView"),
  conflictBar: document.getElementById("conflictBar"),
  conflictMine: document.getElementById("conflictMine"),
  conflictTheirs: document.getElementById("conflictTheirs"),
  toast: document.getElementById("toast"),
};

const state = {
  readOnly: false,
  workspaces: [],
  currentWs: null,
  currentPath: "",
  baseHash: "",
  editor: null,
  seq: 0,
  view: "edit",       // "edit" | "preview"
  previewSeq: 0,      // 预览渲染竞态守卫
};

// ── API 基础层 ──────────────────────────────────────────────

function token() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

async function api(method, url, payload) {
  const init = { cache: "no-store", headers: { "X-Lan-Token": token() } };
  if (method === "POST") {
    init.method = "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload !== undefined ? payload : {});
  }
  const res = await fetch(url, init);
  let data = null;
  try { data = await res.json(); } catch (_e) { /* 404 HTML 等 */ }
  if (res.status === 401) {
    // token 失效：回配对门
    localStorage.removeItem(TOKEN_KEY);
    showGate();
    throw new Error((data && data.error) || "需要访问口令");
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

// ── 门 / 会话 ───────────────────────────────────────────────

// logo 加载失败静默隐藏（不用内联 onerror：CSP default-src 'self' 拦内联事件）
(function () {
  const logo = document.getElementById("gateLogo");
  if (logo) {
    logo.addEventListener("error", () => { logo.style.display = "none"; });
    if (logo.complete && logo.naturalWidth === 0) logo.style.display = "none";
  }
})();

function showGate() {
  els.app.classList.add("hidden");
  els.gate.classList.remove("hidden");
  els.pinInput.value = "";
  setTimeout(() => els.pinInput.focus(), 50);
}

function showApp() {
  els.gate.classList.add("hidden");
  els.app.classList.remove("hidden");
  initApp();
}

els.gateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pin = els.pinInput.value.trim();
  if (!/^\d{6}$/.test(pin)) {
    els.gateError.textContent = "请输入 6 位数字口令";
    return;
  }
  els.gateSubmit.disabled = true;
  els.gateError.textContent = "";
  try {
    const r = await fetch("/api/lan/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await r.json().catch(() => null);
    if (r.ok && data && data.ok && data.token) {
      localStorage.setItem(TOKEN_KEY, data.token);
      showApp();
    } else {
      els.gateError.textContent = (data && data.error) || "口令校验失败";
    }
  } catch (err) {
    els.gateError.textContent = `网络错误：${err.message}`;
  } finally {
    els.gateSubmit.disabled = false;
  }
});

// ── 视图切换（编辑 / 预览） ─────────────────────────────────

function setView(mode) {
  if (mode !== "edit" && mode !== "preview") return;
  state.view = mode;
  const isPreview = mode === "preview";
  els.editViewBtn.classList.toggle("active", !isPreview);
  els.previewViewBtn.classList.toggle("active", isPreview);
  els.editViewBtn.setAttribute("aria-selected", String(!isPreview));
  els.previewViewBtn.setAttribute("aria-selected", String(isPreview));
  els.editorHost.classList.toggle("hidden", isPreview);
  els.readerHost.classList.toggle("hidden", !isPreview);
  if (isPreview) renderPreview();
}

els.editViewBtn.addEventListener("click", () => setView("edit"));
els.previewViewBtn.addEventListener("click", () => setView("preview"));

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
    // Ctrl+P 与桌面端习惯一致：切到预览
    e.preventDefault();
    setView("preview");
  }
});

// ── 树渲染 ──────────────────────────────────────────────────

function renderWsTabs() {
  els.wsTabs.textContent = "";
  for (const ws of state.workspaces) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ws-tab" + (state.currentWs === ws.id ? " active" : "");
    b.textContent = ws.name || ws.id;
    b.addEventListener("click", () => {
      state.currentWs = ws.id;
      renderWsTabs();
      loadTree();
    });
    els.wsTabs.appendChild(b);
  }
}

function fileIcon(name) {
  const lower = String(name || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(lower)) return "🖼";
  if (/\.(mp4|webm|mov|avi|mkv)$/.test(lower)) return "🎬";
  if (/\.(mp3|wav|ogg|m4a)$/.test(lower)) return "🎵";
  if (/\.(pdf|docx?|pptx?|xlsx?|odt)$/.test(lower)) return "📄";
  if (/\.(js|ts|py|rs|go|java|c|cpp|h|css|html|json|yaml|yml|toml|sh|bat)$/.test(lower)) return "⚙";
  return "📝";
}

function renderTree(nodes, container, depth) {
  container.textContent = "";
  if (!Array.isArray(nodes) || nodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = depth === 0 ? "该工作区还没有文档" : "";
    if (empty.textContent) container.appendChild(empty);
    return;
  }
  for (const node of nodes) {
    const wrap = document.createElement("div");
    wrap.className = "tree-node";
    const row = document.createElement("div");
    row.className = "tree-row";
    row.dataset.path = node.path || "";
    if (node.type === "file") {
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = fileIcon(node.name);
      const label = document.createElement("span");
      label.textContent = node.name;
      row.appendChild(icon);
      row.appendChild(label);
      row.addEventListener("click", () => {
        container.querySelectorAll(".tree-row.active").forEach((r) => r.classList.remove("active"));
        row.classList.add("active");
        openDoc(node.path, node.workspace_id || state.currentWs);
      });
    } else {
      // workspace / folder：可折叠
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = node.type === "workspace" ? "📚" : "📁";
      const label = document.createElement("span");
      label.textContent = node.name;
      const arrow = document.createElement("span");
      arrow.style.cssText = "margin-left:auto;font-size:11px;color:#94a3b8";
      arrow.textContent = "▾";
      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(arrow);
      const children = document.createElement("div");
      children.className = "tree-children";
      let open = node.type === "workspace" || depth < 1;
      children.style.display = open ? "" : "none";
      arrow.textContent = open ? "▾" : "▸";
      row.addEventListener("click", (e) => {
        if (e.target === arrow) { open = !open; children.style.display = open ? "" : "none"; arrow.textContent = open ? "▾" : "▸"; return; }
        if (node.type === "folder" && e.target === label) {
          open = !open; children.style.display = open ? "" : "none"; arrow.textContent = open ? "▾" : "▸";
        }
      });
      renderTree(node.children || [], children, depth + 1);
      wrap.appendChild(row);
      wrap.appendChild(children);
      container.appendChild(wrap);
      continue;
    }
    wrap.appendChild(row);
    container.appendChild(wrap);
  }
}

async function loadTree() {
  try {
    const data = await api("GET", "/api/tree");
    const roots = (data.tree || []).filter((n) => !state.currentWs || n.workspace_id === state.currentWs || n.workspaceId === state.currentWs);
    renderTree(roots, els.tree, 0);
  } catch (err) {
    if (err.message !== "需要访问口令") toast(`加载目录失败：${err.message}`);
  }
}

// ── 文档打开 / 保存 ─────────────────────────────────────────

async function openDoc(docPath, wsId) {
  const seq = ++state.seq;
  try {
    const doc = await api("GET", `/api/doc?path=${encodeURIComponent(docPath)}`);
    if (seq !== state.seq) return; // 已被更新的打开请求覆盖
    if (!doc || typeof doc.content !== "string") {
      toast("打开失败：返回数据不完整");
      return;
    }
    state.currentPath = doc.path || docPath;
    state.baseHash = doc.contentSha256 || "";
    // 打开时定位工作区：优先点击来源，其次按路径推断（搜索结果没有 ws 字段）
    if (wsId) state.currentWs = wsId;
    els.docTitle.textContent = doc.title || state.currentPath;
    ensureEditor();
    state.editor.value = doc.content;
    hideConflict();
    if (state.view === "preview") renderPreview();
  } catch (err) {
    if (err.message !== "需要访问口令") toast(`打开文档失败：${err.message}`);
  }
}

function ensureEditor() {
  if (state.editor) return;
  state.editor = createMarkdownEditor(els.editorHost, "");
}

function hideConflict() {
  els.conflictBar.classList.add("hidden");
}

async function saveDoc({ force = false } = {}) {
  if (!state.editor || !state.currentPath) return;
  if (state.readOnly) {
    toast("当前为只读共享，无法保存");
    return;
  }
  const content = state.editor.value;
  try {
    const r = await api("POST", "/api/save", {
      path: state.currentPath,
      content,
      baseHash: force ? "" : state.baseHash,
    });
    if (r && r.ok) {
      state.baseHash = r.contentSha256 || "";
      hideConflict();
      toast("已保存");
    } else if (r && r.conflict) {
      els.conflictBar.classList.remove("hidden");
      toast("文档已被他人修改");
    } else {
      toast((r && r.error) || "保存失败");
    }
  } catch (err) {
    if (err.message !== "需要访问口令") toast(`保存失败：${err.message}`);
  }
}

els.saveBtn.addEventListener("click", () => saveDoc());
els.conflictMine.addEventListener("click", () => {
  hideConflict();
  saveDoc({ force: true }); // 用空 baseHash 强制覆盖（保留我的版本）
});
els.conflictTheirs.addEventListener("click", () => {
  hideConflict();
  openDoc(state.currentPath); // 重新加载磁盘最新版本
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveDoc();
  }
});

// ── 新建文档 ────────────────────────────────────────────────

els.newDocBtn.addEventListener("click", async () => {
  if (state.readOnly) { toast("当前为只读共享，无法新建"); return; }
  const name = (window.prompt("新文档名称（不含扩展名）") || "").trim();
  if (!name) return;
  const ws = state.workspaces.find((w) => w.id === state.currentWs) || state.workspaces[0];
  if (!ws) { toast("没有可用工作区"); return; }
  try {
    const r = await api("POST", "/api/create-doc", { parent: ws.root, name });
    if (r && r.ok) {
      toast("已创建");
      await loadTree();
      if (r.path) openDoc(r.path, ws.id);
    } else {
      toast((r && r.error) || "创建失败");
    }
  } catch (err) {
    if (err.message !== "需要访问口令") toast(`创建失败：${err.message}`);
  }
});

// ── 搜索 ────────────────────────────────────────────────────

let searchSeq = 0;
els.searchInput.addEventListener("input", () => {
  const q = els.searchInput.value.trim();
  const seq = ++searchSeq;
  if (!q) { loadTree(); return; }
  setTimeout(async () => {
    if (seq !== searchSeq) return;
    try {
      const data = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
      if (seq !== searchSeq) return;
      const results = data.results || data.items || [];
      renderSearchResults(results, q);
    } catch (_err) { /* 静默：搜索失败不打断编辑 */ }
  }, 250);
});

function renderSearchResults(results, q) {
  els.tree.textContent = "";
  const head = document.createElement("div");
  head.className = "tree-empty";
  head.textContent = `搜索「${q}」：${results.length} 条结果`;
  els.tree.appendChild(head);
  for (const item of results) {
    const row = document.createElement("div");
    row.className = "tree-row";
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "🔍";
    const label = document.createElement("span");
    label.textContent = item.title || item.path || "(未知文档)";
    row.appendChild(icon);
    row.appendChild(label);
    row.addEventListener("click", () => {
      if (item.path) openDoc(item.path);
    });
    els.tree.appendChild(row);
  }
}

// ── 侧栏折叠（所有宽度都生效，与桌面端行为一致） ─────────────

els.sidebarToggle.addEventListener("click", () => {
  els.sidebar.classList.toggle("collapsed");
});

// ══ 预览渲染管线（与桌面端 app.js 同源策略的访客版） ════════════════════

// ── markdown-worker（chart / html 沙箱帧由 worker 输出自包含页） ──
let _mdWorker = null;
let _mdWorkerSeq = 0;
const _mdWorkerPending = new Map();

function ensureMdWorker() {
  if (_mdWorker) return _mdWorker;
  try {
    _mdWorker = new Worker(`/markdown-worker.js?v=${ASSET_V}&assets=/vendor/`);
    _mdWorker.onmessage = (event) => {
      const d = event.data;
      if (!d || typeof d.seq !== "number") return;
      const pending = _mdWorkerPending.get(d.seq);
      if (pending) {
        _mdWorkerPending.delete(d.seq);
        pending(d);
      }
    };
    _mdWorker.onerror = () => { /* 渲染失败由调用侧超时兜底 */ };
  } catch (_err) {
    _mdWorker = null;
  }
  return _mdWorker;
}

function workerRenderMarkdown(source) {
  const worker = ensureMdWorker();
  if (!worker) return Promise.reject(new Error("Markdown 渲染服务不可用"));
  const seq = ++_mdWorkerSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (_mdWorkerPending.has(seq)) {
        _mdWorkerPending.delete(seq);
        reject(new Error("Markdown 渲染超时"));
      }
    }, 15000);
    _mdWorkerPending.set(seq, (d) => {
      clearTimeout(timer);
      if (d.error) reject(new Error(String(d.error)));
      else resolve(d);
    });
    worker.postMessage({ seq, searchTerm: "", includeHtml: true, includeOutline: false, source });
  });
}

// ── 沙箱帧自适应高度（worker 注入的上报脚本 → 父页调 iframe 高度） ──
(function installHtmlFrameAutoHeight() {
  window.addEventListener("message", (event) => {
    const d = event.data;
    if (!d || d.type !== "mt-html-frame-height") return;
    const h = Number(d.h);
    if (!Number.isFinite(h) || h <= 0) return;
    document.querySelectorAll("iframe.html-inline-frame").forEach((frame) => {
      if (!frame.isConnected || frame.contentWindow !== event.source) return;
      const clamped = Math.min(Math.max(Math.ceil(h) + 12, 240), HTML_FRAME_MAX_HEIGHT);
      frame.style.height = `${clamped}px`;
    });
  });
})();

// ── 图片 / 视频相对路径 → /source/<wsId>/…（访客资产端点只认这种格式） ──
function rewriteMediaSrc(container, wsId) {
  if (!container || !wsId) return;
  // <img>/<video> 发不了 X-Lan-Token 头：URL 上追加 ?lan_token=（服务端 lan_guard
  // 同时接受头字段与查询参数）。token 缺失时保持原样，让服务端 401 暴露问题。
  const t = token();
  const withToken = (url) => (t ? url + (url.includes("?") ? "&" : "?") + "lan_token=" + encodeURIComponent(t) : url);
  container.querySelectorAll("img, video").forEach((el) => {
    const src = el.getAttribute("src") || "";
    if (!src || /^(data:|blob:|https?:)/i.test(src)) return;
    // 已带工作区前缀（/source/ws_xxx/…）的改为绝对路径并追加 token；Rust 端白名单闸门会校验
    if (/^\/?source\/ws_[A-Za-z0-9_-]+\//.test(src)) {
      const abs = src.startsWith("source/") ? "/" + src : src;
      el.setAttribute("src", withToken(abs));
      return;
    }
    let rel = String(src).trim();
    rel = rel.replace(/^\.\//, "").replace(/^\//, "");
    // 文档里最常见的「source/xxx.webp」形式 → 工作区 source 目录
    if (rel.startsWith("source/")) rel = rel.slice("source/".length);
    if (!rel) return;
    el.setAttribute("src", withToken(`/source/${wsId}/${rel}`));
  });
}

// ── KaTeX ──
let _katexLoadingPromise = null;
function loadKatexAsync() {
  if (window.katex) return Promise.resolve(window.katex);
  if (_katexLoadingPromise) return _katexLoadingPromise;
  _katexLoadingPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `/vendor/katex/katex.min.css?v=${ASSET_V}`;
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = `/vendor/katex/katex.min.js?v=${ASSET_V}`;
    script.onload = () => resolve(window.katex);
    script.onerror = () => {
      _katexLoadingPromise = null;
      reject(new Error("KaTeX 本地资源加载失败"));
    };
    script.async = true;
    document.head.appendChild(script);
  });
  return _katexLoadingPromise;
}

const _mathRenderSeqs = new WeakMap();
async function renderMathInPreview(container) {
  if (!container) return;
  const selector = ".math-block[data-math], .math-inline[data-math]";
  const mathElements = [
    ...(typeof container.matches === "function" && container.matches(selector) ? [container] : []),
    ...container.querySelectorAll(selector),
  ];
  if (!mathElements.length) return;
  const seq = (_mathRenderSeqs.get(container) || 0) + 1;
  _mathRenderSeqs.set(container, seq);
  const stale = () => _mathRenderSeqs.get(container) !== seq;
  try {
    const katex = await loadKatexAsync();
    if (stale()) return;
    if (!katex) throw new Error("KaTeX 库不可用");
    mathElements.forEach((el) => {
      const math = el.getAttribute("data-math") || "";
      const isBlock = el.classList.contains("math-block");
      try {
        katex.render(math, el, { throwOnError: false, displayMode: isBlock, errorColor: "#ef4444" });
      } catch (err) {
        el.textContent = math;
        el.style.color = "#ef4444";
      }
    });
  } catch (_err) {
    if (!stale()) mathElements.forEach((el) => { el.textContent = el.getAttribute("data-math") || ""; });
  }
}

// ── Mermaid（串行 + 可见性等待 + 自测量塌缩防护，与桌面端 app.js 同源） ──
let _mermaidLoadingPromise = null;
let _mermaidInitialized = false;
function loadMermaidAsync() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (_mermaidLoadingPromise) return _mermaidLoadingPromise;
  _mermaidLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `/vendor/mermaid/mermaid.min.js?v=${ASSET_V}`;
    script.onload = () => resolve(window.mermaid);
    script.onerror = () => {
      _mermaidLoadingPromise = null;
      reject(new Error("Mermaid 本地库加载失败"));
    };
    script.async = true;
    document.head.appendChild(script);
  });
  return _mermaidLoadingPromise;
}

let _mermaidRenderUid = 0;
let _mermaidRenderChain = Promise.resolve();
// ⚠️ 页面隐藏期间（后台标签页等）getBBox 对文本返回 0 尺寸 —— mermaid 自测量
// 整体塌缩，图会被压成一条线。渲染前先等页面可见，最多 3s；超时放行，
// 塌缩兜底由 mermaidMeasurementDegenerate + 重渲染负责。
function waitUntilChartsPageVisible(timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      if (document.visibilityState === "visible") return resolve(true);
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", done);
        resolve(document.visibilityState === "visible");
      }
      document.addEventListener("visibilitychange", done);
    } catch (_) {
      resolve(true);
    }
  });
}
function renderMermaidSerialized(mermaid, id, rawDef, timeoutMs = 12000) {
  const task = _mermaidRenderChain.then(
    () =>
      new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("Mermaid 渲染超时"));
        }, timeoutMs);
        Promise.resolve()
          .then(() => waitUntilChartsPageVisible())
          .then(() => mermaid.render(id, rawDef))
          .then(
            (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } },
            (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
          );
      }),
  );
  _mermaidRenderChain = task.then(() => {}, () => {});
  return task;
}

const MERMAID_MAX_GROW = 1.35;
function rawViewBoxOf(svgEl) {
  try {
    const raw = svgEl.getAttribute("data-mt-raw-viewbox") || svgEl.getAttribute("viewBox") || "";
    const vb = raw.split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb.every((n) => isFinite(n)) && vb[2] > 0 && vb[3] > 0) return vb;
  } catch (_) {}
  return null;
}
function markRawViewBox(svgEl) {
  try {
    if (!svgEl || svgEl.getAttribute("data-mt-raw-viewbox")) return;
    const raw = svgEl.getAttribute("viewBox") || "";
    const vb = raw.split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb.every((n) => isFinite(n)) && vb[2] > 0 && vb[3] > 0) {
      svgEl.setAttribute("data-mt-raw-viewbox", raw);
    }
  } catch (_) {}
}
function visibleBBoxOf(svgEl) {
  try {
    const b = svgEl.getBBox();
    if (isFinite(b.x) && isFinite(b.y) && b.width > 0 && b.height > 0) return b;
  } catch (_) {}
  return null;
}
function fitViewBoxToContent(svgEl) {
  const content = visibleBBoxOf(svgEl);
  if (!content) return null;
  const cx1 = content.x, cy1 = content.y, cx2 = content.x + content.width, cy2 = content.y + content.height;
  if (![cx1, cy1, cx2, cy2].every((n) => isFinite(n))) return null;
  const contentW = cx2 - cx1, contentH = cy2 - cy1;
  if (!(contentW > 0) || !(contentH > 0)) return null;
  const pad = Math.min(12, Math.min(contentW, contentH) * 0.03);
  let fx1 = cx1 - pad, fy1 = cy1 - pad, fw = contentW + pad * 2, fh = contentH + pad * 2;
  const raw = rawViewBoxOf(svgEl);
  if (raw) {
    if (fw > raw[2] * MERMAID_MAX_GROW || fh > raw[3] * MERMAID_MAX_GROW) {
      return `${raw[0]} ${raw[1]} ${raw[2]} ${raw[3]}`;
    }
  }
  if (!(fw > 0) || !(fh > 0) || ![fx1, fy1].every((n) => isFinite(n))) return null;
  return `${fx1} ${fy1} ${fw} ${fh}`;
}
function fixMermaidViewBox(svgEl) {
  try {
    if (!svgEl || !svgEl.getBBox) return;
    const fitted = fitViewBoxToContent(svgEl);
    if (!fitted) return;
    if (svgEl.getAttribute("viewBox") !== fitted) svgEl.setAttribute("viewBox", fitted);
  } catch (_) {}
}
// 检测 mermaid 自测量塌缩：真实内容双向 >3× 自报 viewBox（正常 ≈1×，
// 页面隐藏期间渲染实测 6.9×/9.75×）
function mermaidMeasurementDegenerate(svgEl) {
  try {
    const raw = rawViewBoxOf(svgEl);
    if (!raw || !(raw[2] > 0) || !(raw[3] > 0)) return false;
    const b = visibleBBoxOf(svgEl);
    if (!b) return false;
    return b.width > raw[2] * 3 && b.height > raw[3] * 3;
  } catch (_) {
    return false;
  }
}

async function renderMermaidInPreview(container) {
  if (!container) return;
  const mermaidBlocks = container.querySelectorAll(".chart-block.mermaid-block");
  if (!mermaidBlocks.length) return;
  let mermaid;
  try {
    mermaid = await loadMermaidAsync();
    if (!mermaid) throw new Error("Mermaid 库不可用");
    if (!_mermaidInitialized) {
      mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });
      _mermaidInitialized = true;
    }
  } catch (err) {
    mermaidBlocks.forEach((block) => {
      const box = block.querySelector(".mermaid-container");
      if (box) box.innerHTML = `<div class="chart-error">Mermaid 图表库未加载（本地资源缺失）。</div>`;
    });
    return;
  }
  const seq = (_chartRenderSeqs.get(container) || 0) + 1;
  _chartRenderSeqs.set(container, seq);
  const isCurrent = () => _chartRenderSeqs.get(container) === seq;
  for (let i = 0; i < mermaidBlocks.length; i++) {
    const block = mermaidBlocks[i];
    const sourcePre = block.querySelector(".mermaid-source");
    const containerDiv = block.querySelector(".mermaid-container");
    if (!sourcePre || !containerDiv) continue;
    const rawDef = sourcePre.textContent || "";
    const id = `guest-mermaid-${++_mermaidRenderUid}`;
    try {
      const { svg } = await renderMermaidSerialized(mermaid, id, rawDef);
      if (!isCurrent()) continue;
      containerDiv.innerHTML = svg;
      const svgEl = containerDiv.querySelector("svg");
      if (svgEl) {
        markRawViewBox(svgEl);
        fixMermaidViewBox(svgEl);
        // 自测量塌缩兜底：页面隐藏期间渲染的图布局已毁，重渲染一次换回正确布局
        if (mermaidMeasurementDegenerate(svgEl)) {
          const retryId = `guest-mermaid-${++_mermaidRenderUid}`;
          const retry = await renderMermaidSerialized(mermaid, retryId, rawDef);
          if (isCurrent() && retry?.svg) {
            containerDiv.innerHTML = retry.svg;
            const svg2 = containerDiv.querySelector("svg");
            if (svg2) {
              markRawViewBox(svg2);
              fixMermaidViewBox(svg2);
            }
          }
        }
        // 与桌面端一致的呈现策略：移除固定宽高、以自然宽度为上限居中
        svgEl.removeAttribute("width");
        svgEl.removeAttribute("height");
        svgEl.style.width = "100%";
        const vb = rawViewBoxOf(svgEl);
        if (vb) svgEl.style.maxWidth = `${Math.round(vb[2])}px`;
        svgEl.style.height = "auto";
        svgEl.style.display = "block";
        svgEl.style.margin = "0 auto";
      }
    } catch (err) {
      if (isCurrent()) {
        const msg = String((err && err.message) || err || "渲染失败").replace(/[<>&]/g, "");
        containerDiv.innerHTML = `<div class="chart-error">Mermaid 渲染失败：${msg}</div>`;
      }
    }
  }
}
const _chartRenderSeqs = new WeakMap();

// ── highlight.js 代码高亮 ──
const HLJS_LANGS = [
  "powershell", "dockerfile", "cmake", "groovy", "dart", "nginx", "nsis",
  "apache", "properties", "haskell", "elixir", "clojure", "dos", "latex",
  "protobuf", "handlebars", "scala", "fortran",
];
let _hljsLoadingPromise = null;
let _hljsConfigured = false;
function loadHljsAsync() {
  if (window.hljs) return Promise.resolve(window.hljs);
  if (_hljsLoadingPromise) return _hljsLoadingPromise;
  _hljsLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `/vendor/highlight/highlight.min.js?v=${ASSET_V}`;
    script.onload = () => {
      // 语言包按序补齐（体积小，直接全量）
      Promise.all(
        HLJS_LANGS.map(
          (lang) =>
            new Promise((res) => {
              const s = document.createElement("script");
              s.src = `/vendor/highlight/langs/${lang}.min.js?v=${ASSET_V}`;
              s.onload = res;
              s.onerror = res; // 单个语言包缺失不阻塞
              document.head.appendChild(s);
            }),
        ),
      ).then(() => resolve(window.hljs));
    };
    script.onerror = () => {
      _hljsLoadingPromise = null;
      reject(new Error("highlight.js 本地资源加载失败"));
    };
    script.async = true;
    document.head.appendChild(script);
  });
  return _hljsLoadingPromise;
}

async function highlightCodeBlocks(container) {
  if (!container) return;
  const blocks = container.querySelectorAll("pre code");
  if (!blocks.length) return;
  let hljs = null;
  try { hljs = await loadHljsAsync(); } catch (_err) { hljs = null; }
  if (!hljs || !hljs.highlightElement) return;
  if (!_hljsConfigured) {
    try { hljs.configure({ ignoreUnescapedHTML: true }); _hljsConfigured = true; } catch (_) {}
  }
  let i = 0;
  const step = () => {
    const end = Math.min(i + 12, blocks.length);
    for (; i < end; i++) {
      const el = blocks[i];
      if (!el || el.dataset.highlighted === "1") continue;
      if (el.parentElement?.parentElement?.classList?.contains("chart-block")) { el.dataset.highlighted = "1"; continue; }
      try { hljs.highlightElement(el); } catch (_) { /* 单块失败不影响其它 */ }
      el.dataset.highlighted = "1";
    }
    if (i < blocks.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── Excalidraw：访客端给占位提示（绘图编辑是桌面端能力） ──
function decorateExcalidrawHint(container) {
  if (!container) return;
  container.querySelectorAll(".chart-block.excalidraw-block").forEach((block) => {
    const box = block.querySelector(".excalidraw-container");
    if (!box || box.childElementCount > 0) return;
    box.innerHTML = `<div class="chart-placeholder">🎨 Excalidraw 绘图 — 请到桌面端查看与编辑</div>`;
  });
}

// ── 预览主入口 ──
async function renderPreview() {
  const container = els.markdownView;
  if (!container) return;
  const source = state.editor ? state.editor.value : "";
  if (!source) {
    container.innerHTML = `<div class="tree-empty" style="padding:32px 0;text-align:center;color:var(--muted)">打开左侧文档开始阅读</div>`;
    return;
  }
  const seq = ++state.previewSeq;
  container.innerHTML = `<div class="chart-placeholder">正在渲染…</div>`;
  let html = "";
  try {
    const d = await workerRenderMarkdown(source);
    if (seq !== state.previewSeq) return;
    html = d.html || "";
  } catch (err) {
    if (seq !== state.previewSeq) return;
    const msg = String((err && err.message) || err).replace(/[<>&]/g, "");
    container.innerHTML = `<div class="chart-error">Markdown 渲染失败：${msg}（可切回编辑视图查看源码）</div>`;
    return;
  }
  container.innerHTML = html;
  // 图片 / 视频：相对路径改写到访客资产端点
  rewriteMediaSrc(container, state.currentWs);
  // Excalidraw 占位
  decorateExcalidrawHint(container);
  // 公式 / 图表 / 代码高亮（与桌面端同一顺序）
  renderMathInPreview(container);
  renderMermaidInPreview(container);
  highlightCodeBlocks(container);
}

// ── 初始化 ──────────────────────────────────────────────────

async function initApp() {
  try {
    const s = await api("GET", "/api/lan/state");
    state.readOnly = !!(s && s.readOnly);
  } catch (_err) { return; } // 401 时 api() 已跳回配对门
  els.roBadge.classList.toggle("hidden", !state.readOnly);
  els.roBanner.classList.toggle("hidden", !state.readOnly);
  els.saveBtn.disabled = state.readOnly;
  els.newDocBtn.disabled = state.readOnly;
  // 只读共享默认进预览（访客主要场景是阅读）；可编辑默认进编辑
  setView(state.readOnly ? "preview" : "edit");
  try {
    const data = await api("GET", "/api/workspaces");
    state.workspaces = (data && data.visible && data.visible.length ? data.visible : data.workspaces) || [];
    if (state.workspaces.length > 0 && !state.currentWs) {
      state.currentWs = state.workspaces[0].id;
    }
    renderWsTabs();
  } catch (_err) { /* 工作区失败时树仍可尝试 */ }
  loadTree();
}

// 入口：已有 token 则直接进 app，否则显示配对门
(async function boot() {
  if (!token()) { showGate(); return; }
  try {
    await api("GET", "/api/lan/state");
    showApp();
  } catch (_err) {
    showGate();
  }
})();
