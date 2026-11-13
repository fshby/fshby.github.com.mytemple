// guest.js — 局域网访客页
//
// 流程：PIN 配对门（/api/lan/verify）→ token 存 localStorage →
//       工作区标签 + 文档树 + 编辑/预览双视图 →
//       保存走 /api/save（baseHash 乐观锁，冲突时给「保留我的/加载最新」二选一）。
// 预览管线与桌面端 app.js 同源策略：
//       markdown-worker（含 chart/html 沙箱帧）→ KaTeX → Mermaid（串行 + 可见性等待 +
//       自测量塌缩防护）→ hljs 代码高亮 → 图片/视频经 /source/<wsId>/… 资产端点。
// 所有请求带 X-Lan-Token 头；无任何 Tauri / 云端依赖、无任何外链。

import { createMarkdownEditor } from "/editor-core.js?v=20261113-2a29346c";

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
  splitViewBtn: document.getElementById("splitViewBtn"),
  previewViewBtn: document.getElementById("previewViewBtn"),
  tocToggle: document.getElementById("tocToggle"),
  tocPanel: document.getElementById("tocPanel"),
  tocList: document.getElementById("tocList"),
  tocClose: document.getElementById("tocClose"),
  mdToolbar: document.getElementById("mdToolbar"),
  panes: document.getElementById("panes"),
  readerScroll: document.getElementById("readerScroll"),
  imageInput: document.getElementById("imageInput"),
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
  view: "edit",       // "edit" | "split" | "preview"
  lastEditView: "edit",
  previewSeq: 0,      // 预览渲染竞态守卫
  outline: [],        // worker 返回的标题目录 [{id,title,level}]
  tocOpen: true,
  scrollWired: false,
  scrollLock: false,
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

// ── 视图切换（编辑 / 双栏 / 预览） ─────────────────────────
//
// 双栏 = 编辑与预览同行实时联动（桌面端工作台形态）；左编辑右预览，
// 窄屏自动改为上下堆叠（CSS）。只读共享一律预览。

function setView(mode, { persist = true } = {}) {
  if (mode !== "edit" && mode !== "split" && mode !== "preview") return;
  if (state.readOnly && mode !== "preview") mode = "preview";
  state.view = mode;
  if (mode !== "preview") state.lastEditView = mode;
  const isEdit = mode === "edit";
  const isSplit = mode === "split";
  const isPreview = mode === "preview";
  els.editViewBtn.classList.toggle("active", isEdit);
  els.splitViewBtn.classList.toggle("active", isSplit);
  els.previewViewBtn.classList.toggle("active", isPreview);
  els.editViewBtn.setAttribute("aria-selected", String(isEdit));
  els.splitViewBtn.setAttribute("aria-selected", String(isSplit));
  els.previewViewBtn.setAttribute("aria-selected", String(isPreview));
  if (els.panes) els.panes.dataset.view = mode;
  // 编辑区：纯预览才隐藏；阅读区：纯编辑才隐藏（双栏两者都在）
  els.editorHost.classList.toggle("hidden", isPreview);
  els.readerHost.classList.toggle("hidden", isEdit);
  // 工具栏只在有编辑区时出现
  els.mdToolbar?.classList.toggle("hidden", isPreview);
  if (persist) {
    try { localStorage.setItem("guestView", mode); } catch (_) {}
  }
  if (isSplit) wireScrollSync();
  if (!isEdit) renderPreview();
}

els.editViewBtn.addEventListener("click", () => setView("edit"));
els.splitViewBtn.addEventListener("click", () => setView("split"));
els.previewViewBtn.addEventListener("click", () => setView("preview"));

// 目录开关
function setTocOpen(open, { persist = true } = {}) {
  state.tocOpen = Boolean(open);
  els.tocPanel?.classList.toggle("hidden", !state.tocOpen);
  els.readerHost?.classList.toggle("no-toc", !state.tocOpen);
  els.tocToggle?.classList.toggle("active", state.tocOpen);
  els.tocToggle?.setAttribute("aria-pressed", String(state.tocOpen));
  if (persist) {
    try { localStorage.setItem("guestToc", state.tocOpen ? "1" : "0"); } catch (_) {}
  }
  if (state.tocOpen) updateTocActive();
}

els.tocToggle?.addEventListener("click", () => setTocOpen(!state.tocOpen));
els.tocClose?.addEventListener("click", () => setTocOpen(false));

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "p") {
    // Ctrl+P 与桌面端习惯一致：预览 ↔ 上一个编辑视图
    e.preventDefault();
    setView(state.view === "preview" ? state.lastEditView : "preview");
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
    // 打开时定位工作区：点击来源 > 按路径前缀解析（搜索结果无 ws 字段）> 沿用当前
    state.currentWs = wsId || resolveWsForPath(state.currentPath) || state.currentWs;
    els.docTitle.textContent = doc.title || state.currentPath;
    ensureEditor();
    state.editor.value = doc.content;
    hideConflict();
    if (state.view !== "edit") renderPreview();
  } catch (err) {
    if (err.message !== "需要访问口令") toast(`打开文档失败：${err.message}`);
  }
}

// 文档路径 → 工作区 id（按各工作区 root 前缀反查）。图片资产端点必须先知道
// 工作区，否则 /source/<ws>/… 的改写会指向错误工作区导致 404。
function resolveWsForPath(p) {
  const norm = String(p || "").replace(/\\/g, "/").toLowerCase();
  if (!norm) return "";
  for (const ws of state.workspaces) {
    const root = String(ws.root || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    if (root && (norm === root || norm.startsWith(root + "/"))) return ws.id;
  }
  return "";
}

function ensureEditor() {
  if (state.editor) return;
  state.editor = createMarkdownEditor(els.editorHost, "");
  // 双栏实时预览：输入防抖后重渲染（长文档拉长防抖，避免打断输入）
  state.editor.addEventListener("input", () => schedulePreview());
  wireScrollSync();
  wireEditorPaste();
  wireCursorJump();
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

// ── 预览区代码块「复制」按钮 ──
// markdown-worker 输出的 .code-copy 与桌面端同源，桌面端在 app.js 委托处理；
// 访客页此前没有挂接 → 点击无反应。且访客页走明文 HTTP（192.168.x.x），
// 非安全上下文里 navigator.clipboard 为 undefined，必须 execCommand 兜底。
function legacyCopyText(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (_err) {
    return false;
  }
}
function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    // 安全上下文（桌面 WebView / localhost）：优先异步剪贴板 API，失败退回 execCommand
    return navigator.clipboard.writeText(text)
      .then(() => true)
      .catch(() => legacyCopyText(text));
  }
  return Promise.resolve(legacyCopyText(text));
}
els.markdownView.addEventListener("click", (event) => {
  const copyBtn = event.target.closest(".code-copy");
  if (!copyBtn) return;
  const code = copyBtn.closest(".code-block")?.querySelector("code")?.innerText || "";
  if (!code) return;
  copyTextToClipboard(code).then((ok) => {
    if (!ok) { toast("复制失败，请手动选择代码复制"); return; }
    const label = copyBtn.dataset.label || (copyBtn.dataset.label = copyBtn.textContent);
    copyBtn.textContent = "已复制";
    setTimeout(() => { copyBtn.textContent = label; }, 1500);
    toast("代码已复制");
  });
});

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveDoc();
    return;
  }
  // 与桌面端一致的布局/视图快捷键
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "q") {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if (e.altKey && !mod && !e.shiftKey && !e.repeat) {
    const k = e.key.toLowerCase();
    if (k === "q") { e.preventDefault(); setTocOpen(!state.tocOpen); return; }
    // Alt+E：编辑/预览切换（与桌面端编辑↔阅读一致）
    if (k === "e") { e.preventDefault(); setView(state.view === "preview" ? state.lastEditView : "preview"); return; }
    // Alt+W：双栏开/关（与桌面端显示/隐藏预览栏对应）
    if (k === "w") { e.preventDefault(); setView(state.view === "split" ? state.lastEditView : "split"); return; }
  }
  // 编辑器字号（与桌面端 Ctrl+±/0 一致）
  if (mod && !e.shiftKey && !e.altKey && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    adjustEditorFontSize(1);
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && e.key === "-") {
    e.preventDefault();
    adjustEditorFontSize(-1);
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && e.key === "0") {
    e.preventDefault();
    adjustEditorFontSize(0);
    return;
  }
  // Ctrl+F：焦点不在编辑器时定位搜索框（编辑器内保留 CM6 默认查找面板）
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
    const inEditor = e.target && typeof e.target.closest === "function" && e.target.closest(".cm-editor");
    if (!inEditor) {
      e.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    }
    return;
  }
  // 常用强调快捷键与桌面端一致（仅在有编辑区时生效）
  if (mod && !e.shiftKey && !e.altKey && state.view !== "preview") {
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); runToolbarCmd("bold"); }
    else if (k === "i") { e.preventDefault(); runToolbarCmd("italic"); }
  }
});

// ── 编辑器字号（CM6 内容字体走 --doc-font-size 变量，与桌面端同一入口） ──
const GUEST_EDITOR_FONT_DEFAULT = 14;
let editorFontSize = GUEST_EDITOR_FONT_DEFAULT;
try { editorFontSize = Number(localStorage.getItem("guestEditorFontSize")) || GUEST_EDITOR_FONT_DEFAULT; } catch (_) {}
editorFontSize = Math.min(32, Math.max(10, editorFontSize));
function applyEditorFontSize() {
  document.documentElement.style.setProperty("--doc-font-size", `${editorFontSize}px`);
}
function adjustEditorFontSize(delta) {
  editorFontSize = delta === 0
    ? GUEST_EDITOR_FONT_DEFAULT
    : Math.min(32, Math.max(10, editorFontSize + delta));
  try { localStorage.setItem("guestEditorFontSize", String(editorFontSize)); } catch (_) {}
  applyEditorFontSize();
  toast(`编辑器字号 ${editorFontSize}px`);
}
applyEditorFontSize();

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

// ══ 编辑能力：工具栏 / 粘贴图片 / 双栏实时预览 / 标题目录 ════════════════

function editorCtx() {
  if (state.readOnly) { toast("当前为只读共享，无法编辑"); return null; }
  if (!state.currentPath) { toast("请先打开一个文档"); return null; }
  ensureEditor();
  return state.editor;
}

let previewTimer = 0;
// 双栏/预览下输入防抖重渲染；长文档拉长间隔，避免每次击键都走一遍完整管线
function schedulePreview(immediate = false) {
  if (state.view === "edit") return;
  clearTimeout(previewTimer);
  const len = state.editor ? state.editor.value.length : 0;
  const delay = immediate ? 0 : len > 200000 ? 1200 : len > 60000 ? 700 : 420;
  previewTimer = setTimeout(() => { renderPreview(); }, delay);
}

function insertTextAtCursor(text, { prefixNewline = true } = {}) {
  const ed = editorCtx();
  if (!ed) return;
  ed.focus();
  const v = ed.value;
  const start = ed.selectionStart;
  const end = ed.selectionEnd;
  const lineStart = v.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const needNl = prefixNewline && v.slice(lineStart, start).trim() !== "";
  const insert = (needNl ? "\n" : "") + text;
  ed.setRangeText(insert, start, end, "end");
  ed.focus();
  schedulePreview(true);
}

function wrapInline(prefix, suffix = prefix, placeholder = "文本") {
  const ed = editorCtx();
  if (!ed) return;
  ed.focus();
  const start = ed.selectionStart;
  const end = ed.selectionEnd;
  const inner = ed.value.slice(start, end) || placeholder;
  ed.setRangeText(prefix + inner + suffix, start, end, "end");
  ed.setSelectionRange(start + prefix.length, start + prefix.length + inner.length);
  ed.focus();
  schedulePreview(true);
}

// 行级命令：多行同时处理，已有标记则移除（toggle 语义，与桌面端一致）
function transformSelectedLines(fn) {
  const ed = editorCtx();
  if (!ed) return;
  ed.focus();
  const v = ed.value;
  const selStart = ed.selectionStart;
  const selEnd = ed.selectionEnd;
  const lineStart = v.lastIndexOf("\n", Math.max(0, selStart - 1)) + 1;
  let lineEnd = v.indexOf("\n", selEnd);
  if (lineEnd === -1) lineEnd = v.length;
  const block = v.slice(lineStart, lineEnd);
  const next = fn(block.split("\n")).join("\n");
  if (next === block) return;
  ed.setRangeText(next, lineStart, lineEnd, "end");
  const clampPos = (p) => lineStart + Math.min(Math.max(0, p - lineStart), next.length);
  ed.setSelectionRange(clampPos(selStart), clampPos(selEnd));
  ed.focus();
  schedulePreview(true);
}

const HEADING_RE = /^\s*#{1,6}\s+/;

function toggleHeading(level) {
  const mark = "#".repeat(level) + " ";
  transformSelectedLines((lines) => {
    const has = lines.every((l) => !l.trim() || l.startsWith(mark));
    return lines.map((l) => {
      if (!l.trim()) return l;
      const bare = l.replace(HEADING_RE, "");
      return has ? bare : mark + bare;
    });
  });
}

function toggleLinePrefix(prefix) {
  transformSelectedLines((lines) => {
    const has = lines.every((l) => !l.trim() || l.startsWith(prefix));
    return lines.map((l) => {
      if (!l.trim()) return l;
      return has ? l.slice(prefix.length) : prefix + l;
    });
  });
}

const OL_RE = /^\s*\d+\.\s+/;
function toggleOrderedList() {
  transformSelectedLines((lines) => {
    const filled = lines.filter((l) => l.trim());
    const has = filled.length > 0 && filled.every((l) => OL_RE.test(l));
    let n = 0;
    return lines.map((l) => {
      if (!l.trim()) return l;
      if (has) return l.replace(OL_RE, "");
      n += 1;
      return `${n}. ${l}`;
    });
  });
}

function runToolbarCmd(cmd) {
  switch (cmd) {
    case "h1": return toggleHeading(1);
    case "h2": return toggleHeading(2);
    case "h3": return toggleHeading(3);
    case "bold": return wrapInline("**", "**", "加粗文字");
    case "italic": return wrapInline("*", "*", "斜体文字");
    case "strike": return wrapInline("~~", "~~", "删除线");
    case "code": return wrapInline("`", "`", "code");
    case "quote": return toggleLinePrefix("> ");
    case "ul": return toggleLinePrefix("- ");
    case "ol": return toggleOrderedList();
    case "task": return toggleLinePrefix("- [ ] ");
    case "link": {
      const ed = editorCtx();
      if (!ed) return;
      ed.focus();
      const start = ed.selectionStart;
      const end = ed.selectionEnd;
      const text = ed.value.slice(start, end) || "链接文字";
      const md = `[${text}](https://)`;
      ed.setRangeText(md, start, end, "end");
      const urlStart = start + text.length + 3;
      ed.setSelectionRange(urlStart, urlStart + 8);
      ed.focus();
      return schedulePreview(true);
    }
    case "image": return els.imageInput?.click();
    case "table":
      return insertTextAtCursor("| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n");
    case "codeblock": {
      const ed = editorCtx();
      if (!ed) return;
      const start = ed.selectionStart;
      const end = ed.selectionEnd;
      const inner = ed.value.slice(start, end) || "";
      const block = "```\n" + inner + (inner && !inner.endsWith("\n") ? "\n" : "") + "```\n";
      ed.setRangeText(block, start, end, "end");
      if (!inner) ed.setSelectionRange(start + 4, start + 4);
      ed.focus();
      return schedulePreview(true);
    }
    case "hr": return insertTextAtCursor("\n---\n");
    default: return undefined;
  }
}

els.mdToolbar?.querySelectorAll("[data-cmd]").forEach((btn) => {
  // mousedown 阻止默认：点工具栏时编辑器保持焦点与选区（否则选区丢失、命令落空）
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => runToolbarCmd(btn.dataset.cmd));
});

// ── 粘贴 / 选择图片 → /api/lan/asset → 插入 markdown ──
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(new Error("读取图片失败"));
    fr.readAsDataURL(file);
  });
}

function clipboardImageFiles(cd) {
  if (!cd) return [];
  const out = [];
  if (cd.items) {
    for (const item of Array.from(cd.items)) {
      if (item.kind === "file" && String(item.type || "").startsWith("image/")) {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (!out.length && cd.files) {
    for (const f of Array.from(cd.files)) {
      if (String(f.type || "").startsWith("image/")) out.push(f);
    }
  }
  return out;
}

function pickImageExt(mime, fileName) {
  const m = String(mime || "");
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  if (m.includes("bmp")) return "bmp";
  const fromName = String(fileName || "").split(".").pop();
  return fromName && /^[a-z0-9]{2,5}$/i.test(fromName) ? fromName.toLowerCase() : "png";
}

async function uploadAndInsertImages(files) {
  if (!files || !files.length) return;
  if (state.readOnly) { toast("当前为只读共享，无法插入图片"); return; }
  if (!state.currentPath) { toast("请先打开一个文档"); return; }
  for (const file of files) {
    try {
      toast("正在上传图片…");
      const dataUrl = await fileToDataUrl(file);
      const ext = pickImageExt(file.type, file.name);
      const name = `paste_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
      // 走访客专用资产端点（桌面主通道的资产接口不对访客开放）；工作区归属决定
      // 落盘目录与后面 /source/<wsId>/… 的读取路径。
      const r = await api("POST", "/api/lan/asset", {
        dataUrl,
        name,
        workspaceId: state.currentWs || undefined,
      });
      if (!r || !r.ok || !r.path) throw new Error((r && r.error) || "上传失败");
      const md = r.markdown || `![](${r.path})`;
      insertTextAtCursor(md + "\n");
      toast("图片已插入");
    } catch (err) {
      if (err.message !== "需要访问口令") toast(`图片上传失败：${err.message}`);
    }
  }
}

function wireEditorPaste() {
  if (state.pasteWired) return;
  state.pasteWired = true;
  // 编辑器内：capture 抢在 CM6 原生 paste 之前，图片一律走上传（文本粘贴不干预）
  els.editorHost.addEventListener("paste", (e) => {
    if (state.readOnly) return;
    const files = clipboardImageFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    uploadAndInsertImages(files);
  }, true);
  // 兜底：焦点不在编辑器（刚点完工具栏、或点了预览区）时，整页 paste 也接管图片
  document.addEventListener("paste", (e) => {
    if (state.readOnly || !state.currentPath) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const files = clipboardImageFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    uploadAndInsertImages(files);
  });
}

els.imageInput?.addEventListener("change", () => {
  const files = Array.from(els.imageInput.files || []);
  els.imageInput.value = "";
  uploadAndInsertImages(files);
});

// ── 预览区图片/视频删除（对齐桌面端：移除引用 + 清理磁盘文件） ──
function attachMediaDeleteButtons(container) {
  if (!container || state.readOnly) return;
  container.querySelectorAll("img, video").forEach((el) => {
    const docSrc = el.dataset.docSrc || "";
    if (!docSrc || el.dataset.deleteAttached) return;
    // 只对工作区 source/ 引用提供删除（外链/data 图不涉及磁盘文件）
    if (!/^\/?(source|ws-asset)\//.test(docSrc)) return;
    el.dataset.deleteAttached = "1";
    const parent = el.parentElement;
    if (!parent) return;
    parent.classList.add("image-delete-wrapper");
    if (parent.querySelector(".image-delete-btn")) return;
    const btn = document.createElement("button");
    btn.className = "image-delete-btn";
    btn.type = "button";
    btn.title = "删除该媒体（同时清理磁盘文件）";
    btn.setAttribute("aria-label", "删除图片或视频");
    btn.textContent = "×";
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteMediaFromDoc(docSrc);
    });
    parent.appendChild(btn);
  });
}

async function deleteMediaFromDoc(docSrc) {
  if (!docSrc) return;
  if (state.readOnly) { toast("当前为只读共享，无法删除"); return; }
  if (!state.editor) return;
  const ok = window.confirm(
    "确定删除该图片/视频吗？\n\n将同时执行：\n1. 移除文档中的引用\n2. 删除磁盘上的文件以释放空间",
  );
  if (!ok) return;
  const content = state.editor.value;
  const escaped = docSrc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\s*!\\[[^\\]]*\\]\\(${escaped}\\)\\s*\\n?`, "g");
  const next = content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
  if (next !== content) {
    state.editor.value = next;
    schedulePreview(true);
  }
  try {
    await api("POST", "/api/lan/asset-delete", {
      path: docSrc,
      workspaceId: state.currentWs || undefined,
    });
    toast(next !== content ? "已删除：文档引用已移除，磁盘文件已清理" : "磁盘文件已清理（文档中未找到引用）");
  } catch (err) {
    if (err.message !== "需要访问口令") toast(`磁盘文件清理失败：${err.message}`);
  }
}

// ── 双栏滚动同步（按比例，双向；带互斥锁防抖） ──
function wireScrollSync() {
  if (state.scrollWired || !state.editor || !els.readerScroll) return;
  state.scrollWired = true;
  const ed = state.editor;
  const reader = els.readerScroll;
  const ratioTo = (srcTop, srcMax, dstMax) => (srcMax > 2 && dstMax > 2 ? (srcTop / srcMax) * dstMax : null);
  ed.addEventListener("scroll", () => {
    if (state.view !== "split" || state.scrollLock) return;
    const target = ratioTo(ed.scrollTop, ed.scrollHeight - ed.clientHeight, reader.scrollHeight - reader.clientHeight);
    if (target === null || Math.abs(reader.scrollTop - target) < 8) return;
    state.scrollLock = true;
    reader.scrollTop = target;
    setTimeout(() => { state.scrollLock = false; }, 90);
  });
  reader.addEventListener("scroll", () => {
    if (state.view !== "split" || state.scrollLock) return;
    const target = ratioTo(reader.scrollTop, reader.scrollHeight - reader.clientHeight, ed.scrollHeight - ed.clientHeight);
    if (target === null || Math.abs(ed.scrollTop - target) < 8) return;
    state.scrollLock = true;
    ed.scrollTop = target;
    setTimeout(() => { state.scrollLock = false; }, 90);
  });
}

// ── 标题目录（worker outline → 列表；点击跳转 + 滚动高亮） ──
let tocSpyTimer = 0;
function scheduleTocSpy() {
  clearTimeout(tocSpyTimer);
  tocSpyTimer = setTimeout(updateTocActive, 100);
}

function renderToc(outline) {
  const list = els.tocList;
  if (!list) return;
  const items = (Array.isArray(outline) ? outline : []).filter((h) => h && h.id && h.title);
  state.outline = items;
  list.textContent = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "toc-empty";
    empty.textContent = state.currentPath ? "本文档没有标题" : "打开文档后显示目录";
    list.appendChild(empty);
    return;
  }
  for (const h of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `toc-item lv${Math.min(Math.max(h.level || 1, 1), 6)}`;
    b.textContent = h.title;
    b.title = h.title;
    b.dataset.id = h.id;
    b.addEventListener("click", () => jumpToHeading(h.id));
    list.appendChild(b);
  }
  updateTocActive();
}

function jumpToHeading(id) {
  const el = els.markdownView.querySelector(`[id="${String(id).replace(/["\\]/g, "\\$&")}"]`);
  if (!el || !els.readerScroll) return;
  const top = el.getBoundingClientRect().top - els.readerScroll.getBoundingClientRect().top + els.readerScroll.scrollTop - 8;
  els.readerScroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  setActiveTocItem(id);
}

function updateTocActive() {
  if (!state.outline.length || !els.readerScroll) return;
  const threshold = els.readerScroll.getBoundingClientRect().top + 24;
  let activeId = state.outline[0].id;
  for (const h of state.outline) {
    const el = els.markdownView.querySelector(`[id="${String(h.id).replace(/["\\]/g, "\\$&")}"]`);
    if (!el) continue;
    if (el.getBoundingClientRect().top <= threshold) activeId = h.id;
    else break;
  }
  setActiveTocItem(activeId);
}

function setActiveTocItem(id) {
  if (!els.tocList) return;
  let active = null;
  els.tocList.querySelectorAll(".toc-item").forEach((b) => {
    const on = b.dataset.id === id;
    b.classList.toggle("active", on);
    if (on) active = b;
  });
  if (active && typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest" });
  }
}

// 目录高亮的滚动监听独立于编辑区：只读访客没有编辑器也要能跟随滚动高亮
els.readerScroll?.addEventListener("scroll", scheduleTocSpy);

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

// ── 侧栏折叠（所有宽度都生效，与桌面端行为一致；Ctrl+Q 同款） ─────────────

function toggleSidebar() {
  els.sidebar.classList.toggle("collapsed");
  try {
    localStorage.setItem("guestSidebar", els.sidebar.classList.contains("collapsed") ? "0" : "1");
  } catch (_) {}
}

els.sidebarToggle.addEventListener("click", toggleSidebar);

// ── 点击编辑区 → 预览跳到对应标题（与 worker extractOutline 同序扫描） ──
//
// worker 的大纲按文档顺序提取（代码块跳过 + 四类标题模式），本函数按同一
// 规则只记录「第 i 个标题所在行」，行序天然与 state.outline 对齐 ——
// 光标上方最近的标题 = outline[target]，直接复用 jumpToHeading。

function sourceHeadingLines(source) {
  const out = [];
  let inCode = false;
  String(source || "").replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    if (line.startsWith("```")) { inCode = !inCode; return; }
    if (inCode) return;
    const isHeading =
      /^(\s*)(#{1,6})\s+(.+)$/.test(line) ||
      /^(\s*)([一二三四五六七八九十]{1,4}[、．.)]\s*.+)$/.test(line) ||
      /^(\s*)(\d+(?:\.\d+)+)[、．.)]\s*([^-*].+)$/.test(line) ||
      (/^(\s*)(\((?:\d{1,3})\)|(\d{1,3})([、．.)]))\s*([^-*].+)$/.test(line)
        && !/^\s*\d+[.)]\s+\[[ xX]\](?:\s|$)/.test(line));
    if (isHeading) out.push(i);
  });
  return out;
}

let cursorJumpTimer = 0;
let lastJumpedHeadingId = "";

function scheduleCursorJump(delay = 120) {
  if (state.view !== "split") return;
  clearTimeout(cursorJumpTimer);
  cursorJumpTimer = setTimeout(syncPreviewToCursor, delay);
}

function syncPreviewToCursor() {
  if (state.view !== "split" || !state.editor || !state.outline.length) return;
  const ed = state.editor;
  const cursorLine = String(ed.value).slice(0, ed.selectionStart || 0).split("\n").length - 1;
  const marks = sourceHeadingLines(ed.value);
  let target = -1;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i] <= cursorLine) target = i;
    else break;
  }
  if (target < 0) return;
  const h = state.outline[target];
  if (!h || h.id === lastJumpedHeadingId) return; // 同一节内移动光标不打断滚动
  lastJumpedHeadingId = h.id;
  // 跳转期间挂起双向比例同步，避免平滑滚动被 ratio 联动打断
  state.scrollLock = true;
  setTimeout(() => { state.scrollLock = false; }, 600);
  jumpToHeading(h.id);
}

function wireCursorJump() {
  if (state.cursorJumpWired || !els.editorHost) return;
  state.cursorJumpWired = true;
  // 点击定位：mouseup 后光标已落位，稍候即跳
  els.editorHost.addEventListener("mouseup", () => scheduleCursorJump(140));
  // 方向键翻页等导航键也跟随（输入打字不触发，避免打断预览位置）
  els.editorHost.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) {
      scheduleCursorJump(160);
    }
  }, true);
}

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
    worker.postMessage({ seq, searchTerm: "", includeHtml: true, includeOutline: true, source });
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
    // 记录文档里的原始引用路径（预览区删除按钮靠它反查 markdown 引用）
    if (src && !/^(data:|blob:)/i.test(src)) el.dataset.docSrc = src;
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
    renderToc([]);
    return;
  }
  const seq = ++state.previewSeq;
  container.innerHTML = `<div class="chart-placeholder">正在渲染…</div>`;
  let html = "";
  let outline = [];
  try {
    const d = await workerRenderMarkdown(source);
    if (seq !== state.previewSeq) return;
    html = d.html || "";
    outline = Array.isArray(d.outline) ? d.outline : [];
  } catch (err) {
    if (seq !== state.previewSeq) return;
    const msg = String((err && err.message) || err).replace(/[<>&]/g, "");
    container.innerHTML = `<div class="chart-error">Markdown 渲染失败：${msg}（可切回编辑视图查看源码）</div>`;
    return;
  }
  container.innerHTML = html;
  // 图片 / 视频：相对路径改写到访客资产端点（并记录 docSrc 供删除反查）
  rewriteMediaSrc(container, state.currentWs);
  // 图片/视频删除按钮（可编辑共享才有；只读访客不提供删除入口）
  attachMediaDeleteButtons(container);
  // Excalidraw 占位
  decorateExcalidrawHint(container);
  // 标题目录（worker 与正文同源生成 id，点击即滚动到对应标题）
  renderToc(outline);
  lastJumpedHeadingId = ""; // 新一轮渲染后允许光标跳转重新定位
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
  // 只读共享：只能预览（编辑/双栏按钮禁用，避免写出必失败的假入口）
  els.editViewBtn.disabled = state.readOnly;
  els.splitViewBtn.disabled = state.readOnly;
  els.imageInput?.toggleAttribute("disabled", state.readOnly);
  // 目录开关按上次选择恢复（默认开）
  let tocSaved = null;
  try { tocSaved = localStorage.getItem("guestToc"); } catch (_) {}
  setTocOpen(tocSaved === null ? true : tocSaved === "1", { persist: false });
  // 侧栏折叠状态恢复（默认展开）
  try {
    if (localStorage.getItem("guestSidebar") === "0") els.sidebar.classList.add("collapsed");
  } catch (_) {}
  // 视图恢复：只读 → 预览；可编辑 → 上次选择，未选择时宽屏默认双栏、窄屏编辑
  let savedView = null;
  try { savedView = localStorage.getItem("guestView"); } catch (_) {}
  const fallback = window.innerWidth >= 1000 ? "split" : "edit";
  const initialView = state.readOnly
    ? "preview"
    : (savedView === "edit" || savedView === "split" || savedView === "preview" ? savedView : fallback);
  setView(initialView, { persist: false });
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
