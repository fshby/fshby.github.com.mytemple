const text = {
  emptyResult: "\u6ca1\u6709\u5339\u914d\u7ed3\u679c",
  retryKeyword: "\u6362\u4e00\u4e2a\u5173\u952e\u8bcd\u8bd5\u8bd5",
  noGraph: "\u6682\u65e0\u53ef\u7ed8\u5236\u7684 Markdown \u6587\u6863",
  docsUnit: "\u7bc7 Markdown",
  newFolder: "\u65b0\u5efa\u6587\u4ef6\u5939",
  newDoc: "\u65b0\u5efa Markdown",
  deleteConfirm: "\u786e\u5b9a\u5220\u9664\u5f53\u524d\u9879\u5417\uff1f",
};

const state = {
  tree: [],
  flatFiles: [],
  currentPath: "",
  currentContent: "",
  mode: "view",
  graph: { nodes: [], edges: [] },
  graphReady: false,
  selectedNode: "",
  selectedFolder: "",
  multiSelected: new Set(),
  sidebarCollapsed: false,
  folderExplicit: false,
  activeWorkspaceId: "",
  openSeq: 0,
  searchSeq: 0,
  saveSeq: 0,
  createMode: "doc",
  expandedFolders: new Set(),
  expandedWorkspaceRoots: new Set(),
  graphDrag: null,
  undo: { stack: [], index: -1, applying: false },
  deleteTarget: "",
  dragItem: null,
  clipboardItem: null,
  clipboardItems: [],
  workspaces: [],
  defaultWorkspaceId: "default",
  sidebarResize: null,
  syncPreviewScroll: { frame: 0, ratio: 0 },
  lastSavedContent: "",
  toastTimer: 0,
  recentDocs: [],
};

const els = {
  appShell: document.querySelector(".app-shell"),
  tree: document.querySelector("#tree"),
  docCount: document.querySelector("#docCount"),
  searchInput: document.querySelector("#searchInput"),
  searchResults: document.querySelector("#searchResults"),
  docPath: document.querySelector("#docPath"),
  docTitle: document.querySelector("#docTitle"),
  readerPanel: document.querySelector("#readerPanel"),
  editorPanel: document.querySelector("#editorPanel"),
  graphPanel: document.querySelector("#graphPanel"),
  markdownView: document.querySelector("#markdownView"),
  readerOutline: document.querySelector("#readerOutline"),
  editor: document.querySelector("#editor"),
  preview: document.querySelector("#preview"),
  viewBtn: document.querySelector("#viewBtn"),
  editBtn: document.querySelector("#editBtn"),
  graphBtn: document.querySelector("#graphBtn"),
  deleteBtn: document.querySelector("#deleteBtn"),
  saveBtn: document.querySelector("#saveBtn"),
  fitGraphBtn: document.querySelector("#fitGraphBtn"),
  formatBtn: document.querySelector("#formatBtn"),
  canvas: document.querySelector("#graphCanvas"),
  newFolderBtn: document.querySelector("#newFolderBtn"),
  newDocBtn: document.querySelector("#newDocBtn"),
  workspaceBtn: document.querySelector("#workspaceBtn"),
  workspaceSummary: document.querySelector("#workspaceSummary"),
  workspaceModal: document.querySelector("#workspaceModal"),
  workspaceForm: document.querySelector("#workspaceForm"),
  workspacePath: document.querySelector("#workspacePath"),
  workspaceName: document.querySelector("#workspaceName"),
  workspaceList: document.querySelector("#workspaceList"),
  cancelWorkspaceBtn: document.querySelector("#cancelWorkspaceBtn"),
  createModal: document.querySelector("#createModal"),
  createForm: document.querySelector("#createForm"),
  createTitle: document.querySelector("#createTitle"),
  createSummary: document.querySelector("#createSummary"),
  createWorkspaceRow: document.querySelector("#createWorkspaceRow"),
  createWorkspaceChoices: document.querySelector("#createWorkspaceChoices"),
  createName: document.querySelector("#createName"),
  cancelCreateBtn: document.querySelector("#cancelCreateBtn"),
  deleteModal: document.querySelector("#deleteModal"),
  deleteTarget: document.querySelector("#deleteTarget"),
  cancelDeleteBtn: document.querySelector("#cancelDeleteBtn"),
  confirmDeleteBtn: document.querySelector("#confirmDeleteBtn"),
  editorToolbar: document.querySelector("#editorToolbar"),
  textColor: document.querySelector("#textColor"),
  bgColor: document.querySelector("#bgColor"),
  fontSize: document.querySelector("#fontSize"),
  sidebarResizer: document.querySelector("#sidebarResizer"),
  sidebarHideBtn: document.querySelector("#sidebarHideBtn"),
  sidebarShowBtn: document.querySelector("#sidebarShowBtn"),
  settingsBtn: document.querySelector("#settingsBtn"),
  settingsModal: document.querySelector("#settingsModal"),
  closeSettingsBtn: document.querySelector("#closeSettingsBtn"),
  themeChoices: document.querySelector("#themeChoices"),
  bgImageInput: document.querySelector("#bgImageInput"),
  globalFontSize: document.querySelector("#globalFontSize"),
  globalFontSizeValue: document.querySelector("#globalFontSizeValue"),
  docFontSize: document.querySelector("#docFontSize"),
  docFontSizeValue: document.querySelector("#docFontSizeValue"),
  globalFontFamily: document.querySelector("#globalFontFamily"),
  defaultWorkspaceChoices: document.querySelector("#defaultWorkspaceChoices"),
  browseFolderBtn: document.querySelector("#browseFolderBtn"),
  fileBrowser: document.querySelector("#fileBrowser"),
  browserFullPath: document.querySelector("#browserFullPath"),
  browserFavorites: document.querySelector("#browserFavorites"),
  browserRoots: document.querySelector("#browserRoots"),
  browserRootsGroup: document.querySelector("#browserRootsGroup"),
  browserSearchHint: document.querySelector("#browserSearchHint"),
  browserBreadcrumbs: document.querySelector("#browserBreadcrumbs"),
  browserUpBtn: document.querySelector("#browserUpBtn"),
  browserGrid: document.querySelector("#browserGrid"),
  browserEmpty: document.querySelector("#browserEmpty"),
  browserCurrent: document.querySelector("#browserCurrent"),
  browserSelectBtn: document.querySelector("#browserSelectBtn"),
  normalizeMdBtn: document.querySelector("#normalizeMdBtn"),
  normalizeProgress: document.querySelector("#normalizeProgress"),
  normalizeStatus: document.querySelector("#normalizeStatus"),
  normalizeMdModal: document.querySelector("#normalizeMdModal"),
  normalizeWorkspaceList: document.querySelector("#normalizeWorkspaceList"),
  normalizeExtensionChoices: document.querySelector("#normalizeExtensionChoices"),
  cancelNormalizeMdBtn: document.querySelector("#cancelNormalizeMdBtn"),
  confirmNormalizeMdBtn: document.querySelector("#confirmNormalizeMdBtn"),
  normalizeStatus: document.querySelector("#normalizeStatus"),
  toast: document.querySelector("#toast"),
  recentDocs: document.querySelector("#recentDocs"),
};

const api = {
  async get(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
  async post(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
};

function showToast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  state.toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 1800);
}

function loadSettings() {
  return {
    theme: localStorage.getItem("docTheme") || "light",
    bg: localStorage.getItem("docBgImage") || "",
    fontSize: Number(localStorage.getItem("docFontSize") || 16),
    contentFontSize: Number(localStorage.getItem("docContentFontSize") || 16),
    fontFamily: localStorage.getItem("docFontFamily") || els.globalFontFamily.value,
  };
}

function applySettings(settings = loadSettings()) {
  document.body.dataset.theme = settings.theme;
  document.documentElement.style.setProperty("--app-font-size", `${settings.fontSize}px`);
  document.documentElement.style.setProperty("--doc-font-size", `${settings.contentFontSize}px`);
  document.documentElement.style.setProperty("--app-font-family", settings.fontFamily);
  if (settings.bg) document.documentElement.style.setProperty("--custom-bg", `url("${settings.bg}")`);
  else document.documentElement.style.removeProperty("--custom-bg");
  els.globalFontSize.value = settings.fontSize;
  els.globalFontSizeValue.textContent = `${settings.fontSize}px`;
  els.docFontSize.value = settings.contentFontSize;
  els.docFontSizeValue.textContent = `${settings.contentFontSize}px`;
  els.globalFontFamily.value = settings.fontFamily;
  [...els.themeChoices.querySelectorAll("[data-theme]")].forEach((button) => {
    button.classList.toggle("active", button.dataset.theme === settings.theme);
  });
}

function loadRecentDocs() {
  try {
    const saved = localStorage.getItem("recentDocs");
    if (saved) {
      state.recentDocs = JSON.parse(saved);
    }
  } catch (e) {
    state.recentDocs = [];
  }
}

function saveRecentDocs() {
  try {
    localStorage.setItem("recentDocs", JSON.stringify(state.recentDocs));
  } catch (e) {
    // ignore
  }
}

function addRecentDoc(docPath) {
  if (!docPath) return;
  const existingIndex = state.recentDocs.findIndex((item) => item.path === docPath);
  if (existingIndex >= 0) {
    state.recentDocs.splice(existingIndex, 1);
  }
  const file = state.flatFiles.find((f) => f.path === docPath);
  state.recentDocs.unshift({
    path: docPath,
    name: displayName(file) || docPath.split("/").pop(),
    timestamp: Date.now(),
  });
  const maxRecent = 6;
  if (state.recentDocs.length > maxRecent) {
    state.recentDocs = state.recentDocs.slice(0, maxRecent);
  }
  saveRecentDocs();
  renderRecentDocs();
}

function removeRecentDoc(docPath) {
  state.recentDocs = state.recentDocs.filter((item) => item.path !== docPath);
  saveRecentDocs();
  renderRecentDocs();
}

function renderRecentDocs() {
  if (!els.recentDocs) return;
  if (state.recentDocs.length === 0) {
    els.recentDocs.innerHTML = '<span class="recent-docs-empty">暂无最近打开文档</span>';
    return;
  }
  els.recentDocs.innerHTML = state.recentDocs.map((doc, index) => `
    <div class="recent-item ${state.currentPath === doc.path ? "active" : ""}" data-path="${escapeHtml(doc.path)}" title="${escapeHtml(doc.path)}">
      <span class="recent-icon">${index === 0 ? "★" : "○"}</span>
      <span class="recent-name">${escapeHtml(compactName(doc.name, 24))}</span>
      <span class="recent-close" data-remove="${escapeHtml(doc.path)}">×</span>
    </div>
  `).join("");

  els.recentDocs.querySelectorAll(".recent-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target.closest(".recent-close")) return;
      const path = item.dataset.path;
      if (path) openDoc(path);
    });
  });

  els.recentDocs.querySelectorAll(".recent-close").forEach((closeBtn) => {
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const path = closeBtn.dataset.remove;
      if (path) removeRecentDoc(path);
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function displayName(file) {
  return file.displayName || file.name || file.path.split("/").pop();
}

function splitPathRef(value = "") {
  const text = String(value || "");
  const index = text.indexOf(":");
  if (index > 0) return { workspaceId: text.slice(0, index), relative: text.slice(index + 1) };
  return { workspaceId: "default", relative: text };
}

function joinPathRef(workspaceId, relative = "") {
  return `${workspaceId || "default"}:${String(relative || "").replace(/^\/+/, "")}`;
}

function parentPathRef(value = "") {
  const ref = splitPathRef(value);
  if (!ref.relative) return joinPathRef(ref.workspaceId);
  const parent = ref.relative.includes("/") ? ref.relative.split("/").slice(0, -1).join("/") : "";
  return joinPathRef(ref.workspaceId, parent);
}

function displayPath(value = "") {
  const ref = splitPathRef(value);
  const workspace = state.workspaces.find((item) => item.id === ref.workspaceId);
  return `${workspace?.name || ref.workspaceId}${ref.relative ? `/${ref.relative}` : ""}`;
}

function compactName(value, limit = 20) {
  const name = String(value || "");
  return name.length > limit ? `${name.slice(0, limit)}...` : name;
}

function splitWorkspaceRef(path) {
  const value = String(path || "");
  const colon = value.indexOf(":");
  if (colon > 0) {
    return { id: value.slice(0, colon), relative: value.slice(colon + 1) };
  }
  return { id: value, relative: "" };
}

function plainText(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~+#>|{}\[\]]/g, "")
    .trim();
}

function headingId(text, index) {
  const base = plainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `h-${base || "section"}-${index}`;
}

function extractOutline(source) {
  const outline = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let h1Index = 0;
  let h2Index = 0;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = line.match(/^(#{1,2})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const index = level === 1 ? h1Index++ : `sub-${h2Index++}`;
      outline.push({ id: headingId(heading[2], index), title: plainText(heading[2]), level });
      continue;
    }
    const autoHeading = line.match(/^([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (autoHeading) outline.push({ id: headingId(autoHeading[1], `auto-${h2Index++}`), title: plainText(autoHeading[1]), level: 2 });
  }
  return outline;
}

function formatDocument(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const result = [];
  let inCode = false;
  let lastHeadingLevel = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith("```")) {
      inCode = !inCode;
      result.push(line);
      continue;
    }
    
    if (inCode) {
      result.push(line);
      continue;
    }
    
    const headingMatch = line.match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const indent = headingMatch[1];
      const rawLevel = headingMatch[2].length;
      const title = headingMatch[3];
      
      let correctedLevel = rawLevel;
      
      if (rawLevel > lastHeadingLevel + 1) {
        correctedLevel = lastHeadingLevel + 1;
      }
      
      if (rawLevel < lastHeadingLevel) {
        correctedLevel = rawLevel;
      }
      
      lastHeadingLevel = correctedLevel;
      
      result.push(`${indent}${"#".repeat(correctedLevel)} ${title}`);
      continue;
    }
    
    const cnHeading = line.match(/^([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (cnHeading) {
      lastHeadingLevel = 2;
      result.push(line);
      continue;
    }
    
    const numHeading = line.match(/^(\d{1,3})[、.．]\s*(.+)$/);
    if (numHeading) {
      const level = Math.min(6, Math.max(3, numHeading[1].length + 2));
      
      let correctedLevel = level;
      if (level > lastHeadingLevel + 1) {
        correctedLevel = lastHeadingLevel + 1;
      }
      
      lastHeadingLevel = correctedLevel;
      
      result.push(`${numHeading[1]}、${numHeading[2]}`);
      continue;
    }
    
    result.push(line);
  }
  
  return result.join("\n");
}

function renderOutline(source) {
  const outline = extractOutline(source);
  els.readerPanel.classList.toggle("has-outline", outline.length > 0);
  els.readerOutline.classList.toggle("hidden", outline.length === 0);
  els.readerOutline.innerHTML = outline.length
    ? `<p class="reader-outline-title">\u672c\u6587\u76ee\u5f55</p>${outline.map((item) => `<button class="level-${item.level}" data-heading="${escapeHtml(item.id)}" data-level="${item.level}" data-title="${escapeHtml(item.title)}" title="${escapeHtml(item.title)}">${escapeHtml(compactName(item.title, 22))}</button>`).join("")}`
    : "";
}

function inlineMarkdown(value, searchTerm = "") {
  let html = escapeHtml(value)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="auto-size-image" loading="lazy" />')
    .replace(/==([^=]+)==/g, "<mark>$1</mark>")
    .replace(/\+\+([^+]+)\+\+/g, "<u>$1</u>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  const styleToken = /\{(color|bg|size):(#[0-9a-fA-F]{6}|\d{1,2})\|([^{}]*)\}/g;
  for (let i = 0; i < 8; i += 1) {
    styleToken.lastIndex = 0;
    if (!styleToken.test(html)) break;
    styleToken.lastIndex = 0;
    html = html.replace(styleToken, (_, type, value, content) => {
      if (type === "color") return `<span style="color:${value}">${content}</span>`;
      if (type === "bg") return `<span style="background-color:${value};padding:0 3px;border-radius:3px">${content}</span>`;
      return `<span style="font-size:${value}px">${content}</span>`;
    });
  }

  if (searchTerm) {
    const safeTerm = escapeHtml(searchTerm).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(safeTerm, "i"), (match) => `<mark class="search-hit">${match}</mark>`);
  }

  return html
    .replace(/\[\[([^\]]+)\]\]/g, '<a href="#" data-doc-link="$1">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function renderMarkdown(source, options = {}) {
  const searchTerm = options.searchTerm || "";
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let h1Index = 0;
  let h2Index = 0;
  let inCode = false;
  let code = [];
  let list = null;
  let table = [];

  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${inlineMarkdown(item, searchTerm)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map((row) => row.split("|").map((cell) => cell.trim()).filter(Boolean));
    if (rows.length > 1) {
      const [head, , ...body] = rows;
      html.push(`<table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell, searchTerm)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell, searchTerm)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    }
    table = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushList();
      flushTable();
      if (inCode) {
        const raw = code.join("\n");
        html.push(`<div class="code-block"><button class="code-copy" type="button">\u590d\u5236</button><pre><code>${escapeHtml(raw)}</code></pre></div>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushList();
      flushTable();
      html.push("<hr />");
      continue;
    }
    if (/^\|.+\|$/.test(line)) {
      flushList();
      table.push(line);
      continue;
    }
    flushTable();
    const indentedHeading = line.match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (indentedHeading) {
      flushList();
      const indent = indentedHeading[1].length;
      const level = indentedHeading[2].length;
      const id = level === 1
        ? headingId(indentedHeading[3], h1Index++)
        : level === 2
          ? headingId(indentedHeading[3], `sub-${h2Index++}`)
          : "";
      const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
      const marginLeft = indent * 16;
      html.push(`<h${level}${idAttr} style="margin-left: ${marginLeft}px;">${inlineMarkdown(indentedHeading[3], searchTerm)}</h${level}>`);
      continue;
    }
    const cnHeading = line.match(/^([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (cnHeading) {
      flushList();
      const id = headingId(cnHeading[1], `auto-${h2Index++}`);
      html.push(`<h2 id="${escapeHtml(id)}">${inlineMarkdown(cnHeading[1], searchTerm)}</h2>`);
      continue;
    }
    const numHeading = line.match(/^(\d{1,3})[、.．]\s*([^-*].+)$/);
    if (numHeading) {
      const prevLine = i > 0 ? lines[i - 1] : "";
      const prevIsHeading = prevLine.match(/^(#{1,6})\s+(.+)$/) || prevLine.match(/^([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
      if (!prevIsHeading && numHeading[2].trim().length > 0) {
        flushList();
        const level = Math.min(6, Math.max(3, numHeading[1].length + 2));
        const id = headingId(numHeading[2], `num-${h2Index++}`);
        html.push(`<h${level} id="${escapeHtml(id)}">${inlineMarkdown(numHeading[1] + "、" + numHeading[2], searchTerm)}</h${level}>`);
        continue;
      }
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushList();
      html.push(`<blockquote>${inlineMarkdown(quote[1], searchTerm)}</blockquote>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((bullet || ordered)[1]);
      continue;
    }
    const indentedImage = line.match(/^(\s*)(!\[([^\]]*)\]\(([^)]+)\))/);
    if (indentedImage) {
      flushList();
      const indent = indentedImage[1].length;
      const marginLeft = indent * 16;
      const maxWidth = Math.max(50, 100 - indent * 10);
      const widthPercent = maxWidth < 100 ? `${maxWidth}%` : "100%";
      html.push(`<div style="margin-left: ${marginLeft}px; width: ${widthPercent};"><p>${inlineMarkdown(indentedImage[2], searchTerm)}</p></div>`);
      continue;
    }
    if (!line.trim()) {
      flushList();
      html.push("");
      continue;
    }
    flushList();
    html.push(`<p>${inlineMarkdown(line, searchTerm)}</p>`);
  }
  flushList();
  flushTable();
  if (inCode) {
    const raw = code.join("\n");
    html.push(`<div class="code-block"><button class="code-copy" type="button">\u590d\u5236</button><pre><code>${escapeHtml(raw)}</code></pre></div>`);
  }
  return html.join("\n");
}

function renderTree(nodes, container = els.tree) {
  container.innerHTML = "";
  for (const node of nodes) {
    if (node.type === "workspace") {
      const workspace = state.workspaces.find((ws) => ws.id === node.workspaceId) || { name: node.name, id: node.workspaceId };
      const panel = document.createElement("section");
      panel.className = `tree-workspace workspace-${node.workspaceId} ${state.activeWorkspaceId === node.workspaceId ? "active-workspace" : ""}`;
      panel.dataset.workspaceId = node.workspaceId;

      const head = document.createElement("div");
      head.className = "tree-workspace-head";
      head.innerHTML = `
        <span class="ws-dot" aria-hidden="true"></span>
        <strong class="ws-name" title="${escapeHtml(node.root || node.name)}">${escapeHtml(compactName(workspace.name || node.name, 28))}</strong>
        <span class="ws-meta" title="${escapeHtml(node.root || "")}">${escapeHtml(compactName(node.root || "", 36))}</span>
        <button class="ws-open-folder" title="在文件管理器中打开"></button>
      `;
      head.addEventListener("click", (e) => {
        if (e.target.closest(".ws-open-folder")) {
          if (node.root) {
            api.post("/api/open-folder", { path: node.root }).catch(() => showToast("无法打开文件夹"));
          }
          return;
        }
        state.activeWorkspaceId = node.workspaceId;
        state.selectedFolder = node.path;
        state.folderExplicit = false;
        state.multiSelected.clear();
        renderTree(state.tree);
      });

      const actions = document.createElement("div");
      actions.className = "ws-actions";
      const pasteBtn = document.createElement("button");
      pasteBtn.type = "button";
      pasteBtn.className = "ws-paste";
      pasteBtn.title = "粘贴到该工作路径根目录（先按 Ctrl+C 复制，再点击此处）";
      pasteBtn.textContent = "\u2199 \u7c98\u8d34";
      pasteBtn.addEventListener("click", async () => {
        if (!state.clipboardItems.length) return showToast("请先按 Ctrl+C 复制文件或文件夹");
        try {
          const copied = await api.post("/api/workspaces/paste", { source: state.clipboardItems, targetFolder: node.path });
          state.graphReady = false;
          await bootstrap(true);
          if (copied.type === "file" && copied.path) openDoc(copied.path);
          showToast(`已粘贴 ${state.clipboardItems.length} 项`);
        } catch (error) {
          showToast(error.message || "粘贴失败");
        }
      });
      actions.append(pasteBtn);
      head.append(actions);

      const children = document.createElement("div");
      children.className = "tree-workspace-body";
      children.addEventListener("dragover", (event) => {
        if (!state.dragItem || event.target.closest(".folder-title")) return;
        event.preventDefault();
        children.classList.add("drop-root");
        event.dataTransfer.dropEffect = "move";
      });
      children.addEventListener("dragleave", () => children.classList.remove("drop-root"));
      children.addEventListener("drop", async (event) => {
        if (!state.dragItem || event.target.closest(".folder-title")) return;
        event.preventDefault();
        children.classList.remove("drop-root");
        const moved = await api.post("/api/move", { source: state.dragItem.path, targetFolder: node.path });
        state.graphReady = false;
        await bootstrap(true);
        if (moved.type === "file" && moved.path) openDoc(moved.path);
        if (moved.type === "folder" && moved.path) {
          state.selectedFolder = moved.path;
          state.folderExplicit = true;
          renderTree(state.tree);
        }
      });

      const folders = node.children.filter((c) => c.type === "folder");
      const allFiles = [];
      function collectFiles(nodes) {
        for (const n of nodes) {
          if (n.type === "file") allFiles.push(n);
          if (n.children) collectFiles(n.children);
        }
      }
      collectFiles(node.children);
      const maxFiles = 10;
      const isExpanded = state.expandedWorkspaceRoots.has(node.workspaceId);
      const displayFiles = isExpanded ? allFiles : allFiles.slice(0, maxFiles);

      folders.forEach((folder) => renderTree([folder], children));

      for (const file of displayFiles) {
        const button = document.createElement("button");
        const isSelected = state.multiSelected.has(file.path) || state.currentPath === file.path;
        button.className = `file-item ${state.currentPath === file.path ? "active" : ""} ${state.multiSelected.has(file.path) ? "multi-selected" : ""}`;
        button.draggable = true;
        button.title = file.path + "（按住 Ctrl 点击可多选）";
        button.innerHTML = `<span class="file-icon">-</span><span>${escapeHtml(compactName(displayName(file)))}</span>`;
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          state.activeWorkspaceId = file.workspaceId;
          if (event && (event.ctrlKey || event.metaKey || event.shiftKey)) {
            if (state.multiSelected.has(file.path)) state.multiSelected.delete(file.path);
            else state.multiSelected.add(file.path);
            renderTree(state.tree);
          } else {
            state.multiSelected.clear();
            state.multiSelected.add(file.path);
            openDoc(file.path);
          }
        });
        button.addEventListener("dragstart", (event) => startTreeDrag(event, { type: "file", path: file.path }));
        button.addEventListener("dragend", endTreeDrag);
        children.append(button);
      }

      if (allFiles.length > maxFiles) {
        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "more-files-btn";
        moreBtn.textContent = isExpanded ? `收起 ${allFiles.length - maxFiles} 项` : `... 还有 ${allFiles.length - maxFiles} 项`;
        const workspaceId = node.workspaceId;
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (state.expandedWorkspaceRoots.has(workspaceId)) {
            state.expandedWorkspaceRoots.delete(workspaceId);
          } else {
            state.expandedWorkspaceRoots.add(workspaceId);
          }
          renderTree(state.tree);
        });
        children.append(moreBtn);
      }

      panel.append(head, children);
      container.append(panel);
      continue;
    }

    if (node.type === "folder") {
      const expanded = state.expandedFolders.has(node.path);
      const wrapper = document.createElement("div");
      wrapper.className = `tree-folder ${expanded ? "" : "collapsed"}`;
      const title = document.createElement("button");
      const isSelected = state.multiSelected.has(node.path) || state.selectedFolder === node.path;
      title.className = `folder-title ${isSelected ? "selected" : ""} ${state.multiSelected.has(node.path) ? "multi-selected" : ""}`;
      title.type = "button";
      title.draggable = true;
      title.title = node.path + "（按住 Ctrl 点击可多选）";
      title.innerHTML = `<span class="folder-icon">v</span><span>${escapeHtml(compactName(node.name))}</span>`;
      title.addEventListener("click", (event) => {
        event.stopPropagation();
        state.activeWorkspaceId = node.workspaceId;
        state.selectedFolder = node.path;
        state.folderExplicit = true;
        // Ctrl 点击 = 多选添加/移除，不触发展开收起（双击展开）
        if (event && (event.ctrlKey || event.metaKey || event.shiftKey)) {
          if (state.multiSelected.has(node.path)) state.multiSelected.delete(node.path);
          else state.multiSelected.add(node.path);
        } else {
          state.multiSelected.clear();
          state.multiSelected.add(node.path);
          if (state.expandedFolders.has(node.path)) state.expandedFolders.delete(node.path);
          else state.expandedFolders.add(node.path);
        }
        renderTree(state.tree);
      });
      title.addEventListener("dragstart", (event) => startTreeDrag(event, { type: "folder", path: node.path }));
      title.addEventListener("dragend", endTreeDrag);
      title.addEventListener("dragover", allowFolderDrop);
      title.addEventListener("dragleave", clearFolderDrop);
      title.addEventListener("drop", (event) => dropOnFolder(event, node.path));
      const children = document.createElement("div");
      children.className = "folder-children";
      renderTree(node.children, children);
      wrapper.append(title);
      wrapper.append(children);
      container.append(wrapper);
      continue;
    }

    const button = document.createElement("button");
    const isSelected = state.multiSelected.has(node.path) || state.currentPath === node.path;
    button.className = `file-item ${state.currentPath === node.path ? "active" : ""} ${state.multiSelected.has(node.path) ? "multi-selected" : ""}`;
    button.draggable = true;
    button.title = node.path + "（按住 Ctrl 点击可多选）";
    button.innerHTML = `<span class="file-icon">-</span><span>${escapeHtml(compactName(displayName(node)))}</span>`;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.activeWorkspaceId = node.workspaceId;
      if (event && (event.ctrlKey || event.metaKey || event.shiftKey)) {
        // 多选添加/移除，不打开文档
        if (state.multiSelected.has(node.path)) state.multiSelected.delete(node.path);
        else state.multiSelected.add(node.path);
        renderTree(state.tree);
      } else {
        state.multiSelected.clear();
        state.multiSelected.add(node.path);
        openDoc(node.path);
      }
    });
    button.addEventListener("dragstart", (event) => startTreeDrag(event, { type: "file", path: node.path }));
    button.addEventListener("dragend", endTreeDrag);
    container.append(button);
  }
}

function renderWorkspaceSummary() {
  const visible = state.workspaces.filter((ws) => ws.visible).slice(0, 2);
  const totalFiles = state.flatFiles.length;
  els.workspaceSummary.innerHTML = visible.length
    ? `<div class="ws-bar">${visible.map((ws, idx) => `<span class="ws-chip workspace-${ws.id}" title="${escapeHtml(ws.root || ws.name)}">${idx + 1}. ${escapeHtml(compactName(ws.name, 16))}</span>`).join("")}<span class="ws-total">\u2726 ${totalFiles || 0}</span></div>`
    : `<p class="muted">尚未加载工作路径</p>`;
}

function renderWorkspaceList(workspaces) {
  if (!workspaces || !workspaces.length) {
    els.workspaceList.innerHTML = `<p class="muted">暂无已注册的工作路径</p>`;
    return;
  }
  const sorted = [...workspaces].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  els.workspaceList.innerHTML = sorted.map((ws) => {
    const visible = ws.visible ? "active" : "";
    const mdOnlyChecked = ws.mdOnly !== false ? "checked" : "";
    return `
      <div class="workspace-item ${visible}" data-id="${escapeHtml(ws.id)}">
        <span class="ws-dot" aria-hidden="true"></span>
        <div class="workspace-meta">
          <strong class="workspace-name" title="${escapeHtml(ws.name)}">${escapeHtml(compactName(ws.name, 24))}</strong>
          <span class="workspace-path" title="${escapeHtml(ws.root)}">${escapeHtml(compactName(ws.root, 48))}</span>
          <label class="ws-mdonly-toggle" title="是否仅显示 .md 文件">
            <input type="checkbox" data-action="mdonly" data-id="${escapeHtml(ws.id)}" ${mdOnlyChecked}>
            <span>仅显示 md</span>
          </label>
        </div>
        <div class="workspace-actions">
          <button type="button" class="ws-toggle" data-action="toggle" data-id="${escapeHtml(ws.id)}">${ws.visible ? "\u2713 \u663e\u793a\u4e2d" : "\u25cb \u663e\u793a"}</button>
          <button type="button" class="ws-rename" data-action="rename" data-id="${escapeHtml(ws.id)}" title="重命名">&#9998;</button>
          <button type="button" class="ws-remove danger" data-action="remove" data-id="${escapeHtml(ws.id)}" title="移除记录" ${ws.builtin ? 'disabled style="opacity:.3;cursor:not-allowed"' : ""}>&times;</button>
        </div>
      </div>
    `;
  }).join("");

  els.workspaceList.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      try {
        if (action === "toggle") {
          const target = state.workspaces.find((ws) => ws.id === id);
          await api.post("/api/workspaces/show", { id, visible: !target?.visible });
          state.graphReady = false;
          await bootstrap(true);
          openWorkspaceModal();
        } else if (action === "remove") {
          const target = state.workspaces.find((ws) => ws.id === id);
          if (!target || target.builtin) return;
          const ok = confirm(`确认移除工作路径「${target.name}」？\n（仅移除记录，不会删除磁盘文件）`);
          if (!ok) return;
          await api.post("/api/workspaces/remove", { id });
          state.graphReady = false;
          await bootstrap(true);
          openWorkspaceModal();
        } else if (action === "rename") {
          const target = state.workspaces.find((ws) => ws.id === id);
          if (!target) return;
          const newName = prompt("输入新的工作路径名称", target.name);
          if (!newName || newName === target.name) return;
          await api.post("/api/workspaces/rename", { id, name: newName });
          await bootstrap(true);
          openWorkspaceModal();
        } else if (action === "mdonly") {
          const target = state.workspaces.find((ws) => ws.id === id);
          if (!target) return;
          await api.post("/api/workspaces/set-md-only", { id, mdOnly: btn.checked !== false });
          state.graphReady = false;
          await bootstrap(true);
          openWorkspaceModal();
        }
      } catch (error) {
        showToast(error.message || "操作失败");
      }
    });
  });
}

async function openWorkspaceModal() {
  const data = await api.get("/api/workspaces");
  state.workspaces = data.workspaces || [];
  if (data.defaultWorkspaceId) state.defaultWorkspaceId = data.defaultWorkspaceId;
  renderWorkspaceList(state.workspaces);
  els.workspacePath.value = "";
  if (els.workspaceName) els.workspaceName.value = "";
  els.workspaceModal.classList.remove("hidden");
  els.workspacePath.focus();
}

// === 内嵌文件浏览器 ===
async function openFileBrowser(startPath) {
  if (!els.fileBrowser) return;
  els.fileBrowser.hidden = false;
  // 加载侧边栏常用路径
  if (!els.browserFavorites.dataset.loaded) {
    try {
      const data = await api.get("/api/browse-directory?action=roots");
      renderQuickJumps(data.favorites || [], data.roots || []);
      els.browserFavorites.dataset.loaded = "1";
    } catch {}
  }
  const path = startPath || els.workspacePath.value || "";
  await browseDirectory(path);
}

function closeFileBrowser() {
  if (els.fileBrowser) els.fileBrowser.hidden = true;
  clearQuickMatch();
}

// === 键盘首字母快速匹配 ===
let quickMatchText = "";
let quickMatchTimer = null;
let quickMatchActive = false;
let quickMatchLastIdx = 0;

function clearQuickMatch() {
  quickMatchText = "";
  quickMatchLastIdx = 0;
  if (quickMatchTimer) {
    clearTimeout(quickMatchTimer);
    quickMatchTimer = null;
  }
  if (els.browserSearchHint) {
    els.browserSearchHint.classList.add("hidden");
    const span = els.browserSearchHint.querySelector("span");
    if (span) span.textContent = "";
  }
  document.querySelectorAll(".folder-row.quick-match").forEach((row) => {
    row.classList.remove("quick-match");
  });
}

function showQuickMatch(text) {
  if (!els.browserSearchHint) return;
  els.browserSearchHint.classList.remove("hidden");
  const span = els.browserSearchHint.querySelector("span");
  if (span) span.textContent = text;
  if (quickMatchTimer) clearTimeout(quickMatchTimer);
  quickMatchTimer = setTimeout(() => {
    els.browserSearchHint.classList.add("hidden");
    quickMatchText = "";
  }, 2000);
}

function findAndHighlightFolder(text) {
  if (!els.browserGrid || !text) return;
  const rows = els.browserGrid.querySelectorAll(".folder-row");
  if (!rows.length) return;
  const query = text.toLowerCase();
  // 先找完全以查询开头的文件夹；如果没有匹配，找包含查询的
  let matchIdx = -1;
  let fallbackIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const name = rows[i].querySelector(".folder-row-name")?.textContent || "";
    const lname = name.toLowerCase();
    if (lname.startsWith(query)) {
      matchIdx = i;
      break;
    }
    if (fallbackIdx === -1 && lname.indexOf(query) !== -1) {
      fallbackIdx = i;
    }
  }
  const idx = matchIdx !== -1 ? matchIdx : fallbackIdx;
  if (idx === -1) return false;
  document.querySelectorAll(".folder-row.quick-match").forEach((row) => {
    row.classList.remove("quick-match");
  });
  const matched = rows[idx];
  matched.classList.add("quick-match");
  matched.scrollIntoView({ behavior: "smooth", block: "center" });
  quickMatchLastIdx = idx;
  return true;
}

function handleFileBrowserKeydown(e) {
  if (!els.fileBrowser || els.fileBrowser.hidden) return;
  // 跳过正在输入路径/名称的输入框
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;

  if (e.key === "Escape") {
    clearQuickMatch();
    return;
  }
  if (e.key === "Backspace" && quickMatchText.length > 0) {
    quickMatchText = quickMatchText.slice(0, -1);
    showQuickMatch(quickMatchText);
    if (quickMatchText) findAndHighlightFolder(quickMatchText);
    e.preventDefault();
    return;
  }
  // 单字母/数字/部分符号键
  const key = e.key;
  if (key.length === 1) {
    // 如果距离上次输入超过 500ms，重置（从新字母开始）
    if (!quickMatchTimer) quickMatchText = "";
    quickMatchText += key;
    showQuickMatch(quickMatchText);
    findAndHighlightFolder(quickMatchText);
    e.preventDefault();
  }
}

function renderQuickJumps(favorites, roots) {
  if (!els.browserFavorites) return;
  els.browserFavorites.innerHTML = favorites
    .map((f) => `<button type="button" class="jump-btn" data-path="${escapeHtml(f.value)}">&#128193; ${escapeHtml(f.label)}</button>`)
    .join("");
  els.browserFavorites.querySelectorAll(".jump-btn").forEach((btn) => {
    btn.addEventListener("click", () => browseDirectory(btn.dataset.path));
  });
  if (roots && roots.length) {
    if (els.browserRootsGroup) els.browserRootsGroup.style.display = "";
    els.browserRoots.innerHTML = roots
      .map((r) => `<button type="button" class="jump-btn jump-btn-drive" data-path="${escapeHtml(r.value)}">&#128186; ${escapeHtml(r.label)}</button>`)
      .join("");
    els.browserRoots.querySelectorAll(".jump-btn").forEach((btn) => {
      btn.addEventListener("click", () => browseDirectory(btn.dataset.path));
    });
  }
}

async function browseDirectory(targetPath) {
  if (!els.browserGrid) return;
  try {
    const data = await api.post("/api/browse-directory", { path: targetPath || "", action: "list" });
    renderBrowserContent(data);
  } catch (e) {
    els.browserGrid.innerHTML = `<div class="browser-error">无法访问：${escapeHtml(e.message || "未知错误")}</div>`;
  }
}

function renderBrowserContent(data) {
  // 顶部：完整绝对路径（最显眼的位置）
  if (els.browserFullPath) {
    els.browserFullPath.textContent = data.current || "";
    els.browserFullPath.title = data.current || "";
  }
  // 面包屑（路径层级
  if (els.browserBreadcrumbs) {
    const crumbs = data.breadcrumbs || [];
    els.browserBreadcrumbs.innerHTML = crumbs
      .map((c) => `<button type="button" class="crumb" data-path="${escapeHtml(c.path)}">${escapeHtml(c.name || c.path)}</button>`)
      .join('<span class="crumb-sep">›</span>');
    els.browserBreadcrumbs.querySelectorAll(".crumb").forEach((btn) => {
      btn.addEventListener("click", () => browseDirectory(btn.dataset.path));
    });
  }
  // 上一级按钮
  if (els.browserUpBtn) {
    if (data.parent) {
      els.browserUpBtn.disabled = false;
      els.browserUpBtn.onclick = () => browseDirectory(data.parent);
    } else {
      els.browserUpBtn.disabled = true;
      els.browserUpBtn.onclick = null;
    }
  }
  // 文件夹列表（列表视图）：每行显示文件夹名 + 完整绝对路径
  const items = data.items || [];
  if (items.length === 0) {
    els.browserGrid.innerHTML = "";
    els.browserEmpty.classList.remove("hidden");
  } else {
    els.browserEmpty.classList.add("hidden");
    els.browserGrid.innerHTML = items
      .map((it) => `
        <button type="button" class="folder-row" data-path="${escapeHtml(it.path)}">
          <span class="folder-row-icon">&#128193;</span>
          <span class="folder-row-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
          <span class="folder-row-path" title="${escapeHtml(it.path)}">${escapeHtml(it.path)}</span>
        </button>
      `)
      .join("");
    els.browserGrid.querySelectorAll(".folder-row").forEach((row) => {
      row.addEventListener("click", () => browseDirectory(row.dataset.path));
    });
  }
  // 页脚：当前路径（再次显示 + 选择按钮
  if (els.browserCurrent) els.browserCurrent.textContent = data.current || "";
  if (els.browserSelectBtn) {
    els.browserSelectBtn.onclick = () => {
      els.workspacePath.value = data.current || "";
      if (els.workspaceName && !els.workspaceName.value) {
        const baseName = data.breadcrumbs && data.breadcrumbs.length > 0 ? data.breadcrumbs[data.breadcrumbs.length - 1].name : "";
        if (baseName && baseName.length <= 20) els.workspaceName.value = baseName;
      }
      closeFileBrowser();
      showToast("已选择路径，可点击「添加并显示」加入工作路径");
    };
  }
}

function closeWorkspaceModal() {
  els.workspaceModal.classList.add("hidden");
  closeFileBrowser();
}

function startTreeDrag(event, item) {
  state.dragItem = item;
  event.currentTarget.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/json", JSON.stringify(item));
  event.dataTransfer.setData("text/plain", item.path);
}

function endTreeDrag(event) {
  event.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  state.dragItem = null;
}

function allowFolderDrop(event) {
  if (!state.dragItem) return;
  event.preventDefault();
  event.currentTarget.classList.add("drop-target");
  event.dataTransfer.dropEffect = "move";
}

function clearFolderDrop(event) {
  event.currentTarget.classList.remove("drop-target");
}

async function dropOnFolder(event, targetFolder) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove("drop-target");
  const item = state.dragItem || JSON.parse(event.dataTransfer.getData("application/json") || "null");
  if (!item || item.path === targetFolder) return;
  const moved = await api.post("/api/move", { source: item.path, targetFolder });
  state.graphReady = false;
  await bootstrap(true);
  if (moved.type === "file" && moved.path) await openDoc(moved.path);
  if (moved.type === "folder" && moved.path) {
    state.selectedFolder = moved.path;
    state.folderExplicit = true;
    renderTree(state.tree);
  }
}

function allowRootDrop(event) {
  if (!state.dragItem || event.target.closest(".folder-title")) return;
  event.preventDefault();
  els.tree.classList.add("drop-root");
  event.dataTransfer.dropEffect = "move";
}

function clearRootDrop() {
  els.tree.classList.remove("drop-root");
}

async function dropOnRoot(event) {
  if (!state.dragItem || event.target.closest(".folder-title")) return;
  event.preventDefault();
  clearRootDrop();
  const moved = await api.post("/api/move", { source: state.dragItem.path, targetFolder: "" });
  state.graphReady = false;
  await bootstrap(true);
  if (moved.type === "file" && moved.path) await openDoc(moved.path);
  if (moved.type === "folder" && moved.path) {
    state.selectedFolder = moved.path;
    state.folderExplicit = true;
    renderTree(state.tree);
  }
}

function flatten(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === "file") out.push(node);
    if (node.children) flatten(node.children, out);
  }
  return out;
}

function setMode(mode) {
  if (state.mode === mode) return;
  if (state.mode === "view" && mode === "edit") {
    const readerMax = Math.max(1, els.markdownView.scrollHeight - els.markdownView.clientHeight);
    state.readerScrollRatio = readerMax > 0 ? els.markdownView.scrollTop / readerMax : 0;
  }
  state.mode = mode;
  els.readerPanel.classList.toggle("hidden", mode !== "view");
  els.editorPanel.classList.toggle("hidden", mode !== "edit");
  els.graphPanel.classList.toggle("hidden", mode !== "graph");
  els.saveBtn.classList.toggle("hidden", mode !== "edit" || !state.currentPath);
  els.formatBtn.classList.toggle("hidden", mode !== "edit" || !state.currentPath);
  els.viewBtn.classList.toggle("active", mode === "view");
  els.editBtn.classList.toggle("active", mode === "edit");
  els.graphBtn.classList.toggle("active", mode === "graph");
  if (mode === "edit") {
    syncPreviewToEditor();
    requestAnimationFrame(() => {
      const editorMax = Math.max(1, els.editor.scrollHeight - els.editor.clientHeight);
      els.editor.scrollTop = Math.round(editorMax * (state.readerScrollRatio || 0));
    });
  }
  if (mode === "graph") requestAnimationFrame(() => initGraph());
}

function resetUndo(content) {
  state.undo.stack = [content];
  state.undo.index = 0;
  state.undo.applying = false;
}

function recordUndo(value) {
  if (state.undo.applying) return;
  if (state.undo.stack[state.undo.index] === value) return;
  state.undo.stack = state.undo.stack.slice(0, state.undo.index + 1);
  state.undo.stack.push(value);
  if (state.undo.stack.length > 80) state.undo.stack.shift();
  state.undo.index = state.undo.stack.length - 1;
}

function applyEditorValue(value) {
  state.undo.applying = true;
  els.editor.value = value;
  state.currentContent = value;
  els.preview.innerHTML = renderMarkdown(value);
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
  state.undo.applying = false;
}

function undoEditor() {
  if (state.undo.index <= 0) return;
  state.undo.index -= 1;
  applyEditorValue(state.undo.stack[state.undo.index]);
}

function redoEditor() {
  if (state.undo.index >= state.undo.stack.length - 1) return;
  state.undo.index += 1;
  applyEditorValue(state.undo.stack[state.undo.index]);
}

function scrollReaderToElement(target, behavior = "auto") {
  if (!target) return;
  const containerRect = els.markdownView.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = els.markdownView.scrollTop + targetRect.top - containerRect.top - 14;
  els.markdownView.scrollTo({ top: Math.max(0, top), behavior });
}

async function openDoc(docPath, options = {}) {
  const seq = ++state.openSeq;
  const doc = await api.get(`/api/doc?path=${encodeURIComponent(docPath)}`);
  if (seq !== state.openSeq) return;

  const item = state.flatFiles.find((file) => file.path === doc.path) || doc;
  state.currentPath = doc.path;
  state.currentContent = doc.content;
  state.lastSavedContent = doc.content;
  state.selectedNode = doc.path;
  state.selectedFolder = doc.path.includes("/") ? doc.path.split("/").slice(0, -1).join("/") : "";
  state.folderExplicit = false;
  els.docPath.textContent = displayPath(doc.path);
  els.docPath.title = doc.path;
  els.docTitle.textContent = displayName(item);
  els.docTitle.title = doc.title || displayName(item);
  els.markdownView.classList.remove("empty-state");
  els.markdownView.innerHTML = renderMarkdown(doc.content, { searchTerm: options.searchTerm || "" });
  renderOutline(doc.content);
  els.editor.value = doc.content;
  els.preview.innerHTML = renderMarkdown(doc.content);
  els.editor.scrollTop = 0;
  els.preview.scrollTop = 0;
  state.syncPreviewScroll.ratio = 0;
  resetUndo(doc.content);
  setSaveStatus("\u4fdd\u5b58", false);
  renderTree(state.tree);
  if (state.mode === "graph") drawGraph();
  if (options.searchTerm) {
    requestAnimationFrame(() => scrollReaderToElement(els.markdownView.querySelector(".search-hit"), "auto"));
  }
  addRecentDoc(doc.path);
}

function debounce(fn, wait = 180) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function setSaveStatus(label, active = false) {
  els.saveBtn.textContent = label;
  els.saveBtn.classList.toggle("active", active);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setSidebarWidth(width) {
  const max = Math.max(360, Math.floor(window.innerWidth * 0.52));
  const next = clamp(Math.round(width), 240, max);
  document.documentElement.style.setProperty("--sidebar-width", `${next}px`);
  localStorage.setItem("docSidebarWidth", String(next));
}

function restoreSidebarWidth() {
  const saved = Number(localStorage.getItem("docSidebarWidth"));
  if (Number.isFinite(saved) && saved > 0) setSidebarWidth(saved);
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = collapsed;
  els.appShell.classList.toggle("sidebar-collapsed", collapsed);
  els.sidebarShowBtn.classList.toggle("active", !collapsed);
  els.sidebarShowBtn.textContent = collapsed ? "\u663e\u793a\u76ee\u5f55" : "\u76ee\u5f55";
  localStorage.setItem("docSidebarCollapsed", collapsed ? "1" : "0");
  if (collapsed) {
    clearRootDrop();
    endSidebarResize({ pointerId: state.sidebarResize?.pointerId });
  }
  if (state.mode === "graph") requestAnimationFrame(() => {
    resizeCanvas();
    drawGraph();
  });
}

function restoreSidebarCollapsed() {
  setSidebarCollapsed(localStorage.getItem("docSidebarCollapsed") === "1");
}

function startSidebarResize(event) {
  if (state.sidebarCollapsed || window.matchMedia("(max-width: 860px)").matches) return;
  state.sidebarResize = { pointerId: event.pointerId };
  els.sidebarResizer.classList.add("dragging");
  document.body.classList.add("resizing-sidebar");
  els.sidebarResizer.setPointerCapture?.(event.pointerId);
  setSidebarWidth(event.clientX);
}

function moveSidebarResize(event) {
  if (!state.sidebarResize) return;
  event.preventDefault();
  setSidebarWidth(event.clientX);
}

function endSidebarResize(event) {
  if (!state.sidebarResize) return;
  state.sidebarResize = null;
  els.sidebarResizer.classList.remove("dragging");
  document.body.classList.remove("resizing-sidebar");
  try {
    if (event?.pointerId !== undefined) els.sidebarResizer.releasePointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture can already be released when hiding the sidebar.
  }
}

function syncPreviewToEditor() {
  if (state.mode !== "edit") return;
  cancelAnimationFrame(state.syncPreviewScroll.frame);
  state.syncPreviewScroll.frame = requestAnimationFrame(() => {
    const editorMax = Math.max(1, els.editor.scrollHeight - els.editor.clientHeight);
    const previewMax = Math.max(0, els.preview.scrollHeight - els.preview.clientHeight);
    const ratio = clamp(els.editor.scrollTop / editorMax, 0, 1);
    state.syncPreviewScroll.ratio = ratio;
    els.preview.scrollTop = Math.round(previewMax * ratio);
  });
}

const updatePreview = debounce(() => {
  els.preview.innerHTML = renderMarkdown(state.currentContent);
  syncPreviewToEditor();
}, 80);

async function saveCurrentDoc({ refreshTree = false } = {}) {
  if (!state.currentPath) return false;
  const content = els.editor.value;
  if (!refreshTree && content === state.lastSavedContent) return true;
  const seq = ++state.saveSeq;
  setSaveStatus("\u4fdd\u5b58\u4e2d", true);
  try {
    await api.post("/api/save", { path: state.currentPath, content });
  } catch (e) {
    const errorMessage = e?.response?.data?.error || e?.message || "保存失败";
    setSaveStatus("保存失败", false);
    showToast(errorMessage);
    return false;
  }
  if (seq !== state.saveSeq) return true;
  state.currentContent = content;
  state.lastSavedContent = content;
  els.markdownView.innerHTML = renderMarkdown(content);
  renderOutline(content);
  state.graphReady = false;
  setSaveStatus(refreshTree ? "\u5df2\u4fdd\u5b58" : "\u5df2\u81ea\u52a8\u4fdd\u5b58", false);
  if (refreshTree) {
    const path = state.currentPath;
    await bootstrap(true);
    await openDoc(path);
    setMode("edit");
  }
  return true;
}

const autoSaveCurrentDoc = debounce(async () => {
  if (state.mode !== "edit" || !state.currentPath) return;
  try {
    await saveCurrentDoc();
  } catch (error) {
    setSaveStatus("\u4fdd\u5b58\u5931\u8d25", true);
    console.error(error);
  }
}, 900);

async function normalizeAllToMarkdown() {
  els.normalizeProgress.classList.remove("hidden");
  els.normalizeStatus.textContent = "\u6b63\u5728\u626b\u63cf docs \u76ee\u5f55...";
  els.normalizeMdBtn.disabled = true;
  try {
    const result = await api.post("/api/normalize-md", {});
    await bootstrap(true);
    state.graphReady = false;
    els.normalizeStatus.textContent = result.changed
      ? `\u5df2\u5904\u7406 ${result.changed} \u4e2a\u6587\u4ef6`
      : "\u6ca1\u6709\u9700\u8981\u8f6c\u6362\u7684\u6587\u4ef6";
  } catch (error) {
    els.normalizeStatus.textContent = error.message || "\u5904\u7406\u5931\u8d25";
  } finally {
    els.normalizeProgress.classList.add("hidden");
    els.normalizeMdBtn.disabled = false;
  }
}

async function runSearch() {
  const seq = ++state.searchSeq;
  const query = els.searchInput.value.trim();
  els.searchResults.classList.toggle("hidden", !query);
  if (!query) {
    els.searchResults.innerHTML = "";
    return;
  }
  const { results } = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
  if (seq !== state.searchSeq) return;
  els.searchResults.innerHTML = results.length
    ? results.map((item) => {
        const file = state.flatFiles.find((entry) => entry.path === item.path) || item;
        return `<button class="search-item" data-path="${escapeHtml(item.path)}" data-query="${escapeHtml(query)}"><strong>${escapeHtml(displayName(file))}</strong><span>${escapeHtml(item.snippet || item.path)}</span></button>`;
      }).join("")
    : `<div class="search-item"><strong>${text.emptyResult}</strong><span>${text.retryKeyword}</span></div>`;
}

function currentParent() {
  if (state.selectedFolder) return state.selectedFolder;
  if (!state.currentPath || !state.currentPath.includes("/")) return "";
  const parts = state.currentPath.split("/");
  return parts.slice(0, -1).join("/");
}

function openCreateModal(mode) {
  state.createMode = mode;
  els.createTitle.textContent = mode === "folder" ? text.newFolder : text.newDoc;
  els.createName.value = "";

  const visible = state.workspaces.filter((ws) => ws.visible).slice(0, 2);
  const parent = currentParent();
  const active = state.activeWorkspaceId && visible.find((ws) => ws.id === state.activeWorkspaceId);
  const targetWorkspaceId = active
    ? active.id
    : (parent
      ? (splitWorkspaceRef(parent).id || state.defaultWorkspaceId)
      : state.defaultWorkspaceId);
  const defaultName = visible.find((ws) => ws.id === targetWorkspaceId)?.name
    || visible[0]?.name
    || "默认 docs";

  if (visible.length <= 1) {
    els.createSummary.textContent = parent
      ? `保存到 ${defaultName} / ${parent.replace(/^.*?:/, "") || "根目录"}`
      : `保存到 ${defaultName} 根目录`;
    els.createWorkspaceRow.classList.add("hidden");
  } else {
    els.createSummary.textContent = parent ? "在以下工作路径创建" : "选择创建位置";
    els.createWorkspaceRow.classList.remove("hidden");
    els.createWorkspaceChoices.innerHTML = visible
      .map((ws) => `<button type="button" data-id="${escapeHtml(ws.id)}" class="${ws.id === targetWorkspaceId ? "active" : ""}">${escapeHtml(compactName(ws.name, 26))}</button>`)
      .join("");
    els.createWorkspaceChoices.dataset.selected = targetWorkspaceId;
    els.createWorkspaceChoices.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        els.createWorkspaceChoices.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        els.createWorkspaceChoices.dataset.selected = button.dataset.id;
      });
    });
  }

  els.createModal.classList.remove("hidden");
  els.createName.focus();
}

function closeCreateModal() {
  els.createModal.classList.add("hidden");
}

async function submitCreate(event) {
  event.preventDefault();
  const name = els.createName.value.trim();
  if (!name) return;

  const visible = state.workspaces.filter((ws) => ws.visible).slice(0, 2);
  let parent = currentParent();

  // 如果没有选中文件夹，但有 activeWorkspaceId，则使用 activeWorkspaceId 作为根路径
  if (!parent && state.activeWorkspaceId && visible.find((ws) => ws.id === state.activeWorkspaceId)) {
    parent = `${state.activeWorkspaceId}:`;
  }

  // 如果仍然没有 parent，使用默认工作区或下拉选择的工作区
  if (!parent) {
    const selectedWorkspaceId = visible.length > 1 ? els.createWorkspaceChoices.dataset.selected : state.defaultWorkspaceId;
    parent = `${selectedWorkspaceId || state.defaultWorkspaceId}:`;
  }

  try {
    const endpoint = state.createMode === "folder" ? "/api/create-folder" : "/api/create-doc";
    const created = await api.post(endpoint, { parent, name });
    await bootstrap(true);
    if (state.createMode === "doc" && created.path) await openDoc(created.path);
    if (state.createMode === "folder" && created.path) {
      state.selectedFolder = created.path;
      state.folderExplicit = true;
      state.collapsedFolders.delete(created.path);
      renderTree(state.tree);
    }
    closeCreateModal();
  } catch (error) {
    let message = error.message || "创建失败";
    try {
      const parsed = JSON.parse(message);
      message = parsed.error || message;
    } catch (ignored) {}
    // 中文友好提示
    if (message.includes("already exists") || message.includes("already")) {
      message = state.createMode === "folder" ? "同名文件夹已存在" : "同名文档已存在";
    } else if (message.includes("Workspace not found")) {
      message = "工作路径未找到，请先添加";
    } else if (message.includes("EPERM") || message.includes("EACCES")) {
      message = "没有写入权限，请检查工作路径的访问权限";
    }
    showToast(message);
  }
}

function selectedDeletePath() {
  return state.folderExplicit ? state.selectedFolder : state.currentPath || state.selectedFolder;
}

async function deleteSelected() {
  const target = selectedDeletePath();
  if (!target) return;
  state.deleteTarget = target;
  els.deleteTarget.textContent = target;
  els.deleteModal.classList.remove("hidden");
}

function closeDeleteModal() {
  state.deleteTarget = "";
  els.deleteModal.classList.add("hidden");
}

async function confirmDeleteSelected() {
  const target = state.deleteTarget;
  if (!target) return;
  const paths = target.includes("|") ? target.split("|") : [target];
  try {
    await api.post("/api/delete", { path: paths.length > 1 ? paths : paths[0] });
    state.currentPath = "";
    state.currentContent = "";
    state.selectedNode = "";
    paths.forEach((p) => {
      if (state.selectedFolder === p || p.startsWith(`${state.selectedFolder}/`)) state.selectedFolder = "";
      state.multiSelected.delete(p);
    });
    state.folderExplicit = false;
    els.docPath.textContent = "docs";
    els.docTitle.textContent = "\u9009\u62e9\u4e00\u7bc7 Markdown \u6587\u6863";
    els.markdownView.classList.add("empty-state");
    els.markdownView.innerHTML = "<h2>\u6253\u5f00\u5de6\u4fa7\u76ee\u5f55\u4e2d\u7684\u6587\u6863</h2><p>\u652f\u6301\u6587\u4ef6\u5939\u5206\u7c7b\u3001\u5168\u6587\u641c\u7d22\u3001\u6587\u6863\u5207\u6362\u3001\u7f16\u8f91\u4fdd\u5b58\u548c\u5173\u8054\u56fe\u8c31\u6d4f\u89c8\u3002</p>";
    renderOutline("");
    els.editor.value = "";
    els.preview.innerHTML = "";
    resetUndo("");
    state.graphReady = false;
    await bootstrap(true);
    setMode("view");
    closeDeleteModal();
    showToast(`已删除 ${paths.length} 项`);
  } catch (error) {
    let message = error.message || "删除失败";
    try {
      const parsed = JSON.parse(message);
      message = parsed.error || message;
    } catch (ignored) {}
    if (message.includes("not found") || message.includes("Target not found")) message = "目标文件不存在";
    showToast(message);
    closeDeleteModal();
  }
}

function closeSearchWhenIdle(event) {
  if (event.target.closest(".search-box") || event.target.closest("#searchResults")) return;
  els.searchResults.classList.add("hidden");
}

function resizeCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  els.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  els.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  els.canvas.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
}

async function initGraph(force = false) {
  if (!state.graphReady || force) {
    const graph = await api.get("/api/graph");
    state.graph = layoutGraph(graph);
    state.graphReady = true;
  }
  resizeCanvas();
  drawGraph();
}

function layoutGraph(graph) {
  const nodes = graph.nodes.map((node) => ({
    ...node,
    label: node.kind === "keyword" ? node.label : node.id.split("/").pop(),
  }));
  const groups = [...new Set(nodes.map((node) => node.group || "docs"))];
  const byGroup = new Map(groups.map((group) => [group, []]));
  for (const node of nodes) byGroup.get(node.group || "docs").push(node);

  const centerX = 520;
  const centerY = 340;
  const groupRadius = Math.max(180, groups.length * 48);
  groups.forEach((group, groupIndex) => {
    const bucket = byGroup.get(group);
    const groupAngle = (Math.PI * 2 * groupIndex) / Math.max(1, groups.length);
    const gx = centerX + Math.cos(groupAngle) * groupRadius;
    const gy = centerY + Math.sin(groupAngle) * groupRadius;
    const localRadius = Math.max(42, bucket.length * 12);
    bucket.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, bucket.length);
      node.x = gx + Math.cos(angle) * localRadius;
      node.y = gy + Math.sin(angle) * localRadius;
    });
  });

  const usefulEdges = graph.edges
    .filter((edge) => edge.type === "keyword" || edge.type !== "semantic" || edge.weight >= 4)
    .sort((a, b) => {
      const order = { link: 0, tag: 1, semantic: 2 };
      return (order[a.type] ?? 9) - (order[b.type] ?? 9) || b.weight - a.weight;
    })
    .slice(0, Math.max(80, nodes.length * 4));

  return { nodes, edges: usefulEdges };
}

function graphTransform(rect, nodes) {
  const minX = Math.min(...nodes.map((n) => n.x));
  const maxX = Math.max(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxY = Math.max(...nodes.map((n) => n.y));
  const scale = Math.min((rect.width - 90) / Math.max(1, maxX - minX), (rect.height - 90) / Math.max(1, maxY - minY), 1.35);
  return {
    scale,
    tx: (rect.width - (minX + maxX) * scale) / 2,
    ty: (rect.height - (minY + maxY) * scale) / 2,
  };
}

function graphPoint(node) {
  const rect = els.canvas.getBoundingClientRect();
  const { scale, tx, ty } = graphTransform(rect, state.graph.nodes || []);
  return { x: node.x * scale + tx, y: node.y * scale + ty };
}

function screenToGraph(clientX, clientY) {
  const rect = els.canvas.getBoundingClientRect();
  const { scale, tx, ty } = graphTransform(rect, state.graph.nodes || []);
  return {
    x: (clientX - rect.left - tx) / scale,
    y: (clientY - rect.top - ty) / scale,
  };
}

function drawGraph() {
  if (state.mode !== "graph") return;
  const ctx = els.canvas.getContext("2d");
  const rect = els.canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  const nodes = state.graph.nodes || [];
  if (!nodes.length) {
    ctx.fillStyle = "#667085";
    ctx.fillText(text.noGraph, 24, 32);
    return;
  }

  const { scale, tx, ty } = graphTransform(rect, nodes);
  const point = (node) => ({ x: node.x * scale + tx, y: node.y * scale + ty });
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const edge of state.graph.edges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;
    const pa = point(a);
    const pb = point(b);
    ctx.strokeStyle = edge.type === "link" ? "#0f766e" : edge.type === "tag" ? "#b45309" : edge.type === "keyword" ? "#6941c6" : "#98a2b3";
    ctx.globalAlpha = edge.type === "semantic" ? 0.22 : edge.type === "keyword" ? 0.42 : 0.58;
    ctx.lineWidth = Math.min(3, 0.8 + edge.weight * 0.2);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  for (const node of nodes) {
    const p = point(node);
    const active = node.id === state.selectedNode;
    const keyword = node.kind === "keyword";
    ctx.fillStyle = active ? "#0f766e" : keyword ? "#f4efff" : "#ffffff";
    ctx.strokeStyle = active ? "#115e59" : keyword ? "#6941c6" : "#98a2b3";
    ctx.lineWidth = active ? 3 : 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, active ? 13 : keyword ? 8 : 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = active ? "#115e59" : keyword ? "#53389e" : "#1d2430";
    ctx.font = active ? "700 13px Segoe UI" : keyword ? "700 11px Segoe UI" : "12px Segoe UI";
    ctx.fillText(node.label, p.x + 15, p.y + 4);
  }
}

function hitGraph(event) {
  const nodes = state.graph.nodes || [];
  if (!nodes.length) return null;
  const rect = els.canvas.getBoundingClientRect();
  const { scale, tx, ty } = graphTransform(rect, nodes);
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return nodes.find((node) => Math.hypot(node.x * scale + tx - x, node.y * scale + ty - y) < 18);
}

function insertAtCursor(value) {
  const start = els.editor.selectionStart ?? els.editor.value.length;
  const end = els.editor.selectionEnd ?? start;
  els.editor.value = `${els.editor.value.slice(0, start)}${value}${els.editor.value.slice(end)}`;
  const next = start + value.length;
  els.editor.selectionStart = next;
  els.editor.selectionEnd = next;
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

const chineseDigits = ["", "\u4e00", "\u4e8c", "\u4e09", "\u56db", "\u4e94", "\u516d", "\u4e03", "\u516b", "\u4e5d"];

function nextChineseNumber(value) {
  const map = new Map([["\u4e00", 1], ["\u4e8c", 2], ["\u4e09", 3], ["\u56db", 4], ["\u4e94", 5], ["\u516d", 6], ["\u4e03", 7], ["\u516b", 8], ["\u4e5d", 9], ["\u5341", 10]]);
  let number = map.get(value);
  if (!number) {
    const tenParts = value.split("\u5341");
    if (tenParts.length === 2) {
      const tens = tenParts[0] ? map.get(tenParts[0]) || 0 : 1;
      const ones = tenParts[1] ? map.get(tenParts[1]) || 0 : 0;
      number = tens * 10 + ones;
    }
  }
  if (!number || number >= 99) return null;
  const next = number + 1;
  if (next <= 10) return chineseDigits[next] || "\u5341";
  const tens = Math.floor(next / 10);
  const ones = next % 10;
  return `${tens === 1 ? "" : chineseDigits[tens]}\u5341${ones ? chineseDigits[ones] : ""}`;
}

function parseChineseNumber(value) {
  const map = new Map([["\u4e00", 1], ["\u4e8c", 2], ["\u4e09", 3], ["\u56db", 4], ["\u4e94", 5], ["\u516d", 6], ["\u4e03", 7], ["\u516b", 8], ["\u4e5d", 9], ["\u5341", 10]]);
  let number = map.get(value);
  if (!number) {
    const tenParts = value.split("\u5341");
    if (tenParts.length === 2) {
      const tens = tenParts[0] ? map.get(tenParts[0]) || 0 : 1;
      const ones = tenParts[1] ? map.get(tenParts[1]) || 0 : 0;
      number = tens * 10 + ones;
    }
  }
  return number || 0;
}

function numberToChinese(num) {
  if (num <= 0) return "";
  if (num <= 10) return chineseDigits[num] || "\u5341";
  if (num < 20) return `\u5341${chineseDigits[num - 10]}`;
  if (num < 100) {
    const tens = Math.floor(num / 10);
    const ones = num % 10;
    return `${chineseDigits[tens]}\u5341${ones ? chineseDigits[ones] : ""}`;
  }
  return String(num);
}

function expandSequenceOnEnter(event) {
  if (event.key !== "Enter" || event.shiftKey) return false;
  const start = els.editor.selectionStart ?? 0;
  const end = els.editor.selectionEnd ?? start;
  if (start !== end) return false;
  const value = els.editor.value;
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const line = value.slice(lineStart, start);
  const arabic = line.match(/^(\s*)(?:##\s*)?(\d+)([.)、])(\s*)(.*)$/);
  const chinese = line.match(/^(\s*)(##\s*)?([一二三四五六七八九十百千]{1,6})([.)、])(\s*)(.*)$/);
  let marker = "";
  let separator = "";
  let indent = "";
  let hasMd = false;
  let numberType = null;
  if (arabic) {
    numberType = "arabic";
    separator = arabic[3];
    indent = arabic[1];
    marker = `${indent}${Number(arabic[2]) + 1}${separator}${arabic[4] || " "}`;
  } else if (chinese) {
    numberType = "chinese";
    separator = chinese[4];
    indent = chinese[1];
    hasMd = !!chinese[2];
    const next = nextChineseNumber(chinese[3]);
    if (next) marker = `${indent}${hasMd ? "## " : ""}${next}${separator}${chinese[5] || " "}`;
  }
  if (!marker) return false;
  event.preventDefault();

  // 扫描整个文档，找出同类型、同级缩进、同分隔符的序号行，进行重新编号
  let newValue = value;
  let positionOffset = 0;
  const lines = newValue.split("\n");
  const headerLineIdx = lines.findIndex((l, idx) => {
    const lineStartIdx = lines.slice(0, idx).reduce((acc, ll) => acc + ll.length + 1, 0);
    return lineStartIdx === lineStart;
  });

  // 向上扫描找到最近的父级标题（更高层级的标题）
  let parentHeadingLevel = 0;
  let parentHeadingLine = -1;
  for (let i = headerLineIdx - 1; i >= 0; i--) {
    const hMatch = lines[i].match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const hLevel = hMatch[2].length;
      const hIndent = hMatch[1].length;
      const currentIndent = indent.length;
      if (hLevel <= 3 && hIndent < currentIndent) {
        parentHeadingLevel = hLevel;
        parentHeadingLine = i;
        break;
      }
    }
    const cnMatch = lines[i].match(/^([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (cnMatch) {
      parentHeadingLevel = 2;
      parentHeadingLine = i;
      break;
    }
    const numMatch = lines[i].match(/^(\d{1,3})[、.．]\s*(.+)$/);
    if (numMatch) {
      const numLevel = Math.min(6, Math.max(3, numMatch[1].length + 2));
      const numIndent = lines[i].match(/^(\s*)/)?.[1].length || 0;
      const currentIndent = indent.length;
      if (numLevel < 6 && numIndent < currentIndent) {
        parentHeadingLevel = numLevel;
        parentHeadingLine = i;
        break;
      }
    }
  }

  // 收集所有同级序号行（在同一个父级标题下）
  const patternType = numberType;
  const rows = [];
  for (let i = (parentHeadingLine >= 0 ? parentHeadingLine + 1 : 0); i < lines.length; i++) {
    const currentLine = lines[i];
    // 检查是否遇到更高层级的标题（表示新的段落开始）
    const hMatch = currentLine.match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const hLevel = hMatch[2].length;
      const hIndent = hMatch[1].length;
      const currentIndent = indent.length;
      if (hLevel <= 3 && hIndent < currentIndent) {
        break;
      }
    }
    const cnMatch = currentLine.match(/^([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (cnMatch && !currentLine.startsWith("    ")) {
      break;
    }
    const numMatch = currentLine.match(/^(\s*)(\d{1,3})[、.．]\s*(.+)$/);
    if (numMatch) {
      const numLevel = Math.min(6, Math.max(3, numMatch[2].length + 2));
      const numIndent = numMatch[1].length;
      const currentIndent = indent.length;
      if (numLevel < 6 && numIndent < currentIndent) {
        break;
      }
    }

    let match;
    if (patternType === "arabic") {
      match = currentLine.match(/^(\s*)(?:##\s*)?(\d+)([.)、])(.*)$/);
      if (match && match[1] === indent && match[3] === separator) {
        rows.push({ lineIndex: i, lineStart: lines.slice(0, i).reduce((acc, ll) => acc + ll.length + 1, 0), number: Number(match[2]), prefix: match[1], sep: match[3], rest: match[4], original: currentLine, mdPrefix: currentLine.includes("##") ? "## " : "" });
      }
    } else if (patternType === "chinese") {
      match = currentLine.match(/^(\s*)(##\s*)?([一二三四五六七八九十百千]{1,6})([.)、])(.*)$/);
      if (match && match[1] === indent && match[4] === separator) {
        const num = parseChineseNumber(match[3]);
        if (num > 0) {
          rows.push({ lineIndex: i, lineStart: lines.slice(0, i).reduce((acc, ll) => acc + ll.length + 1, 0), number: num, prefix: match[1], sep: match[4], rest: match[5], original: currentLine, mdPrefix: match[2] || "" });
        }
      }
    }
  }

  // 检查是否需要重新编号（序号不是连续的 1,2,3...）
  let needRenumber = false;
  if (rows.length >= 1) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].number !== i + 1) {
        needRenumber = true;
        break;
      }
    }
  }

  // 如果需要重新编号，从前往后替换这些行
  let currentLineIdx = headerLineIdx;
  if (needRenumber && rows.length > 0) {
    // 从第一行开始，按照顺序重新编号，处理行号映射
    const newLines = lines.slice();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const newNum = i + 1;
      const newNumStr = patternType === "arabic" ? String(newNum) : numberToChinese(newNum);
      const restTrimmed = row.rest.replace(/^\s+/, "");
      newLines[row.lineIndex] = `${row.prefix}${row.mdPrefix}${newNumStr}${row.sep}${restTrimmed.length ? (restTrimmed.startsWith(" ") ? restTrimmed : " " + restTrimmed) : " "}`.trimEnd();
    }
    newValue = newLines.join("\n");
    // 计算光标位置的偏移
    let originalPos = start;
    let newPos = 0;
    for (let i = 0; i <= Math.min(currentLineIdx, lines.length - 1); i++) {
      if (i < currentLineIdx) newPos += (newLines[i].length) + 1;
      else {
        // 光标在当前行内
        newPos += Math.min(start - lineStart, newLines[i].length);
        break;
      }
    }
    // 更稳健的方式：按行重建位置
    let offset = 0;
    for (let i = 0; i < currentLineIdx; i++) {
      offset += newLines[i].length + 1;
    }
    offset += Math.min(start - lineStart, newLines[currentLineIdx].length);
    els.editor.value = newValue;
    els.editor.selectionStart = offset;
    els.editor.selectionEnd = offset;
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    // 插入下一个序号行
    const afterMarker = patternType === "arabic" ? `${indent}${rows.length + 1}${separator} ` : `${indent}${hasMd ? "## " : ""}${numberToChinese(rows.length + 1)}${separator} `;
    insertAtCursor(`\n${afterMarker}`);
    return true;
  }

  // 处理原有的中文行补 ## 的逻辑
  if (chinese && !chinese[2]) {
    const fixedLine = `${chinese[1]}## ${chinese[3]}${chinese[4]}${chinese[5]}${chinese[6]}`;
    els.editor.value = `${value.slice(0, lineStart)}${fixedLine}${value.slice(start)}`;
    const fixedStart = lineStart + fixedLine.length;
    els.editor.selectionStart = fixedStart;
    els.editor.selectionEnd = fixedStart;
  }
  insertAtCursor(`\n${marker}`);
  return true;
}

function cursorInsideFence(value, position) {
  const before = value.slice(0, position);
  return (before.match(/```/g) || []).length % 2 === 1;
}

function shouldWrapPastedCode(text) {
  if (!text || text.includes("```")) return false;
  if (!text.includes("\n")) return false;
  return /[{};=<>]|\b(function|const|let|var|class|import|export|return|SELECT|FROM|WHERE|def|public|private)\b/.test(text);
}

function wrapSelection(before, after = before, placeholder = "text") {
  let start = els.editor.selectionStart ?? els.editor.value.length;
  let end = els.editor.selectionEnd ?? start;
  if (start === end && els.editor.value) {
    const lineStart = els.editor.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const nextLine = els.editor.value.indexOf("\n", start);
    const lineEnd = nextLine === -1 ? els.editor.value.length : nextLine;
    if (lineEnd > lineStart) {
      start = lineStart;
      end = lineEnd;
    }
  }
  const selected = els.editor.value.slice(start, end) || placeholder;
  const nextValue = `${els.editor.value.slice(0, start)}${before}${selected}${after}${els.editor.value.slice(end)}`;
  els.editor.value = nextValue;
  els.editor.focus();
  els.editor.selectionStart = start + before.length;
  els.editor.selectionEnd = start + before.length + selected.length;
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertDivider() {
  const cursor = els.editor.selectionEnd ?? els.editor.value.length;
  const nextLine = els.editor.value.indexOf("\n", cursor);
  const insertAt = nextLine === -1 ? els.editor.value.length : nextLine;
  const prefix = els.editor.value.slice(0, insertAt).endsWith("\n") ? "" : "\n";
  const value = `${prefix}---\n`;
  els.editor.value = `${els.editor.value.slice(0, insertAt)}${value}${els.editor.value.slice(insertAt)}`;
  const next = insertAt + value.length;
  els.editor.focus();
  els.editor.selectionStart = next;
  els.editor.selectionEnd = next;
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyFormat(format) {
  const color = els.textColor.value;
  const bg = els.bgColor.value;
  const size = els.fontSize.value;
  const actions = {
    bold: () => wrapSelection("**", "**"),
    underline: () => wrapSelection("++", "++"),
    strike: () => wrapSelection("~~", "~~"),
    highlight: () => wrapSelection("==", "=="),
    color: () => wrapSelection(`{color:${color}|`, "}"),
    bg: () => wrapSelection(`{bg:${bg}|`, "}"),
    size: () => wrapSelection(`{size:${size}|`, "}"),
    hr: () => insertDivider(),
  };
  actions[format]?.();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1600;
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  bitmap.close?.();
  return blob || file;
}

async function handleEditorPaste(event) {
  const image = [...(event.clipboardData?.items || [])]
    .find((item) => item.kind === "file" && item.type.startsWith("image/"))
    ?.getAsFile();
  if (image) {
    event.preventDefault();
    const compressed = await compressImage(image);
    const dataUrl = await blobToDataUrl(compressed);
    const uploaded = await api.post("/api/asset", {
      dataUrl,
      name: `screenshot-${Date.now()}.webp`,
    });
    insertAtCursor(`\n${uploaded.markdown}\n`);
    return;
  }
  const textValue = event.clipboardData?.getData("text/plain") || "";
  const cursor = els.editor.selectionStart ?? 0;
  if (shouldWrapPastedCode(textValue) && !cursorInsideFence(els.editor.value, cursor)) {
    event.preventDefault();
    insertAtCursor(`\n\`\`\`\n${textValue.trim()}\n\`\`\`\n`);
  }
}

els.searchInput.addEventListener("input", debounce(runSearch, 160));
els.tree.addEventListener("dragover", allowRootDrop);
els.tree.addEventListener("dragleave", clearRootDrop);
els.tree.addEventListener("drop", dropOnRoot);

function pickClipboardSource() {
  // 多选优先
  if (state.multiSelected.size > 0) return Array.from(state.multiSelected);
  // 单选场景：selectedFolder 仅在显式点击文件夹时优先
  if (state.folderExplicit && state.selectedFolder) return [state.selectedFolder];
  if (state.currentPath) return [state.currentPath];
  if (state.selectedFolder) return [state.selectedFolder];
  return [];
}

function handleTreeMultiSelect(path, event) {
  const withCtrl = event && (event.ctrlKey || event.metaKey || event.shiftKey);
  if (withCtrl) {
    if (state.multiSelected.has(path)) state.multiSelected.delete(path);
    else state.multiSelected.add(path);
  } else {
    state.multiSelected.clear();
    state.multiSelected.add(path);
  }
  renderTree(state.tree);
}

function keyboardCopy(event) {
  if (event.target === els.editor) {
    const selected = els.editor.value.substring(els.editor.selectionStart, els.editor.selectionEnd);
    if (selected.trim()) {
      navigator.clipboard.writeText(selected).then(() => {
        showToast("已复制到剪贴板");
      }).catch(() => {
        showToast("复制成功");
      });
    }
    return;
  }
  if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.isContentEditable)) return;
  event.preventDefault();
  const sources = pickClipboardSource();
  if (!sources.length) return showToast("请先选中一个或多个文件/文件夹（按住 Ctrl 可多选）");
  state.clipboardItems = sources;
  showToast(`已复制 ${sources.length} 项：${sources.map((p) => path.basename(p)).join("、")}`);
}

function keyboardPaste(event) {
  if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.isContentEditable)) return;
  if (!state.clipboardItems.length) return showToast("请先按 Ctrl+C 复制文件或文件夹");
  event.preventDefault();
  const targetFolder = state.selectedFolder || "";
  api.post("/api/workspaces/paste", { source: state.clipboardItems, targetFolder })
    .then((copied) => {
      state.graphReady = false;
      return bootstrap(true).then(() => copied);
    })
    .then((copied) => {
      if (copied.type === "file" && copied.path) openDoc(copied.path);
      showToast(`已粘贴 ${Array.isArray(state.clipboardItems) ? state.clipboardItems.length : 1} 项`);
    })
    .catch((error) => showToast(error.message || "粘贴失败"));
}

function keyboardDelete(event) {
  if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.isContentEditable)) return;
  let targets;
  if (state.multiSelected.size > 0) targets = Array.from(state.multiSelected);
  else {
    const single = state.folderExplicit ? state.selectedFolder : state.currentPath || state.selectedFolder;
    if (!single) return showToast("请先选中一个文件或文件夹");
    targets = [single];
  }
  event.preventDefault();
  state.deleteTarget = targets.join("|");
  els.deleteTarget.textContent = targets.join("\n");
  els.deleteModal.classList.remove("hidden");
}

// 全局键盘快捷键
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key && event.key.toLowerCase() === "c") return keyboardCopy(event);
  if ((event.ctrlKey || event.metaKey) && event.key && event.key.toLowerCase() === "v") return keyboardPaste(event);
  if ((event.ctrlKey || event.metaKey) && event.key && event.key.toLowerCase() === "d") return keyboardDelete(event);
  if (event.key === "Delete") return keyboardDelete(event);
});

if (els.workspaceBtn) {
  els.workspaceBtn.addEventListener("click", openWorkspaceModal);
}
if (els.cancelWorkspaceBtn) {
  els.cancelWorkspaceBtn.addEventListener("click", closeWorkspaceModal);
}
if (els.workspaceModal) {
  els.workspaceModal.addEventListener("click", (event) => {
    if (event.target === els.workspaceModal) closeWorkspaceModal();
  });
}
if (els.workspaceForm) {
  els.workspaceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const path = (els.workspacePath?.value || "").trim();
    const name = (els.workspaceName?.value || "").trim();
    if (!path) return showToast("请先输入一个磁盘路径");
    try {
      const result = await api.post("/api/workspaces/add", { path, name });
      state.graphReady = false;
      await bootstrap(true);
      openWorkspaceModal();
      showToast("已加载工作路径");
    } catch (error) {
      showToast(error.message || "路径无效或不存在");
    }
  });
}
if (els.browseFolderBtn) {
  els.browseFolderBtn.addEventListener("click", () => {
    openFileBrowser(els.workspacePath.value || "");
  });
}
document.addEventListener("keydown", handleFileBrowserKeydown);

async function openNormalizeMdModal() {
  const data = await api.get("/api/workspaces");
  state.workspaces = data.workspaces || state.workspaces;
  const visible = state.workspaces.filter((ws) => ws.visible).slice(0, 2);
  if (!visible.length) return showToast("请先加载工作路径");
  els.normalizeWorkspaceList.innerHTML = visible
    .map((ws) => `<label><input type="checkbox" value="${escapeHtml(ws.id)}" checked /><span class="label-text">${escapeHtml(compactName(ws.name, 32))}<em>${escapeHtml(compactName(ws.root, 40))}</em></span></label>`)
    .join("");
  const boxes = els.normalizeExtensionChoices.querySelectorAll('input[type="checkbox"]');
  boxes.forEach((box) => {
    if (box.value === "*") box.checked = true;
  });
  els.normalizeMdModal.classList.remove("hidden");
}

function closeNormalizeMdModal() {
  els.normalizeMdModal.classList.add("hidden");
}

async function runNormalizeMd() {
  const workspaceIds = [...els.normalizeWorkspaceList.querySelectorAll('input[type="checkbox"]:checked')].map((box) => box.value);
  const extensions = [...els.normalizeExtensionChoices.querySelectorAll('input[type="checkbox"]:checked')].map((box) => box.value);
  if (!workspaceIds.length) return showToast("请至少选择一个工作路径");
  if (!extensions.length) return showToast("请至少选择一种扩展名");
  try {
    els.normalizeMdBtn.disabled = true;
    els.normalizeStatus.textContent = "正在转换...";
    const result = await api.post("/api/normalize-md", { workspaceIds, extensions });
    await bootstrap(true);
    state.graphReady = false;
    els.normalizeStatus.textContent = `已转换 ${result.changed || 0} 个文件`;
    closeNormalizeMdModal();
  } catch (error) {
    els.normalizeStatus.textContent = error.message || "转换失败";
  } finally {
    els.normalizeMdBtn.disabled = false;
  }
}
els.searchInput.addEventListener("focus", () => {
  if (els.searchInput.value.trim()) runSearch();
});
document.addEventListener("click", closeSearchWhenIdle);
els.searchResults.addEventListener("click", (event) => {
  const button = event.target.closest("[data-path]");
  if (button) {
    els.searchResults.classList.add("hidden");
    setMode("view");
    openDoc(button.dataset.path, { searchTerm: button.dataset.query || els.searchInput.value.trim() });
  }
});
els.markdownView.addEventListener("click", (event) => {
  const copy = event.target.closest(".code-copy");
  if (copy) {
    const code = copy.closest(".code-block")?.querySelector("code")?.innerText || "";
    navigator.clipboard?.writeText(code).then(() => showToast("\u4ee3\u7801\u5df2\u590d\u5236"));
    return;
  }
  const link = event.target.closest("[data-doc-link]");
  if (!link) return;
  event.preventDefault();
  const label = link.dataset.docLink.toLowerCase();
  const file = state.flatFiles.find((item) => item.title.toLowerCase() === label || item.path.toLowerCase().endsWith(`${label}.md`));
  if (file) openDoc(file.path);
});
els.markdownView.addEventListener("copy", (event) => {
  const selection = window.getSelection();
  if (selection && selection.toString().trim()) {
    showToast("已复制到剪贴板");
  }
});
els.preview.addEventListener("click", (event) => {
  const copy = event.target.closest(".code-copy");
  if (!copy) return;
  const code = copy.closest(".code-block")?.querySelector("code")?.innerText || "";
  navigator.clipboard?.writeText(code).then(() => showToast("\u4ee3\u7801\u5df2\u590d\u5236"));
});
els.readerOutline.addEventListener("click", (event) => {
  const button = event.target.closest("[data-heading]");
  if (!button) return;
  let target = els.markdownView.querySelector(`#${CSS.escape(button.dataset.heading)}`);
  if (!target) {
    const selector = button.dataset.level === "1" ? "h1" : "h2";
    target = [...els.markdownView.querySelectorAll(selector)]
      .find((heading) => plainText(heading.textContent) === button.dataset.title);
  }
  scrollReaderToElement(target, "auto");
});
els.editor.addEventListener("input", () => {
  state.currentContent = els.editor.value;
  recordUndo(state.currentContent);
  setSaveStatus("\u672a\u4fdd\u5b58", true);
  updatePreview();
  autoSaveCurrentDoc();
});
els.editor.addEventListener("scroll", syncPreviewToEditor, { passive: true });
els.editor.addEventListener("keydown", (event) => {
  if (expandSequenceOnEnter(event)) return;
  if (event.key === "Tab") {
    event.preventDefault();
    const start = els.editor.selectionStart;
    const lineStart = els.editor.value.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = els.editor.value.indexOf("\n", start);
    const line = els.editor.value.substring(lineStart, lineEnd === -1 ? els.editor.value.length : lineEnd);
    
    const headingMatch = line.match(/^(#+)\s+(.+)$/);
    const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    
    if (headingMatch) {
      insertAtCursor("    ");
    } else if (imageMatch) {
      insertAtCursor("    ");
    } else {
      insertAtCursor("    ");
    }
    return;
  }
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key === ";") {
    event.preventDefault();
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    insertAtCursor(dateStr);
    return;
  }
  if (mod && event.key === "'") {
    event.preventDefault();
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    insertAtCursor(timeStr);
    return;
  }
  if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveCurrentDoc({ refreshTree: true });
    return;
  }
  if (!mod) return;
  if (event.key.toLowerCase() === "z" && !event.shiftKey) {
    event.preventDefault();
    undoEditor();
  } else if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) {
    event.preventDefault();
    redoEditor();
  }
});
els.editor.addEventListener("paste", handleEditorPaste);
els.sidebarResizer.addEventListener("pointerdown", startSidebarResize);
els.sidebarResizer.addEventListener("pointermove", moveSidebarResize);
els.sidebarResizer.addEventListener("pointerup", endSidebarResize);
els.sidebarResizer.addEventListener("pointercancel", endSidebarResize);
els.sidebarHideBtn.addEventListener("click", () => setSidebarCollapsed(true));
els.sidebarShowBtn.addEventListener("click", () => setSidebarCollapsed(!state.sidebarCollapsed));
els.settingsBtn.addEventListener("click", async () => {
  applySettings();
  renderDefaultWorkspaceChoices();
  els.settingsModal.classList.remove("hidden");
});

function renderDefaultWorkspaceChoices() {
  if (!els.defaultWorkspaceChoices) return;
  els.defaultWorkspaceChoices.innerHTML = state.workspaces
    .map((ws) => {
      const active = ws.id === state.defaultWorkspaceId ? "active" : "";
      return `<button type="button" data-id="${escapeHtml(ws.id)}" class="${active}">${escapeHtml(compactName(ws.name, 26))}</button>`;
    })
    .join("");
  els.defaultWorkspaceChoices.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const result = await api.post("/api/workspaces/set-default", { id: button.dataset.id });
        state.defaultWorkspaceId = result.defaultWorkspaceId || button.dataset.id;
        renderDefaultWorkspaceChoices();
        showToast("已设置默认工作路径");
      } catch (error) {
        showToast(error.message || "设置失败");
      }
    });
  });
}

els.closeSettingsBtn.addEventListener("click", () => els.settingsModal.classList.add("hidden"));
els.settingsModal.addEventListener("click", (event) => {
  if (event.target === els.settingsModal) els.settingsModal.classList.add("hidden");
});
els.themeChoices.addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme]");
  if (!button) return;
  localStorage.setItem("docTheme", button.dataset.theme);
  applySettings();
});
els.bgImageInput.addEventListener("change", () => {
  const file = els.bgImageInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    localStorage.setItem("docBgImage", reader.result);
    localStorage.setItem("docTheme", "image");
    applySettings();
  };
  reader.readAsDataURL(file);
});
els.globalFontSize.addEventListener("input", () => {
  localStorage.setItem("docFontSize", els.globalFontSize.value);
  applySettings();
});
els.docFontSize.addEventListener("input", () => {
  localStorage.setItem("docContentFontSize", els.docFontSize.value);
  applySettings();
});
els.globalFontFamily.addEventListener("change", () => {
  localStorage.setItem("docFontFamily", els.globalFontFamily.value);
  applySettings();
});
els.normalizeMdBtn.addEventListener("click", openNormalizeMdModal);
if (els.cancelNormalizeMdBtn) {
  els.cancelNormalizeMdBtn.addEventListener("click", closeNormalizeMdModal);
}
if (els.confirmNormalizeMdBtn) {
  els.confirmNormalizeMdBtn.addEventListener("click", runNormalizeMd);
}
if (els.normalizeMdModal) {
  els.normalizeMdModal.addEventListener("click", (event) => {
    if (event.target === els.normalizeMdModal) closeNormalizeMdModal();
  });
}
els.editorToolbar.addEventListener("mousedown", (event) => {
  if (event.target.closest("[data-format]")) event.preventDefault();
});
els.editorToolbar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-format]");
  if (button) applyFormat(button.dataset.format);
});
els.newFolderBtn.addEventListener("click", () => openCreateModal("folder"));
els.newDocBtn.addEventListener("click", () => openCreateModal("doc"));
els.createForm.addEventListener("submit", submitCreate);
els.cancelCreateBtn.addEventListener("click", closeCreateModal);
els.createModal.addEventListener("click", (event) => {
  if (event.target === els.createModal) closeCreateModal();
});
els.cancelDeleteBtn.addEventListener("click", closeDeleteModal);
els.confirmDeleteBtn.addEventListener("click", confirmDeleteSelected);
els.deleteModal.addEventListener("click", (event) => {
  if (event.target === els.deleteModal) closeDeleteModal();
});
els.viewBtn.addEventListener("click", () => setMode("view"));
els.editBtn.addEventListener("click", () => state.currentPath && setMode("edit"));
els.graphBtn.addEventListener("click", () => setMode("graph"));
els.deleteBtn.addEventListener("click", deleteSelected);
els.saveBtn.addEventListener("click", async () => {
  try {
    await saveCurrentDoc({ refreshTree: true });
  } catch (error) {
    setSaveStatus("\u4fdd\u5b58\u5931\u8d25", true);
    alert(error.message || "\u4fdd\u5b58\u5931\u8d25");
  }
});
els.formatBtn.addEventListener("click", () => {
  if (!state.currentPath) return;
  const formatted = formatDocument(els.editor.value);
  els.editor.value = formatted;
  state.currentContent = formatted;
  recordUndo(formatted);
  updatePreview();
  showToast("文档格式化完成");
});
els.fitGraphBtn.addEventListener("click", () => {
  state.graphReady = false;
  initGraph(true);
});
els.canvas.addEventListener("pointerdown", (event) => {
  if (state.mode !== "graph") return;
  const node = hitGraph(event);
  if (!node) return;
  const graphPos = screenToGraph(event.clientX, event.clientY);
  state.graphDrag = {
    node,
    offsetX: node.x - graphPos.x,
    offsetY: node.y - graphPos.y,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  els.canvas.classList.add("dragging");
  els.canvas.setPointerCapture?.(event.pointerId);
});
els.canvas.addEventListener("pointermove", (event) => {
  if (!state.graphDrag) return;
  const graphPos = screenToGraph(event.clientX, event.clientY);
  state.graphDrag.node.x = graphPos.x + state.graphDrag.offsetX;
  state.graphDrag.node.y = graphPos.y + state.graphDrag.offsetY;
  state.graphDrag.moved ||= Math.hypot(event.clientX - state.graphDrag.startX, event.clientY - state.graphDrag.startY) > 4;
  drawGraph();
});
els.canvas.addEventListener("pointerup", (event) => {
  if (!state.graphDrag) return;
  const drag = state.graphDrag;
  state.graphDrag = null;
  els.canvas.classList.remove("dragging");
  els.canvas.releasePointerCapture?.(event.pointerId);
  if (!drag.moved) openDoc(drag.node.id);
});
els.canvas.addEventListener("pointercancel", () => {
  state.graphDrag = null;
  els.canvas.classList.remove("dragging");
});
window.addEventListener("resize", debounce(() => {
  restoreSidebarWidth();
  if (state.mode === "graph") {
    resizeCanvas();
    drawGraph();
  }
}, 120));

if (els.recentDocs) {
  els.recentDocs.addEventListener("wheel", (event) => {
    if (event.deltaX === 0) {
      event.preventDefault();
      els.recentDocs.scrollLeft += event.deltaY;
    }
  }, { passive: false });
}

async function bootstrap(refresh = false) {
  const data = await api.get(`/api/tree${refresh ? "?refresh=1" : ""}`);
  state.tree = data.tree;
  state.flatFiles = flatten(state.tree, []);
  if (data.workspaces && data.workspaces.length) state.workspaces = data.workspaces;
  if (data.defaultWorkspaceId) state.defaultWorkspaceId = data.defaultWorkspaceId;
  els.docCount.textContent = `${data.count || 0} ${text.docsUnit} / ${state.workspaces.filter((ws) => ws.visible).length} 个工作路径`;
  renderWorkspaceSummary();
  renderTree(state.tree);
}

applySettings();
restoreSidebarWidth();
restoreSidebarCollapsed();
loadRecentDocs();
renderRecentDocs();
bootstrap();
