// guest.js — 局域网访客页
//
// 流程：PIN 配对门（/api/lan/verify）→ token 存 localStorage →
//       工作区标签 + 文档树 + 编辑器（复用主应用 editor-core.js）→
//       保存走 /api/save（baseHash 乐观锁，冲突时给「保留我的/加载最新」二选一）。
// 所有请求带 X-Lan-Token 头；无任何 Tauri / 云端依赖。

import { createMarkdownEditor } from "/editor-core.js?v=20261112-fc76f102";

const TOKEN_KEY = "mt-lan-token";

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
  searchInput: document.getElementById("searchInput"),
  newDocBtn: document.getElementById("newDocBtn"),
  saveBtn: document.getElementById("saveBtn"),
  roBadge: document.getElementById("roBadge"),
  roBanner: document.getElementById("roBanner"),
  editorHost: document.getElementById("editorHost"),
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
        openDoc(node.path);
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

async function openDoc(docPath) {
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
    els.docTitle.textContent = doc.title || state.currentPath;
    ensureEditor();
    state.editor.value = doc.content;
    hideConflict();
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
      if (r.path) openDoc(r.path);
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

// ── 侧栏（窄屏） ────────────────────────────────────────────

els.sidebarToggle.addEventListener("click", () => {
  els.sidebar.classList.toggle("collapsed");
});

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
