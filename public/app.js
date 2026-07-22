const text = {
  emptyResult: "\u6ca1\u6709\u5339\u914d\u7ed3\u679c",
  retryKeyword: "\u6362\u4e00\u4e2a\u5173\u952e\u8bcd\u8bd5\u8bd5",
  noGraph: "\u6682\u65e0\u53ef\u7ed8\u5236\u7684 Markdown \u6587\u6863",
  docsUnit: "\u7bc7 Markdown",
  newFolder: "\u65b0\u5efa\u6587\u4ef6\u5939",
  newDoc: "\u65b0\u5efa Markdown",
  deleteConfirm: "\u786e\u5b9a\u5220\u9664\u5f53\u524d\u9879\u5417\uff1f",
};

const LARGE_PREVIEW_BYTES = 100 * 1024;
const LARGE_PREVIEW_DELAY = 700;
const GRAPH_WORKER_URL = "/graph-worker.js?v=20260722-worker-1";

const state = {
  tree: [],
  flatFiles: [],
  currentPath: "",
  currentContent: "",
  mode: "view",
  graph: { nodes: [], edges: [] },
  graphSource: null,
  graphLayouts: new Map(),
  graphLayoutPromises: new Map(),
  graphLayoutSeq: 0,
  graphWorker: null,
  graphWorkerFailed: false,
  graphWorkerSeq: 0,
  graphWorkerPending: new Map(),
  graphReady: false,
  graphView: {
    visibleNodes: [],
    visibleEdges: [],
    scale: 1,
    tx: 0,
    ty: 0,
    hoveredId: "",
    query: "",
    scope: "global",
    depth: 2,
    showTags: true,
    showKeywords: true,
    showOrphans: false,
    showMissing: true,
    dynamic: localStorage.getItem("graphDynamic") !== "0",
    frame: 0,
    relaxFrame: 0,
    simulationFrame: 0,
    simulationTimer: 0,
    simulationLastTime: 0,
    simulationCache: null,
    motionTime: 0,
    chainUntil: 0,
    reboundUntil: 0,
    reboundAnimation: 0,
    fitted: false,
  },
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
  secondaryCursors: [],
  immersive: false,
  previewVisible: true,
  previewBeforeImmersive: true,
  previewTimer: 0,
  previewLastContent: "",
  currentContentBytes: 0,
  largeDocument: false,
  previewAutoHidden: false,
  taskSaveQueue: Promise.resolve(),
  semanticTagPreview: null,
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
  focusModeBtn: document.querySelector("#focusModeBtn"),
  previewToggleBtn: document.querySelector("#previewToggleBtn"),
  fitGraphBtn: document.querySelector("#fitGraphBtn"),
  graphStats: document.querySelector("#graphStats"),
  graphSearchInput: document.querySelector("#graphSearchInput"),
  graphScope: document.querySelector("#graphScope"),
  graphDepth: document.querySelector("#graphDepth"),
  graphShowTags: document.querySelector("#graphShowTags"),
  graphShowKeywords: document.querySelector("#graphShowKeywords"),
  graphShowOrphans: document.querySelector("#graphShowOrphans"),
  graphShowMissing: document.querySelector("#graphShowMissing"),
  graphZoomOutBtn: document.querySelector("#graphZoomOutBtn"),
  graphZoomInBtn: document.querySelector("#graphZoomInBtn"),
  graphDynamic: document.querySelector("#graphDynamic"),
  graphTooltip: document.querySelector("#graphTooltip"),
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
  communityBtn: document.querySelector("#communityBtn"),
  communityModal: document.querySelector("#communityModal"),
  closeCommunityBtn: document.querySelector("#closeCommunityBtn"),
  backCommunityBtn: document.querySelector("#backCommunityBtn"),
  aboutBtn: document.querySelector("#aboutBtn"),
  aboutModal: document.querySelector("#aboutModal"),
  closeAboutBtn: document.querySelector("#closeAboutBtn"),
  aboutVersion: document.querySelector("#aboutVersion"),
  aboutDate: document.querySelector("#aboutDate"),
  aboutReleaseNotes: document.querySelector("#aboutReleaseNotes"),
  checkUpdateBtn: document.querySelector("#checkUpdateBtn"),
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
  semanticTagsBtn: document.querySelector("#semanticTagsBtn"),
  semanticTagsStatus: document.querySelector("#semanticTagsStatus"),
  semanticTagsModal: document.querySelector("#semanticTagsModal"),
  semanticTagsMax: document.querySelector("#semanticTagsMax"),
  semanticTagsPreview: document.querySelector("#semanticTagsPreview"),
  cancelSemanticTagsBtn: document.querySelector("#cancelSemanticTagsBtn"),
  applySemanticTagsBtn: document.querySelector("#applySemanticTagsBtn"),
  toast: document.querySelector("#toast"),
  recentDocs: document.querySelector("#recentDocs"),
};

if (els.graphDynamic) els.graphDynamic.checked = state.graphView.dynamic;

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
  if (state.mode === "graph") requestAnimationFrame(scheduleGraphDraw);
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
  let h3Index = 0;
  let h4Index = 0;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = line.match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[2].length;
      let index;
      if (level === 1) {
        index = h1Index++;
        h2Index = 0;
        h3Index = 0;
        h4Index = 0;
      } else if (level === 2) {
        index = `sub-${h2Index++}`;
        h3Index = 0;
        h4Index = 0;
      } else if (level === 3) {
        index = `h3-${h3Index++}`;
        h4Index = 0;
      } else {
        index = `h4-${h4Index++}`;
      }
      outline.push({ id: headingId(heading[3], index), title: plainText(heading[3]), level });
      continue;
    }
    const autoHeading = line.match(/^(\s*)([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (autoHeading) {
      const level = 2;
      outline.push({ id: headingId(autoHeading[2], `auto-${h2Index++}`), title: plainText(autoHeading[2]), level });
      h3Index = 0;
      h4Index = 0;
      continue;
    }
    const dottedHeading = line.match(/^(\s*)(\d+(?:\.\d+)+)[、.．]\s*([^-*].+)$/);
    if (dottedHeading) {
      const level = 3;
      outline.push({ id: headingId(dottedHeading[3], `num-h3-${h3Index++}`), title: plainText(dottedHeading[3]), level });
      h4Index = 0;
      continue;
    }
    
    const numHeading = line.match(/^(\s*)(\((?:\d{1,3})\)|(\d{1,3})([、.．)]))\s*([^-*].+)$/);
    if (numHeading && !/^\s*\d+[.)]\s+\[[ xX]\](?:\s|$)/.test(line)) {
      const level = 4;
      outline.push({ id: headingId(numHeading[5], `num-h4-${h4Index++}`), title: plainText(numHeading[5]), level });
    }
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
    
    const dottedHeading = line.match(/^(\d+(?:\.\d+)+)[、.．]\s*(.+)$/);
    if (dottedHeading) {
      const dotCount = (dottedHeading[1].match(/\./g) || []).length;
      const level = Math.min(6, 3 + dotCount);
      lastHeadingLevel = level;
      result.push(`${dottedHeading[1]}、${dottedHeading[2]}`);
      continue;
    }
    
    const numHeading = line.match(/^(\s*)(\((?:\d{1,3})\)|(\d{1,3})([、.．)]))\s*(.+)$/);
    if (numHeading && !/^\s*\d+[.)]\s+\[[ xX]\](?:\s|$)/.test(line)) {
      const indent = numHeading[1].length;
      const indentLevel = Math.floor(indent / 4);
      const level = Math.min(6, Math.max(3, 3 + indentLevel));
      
      let correctedLevel = level;
      if (level > lastHeadingLevel + 1) {
        correctedLevel = lastHeadingLevel + 1;
      }
      
      lastHeadingLevel = correctedLevel;
      
      result.push(`${numHeading[1]}${numHeading[2]}${numHeading[5]}`);
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
  if (!outline.length) {
    els.readerOutline.innerHTML = "";
    return;
  }
  const headingButton = (item, extraClass = "") => `<button class="level-${item.level} ${extraClass}" data-heading="${escapeHtml(item.id)}" data-level="${item.level}" data-title="${escapeHtml(item.title)}" title="${escapeHtml(item.title)}">${escapeHtml(compactName(item.title, 22))}</button>`;
  const rows = [];
  for (let index = 0; index < outline.length; index += 1) {
    const item = outline[index];
    if (item.level !== 2) {
      rows.push(headingButton(item));
      continue;
    }
    const children = [];
    let cursor = index + 1;
    while (cursor < outline.length && outline[cursor].level > 2) {
      children.push(outline[cursor]);
      cursor += 1;
    }
    if (!children.length) {
      rows.push(headingButton(item));
      continue;
    }
    const groupId = `outline-group-${index}`;
    rows.push(`<section class="outline-group is-collapsed">
      <div class="outline-group-head">
        ${headingButton(item, "outline-parent")}
        <button type="button" class="outline-toggle" data-outline-toggle="${groupId}" aria-controls="${groupId}" aria-expanded="false" title="展开三级目录"><span aria-hidden="true">&#8250;</span></button>
      </div>
      <div id="${groupId}" class="outline-children">${children.map((child) => headingButton(child)).join("")}</div>
    </section>`);
    index = cursor - 1;
  }
  els.readerOutline.innerHTML = `<p class="reader-outline-title">\u672c\u6587\u76ee\u5f55</p>${rows.join("")}`;
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
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `<a href="${safeMarkdownUrl(url)}">${label}</a>`);
}

function safeMarkdownUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "#";
  const protocol = url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (protocol && !["http", "https", "mailto"].includes(protocol)) return "#";
  return url;
}

function renderMarkdown(source, options = {}) {
  const searchTerm = options.searchTerm || "";
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let h1Index = 0;
  let h2Index = 0;
  let h3Index = 0;
  let h4Index = 0;
  let inCode = false;
  let code = [];
  let list = null;
  let table = [];

  const flushList = () => {
    if (!list) return;
    const hasTasks = list.items.some((item) => item.task);
    const listClass = hasTasks ? ' class="contains-task-list"' : "";
    const items = list.items.map((item) => `<li${item.task ? ' class="task-list-item"' : ""}>${item.html}</li>`).join("");
    html.push(`<${list.type}${listClass}>${items}</${list.type}>`);
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
      let id;
      if (level === 1) {
        id = headingId(indentedHeading[3], h1Index++);
        h2Index = 0;
        h3Index = 0;
        h4Index = 0;
      } else if (level === 2) {
        id = headingId(indentedHeading[3], `sub-${h2Index++}`);
        h3Index = 0;
        h4Index = 0;
      } else if (level === 3) {
        id = headingId(indentedHeading[3], `h3-${h3Index++}`);
        h4Index = 0;
      } else {
        id = headingId(indentedHeading[3], `h4-${h4Index++}`);
      }
      const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
      const marginLeft = indent * 16;
      html.push(`<h${level}${idAttr} style="margin-left: ${marginLeft}px;">${inlineMarkdown(indentedHeading[3], searchTerm)}</h${level}>`);
      continue;
    }
    const cnHeading = line.match(/^(\s*)([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (cnHeading) {
      flushList();
      const indent = cnHeading[1].length;
      const marginLeft = indent * 16;
      const level = 2;
      const id = headingId(cnHeading[2], `auto-${h2Index++}`);
      h3Index = 0;
      h4Index = 0;
      html.push(`<h${level}${id ? ` id="${escapeHtml(id)}"` : ""} style="margin-left: ${marginLeft}px;">${inlineMarkdown(cnHeading[2], searchTerm)}</h${level}>`);
      continue;
    }
    const dottedHeading = line.match(/^(\s*)(\d+(?:\.\d+)+)([、.．])\s*([^-*].+)$/);
    if (dottedHeading) {
      if (dottedHeading[4].trim().length > 0) {
        flushList();
        const indent = dottedHeading[1].length;
        const marginLeft = indent * 16;
        const level = 3;
        const id = headingId(dottedHeading[4], `num-h3-${h3Index++}`);
        h4Index = 0;
        html.push(`<h${level}${id ? ` id="${escapeHtml(id)}"` : ""} style="margin-left: ${marginLeft}px;">${inlineMarkdown(dottedHeading[2] + dottedHeading[3] + dottedHeading[4], searchTerm)}</h${level}>`);
        continue;
      }
    }
    
    const numHeading = line.match(/^(\s*)(\((?:\d{1,3})\)|(\d{1,3})([、.．)]))\s*([^-*].+)$/);
    if (numHeading && !/^\s*\d+[.)]\s+\[[ xX]\](?:\s|$)/.test(line)) {
      if (numHeading[5].trim().length > 0) {
        flushList();
        const indent = numHeading[1].length;
        const marginLeft = indent * 16;
        const level = 4;
        const id = headingId(numHeading[5], `num-h4-${h4Index++}`);
        html.push(`<h${level}${id ? ` id="${escapeHtml(id)}"` : ""} style="margin-left: ${marginLeft}px;">${inlineMarkdown(numHeading[2] + numHeading[5], searchTerm)}</h${level}>`);
        continue;
      }
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushList();
      html.push(`<blockquote>${inlineMarkdown(quote[1], searchTerm)}</blockquote>`);
      continue;
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const type = bullet ? "ul" : "ol";
      const indent = bullet ? bullet[1].length : ordered[1].length;
      const content = bullet ? bullet[2] : ordered[3];
      const task = content.match(/^\[([ xX])\](?:\s+(.*))?$/);
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      const marginStyle = indent > 0 ? ` style="margin-left: ${indent * 16}px;"` : "";
      if (task) {
        const checked = task[1].toLowerCase() === "x";
        const label = inlineMarkdown(task[2] || "", searchTerm);
        list.items.push({
          task: true,
          html: `<label${marginStyle}><input type="checkbox" data-task-line="${i}"${checked ? " checked" : ""} aria-label="${checked ? "已完成" : "未完成"}" title="点击更新任务状态" /><span>${label}</span></label>`,
        });
      } else {
        list.items.push({ task: false, html: `<span${marginStyle}>${inlineMarkdown(content, searchTerm)}</span>` });
      }
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

function syncTaskInputs(lineIndex, checked) {
  document.querySelectorAll(`input[data-task-line="${lineIndex}"]`).forEach((input) => {
    input.checked = checked;
    input.setAttribute("aria-label", checked ? "已完成" : "未完成");
  });
}

async function toggleMarkdownTask(input) {
  const lineIndex = Number(input?.dataset.taskLine);
  if (!state.currentPath || !Number.isInteger(lineIndex) || lineIndex < 0) {
    if (input) input.checked = !input.checked;
    return;
  }
  const previousContent = state.currentContent;
  const taskPath = state.currentPath;
  const newline = previousContent.includes("\r\n") ? "\r\n" : "\n";
  const lines = previousContent.replace(/\r\n/g, "\n").split("\n");
  const line = lines[lineIndex] || "";
  const taskPattern = /^(\s*(?:[-*]|\d+[.)])\s+)\[([ xX])\]/;
  if (!taskPattern.test(line)) {
    input.checked = !input.checked;
    showToast("任务位置已变化，请刷新文档后重试");
    return;
  }
  const checked = Boolean(input.checked);
  lines[lineIndex] = line.replace(taskPattern, (_, prefix) => `${prefix}[${checked ? "x" : " "}]`);
  const nextContent = lines.join(newline);
  state.currentContent = nextContent;
  els.editor.value = nextContent;
  updateLargeDocumentState(nextContent);
  recordUndo(nextContent);
  syncTaskInputs(lineIndex, checked);
  setSaveStatus("保存中", true);

  const saveJob = state.taskSaveQueue
    .catch(() => {})
    .then(() => api.post("/api/save", { path: taskPath, content: nextContent }));
  state.taskSaveQueue = saveJob;
  try {
    await saveJob;
    if (state.currentPath === taskPath && state.currentContent === nextContent) {
      state.lastSavedContent = nextContent;
      setSaveStatus("已保存", false);
    }
    state.graphReady = false;
  } catch (error) {
    if (state.currentPath === taskPath && state.currentContent === nextContent) {
      state.currentContent = previousContent;
      els.editor.value = previousContent;
      updateLargeDocumentState(previousContent, true);
      recordUndo(previousContent);
      syncTaskInputs(lineIndex, !checked);
      setSaveStatus("保存失败", true);
    }
    showToast(error.message || "任务状态保存失败");
  }
}

function syncTreeSelectionState() {
  if (!els.tree) return;
  for (const panel of els.tree.querySelectorAll(".tree-workspace[data-workspace-id]")) {
    panel.classList.toggle("active-workspace", panel.dataset.workspaceId === state.activeWorkspaceId);
  }
  for (const title of els.tree.querySelectorAll(".folder-title[data-tree-path]")) {
    const treePath = title.dataset.treePath;
    const multiSelected = state.multiSelected.has(treePath);
    title.classList.toggle("selected", multiSelected || state.selectedFolder === treePath);
    title.classList.toggle("multi-selected", multiSelected);
  }
  for (const button of els.tree.querySelectorAll(".file-item[data-tree-path]")) {
    const treePath = button.dataset.treePath;
    button.classList.toggle("active", state.currentPath === treePath);
    button.classList.toggle("multi-selected", state.multiSelected.has(treePath));
  }
}

function updateLazyFolderMount(node, wrapper, title, children) {
  const expanded = state.expandedFolders.has(node.path);
  wrapper.classList.toggle("collapsed", !expanded);
  title.setAttribute("aria-expanded", String(expanded));
  if (expanded && children.dataset.mounted !== "1") {
    renderTree(node.children || [], children);
    children.dataset.mounted = "1";
  } else if (!expanded && children.dataset.mounted === "1") {
    children.replaceChildren();
    children.dataset.mounted = "0";
  }
}

function rerenderWorkspacePanel(node, panel) {
  const staging = document.createElement("div");
  renderTree([node], staging);
  const nextPanel = staging.firstElementChild;
  if (nextPanel) panel.replaceWith(nextPanel);
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
        syncTreeSelectionState();
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
          syncTreeSelectionState();
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

      renderTree(folders, children);

      for (const file of displayFiles) {
        const button = document.createElement("button");
        const isSelected = state.multiSelected.has(file.path) || state.currentPath === file.path;
        button.className = `file-item ${state.currentPath === file.path ? "active" : ""} ${state.multiSelected.has(file.path) ? "multi-selected" : ""}`;
        button.dataset.treePath = file.path;
        button.draggable = true;
        button.title = file.path + "（按住 Ctrl 点击可多选）";
        button.innerHTML = `<span class="file-icon">-</span><span>${escapeHtml(compactName(displayName(file)))}</span>`;
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          state.activeWorkspaceId = file.workspaceId;
          if (event && (event.ctrlKey || event.metaKey || event.shiftKey)) {
            if (state.multiSelected.has(file.path)) state.multiSelected.delete(file.path);
            else state.multiSelected.add(file.path);
            syncTreeSelectionState();
          } else {
            state.multiSelected.clear();
            state.multiSelected.add(file.path);
            syncTreeSelectionState();
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
          rerenderWorkspacePanel(node, panel);
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
      title.dataset.treePath = node.path;
      title.type = "button";
      title.draggable = true;
      title.setAttribute("aria-expanded", String(expanded));
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
        updateLazyFolderMount(node, wrapper, title, children);
        syncTreeSelectionState();
      });
      title.addEventListener("dragstart", (event) => startTreeDrag(event, { type: "folder", path: node.path }));
      title.addEventListener("dragend", endTreeDrag);
      title.addEventListener("dragover", allowFolderDrop);
      title.addEventListener("dragleave", clearFolderDrop);
      title.addEventListener("drop", (event) => dropOnFolder(event, node.path));
      const children = document.createElement("div");
      children.className = "folder-children";
      children.dataset.mounted = "0";
      wrapper.append(title);
      wrapper.append(children);
      container.append(wrapper);
      if (expanded) updateLazyFolderMount(node, wrapper, title, children);
      continue;
    }

    const button = document.createElement("button");
    const isSelected = state.multiSelected.has(node.path) || state.currentPath === node.path;
    button.className = `file-item ${state.currentPath === node.path ? "active" : ""} ${state.multiSelected.has(node.path) ? "multi-selected" : ""}`;
    button.dataset.treePath = node.path;
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
        syncTreeSelectionState();
      } else {
        state.multiSelected.clear();
        state.multiSelected.add(node.path);
        syncTreeSelectionState();
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
    syncTreeSelectionState();
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
    syncTreeSelectionState();
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
  if (mode !== "edit" && state.immersive) setImmersiveEditing(false);
  if (state.mode === "view" && mode === "edit") {
    const readerMax = Math.max(1, els.markdownView.scrollHeight - els.markdownView.clientHeight);
    state.readerScrollRatio = readerMax > 0 ? els.markdownView.scrollTop / readerMax : 0;
  }
  state.mode = mode;
  document.body.classList.toggle("graph-mode", mode === "graph");
  lastInputLength = els.editor.value.length;
  lastInputValue = els.editor.value;
  els.readerPanel.classList.toggle("hidden", mode !== "view");
  els.editorPanel.classList.toggle("hidden", mode !== "edit");
  els.graphPanel.classList.toggle("hidden", mode !== "graph");
  els.saveBtn.classList.toggle("hidden", mode !== "edit" || !state.currentPath);
  els.formatBtn.classList.toggle("hidden", mode !== "edit" || !state.currentPath);
  els.viewBtn.classList.toggle("active", mode === "view");
  els.editBtn.classList.toggle("active", mode === "edit");
  els.graphBtn.classList.toggle("active", mode === "graph");
  updateMultiCursorDisplay();
  if (mode === "edit") {
    syncPreviewToEditor();
    requestAnimationFrame(() => {
      const editorMax = Math.max(1, els.editor.scrollHeight - els.editor.clientHeight);
      els.editor.scrollTop = Math.round(editorMax * (state.readerScrollRatio || 0));
    });
  }
  if (mode === "view") {
    els.markdownView.innerHTML = renderMarkdown(state.currentContent);
    renderOutline(state.currentContent);
  }
  if (mode !== "graph") stopGraphSimulation();
  if (mode === "graph") requestAnimationFrame(() => initGraph());
}

function resetUndo(content) {
  state.undo.stack = [content];
  state.undo.index = 0;
  state.undo.applying = false;
}

function contentByteLength(content) {
  return new TextEncoder().encode(String(content || "")).byteLength;
}

function updateLargeDocumentState(content, exact = false) {
  const value = String(content || "");
  const characterThreshold = Math.floor(LARGE_PREVIEW_BYTES / 3);
  if (exact || (!state.largeDocument && value.length > characterThreshold)
    || (state.largeDocument && value.length < characterThreshold)) {
    state.currentContentBytes = contentByteLength(value);
  }
  state.largeDocument = state.currentContentBytes > LARGE_PREVIEW_BYTES || value.length > LARGE_PREVIEW_BYTES;
  return state.largeDocument;
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
  updateLargeDocumentState(value);
  schedulePreviewUpdate();
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
  state.activeWorkspaceId = item.workspaceId || doc.path.split(":", 1)[0] || state.activeWorkspaceId;
  state.currentPath = doc.path;
  state.currentContent = doc.content;
  updateLargeDocumentState(doc.content, true);
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
  els.preview.classList.remove("preview-pending");
  if (state.largeDocument) {
    clearTimeout(state.previewTimer);
    els.preview.replaceChildren();
    state.previewLastContent = "";
    if (state.previewVisible) setPreviewVisible(false, { automatic: true });
  } else {
    if (state.previewAutoHidden) setPreviewVisible(true, { automatic: true });
    if (state.previewVisible) {
      els.preview.innerHTML = renderMarkdown(doc.content);
      state.previewLastContent = doc.content;
    } else {
      els.preview.replaceChildren();
      state.previewLastContent = "";
    }
  }
  els.editor.scrollTop = 0;
  els.preview.scrollTop = 0;
  state.syncPreviewScroll.ratio = 0;
  resetUndo(doc.content);
  lastInputLength = doc.content.length;
  lastInputValue = doc.content;
  setSaveStatus("\u4fdd\u5b58", false);
  syncTreeSelectionState();
  if (state.mode === "graph") scheduleGraphDraw();
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
    scheduleGraphDraw();
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

function renderCurrentPreview() {
  if (!state.previewVisible || state.mode !== "edit") return;
  if (state.previewLastContent === state.currentContent) {
    els.preview.classList.remove("preview-pending");
    syncPreviewToEditor();
    return;
  }
  els.preview.innerHTML = renderMarkdown(state.currentContent);
  els.preview.classList.remove("preview-pending");
  state.previewLastContent = state.currentContent;
  syncPreviewToEditor();
}

function schedulePreviewUpdate() {
  clearTimeout(state.previewTimer);
  if (!state.previewVisible || state.mode !== "edit") return;
  const length = state.currentContent.length;
  const wait = state.largeDocument ? LARGE_PREVIEW_DELAY : length > 500000 ? 420 : length > 100000 ? 240 : 120;
  els.preview.classList.toggle("preview-pending", state.largeDocument && state.previewLastContent !== state.currentContent);
  state.previewTimer = setTimeout(renderCurrentPreview, wait);
}

function setPreviewVisible(visible, { automatic = false } = {}) {
  state.previewVisible = Boolean(visible);
  if (!automatic) state.previewAutoHidden = false;
  else state.previewAutoHidden = !state.previewVisible;
  els.editorPanel.classList.toggle("preview-hidden", !state.previewVisible);
  els.previewToggleBtn.textContent = state.previewVisible ? "隐藏预览" : "显示预览";
  els.previewToggleBtn.setAttribute("aria-pressed", String(state.previewVisible));
  els.previewToggleBtn.textContent = state.previewVisible
    ? "\u9690\u85cf\u9884\u89c8"
    : state.largeDocument ? "\u663e\u793a\u9884\u89c8\uff08\u5927\u6587\u6863\uff09" : "\u663e\u793a\u9884\u89c8";
  if (state.previewVisible) {
    if (state.largeDocument) schedulePreviewUpdate();
    else requestAnimationFrame(renderCurrentPreview);
  } else {
    clearTimeout(state.previewTimer);
    els.preview.classList.remove("preview-pending");
  }
}

function setImmersiveEditing(enabled) {
  if (enabled && !state.currentPath) return showToast("请先打开一篇文档");
  const wasImmersive = state.immersive;
  state.immersive = Boolean(enabled);
  els.appShell.classList.toggle("immersive", state.immersive);
  document.body.classList.toggle("immersive-editing", state.immersive);
  els.focusModeBtn.textContent = state.immersive ? "退出沉浸" : "沉浸";
  els.focusModeBtn.setAttribute("aria-pressed", String(state.immersive));
  if (state.immersive) {
    if (!wasImmersive) state.previewBeforeImmersive = state.previewVisible;
    if (state.mode !== "edit") setMode("edit");
    setPreviewVisible(false);
    requestAnimationFrame(() => els.editor.focus());
  } else if (wasImmersive) {
    setPreviewVisible(state.previewBeforeImmersive);
  }
}

async function saveCurrentDoc({ refreshTree = false, keepEditorState = true } = {}) {
  if (!state.currentPath) return false;
  const content = els.editor.value;
  if (!refreshTree && content === state.lastSavedContent) return true;
  
  const selectionStart = keepEditorState ? els.editor.selectionStart : 0;
  const selectionEnd = keepEditorState ? els.editor.selectionEnd : 0;
  const scrollTop = keepEditorState ? els.editor.scrollTop : 0;
  
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
  updateLargeDocumentState(content);
  state.lastSavedContent = content;
  if (state.mode === "read") {
    els.markdownView.innerHTML = renderMarkdown(content);
    renderOutline(content);
  } else if (state.previewVisible) {
    els.preview.innerHTML = renderMarkdown(content);
    els.preview.classList.remove("preview-pending");
    state.previewLastContent = content;
  } else {
    state.previewLastContent = "";
  }
  state.graphReady = false;
  setSaveStatus(refreshTree ? "\u5df2\u4fdd\u5b58" : "\u5df2\u81ea\u52a8\u4fdd\u5b58", false);
  if (refreshTree) {
    const path = state.currentPath;
    await bootstrap(true);
    await openDoc(path);
    setMode("edit");
  }
  
  if (keepEditorState) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        els.editor.focus();
        els.editor.setSelectionRange(selectionStart, selectionEnd);
        els.editor.scrollTop = scrollTop;
      });
    });
  }
  
  return true;
}

const autoSaveCurrentDoc = debounce(async () => {
  if (state.mode !== "edit" || !state.currentPath) return;
  if (document.activeElement !== els.editor) return;
  try {
    await saveCurrentDoc({ keepEditorState: false });
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

function closeSemanticTagsModal() {
  els.semanticTagsModal.classList.add("hidden");
  state.semanticTagPreview = null;
}

async function previewSemanticTags() {
  els.semanticTagsPreview.textContent = "正在分析全库语义，请稍候...";
  els.applySemanticTagsBtn.disabled = true;
  try {
    const result = await api.post("/api/semantic-tags", {
      maxTags: Number(els.semanticTagsMax.value || 3),
      apply: false,
    });
    state.semanticTagPreview = result;
    if (!result.changed) {
      els.semanticTagsPreview.textContent = `已检查 ${result.total || 0} 篇文档，没有发现高置信度的新标签。`;
      return;
    }
    const rows = (result.changes || []).map((item) => `<div class="tag-preview-row"><span class="tag-preview-name">${escapeHtml(item.title || item.path)}</span><span class="tag-preview-tags">${escapeHtml((item.before || []).join(" · ") || "无")} → ${escapeHtml((item.after || []).join(" · "))}</span></div>`).join("");
    els.semanticTagsPreview.innerHTML = `<strong>将为 ${result.changed} / ${result.total} 篇文档更新标签</strong>${rows}${result.changed > 60 ? `<div class="muted">其余 ${result.changed - 60} 篇将在应用时一并处理。</div>` : ""}`;
    els.applySemanticTagsBtn.disabled = false;
  } catch (error) {
    els.semanticTagsPreview.textContent = error.message || "语义分析失败";
  }
}

function openSemanticTagsModal() {
  els.semanticTagsModal.classList.remove("hidden");
  previewSemanticTags();
}

async function applySemanticTags() {
  if (!state.semanticTagPreview?.changed) return;
  els.applySemanticTagsBtn.disabled = true;
  els.semanticTagsPreview.textContent = "正在写入标签...";
  try {
    const result = await api.post("/api/semantic-tags", {
      maxTags: Number(els.semanticTagsMax.value || 3),
      apply: true,
    });
    closeSemanticTagsModal();
    els.semanticTagsStatus.textContent = `已为 ${result.applied || 0} 篇文档适配标签`;
    state.graphReady = false;
    await bootstrap(true);
    showToast(`智能标签已应用：${result.applied || 0} 篇文档`);
  } catch (error) {
    els.semanticTagsPreview.textContent = error.message || "标签应用失败";
    els.applySemanticTagsBtn.disabled = false;
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
      state.expandedFolders.add(created.path);
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
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  els.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  els.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  els.canvas.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
}

async function initGraph(force = false) {
  if (!state.graphReady || force) {
    const graph = await api.get("/api/graph");
    state.graphSource = graph;
    state.graphLayouts.clear();
    state.graphLayoutPromises.clear();
    const layoutSeq = ++state.graphLayoutSeq;
    const layout = await getGraphLayoutForMode();
    if (layoutSeq !== state.graphLayoutSeq) return;
    state.graph = layout;
    state.graphReady = true;
    state.graphView.fitted = false;
  }
  resizeCanvas();
  refreshGraphView(!state.graphView.fitted);
  startGraphSimulation();
}

function graphModeName() {
  if (state.graphView.showTags && state.graphView.showKeywords) return "混合脉络";
  if (state.graphView.showTags) return "标签脉络";
  if (state.graphView.showKeywords) return "语义脉络";
  return "双链脉络";
}

function ensureGraphWorker() {
  if (state.graphWorker || state.graphWorkerFailed || typeof Worker === "undefined") return state.graphWorker;
  try {
    const worker = new Worker(GRAPH_WORKER_URL);
    worker.onmessage = (event) => {
      const { id, layout, error } = event.data || {};
      const pending = state.graphWorkerPending.get(id);
      if (!pending) return;
      state.graphWorkerPending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve(layout);
    };
    worker.onerror = (event) => {
      state.graphWorkerFailed = true;
      for (const pending of state.graphWorkerPending.values()) pending.reject(event.error || new Error("Graph worker unavailable"));
      state.graphWorkerPending.clear();
      worker.terminate();
      state.graphWorker = null;
    };
    state.graphWorker = worker;
  } catch {
    state.graphWorkerFailed = true;
  }
  return state.graphWorker;
}

function layoutGraphInWorker(graph) {
  const worker = ensureGraphWorker();
  if (!worker) return Promise.resolve(layoutGraph(graph));
  const id = ++state.graphWorkerSeq;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.graphWorkerPending.delete(id);
      reject(new Error("Graph worker timeout"));
    }, 20000);
    state.graphWorkerPending.set(id, {
      resolve: (layout) => { clearTimeout(timeout); resolve(layout); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    try {
      worker.postMessage({ id, graph });
    } catch (error) {
      clearTimeout(timeout);
      state.graphWorkerPending.delete(id);
      reject(error);
    }
  }).catch(() => layoutGraph(graph));
}

async function getGraphLayoutForMode() {
  const view = state.graphView;
  const key = `${Number(view.showTags)}${Number(view.showKeywords)}${Number(view.showMissing)}${Number(view.showOrphans)}`;
  if (state.graphLayouts.has(key)) return state.graphLayouts.get(key);
  if (state.graphLayoutPromises.has(key)) return state.graphLayoutPromises.get(key);
  const source = state.graphSource || { nodes: [], edges: [], stats: {} };
  const allowedTypes = new Set(["link"]);
  if (view.showTags) allowedTypes.add("tag");
  if (view.showKeywords) allowedTypes.add("keyword");
  if (view.showMissing) allowedTypes.add("missing");
  const edges = source.edges.filter((edge) => allowedTypes.has(edge.type)).map((edge) => ({ ...edge }));
  const attached = new Set();
  edges.forEach((edge) => {
    attached.add(edge.source);
    attached.add(edge.target);
  });
  const nodes = source.nodes
    .filter((node) => {
      if (node.kind === "tag" && !view.showTags) return false;
      if (node.kind === "keyword" && !view.showKeywords) return false;
      if (node.kind === "missing" && !view.showMissing) return false;
      if (node.kind === "doc") return attached.has(node.id) || view.showOrphans;
      return attached.has(node.id);
    })
    .map((node) => ({ ...node, modeOrphan: node.kind === "doc" && !attached.has(node.id) }));
  const promise = layoutGraphInWorker({ nodes, edges, stats: source.stats || {} }).then((layout) => {
    if (state.graphSource === source) state.graphLayouts.set(key, layout);
    if (state.graphLayoutPromises.get(key) === promise) state.graphLayoutPromises.delete(key);
    return layout;
  }).catch((error) => {
    if (state.graphLayoutPromises.get(key) === promise) state.graphLayoutPromises.delete(key);
    throw error;
  });
  state.graphLayoutPromises.set(key, promise);
  return promise;
}

async function applyGraphModeLayout() {
  if (!state.graphSource) return;
  const layoutSeq = ++state.graphLayoutSeq;
  state.graph = await getGraphLayoutForMode();
  if (layoutSeq !== state.graphLayoutSeq) return;
  state.graphView.fitted = false;
  refreshGraphView(true);
}

function graphHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function graphEdgeStrength(edge) {
  const typeWeight = edge.type === "link" ? 9 : edge.type === "missing" ? 7 : edge.type === "tag" ? 4 : 2;
  return typeWeight * (1 + Math.log2(1 + Math.max(1, edge.weight || 1)) * 0.24);
}

function buildNeuralBackbone(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  const centrality = new Map(nodes.map((node) => [node.id, 0]));
  edges.forEach((edge, index) => {
    edge.layoutIndex = index;
    edge.backbone = false;
    const strength = graphEdgeStrength(edge);
    adjacency.get(edge.source)?.push({ id: edge.target, edge, strength });
    adjacency.get(edge.target)?.push({ id: edge.source, edge, strength });
    centrality.set(edge.source, (centrality.get(edge.source) || 0) + strength);
    centrality.set(edge.target, (centrality.get(edge.target) || 0) + strength);
  });

  for (let pass = 0; pass < 4; pass += 1) {
    const next = new Map();
    let max = 1;
    for (const node of nodes) {
      const neighbors = adjacency.get(node.id) || [];
      const propagated = neighbors.reduce((sum, item) => sum + (centrality.get(item.id) || 0) * item.strength * 0.025, 0);
      const score = (centrality.get(node.id) || 0) * 0.72 + propagated;
      next.set(node.id, score);
      max = Math.max(max, score);
    }
    for (const node of nodes) centrality.set(node.id, next.get(node.id) / max);
  }
  nodes.forEach((node) => { node.centrality = centrality.get(node.id) || 0; });

  const parent = new Map(nodes.map((node) => [node.id, node.id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return false;
    parent.set(rootB, rootA);
    return true;
  };
  [...edges]
    .sort((a, b) => graphEdgeStrength(b) - graphEdgeStrength(a)
      || (centrality.get(b.source) || 0) + (centrality.get(b.target) || 0)
      - (centrality.get(a.source) || 0) - (centrality.get(a.target) || 0))
    .forEach((edge) => {
      if (union(edge.source, edge.target)) edge.backbone = true;
    });

  const tree = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges.filter((item) => item.backbone)) {
    tree.get(edge.source)?.push(edge.target);
    tree.get(edge.target)?.push(edge.source);
  }
  const componentNodes = new Map();
  for (const node of nodes) {
    const root = find(node.id);
    if (!componentNodes.has(root)) componentNodes.set(root, []);
    componentNodes.get(root).push(node);
  }
  const components = [...componentNodes.values()].sort((a, b) => b.length - a.length);
  const isolated = components.filter((component) => component.length === 1);
  const connected = components.filter((component) => component.length > 1);

  connected.forEach((component) => {
    const componentIds = new Set(component.map((node) => node.id));
    const root = [...component].sort((a, b) => {
      const docBiasA = a.kind === "doc" ? 0.18 : 0;
      const docBiasB = b.kind === "doc" ? 0.18 : 0;
      return b.centrality + docBiasB - a.centrality - docBiasA;
    })[0];
    root.layoutRoot = true;
    const children = new Map(component.map((node) => [node.id, []]));
    const depth = new Map([[root.id, 0]]);
    const queue = [root.id];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      for (const neighbor of tree.get(id) || []) {
        if (!componentIds.has(neighbor) || depth.has(neighbor)) continue;
        depth.set(neighbor, depth.get(id) + 1);
        children.get(id).push(neighbor);
        queue.push(neighbor);
      }
    }
    const subtree = new Map();
    const measure = (id) => {
      const childIds = children.get(id) || [];
      const size = childIds.length ? childIds.reduce((sum, child) => sum + measure(child), 0) : 1;
      subtree.set(id, size);
      return size;
    };
    measure(root.id);
    const maxLayer = new Map();
    depth.forEach((value) => maxLayer.set(value, (maxLayer.get(value) || 0) + 1));
    const ringRadius = new Map([...maxLayer].map(([level, count]) => [level, Math.max(level * 106, count * 23 / (Math.PI * 2))]));
    root.x = 0;
    root.y = 0;
    const place = (id, startAngle, endAngle) => {
      let angle = startAngle;
      const total = Math.max(1, subtree.get(id) || 1);
      for (const childId of children.get(id) || []) {
        const portion = (endAngle - startAngle) * (subtree.get(childId) || 1) / total;
        const childAngle = angle + portion / 2;
        const level = depth.get(childId) || 1;
        const radius = ringRadius.get(level) || level * 106;
        const child = byId.get(childId);
        child.x = Math.cos(childAngle) * radius;
        child.y = Math.sin(childAngle) * radius;
        place(childId, angle, angle + portion);
        angle += portion;
      }
    };
    place(root.id, -Math.PI, Math.PI);
    const extent = Math.max(120, ...component.map((node) => Math.hypot(node.x || 0, node.y || 0) + 38));
    component.layoutRadius = extent;
  });

  const mainRadius = connected[0]?.layoutRadius || 100;
  connected.forEach((component, index) => {
    if (index === 0) return;
    const angle = index * 2.399963;
    const distance = mainRadius + component.layoutRadius + 90 + Math.sqrt(index) * 55;
    const offsetX = Math.cos(angle) * distance;
    const offsetY = Math.sin(angle) * distance;
    component.forEach((node) => { node.x += offsetX; node.y += offsetY; });
  });
  const outerRadius = mainRadius + 150 + Math.sqrt(isolated.length) * 24;
  isolated.forEach((component, index) => {
    const node = component[0];
    const angle = -Math.PI / 2 + index * 2.399963;
    const radius = outerRadius + (index % 3) * 34;
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
  });
}

function layoutGraph(graph) {
  const nodes = graph.nodes.map((node) => ({
    ...node,
    label: node.label || node.id.split("/").pop(),
    vx: 0,
    vy: 0,
  }));
  buildNeuralBackbone(nodes, graph.edges);
  nodes.forEach((node) => {
    node.targetX = node.x;
    node.targetY = node.y;
  });

  const byId = new Map(nodes.map((node, index) => [node.id, { node, index }]));
  const springs = graph.edges
    .map((edge) => ({ edge, a: byId.get(edge.source)?.index, b: byId.get(edge.target)?.index }))
    .filter((item) => item.a !== undefined && item.b !== undefined);
  const iterations = nodes.length < 120 ? 72 : nodes.length < 420 ? 44 : 24;
  const fx = new Float64Array(nodes.length);
  const fy = new Float64Array(nodes.length);
  const cellSize = 96;

  for (let step = 0; step < iterations; step += 1) {
    fx.fill(0);
    fy.fill(0);
    const grid = new Map();
    nodes.forEach((node, index) => {
      const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(index);
    });

    nodes.forEach((node, index) => {
      const cx = Math.floor(node.x / cellSize);
      const cy = Math.floor(node.y / cellSize);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          for (const otherIndex of grid.get(`${cx + ox},${cy + oy}`) || []) {
            if (otherIndex <= index) continue;
            const other = nodes[otherIndex];
            let dx = other.x - node.x;
            let dy = other.y - node.y;
            let distanceSq = dx * dx + dy * dy;
            if (distanceSq < 1) {
              dx = 0.5 - graphHash(`${node.id}:${other.id}`);
              dy = 0.5 - graphHash(`${other.id}:${node.id}`);
              distanceSq = dx * dx + dy * dy;
            }
            if (distanceSq > 26000) continue;
            const distance = Math.sqrt(distanceSq);
            const force = 1120 / (distanceSq + 90);
            const pushX = (dx / distance) * force;
            const pushY = (dy / distance) * force;
            fx[index] -= pushX;
            fy[index] -= pushY;
            fx[otherIndex] += pushX;
            fy[otherIndex] += pushY;
          }
        }
      }
    });

    for (const spring of springs) {
      const a = nodes[spring.a];
      const b = nodes[spring.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired = spring.edge.type === "tag" ? 72 : spring.edge.type === "keyword" ? 88 : 104;
      const strength = spring.edge.backbone ? (spring.edge.type === "link" ? 0.02 : 0.014) : 0.0014;
      const pull = (distance - desired) * strength * Math.min(2, 0.7 + spring.edge.weight * 0.18);
      const pullX = (dx / distance) * pull;
      const pullY = (dy / distance) * pull;
      fx[spring.a] += pullX;
      fy[spring.a] += pullY;
      fx[spring.b] -= pullX;
      fy[spring.b] -= pullY;
    }

    nodes.forEach((node, index) => {
      const attraction = node.layoutRoot ? 0.12 : 0.028;
      fx[index] += (node.targetX - node.x) * attraction;
      fy[index] += (node.targetY - node.y) * attraction;
      node.vx = (node.vx + fx[index]) * 0.72;
      node.vy = (node.vy + fy[index]) * 0.72;
      const speed = Math.max(1, Math.hypot(node.vx, node.vy));
      const limit = Math.min(9, speed);
      node.x += (node.vx / speed) * limit;
      node.y += (node.vy / speed) * limit;
    });
  }

  return { nodes, edges: graph.edges, stats: graph.stats || {} };
}

function refreshGraphView(refit = false) {
  const view = state.graphView;
  const kindAllowed = (node) => {
    if (node.kind === "tag" && !view.showTags) return false;
    if (node.kind === "keyword" && !view.showKeywords) return false;
    if (node.kind === "doc" && (node.orphan || node.modeOrphan) && !view.showOrphans) return false;
    if (node.kind === "missing" && !view.showMissing) return false;
    return true;
  };
  let nodes = state.graph.nodes.filter(kindAllowed);
  let nodeIds = new Set(nodes.map((node) => node.id));
  let edges = state.graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  if (view.scope === "local" && state.currentPath && nodeIds.has(state.currentPath)) {
    const adjacency = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of edges) {
      adjacency.get(edge.source)?.push(edge.target);
      adjacency.get(edge.target)?.push(edge.source);
    }
    const visible = new Set([state.currentPath]);
    let frontier = [state.currentPath];
    for (let depth = 0; depth < view.depth; depth += 1) {
      const next = [];
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) || []) {
          if (visible.has(neighbor)) continue;
          visible.add(neighbor);
          next.push(neighbor);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    nodes = nodes.filter((node) => visible.has(node.id));
    nodeIds = visible;
    edges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  }

  const attached = new Set();
  for (const edge of edges) {
    attached.add(edge.source);
    attached.add(edge.target);
  }
  nodes = nodes.filter((node) => node.kind === "doc" || attached.has(node.id));
  nodeIds = new Set(nodes.map((node) => node.id));
  edges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  view.visibleNodes = nodes;
  view.visibleEdges = edges;
  // Visible graph arrays define the lifetime of all simulation caches. A
  // filter/scope change gets a fresh cache; ordinary frames and pointer moves
  // keep reusing the same indexes, springs, force buffers and spatial buckets.
  view.simulationCache = null;
  const docCount = nodes.filter((node) => node.kind === "doc").length;
  const backboneCount = edges.filter((edge) => edge.backbone).length;
  const totalDocs = state.graph.stats?.documents || docCount;
  const docLabel = docCount === totalDocs ? `${docCount}` : `${docCount}/${totalDocs}`;
  els.graphStats.textContent = `${graphModeName()} · ${docLabel} 篇文档 · ${backboneCount} 条主干 · ${edges.length} 条关联`;
  resizeCanvas();
  if (refit || !view.fitted) fitGraphView();
  else scheduleGraphDraw();
}

function graphPoint(node) {
  const view = state.graphView;
  return { x: node.x * view.scale + view.tx, y: node.y * view.scale + view.ty };
}

function constrainGraphPan() {
  const nodes = state.graphView.visibleNodes;
  const rect = els.canvas.getBoundingClientRect();
  if (!nodes.length || !rect.width || !rect.height) return;
  const view = state.graphView;
  const minX = Math.min(...nodes.map((node) => node.x)) * view.scale;
  const maxX = Math.max(...nodes.map((node) => node.x)) * view.scale;
  const minY = Math.min(...nodes.map((node) => node.y)) * view.scale;
  const maxY = Math.max(...nodes.map((node) => node.y)) * view.scale;
  const marginX = Math.min(180, rect.width * 0.24);
  const marginY = Math.min(150, rect.height * 0.24);
  view.tx = clamp(view.tx, marginX - maxX, rect.width - marginX - minX);
  view.ty = clamp(view.ty, marginY - maxY, rect.height - marginY - minY);
}

function screenToGraph(clientX, clientY) {
  const rect = els.canvas.getBoundingClientRect();
  const view = state.graphView;
  return {
    x: (clientX - rect.left - view.tx) / view.scale,
    y: (clientY - rect.top - view.ty) / view.scale,
  };
}

function fitGraphView() {
  const nodes = state.graphView.visibleNodes;
  const rect = els.canvas.getBoundingClientRect();
  if (!nodes.length || !rect.width || !rect.height) return scheduleGraphDraw();
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y));
  const padding = Math.min(110, Math.max(54, Math.min(rect.width, rect.height) * 0.14));
  const scale = Math.min(
    (rect.width - padding * 2) / Math.max(120, maxX - minX),
    (rect.height - padding * 2) / Math.max(120, maxY - minY),
    1.65,
  );
  state.graphView.scale = clamp(scale, 0.12, 2.8);
  state.graphView.tx = rect.width / 2 - ((minX + maxX) / 2) * state.graphView.scale;
  state.graphView.ty = rect.height / 2 - ((minY + maxY) / 2) * state.graphView.scale;
  state.graphView.fitted = true;
  scheduleGraphDraw();
}

function zoomGraph(factor, clientX, clientY) {
  const rect = els.canvas.getBoundingClientRect();
  const px = clientX === undefined ? rect.left + rect.width / 2 : clientX;
  const py = clientY === undefined ? rect.top + rect.height / 2 : clientY;
  const before = screenToGraph(px, py);
  state.graphView.scale = clamp(state.graphView.scale * factor, 0.12, 4);
  state.graphView.tx = px - rect.left - before.x * state.graphView.scale;
  state.graphView.ty = py - rect.top - before.y * state.graphView.scale;
  state.graphView.fitted = true;
  scheduleGraphDraw();
}

function getGraphPalette() {
  const style = getComputedStyle(document.body);
  const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    text: color("--graph-text", "#263244"),
    muted: color("--graph-muted", "#7a8798"),
    edge: color("--graph-edge", "rgba(100, 116, 139, .32)"),
    link: color("--graph-link", "#14b8a6"),
    doc: color("--graph-doc", "#ffffff"),
    docBorder: color("--graph-doc-border", "#94a3b8"),
    tag: color("--graph-tag", "#f59e0b"),
    keyword: color("--graph-keyword", "#8b5cf6"),
    missing: color("--graph-missing", "#ef6a6a"),
    active: color("--graph-active", "#10b981"),
    labelBg: color("--graph-label-bg", "rgba(255,255,255,.86)"),
  };
}

function graphNodeRadius(node) {
  const base = node.kind === "doc" ? 5.5 : node.kind === "tag" ? 5 : node.kind === "keyword" ? 4.5 : 4;
  return base + Math.min(8, Math.sqrt(Math.max(0, node.degree || node.weight || 1)) * 1.45);
}

function graphGridKey(cellX, cellY) {
  // Graph coordinates remain several orders of magnitude below this stride,
  // so a number key is both collision-free in practice and allocation-free.
  return cellX * 131071 + cellY;
}

const EMPTY_GRAPH_BUCKET = [];

function getGraphSimulationCache(nodes = state.graphView.visibleNodes, edges = state.graphView.visibleEdges) {
  const previous = state.graphView.simulationCache;
  if (previous?.nodes === nodes && previous?.edges === edges) return previous;

  const nodeIndex = new Map();
  const nodeById = new Map();
  nodes.forEach((node, index) => {
    nodeIndex.set(node.id, index);
    nodeById.set(node.id, node);
  });
  const springs = [];
  const adjacency = Array.from({ length: nodes.length }, () => []);
  for (const edge of edges) {
    const a = nodeIndex.get(edge.source);
    const b = nodeIndex.get(edge.target);
    if (a === undefined || b === undefined) continue;
    springs.push({ edge, a, b });
    adjacency[a].push({ index: b, edge });
    adjacency[b].push({ index: a, edge });
  }

  const cache = {
    nodes,
    edges,
    nodeIndex,
    nodeById,
    springs,
    adjacency,
    fx: new Float64Array(nodes.length),
    fy: new Float64Array(nodes.length),
    phases: Float64Array.from(nodes, (node) => graphHash(node.id) * Math.PI * 2),
    radii: Float64Array.from(nodes, graphNodeRadius),
    forceGrid: new Map(),
    forceBuckets: [],
    forceCellX: new Int32Array(nodes.length),
    forceCellY: new Int32Array(nodes.length),
    collisionGrid: new Map(),
    collisionBuckets: [],
    collisionCellX: new Int32Array(nodes.length),
    collisionCellY: new Int32Array(nodes.length),
    visitMarks: new Uint32Array(nodes.length),
    visitToken: 0,
    frontierA: [],
    frontierB: [],
    connected: new Set(),
    matches: new Set(),
    matchQuery: null,
    maxEnergy: 0,
  };
  state.graphView.simulationCache = cache;
  return cache;
}

function fillGraphSpatialGrid(grid, buckets, cellX, cellY, nodes, cellSize) {
  grid.clear();
  let bucketCount = 0;
  nodes.forEach((node, index) => {
    const x = Math.floor(node.x / cellSize);
    const y = Math.floor(node.y / cellSize);
    cellX[index] = x;
    cellY[index] = y;
    const key = graphGridKey(x, y);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = buckets[bucketCount] || [];
      buckets[bucketCount] = bucket;
      bucketCount += 1;
      bucket.length = 0;
      grid.set(key, bucket);
    }
    bucket.push(index);
  });
  return grid;
}

function relaxGraphCollisions(pinnedNode = null, passes = 2) {
  const nodes = state.graphView.visibleNodes;
  if (nodes.length < 2) return false;
  const cache = getGraphSimulationCache(nodes, state.graphView.visibleEdges);
  const scale = clamp(state.graphView.scale, 0.55, 1.25);
  let moved = false;
  for (let pass = 0; pass < passes; pass += 1) {
    const cellSize = 54 / scale;
    const grid = fillGraphSpatialGrid(
      cache.collisionGrid,
      cache.collisionBuckets,
      cache.collisionCellX,
      cache.collisionCellY,
      nodes,
      cellSize,
    );
    nodes.forEach((node, index) => {
      const cx = cache.collisionCellX[index];
      const cy = cache.collisionCellY[index];
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          for (const otherIndex of grid.get(graphGridKey(cx + ox, cy + oy)) || EMPTY_GRAPH_BUCKET) {
            if (otherIndex <= index) continue;
            const other = nodes[otherIndex];
            let dx = other.x - node.x;
            let dy = other.y - node.y;
            let distance = Math.hypot(dx, dy);
            if (distance < 0.01) {
              const angle = graphHash(`${node.id}|${other.id}`) * Math.PI * 2;
              dx = Math.cos(angle);
              dy = Math.sin(angle);
              distance = 1;
            }
            const minimum = (cache.radii[index] + cache.radii[otherIndex] + 13) / scale;
            if (distance >= minimum) continue;
            const overlap = minimum - distance;
            const ux = dx / distance;
            const uy = dy / distance;
            if (node === pinnedNode) {
              other.x += ux * overlap;
              other.y += uy * overlap;
            } else if (other === pinnedNode) {
              node.x -= ux * overlap;
              node.y -= uy * overlap;
            } else {
              node.x -= ux * overlap * 0.5;
              node.y -= uy * overlap * 0.5;
              other.x += ux * overlap * 0.5;
              other.y += uy * overlap * 0.5;
            }
            moved = true;
          }
        }
      }
    });
  }
  return moved;
}

function animateGraphRelaxation(frames = 12) {
  if (state.graphView.dynamic) {
    startGraphSimulation();
    return;
  }
  if (state.graphView.relaxFrame) cancelAnimationFrame(state.graphView.relaxFrame);
  const settle = (remaining) => {
    state.graphView.relaxFrame = 0;
    if (!relaxGraphCollisions(null, remaining > 5 ? 2 : 1) || remaining <= 1) {
      scheduleGraphDraw();
      return;
    }
    scheduleGraphDraw();
    state.graphView.relaxFrame = requestAnimationFrame(() => settle(remaining - 1));
  };
  state.graphView.relaxFrame = requestAnimationFrame(() => settle(frames));
}

function startGraphRebound(previousPositions) {
  if (state.graphView.reboundAnimation) cancelAnimationFrame(state.graphView.reboundAnimation);
  stopGraphSimulation();
  const items = state.graphView.visibleNodes
    .map((node) => ({ node, fromX: node.x, fromY: node.y, to: previousPositions.get(node.id) }))
    .filter((item) => item.to);
  if (!items.length) return;
  const started = performance.now();
  const duration = 1250;
  const tick = (now) => {
    const progress = clamp((now - started) / duration, 0, 1);
    // Damped spring: it overshoots subtly, then settles at the pre-drag layout.
    const eased = progress >= 1
      ? 1
      : 1 - Math.exp(-5.2 * progress) * Math.cos(11.5 * progress);
    for (const item of items) {
      item.node.x = item.fromX + (item.to.x - item.fromX) * eased;
      item.node.y = item.fromY + (item.to.y - item.fromY) * eased;
      item.node.energy = Math.max(item.node.energy || 0, 0.35 * (1 - progress));
    }
    scheduleGraphDraw();
    if (progress < 1) {
      state.graphView.reboundAnimation = requestAnimationFrame(tick);
    } else {
      state.graphView.reboundAnimation = 0;
      if (state.graphView.dynamic) startGraphSimulation();
    }
  };
  state.graphView.reboundAnimation = requestAnimationFrame(tick);
}

function exciteGraphNode(source, dragDx = 0, dragDy = 0) {
  const nodes = state.graphView.visibleNodes;
  const cache = getGraphSimulationCache(nodes, state.graphView.visibleEdges);
  const sourceIndex = cache.nodeIndex.get(source.id);
  if (sourceIndex === undefined) return;
  // Keep a short-lived wave alive after every pointer move.  This is
  // intentionally independent from the persistent "dynamic" toggle: a
  // deliberate drag should always produce a visible chain response.
  state.graphView.chainUntil = performance.now() + 2200;
  source.vx = dragDx * 1.15;
  source.vy = dragDy * 1.15;
  source.energy = 1;
  cache.visitToken = (cache.visitToken + 1) >>> 0;
  if (!cache.visitToken) {
    cache.visitMarks.fill(0);
    cache.visitToken = 1;
  }
  cache.visitMarks[sourceIndex] = cache.visitToken;
  let frontier = cache.frontierA;
  let next = cache.frontierB;
  frontier.length = 0;
  next.length = 0;
  frontier.push(sourceIndex);
  for (let depth = 1; depth <= 3; depth += 1) {
    next.length = 0;
    for (const itemIndex of frontier) {
      const item = nodes[itemIndex];
      for (const relation of cache.adjacency[itemIndex]) {
        const targetIndex = relation.index;
        if (cache.visitMarks[targetIndex] === cache.visitToken) continue;
        cache.visitMarks[targetIndex] = cache.visitToken;
        const target = nodes[targetIndex];
        const dx = item.x - target.x;
        const dy = item.y - target.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const edgePower = relation.edge.backbone ? 0.8 : 0.22;
        const falloff = edgePower / depth;
        // Transfer part of the pointer displacement immediately.  Forces
        // alone only create a delayed pull, which looks like a static line
        // while the source is pinned during the drag.
        const transfer = relation.edge.backbone
          ? ([0.8, 0.42, 0.2][depth - 1] || 0.12)
          : ([0.58, 0.3, 0.14][depth - 1] || 0.08);
        target.x += dragDx * transfer;
        target.y += dragDy * transfer;
        target.vx += (dx / distance) * falloff + dragDx * (0.42 / depth);
        target.vy += (dy / distance) * falloff + dragDy * (0.42 / depth);
        target.energy = Math.max(target.energy || 0, 1 / (depth * 1.15));
        next.push(targetIndex);
      }
    }
    const previous = frontier;
    frontier = next;
    next = previous;
    if (!frontier.length) break;
  }
  startGraphSimulation();
}

function graphMotionReduced() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function stopGraphSimulation() {
  if (state.graphView.simulationFrame) cancelAnimationFrame(state.graphView.simulationFrame);
  if (state.graphView.simulationTimer) clearTimeout(state.graphView.simulationTimer);
  state.graphView.simulationFrame = 0;
  state.graphView.simulationTimer = 0;
  state.graphView.simulationLastTime = 0;
}

function graphSimulationInterval(now, cache) {
  const count = cache.nodes.length;
  const urgent = Boolean(state.graphDrag) || now < state.graphView.chainUntil || now < state.graphView.reboundUntil;
  if (urgent) return count > 900 ? 42 : count > 500 ? 36 : 30;
  if (state.graphView.hoveredId || cache.maxEnergy > 0.08) return count > 900 ? 56 : count > 500 ? 45 : 40;
  return count > 900 ? 100 : count > 500 ? 80 : count > 250 ? 66 : 50;
}

function queueGraphSimulation(delay = 0) {
  if (state.graphView.simulationFrame || state.graphView.simulationTimer) return;
  if (delay <= 12) {
    state.graphView.simulationFrame = requestAnimationFrame(runGraphSimulation);
    return;
  }
  state.graphView.simulationTimer = window.setTimeout(() => {
    state.graphView.simulationTimer = 0;
    state.graphView.simulationFrame = requestAnimationFrame(runGraphSimulation);
  }, Math.max(0, delay - 8));
}

function startGraphSimulation() {
  const now = performance.now();
  if ((!state.graphView.dynamic && now > state.graphView.chainUntil && now > state.graphView.reboundUntil) || graphMotionReduced()) return;
  if (state.mode !== "graph" || document.hidden) return;
  const urgent = Boolean(state.graphDrag) || now < state.graphView.chainUntil || now < state.graphView.reboundUntil;
  if (urgent && state.graphView.simulationTimer) {
    clearTimeout(state.graphView.simulationTimer);
    state.graphView.simulationTimer = 0;
  }
  if (!state.graphView.simulationLastTime) state.graphView.simulationLastTime = now;
  queueGraphSimulation(urgent ? 0 : graphSimulationInterval(now, getGraphSimulationCache()));
}

function runGraphSimulation(timestamp) {
  state.graphView.simulationFrame = 0;
  const temporaryChain = timestamp < state.graphView.chainUntil;
  const rebound = timestamp < state.graphView.reboundUntil;
  if ((!state.graphView.dynamic && !temporaryChain && !rebound) || state.mode !== "graph" || document.hidden || graphMotionReduced()) return;
  const nodes = state.graphView.visibleNodes;
  if (!nodes.length) return;
  const cache = getGraphSimulationCache(nodes, state.graphView.visibleEdges);
  const frameBudget = graphSimulationInterval(timestamp, cache);
  const elapsed = timestamp - state.graphView.simulationLastTime;
  if (elapsed < frameBudget) {
    queueGraphSimulation(frameBudget - elapsed);
    return;
  }
  state.graphView.simulationLastTime = timestamp;
  state.graphView.motionTime = timestamp;
  const dt = clamp(elapsed / 33.333, 0.55, 1.8);
  const fx = cache.fx;
  const fy = cache.fy;
  fx.fill(0);
  fy.fill(0);
  const cellSize = 155;
  const grid = fillGraphSpatialGrid(
    cache.forceGrid,
    cache.forceBuckets,
    cache.forceCellX,
    cache.forceCellY,
    nodes,
    cellSize,
  );
  nodes.forEach((node, index) => {
    const cx = cache.forceCellX[index];
    const cy = cache.forceCellY[index];
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        for (const otherIndex of grid.get(graphGridKey(cx + ox, cy + oy)) || EMPTY_GRAPH_BUCKET) {
          if (otherIndex <= index) continue;
          const other = nodes[otherIndex];
          let dx = other.x - node.x;
          let dy = other.y - node.y;
          let distanceSq = dx * dx + dy * dy;
          if (distanceSq < 1) {
            const angle = graphHash(`${node.id}|${other.id}`) * Math.PI * 2;
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            distanceSq = 1;
          }
          if (distanceSq > 42000) continue;
          const distance = Math.sqrt(distanceSq);
          const force = 24 / (1 + distanceSq / 900);
          const pushX = (dx / distance) * force;
          const pushY = (dy / distance) * force;
          fx[index] -= pushX;
          fy[index] -= pushY;
          fx[otherIndex] += pushX;
          fy[otherIndex] += pushY;
        }
      }
    }
  });
  for (const spring of cache.springs) {
    const { edge, a: aIndex, b: bIndex } = spring;
    const a = nodes[aIndex];
    const b = nodes[bIndex];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const desired = edge.type === "tag" ? 78 : edge.type === "keyword" ? 94 : 112;
    const strength = edge.backbone ? 0.038 : 0.006;
    const pull = clamp((distance - desired) * strength, -5, 5);
    const pullX = (dx / distance) * pull;
    const pullY = (dy / distance) * pull;
    fx[aIndex] += pullX;
    fy[aIndex] += pullY;
    fx[bIndex] -= pullX;
    fy[bIndex] -= pullY;
  }
  const pinned = state.graphDrag?.type === "node" ? state.graphDrag.node : null;
  let maxEnergy = 0;
  nodes.forEach((node, index) => {
    if (node === pinned) {
      node.vx = 0;
      node.vy = 0;
      node.energy = 1;
      maxEnergy = 1;
      return;
    }
    const phase = cache.phases[index];
    const drift = node.layoutRoot ? 0.026 : 0.078;
    fx[index] += Math.sin(timestamp * 0.00047 + phase) * drift;
    fy[index] += Math.cos(timestamp * 0.00039 + phase * 1.31) * drift;
    const returnStrength = rebound
      ? (node.layoutRoot ? 0.075 : 0.052)
      : (node.layoutRoot ? 0.006 : 0.0014);
    fx[index] += (node.targetX - node.x) * returnStrength;
    fy[index] += (node.targetY - node.y) * returnStrength;
    node.vx = (node.vx + fx[index] * dt) * 0.88;
    node.vy = (node.vy + fy[index] * dt) * 0.88;
    node.energy = Math.max(0, (node.energy || 0) * 0.95);
    maxEnergy = Math.max(maxEnergy, node.energy);
    const speed = Math.max(0.001, Math.hypot(node.vx, node.vy));
    const limit = Math.min(node.layoutRoot ? 1.5 : 3.2, speed);
    node.x += (node.vx / speed) * limit * dt;
    node.y += (node.vy / speed) * limit * dt;
  });
  cache.maxEnergy = maxEnergy;
  relaxGraphCollisions(pinned, 1);
  scheduleGraphDraw();
  queueGraphSimulation(graphSimulationInterval(timestamp, cache));
}

function scheduleGraphDraw() {
  if (state.graphView.frame) return;
  state.graphView.frame = requestAnimationFrame(() => {
    state.graphView.frame = 0;
    drawGraph();
  });
}

function drawGraph() {
  if (state.mode !== "graph") return;
  const ctx = els.canvas.getContext("2d");
  const rect = els.canvas.getBoundingClientRect();
  // Clear the complete backing store in physical pixels. Clearing with the
  // DPR transform still active can leave a stale strip after browser zoom or
  // a resize, which looks like the network was rendered twice at the bottom.
  const ratio = rect.width > 0 ? els.canvas.width / rect.width : 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const nodes = state.graphView.visibleNodes;
  if (!nodes.length) {
    ctx.fillStyle = getGraphPalette().muted;
    ctx.font = `500 13px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillText(text.noGraph, 24, 32);
    return;
  }

  const palette = getGraphPalette();
  const view = state.graphView;
  const point = graphPoint;
  const cache = getGraphSimulationCache(nodes, view.visibleEdges);
  const byId = cache.nodeById;
  const focusId = view.hoveredId;
  const connected = cache.connected;
  connected.clear();
  if (focusId) connected.add(focusId);
  if (focusId) {
    for (const edge of view.visibleEdges) {
      if (edge.source === focusId) connected.add(edge.target);
      if (edge.target === focusId) connected.add(edge.source);
    }
  }
  const query = view.query.trim().toLowerCase();
  const matches = cache.matches;
  if (cache.matchQuery !== query) {
    cache.matchQuery = query;
    matches.clear();
    if (query) {
      for (const node of nodes) {
        if (`${node.label} ${node.group}`.toLowerCase().includes(query)) matches.add(node.id);
      }
    }
  }

  ctx.lineCap = "round";
  for (const edge of view.visibleEdges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;
    const pa = point(a);
    const pb = point(b);
    const focused = !focusId || edge.source === focusId || edge.target === focusId;
    const queryRelated = !query || matches.has(edge.source) || matches.has(edge.target);
    if (edge.type === "keyword" && !edge.backbone && view.scale < 0.9 && !focusId && !query) continue;
    if ((pa.x < -40 && pb.x < -40) || (pa.x > rect.width + 40 && pb.x > rect.width + 40)
      || (pa.y < -40 && pb.y < -40) || (pa.y > rect.height + 40 && pb.y > rect.height + 40)) continue;
    ctx.strokeStyle = edge.type === "link" || edge.type === "missing" ? palette.link : edge.type === "tag" ? palette.tag : edge.type === "keyword" ? palette.keyword : palette.edge;
    const energy = clamp(((a.energy || 0) + (b.energy || 0)) * 0.5, 0, 1);
    // Keep the graph structure legible without letting the links overpower
    // document/topic nodes. Energy from an active drag can still brighten a
    // local chain, while idle connections stay deliberately subdued.
    const baseAlpha = edge.backbone ? (edge.type === "link" ? 0.48 : 0.3) : (edge.type === "link" ? 0.11 : 0.045);
    ctx.globalAlpha = focused && queryRelated ? Math.min(0.78, baseAlpha + energy * 0.24) : 0.022;
    ctx.lineWidth = (edge.backbone ? 0.86 : 0.34) + Math.min(1.35, edge.weight * (edge.backbone ? 0.14 : 0.055)) + energy * 0.8;
    ctx.shadowColor = edge.backbone && focused ? ctx.strokeStyle : "transparent";
    ctx.shadowBlur = edge.backbone && focused ? 3 + energy * 6 : 0;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const bendSign = graphHash(`${edge.source}|${edge.target}`) > 0.5 ? 1 : -1;
    const bend = Math.min(22, distance * 0.08) * bendSign;
    const controlX = (pa.x + pb.x) / 2 - (dy / distance) * bend;
    const controlY = (pa.y + pb.y) / 2 + (dx / distance) * bend;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.quadraticCurveTo(controlX, controlY, pb.x, pb.y);
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (edge.directed && focused && view.scale > 0.45) {
      const angle = Math.atan2(pb.y - controlY, pb.x - controlX);
      const targetRadius = graphNodeRadius(b) + 3;
      const ax = pb.x - Math.cos(angle) * targetRadius;
      const ay = pb.y - Math.sin(angle) * targetRadius;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - Math.cos(angle - 0.55) * 5, ay - Math.sin(angle - 0.55) * 5);
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - Math.cos(angle + 0.55) * 5, ay - Math.sin(angle + 0.55) * 5);
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
  const labelCandidates = [];
  const motionTime = view.motionTime || performance.now();
  for (const node of nodes) {
    const p = point(node);
    const active = node.id === state.selectedNode;
    const hovered = node.id === focusId;
    const related = !focusId || connected.has(node.id);
    const queryMatch = !query || matches.has(node.id);
    const energy = clamp(node.energy || 0, 0, 1);
    const idlePulse = view.dynamic ? Math.sin(motionTime * 0.002 + graphHash(node.id) * Math.PI * 2) * 0.025 : 0;
    const radius = graphNodeRadius(node) * clamp(view.scale, 0.72, 1.18) * (1 + idlePulse + energy * 0.2);
    const kindColor = node.kind === "tag" ? palette.tag : node.kind === "keyword" ? palette.keyword : node.kind === "missing" ? palette.missing : palette.doc;
    ctx.globalAlpha = related && queryMatch ? 1 : query && matches.has(node.id) ? 1 : 0.18;
    ctx.fillStyle = active || hovered ? palette.active : kindColor;
    ctx.strokeStyle = active || hovered ? palette.active : node.kind === "doc" ? palette.docBorder : kindColor;
    ctx.lineWidth = active || hovered ? 2.6 : 1.2;
    ctx.shadowColor = active || hovered ? palette.active : energy > 0.08 ? kindColor : "transparent";
    ctx.shadowBlur = active || hovered ? 14 : energy > 0.08 ? 5 + energy * 9 : 0;
    ctx.beginPath();
    if (node.kind === "tag") {
      ctx.moveTo(p.x, p.y - radius);
      ctx.lineTo(p.x + radius, p.y);
      ctx.lineTo(p.x, p.y + radius);
      ctx.lineTo(p.x - radius, p.y);
      ctx.closePath();
    } else if (node.kind === "keyword") {
      for (let side = 0; side < 6; side += 1) {
        const angle = -Math.PI / 2 + side * Math.PI / 3;
        const x = p.x + Math.cos(angle) * radius;
        const y = p.y + Math.sin(angle) * radius;
        if (side === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    } else {
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    }
    ctx.fill();
    if (node.kind === "missing") ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    const importantHub = node.kind !== "doc" && (node.degree || 0) >= 4;
    const tagModeLabel = view.showTags && !view.showKeywords && node.kind === "tag" && view.scale > 0.34;
    const semanticModeLabel = !view.showTags && view.showKeywords && node.kind === "keyword"
      && (node.degree || 0) >= 3 && view.scale > 0.54;
    const showLabel = hovered || active || matches.has(node.id)
      || (node.layoutRoot && view.scale > 0.58)
      || tagModeLabel
      || semanticModeLabel
      || (view.scale > 0.9 && importantHub)
      || (view.scale > 1.15 && node.kind === "doc" && (node.degree || 0) >= 3)
      || (view.scale > 1.65 && node.kind === "doc");
    if (showLabel) labelCandidates.push({ node, p, radius, active, hovered, related, queryMatch });
  }

  const occupied = [];
  labelCandidates.sort((a, b) => Number(b.hovered || b.active || matches.has(b.node.id)) - Number(a.hovered || a.active || matches.has(a.node.id))
    || (b.node.degree || 0) - (a.node.degree || 0));
  for (const item of labelCandidates) {
    const label = compactName(item.node.label, view.scale > 1 ? 28 : 20);
    ctx.font = item.hovered || item.active ? "700 12px Segoe UI, Microsoft YaHei" : "600 11px Segoe UI, Microsoft YaHei";
    const width = ctx.measureText(label).width;
    const labelX = item.p.x + item.radius + 7;
    const labelY = item.p.y + 4;
    const box = { x: labelX - 3, y: labelY - 12, width: width + 7, height: 17 };
    const overlaps = occupied.some((other) => box.x < other.x + other.width + 4 && box.x + box.width + 4 > other.x
      && box.y < other.y + other.height + 3 && box.y + box.height + 3 > other.y);
    if (overlaps && !item.hovered && !item.active && !matches.has(item.node.id)) continue;
    occupied.push(box);
    ctx.globalAlpha = item.related && item.queryMatch ? 0.94 : 0.28;
    ctx.fillStyle = palette.labelBg;
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.fillStyle = palette.text;
    ctx.fillText(label, labelX, labelY);
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

function hitGraph(event) {
  const nodes = state.graphView.visibleNodes;
  if (!nodes.length) return null;
  const rect = els.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    const point = graphPoint(node);
    if (Math.hypot(point.x - x, point.y - y) <= Math.max(12, graphNodeRadius(node) * state.graphView.scale + 5)) return node;
  }
  return null;
}

function updateGraphTooltip(node, event) {
  if (!node) {
    els.graphTooltip.classList.add("hidden");
    return;
  }
  const kindNames = { doc: "文档", tag: "显式标签（# / frontmatter）", keyword: "语义概念（自动提取）", missing: "未创建链接" };
  els.graphTooltip.textContent = `${node.label} · ${kindNames[node.kind] || "节点"} · ${node.degree || 0} 条关联`;
  const rect = els.canvas.getBoundingClientRect();
  els.graphTooltip.style.left = `${Math.min(rect.width - 180, Math.max(10, event.clientX - rect.left + 14))}px`;
  els.graphTooltip.style.top = `${Math.min(rect.height - 44, Math.max(10, event.clientY - rect.top + 14))}px`;
  els.graphTooltip.classList.remove("hidden");
}

async function activateGraphNode(node) {
  if (!node) return;
  if (node.kind === "doc") {
    await openDoc(node.id);
    setMode("view");
    return;
  }
  if (node.kind === "missing") {
    showToast(`尚未创建文档：${node.label}`);
    return;
  }
  const query = node.kind === "tag" ? node.label.replace(/^#/, "") : node.label;
  els.graphSearchInput.value = query;
  state.graphView.query = query.toLowerCase();
  scheduleGraphDraw();
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
    const cnMatch = lines[i].match(/^(\s*)(##\s*)?([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (cnMatch) {
      const cnIndent = cnMatch[1].length;
      const hasMdPrefix = !!cnMatch[2];
      const currentIndent = indent.length;
      if (hasMdPrefix && cnIndent <= currentIndent) {
        parentHeadingLevel = 2;
        parentHeadingLine = i;
        break;
      }
    }
    const hMatch = lines[i].match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const hLevel = hMatch[2].length;
      const hIndent = hMatch[1].length;
      const currentIndent = indent.length;
      if (hLevel <= 3 && hIndent <= currentIndent) {
        parentHeadingLevel = hLevel;
        parentHeadingLine = i;
        break;
      }
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
    
    let match;
    if (patternType === "arabic") {
      match = currentLine.match(/^(\s*)(?:##\s*)?(\d+)([.)、])(.*)$/);
      if (match && match[1] === indent && match[3] === separator) {
        rows.push({ lineIndex: i, lineStart: lines.slice(0, i).reduce((acc, ll) => acc + ll.length + 1, 0), number: Number(match[2]), prefix: match[1], sep: match[3], rest: match[4], original: currentLine, mdPrefix: currentLine.includes("##") ? "## " : "" });
      } else {
        // 检查是否遇到更高层级的标题（表示新的段落开始）
        const hMatch = currentLine.match(/^(\s*)(#{1,6})\s+(.+)$/);
        if (hMatch) {
          const hLevel = hMatch[2].length;
          const hIndent = hMatch[1].length;
          const currentIndent = indent.length;
          if (hLevel <= 3 && hIndent <= currentIndent) {
            break;
          }
        }
        const cnMatch = currentLine.match(/^(\s*)(##\s*)?([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
        if (cnMatch) {
          const cnIndent = cnMatch[1].length;
          const hasMdPrefix = !!cnMatch[2];
          const currentIndent = indent.length;
          if (hasMdPrefix && cnIndent <= currentIndent) {
            break;
          }
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
      }
    } else if (patternType === "chinese") {
      match = currentLine.match(/^(\s*)(##\s*)?([一二三四五六七八九十百千]{1,6})([.)、])(.*)$/);
      if (match && match[1] === indent && match[4] === separator) {
        const num = parseChineseNumber(match[3]);
        if (num > 0) {
          rows.push({ lineIndex: i, lineStart: lines.slice(0, i).reduce((acc, ll) => acc + ll.length + 1, 0), number: num, prefix: match[1], sep: match[4], rest: match[5], original: currentLine, mdPrefix: match[2] || "" });
        }
      } else {
        // 检查是否遇到更高层级的标题（表示新的段落开始）
        const cnMatch = currentLine.match(/^(\s*)(##\s*)?([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
        if (cnMatch) {
          const cnIndent = cnMatch[1].length;
          const hasMdPrefix = !!cnMatch[2];
          const currentIndent = indent.length;
          if (hasMdPrefix && cnIndent <= currentIndent) {
            break;
          }
        }
        const hMatch = currentLine.match(/^(\s*)(#{1,6})\s+(.+)$/);
        if (hMatch) {
          const hLevel = hMatch[2].length;
          const hIndent = hMatch[1].length;
          const currentIndent = indent.length;
          if (hLevel <= 3 && hIndent <= currentIndent) {
            break;
          }
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
      }
    }
  }

  // 检查是否需要重新编号（序号不是从1开始，或序号不是连续的 1,2,3...）
  let needRenumber = false;
  if (rows.length >= 1) {
    if (rows[0].number !== 1) {
      needRenumber = true;
    } else {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].number !== i + 1) {
          needRenumber = true;
          break;
        }
      }
    }
  }

  // 如果需要重新编号，从前往后替换这些行
  let currentLineIdx = headerLineIdx;
  if (needRenumber && rows.length > 0) {
    // 检查同一组中是否有任何一行带有 ##，如果有则给所有行添加 ##
    const hasAnyMdPrefix = rows.some(r => r.mdPrefix);
    const targetMdPrefix = hasAnyMdPrefix ? "## " : "";
    
    // 从第一行开始，按照顺序重新编号，处理行号映射
    const newLines = lines.slice();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const newNum = i + 1;
      const newNumStr = patternType === "arabic" ? String(newNum) : numberToChinese(newNum);
      const restTrimmed = row.rest.replace(/^\s+/, "");
      newLines[row.lineIndex] = `${row.prefix}${targetMdPrefix}${newNumStr}${row.sep}${restTrimmed.length ? (restTrimmed.startsWith(" ") ? restTrimmed : " " + restTrimmed) : " "}`.trimEnd();
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
    const afterMarker = patternType === "arabic" ? `${indent}${rows.length + 1}${separator} ` : `${indent}${targetMdPrefix}${numberToChinese(rows.length + 1)}${separator} `;
    insertAtCursor(`\n${afterMarker}`);
    return true;
  }

  if (rows.length > 0) {
    const hasAnyMdPrefix = rows.some(r => r.mdPrefix);
    const targetMdPrefix = hasAnyMdPrefix ? "## " : "";
    
    if (chinese && !chinese[2] && targetMdPrefix) {
      const fixedLine = `${chinese[1]}## ${chinese[3]}${chinese[4]}${chinese[5]}${chinese[6]}`;
      els.editor.value = `${value.slice(0, lineStart)}${fixedLine}${value.slice(start)}`;
      const fixedStart = lineStart + fixedLine.length;
      els.editor.selectionStart = fixedStart;
      els.editor.selectionEnd = fixedStart;
      els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    
    const afterMarker = patternType === "arabic" ? `${indent}${rows.length + 1}${separator} ` : `${indent}${targetMdPrefix}${numberToChinese(rows.length + 1)}${separator} `;
    insertAtCursor(`\n${afterMarker}`);
  } else {
    if (chinese && !chinese[2]) {
      const fixedLine = `${chinese[1]}## ${chinese[3]}${chinese[4]}${chinese[5]}${chinese[6]}`;
      els.editor.value = `${value.slice(0, lineStart)}${fixedLine}${value.slice(start)}`;
      const fixedStart = lineStart + fixedLine.length;
      els.editor.selectionStart = fixedStart;
      els.editor.selectionEnd = fixedStart;
      els.editor.dispatchEvent(new Event("input", { bubbles: true }));
      const next = nextChineseNumber(chinese[3]);
      if (next) marker = `${indent}## ${next}${separator}${chinese[5] || " "}`;
    }
    insertAtCursor(`\n${marker}`);
  }
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
  syncTreeSelectionState();
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
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    return setImmersiveEditing(!state.immersive);
  }
  if (event.key === "Escape" && state.immersive) {
    event.preventDefault();
    return setImmersiveEditing(false);
  }
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
  const taskInput = event.target.closest("input[data-task-line]");
  if (taskInput) {
    event.stopPropagation();
    toggleMarkdownTask(taskInput);
    return;
  }
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
  const taskInput = event.target.closest("input[data-task-line]");
  if (taskInput) {
    event.stopPropagation();
    toggleMarkdownTask(taskInput);
    return;
  }
  const copy = event.target.closest(".code-copy");
  if (!copy) return;
  const code = copy.closest(".code-block")?.querySelector("code")?.innerText || "";
  navigator.clipboard?.writeText(code).then(() => showToast("\u4ee3\u7801\u5df2\u590d\u5236"));
});
els.readerOutline.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-outline-toggle]");
  if (toggle) {
    const group = toggle.closest(".outline-group");
    const collapsed = group.classList.toggle("is-collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = collapsed ? "展开三级目录" : "收起三级目录";
    return;
  }
  const button = event.target.closest("[data-heading]");
  if (!button) return;
  let target = els.markdownView.querySelector(`#${CSS.escape(button.dataset.heading)}`);
  if (!target) {
    const level = parseInt(button.dataset.level) || 2;
    const selector = `h${level}`;
    target = [...els.markdownView.querySelectorAll(selector)]
      .find((heading) => plainText(heading.textContent) === button.dataset.title);
  }
  scrollReaderToElement(target, "auto");
});
els.editor.addEventListener("input", () => {
  state.currentContent = els.editor.value;
  updateLargeDocumentState(state.currentContent);
  recordUndo(state.currentContent);
  setSaveStatus("\u672a\u4fdd\u5b58", true);
  schedulePreviewUpdate();
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
  if (mod && event.key.toLowerCase() === "d") {
    event.preventDefault();
    const value = els.editor.value;
    const start = els.editor.selectionStart;
    const end = els.editor.selectionEnd;
    
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = value.indexOf("\n", start);
    
    let selectedStart = lineStart;
    let selectedEnd = lineEnd === -1 ? value.length : lineEnd;
    
    if (start !== end) {
      const selLineStart = value.lastIndexOf("\n", start - 1) + 1;
      const selLineEnd = value.indexOf("\n", end - 1);
      selectedStart = selLineStart;
      selectedEnd = selLineEnd === -1 ? value.length : selLineEnd + 1;
    }
    
    const textToCopy = value.substring(selectedStart, selectedEnd);
    const newText = "\n" + textToCopy;
    
    els.editor.value = value.substring(0, selectedEnd) + newText + value.substring(selectedEnd);
    
    const newCursorPos = selectedEnd + newText.length;
    els.editor.selectionStart = newCursorPos;
    els.editor.selectionEnd = newCursorPos;
    
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (mod && event.key.toLowerCase() === "m") {
    event.preventDefault();
    const value = els.editor.value;
    const start = els.editor.selectionStart;
    const end = els.editor.selectionEnd;
    
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = value.indexOf("\n", end);
    
    const before = value.substring(0, lineStart);
    const after = lineEnd === -1 ? "" : value.substring(lineEnd + 1);
    
    els.editor.value = before + after;
    
    const newCursorPos = Math.max(0, before.length);
    els.editor.selectionStart = newCursorPos;
    els.editor.selectionEnd = newCursorPos;
    
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (event.altKey && event.shiftKey) {
    event.preventDefault();
    const value = els.editor.value;
    const start = els.editor.selectionStart;
    
    const lineNum = (pos) => {
      return value.substring(0, pos).split("\n").length;
    };
    
    const posFromLine = (line) => {
      const lines = value.split("\n");
      if (line <= 1) return 0;
      if (line > lines.length) return value.length;
      return lines.slice(0, line - 1).reduce((acc, l) => acc + l.length + 1, 0);
    };
    
    const currentLine = lineNum(start);
    
    if (event.key === "ArrowDown") {
      if (currentLine < value.split("\n").length) {
        const targetLine = currentLine + 1;
        const targetPos = posFromLine(targetLine);
        if (!state.secondaryCursors.includes(targetPos)) {
          state.secondaryCursors.push(targetPos);
          state.secondaryCursors.sort((a, b) => a - b);
        }
      }
    } else if (event.key === "ArrowUp") {
      if (currentLine > 1) {
        const targetLine = currentLine - 1;
        const targetPos = posFromLine(targetLine);
        if (!state.secondaryCursors.includes(targetPos)) {
          state.secondaryCursors.push(targetPos);
          state.secondaryCursors.sort((a, b) => a - b);
        }
      }
    } else if (event.key >= "1" && event.key <= "9") {
      const count = parseInt(event.key);
      for (let i = 1; i <= count; i++) {
        const targetLine = currentLine + i;
        if (targetLine <= value.split("\n").length) {
          const targetPos = posFromLine(targetLine);
          if (!state.secondaryCursors.includes(targetPos)) {
            state.secondaryCursors.push(targetPos);
          }
        }
      }
      state.secondaryCursors.sort((a, b) => a - b);
    } else if (event.key === "Escape") {
      state.secondaryCursors = [];
    }
    
    updateMultiCursorDisplay();
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

let lastInputLength = 0;
let lastInputValue = "";
let isMultiCursorEditing = false;

els.editor.addEventListener("input", () => {
  if (isMultiCursorEditing) return;
  
  if (state.secondaryCursors.length === 0) {
    lastInputLength = els.editor.value.length;
    lastInputValue = els.editor.value;
    return;
  }
  
  const newValue = els.editor.value;
  const diff = newValue.length - lastInputLength;
  
  if (diff !== 0) {
    isMultiCursorEditing = true;
    
    const primaryStart = els.editor.selectionStart;
    const primaryEnd = els.editor.selectionEnd;
    
    const char = diff > 0 ? newValue[primaryStart - 1] : null;
    const deleteCount = diff < 0 ? -diff : 0;
    
    let offset = 0;
    state.secondaryCursors.forEach((cursorPos) => {
      let targetPos = cursorPos + offset;
      
      if (diff > 0 && char) {
        els.editor.value = els.editor.value.substring(0, targetPos) + char + els.editor.value.substring(targetPos);
        offset += 1;
      } else if (diff < 0) {
        const start = Math.max(0, targetPos - deleteCount);
        els.editor.value = els.editor.value.substring(0, start) + els.editor.value.substring(targetPos);
        offset -= deleteCount;
      }
    });
    
    els.editor.selectionStart = primaryStart + offset;
    els.editor.selectionEnd = primaryEnd + offset;
    
    state.secondaryCursors = state.secondaryCursors.map(pos => pos + offset);
    
    isMultiCursorEditing = false;
  }
  
  lastInputLength = els.editor.value.length;
  lastInputValue = els.editor.value;
});

function updateMultiCursorDisplay() {
  let overlay = document.getElementById("cursor-overlay");
  if (!overlay || overlay.parentElement !== els.editorPanel) {
    if (overlay) overlay.remove();
    overlay = document.createElement("div");
    overlay.id = "cursor-overlay";
    els.editorPanel.appendChild(overlay);
  }
  
  if (state.mode !== "edit") {
    overlay.style.display = "none";
    return;
  }
  
  const editorRect = els.editor.getBoundingClientRect();
  const panelRect = els.editorPanel.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(els.editor);
  const lineHeight = parseInt(computedStyle.lineHeight) || 20;
  const fontSize = parseInt(computedStyle.fontSize) || 14;
  const charWidth = fontSize * 0.6;
  
  overlay.style.left = `${editorRect.left - panelRect.left}px`;
  overlay.style.top = `${editorRect.top - panelRect.top}px`;
  overlay.style.width = `${editorRect.width}px`;
  overlay.style.height = `${editorRect.height}px`;
  
  const paddingLeft = parseInt(computedStyle.paddingLeft) || 22;
  const paddingTop = parseInt(computedStyle.paddingTop) || 22;
  
  overlay.innerHTML = state.secondaryCursors.map((pos) => {
    const value = els.editor.value.substring(0, pos);
    const lines = value.split("\n");
    const row = lines.length - 1;
    const col = lines[lines.length - 1].length;
    
    const top = row * lineHeight + paddingTop - els.editor.scrollTop;
    const left = col * charWidth + paddingLeft - els.editor.scrollLeft;
    
    return `<div class="secondary-cursor" style="top: ${top}px; left: ${left}px;"></div>`;
  }).join("");
  
  overlay.style.display = state.secondaryCursors.length > 0 ? "block" : "none";
}

els.editor.addEventListener("scroll", updateMultiCursorDisplay);
window.addEventListener("resize", updateMultiCursorDisplay);
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

async function loadAboutInfo() {
  try {
    const result = await api.get("/api/version");
    if (result.version) {
      els.aboutVersion.textContent = result.version;
    }
    if (result.releaseDate) {
      els.aboutDate.textContent = "发布日期：" + result.releaseDate;
    }
    if (result.releaseNotes) {
      els.aboutReleaseNotes.textContent = result.releaseNotes;
    }
  } catch (error) {
    els.aboutVersion.textContent = "1.0.0";
    els.aboutDate.textContent = "";
    els.aboutReleaseNotes.textContent = "暂无更新日志";
  }
}

els.closeSettingsBtn.addEventListener("click", () => els.settingsModal.classList.add("hidden"));
els.settingsModal.addEventListener("click", (event) => {
  if (event.target === els.settingsModal) els.settingsModal.classList.add("hidden");
});

function openCommunityModal() {
  els.settingsModal.classList.add("hidden");
  els.communityModal.classList.remove("hidden");
}

function closeCommunityModal({ reopenSettings = true } = {}) {
  els.communityModal.classList.add("hidden");
  if (reopenSettings) els.settingsModal.classList.remove("hidden");
}

els.communityBtn.addEventListener("click", openCommunityModal);
els.closeCommunityBtn.addEventListener("click", () => closeCommunityModal());
els.backCommunityBtn.addEventListener("click", () => closeCommunityModal());
els.communityModal.addEventListener("click", (event) => {
  if (event.target === els.communityModal) closeCommunityModal();
});

els.aboutBtn.addEventListener("click", async () => {
  els.settingsModal.classList.add("hidden");
  await loadAboutInfo();
  els.aboutModal.classList.remove("hidden");
});

els.closeAboutBtn.addEventListener("click", () => els.aboutModal.classList.add("hidden"));
els.aboutModal.addEventListener("click", (event) => {
  if (event.target === els.aboutModal) els.aboutModal.classList.add("hidden");
});

els.checkUpdateBtn.addEventListener("click", () => {
  els.aboutModal.classList.add("hidden");
  showToast("正在检查更新...");
});

els.coffeeBtn = document.querySelector("#coffeeBtn");
els.donationModal = document.querySelector("#donationModal");
els.closeDonationBtn = document.querySelector("#closeDonationBtn");

els.coffeeBtn.addEventListener("click", () => {
  els.donationModal.classList.remove("hidden");
});

els.closeDonationBtn.addEventListener("click", () => {
  els.donationModal.classList.add("hidden");
});

els.donationModal.addEventListener("click", (event) => {
  if (event.target === els.donationModal) {
    els.donationModal.classList.add("hidden");
  }
});

document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const text = btn.dataset.copy;
    navigator.clipboard.writeText(text).then(() => {
      const originalHTML = btn.innerHTML;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
      btn.style.color = "var(--accent)";
      btn.style.borderColor = "var(--accent)";
      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.style.color = "";
        btn.style.borderColor = "";
      }, 2000);
    }).catch(() => {
      alert("复制失败，请手动复制");
    });
  });
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
if (els.semanticTagsBtn) els.semanticTagsBtn.addEventListener("click", openSemanticTagsModal);
if (els.cancelSemanticTagsBtn) els.cancelSemanticTagsBtn.addEventListener("click", closeSemanticTagsModal);
if (els.applySemanticTagsBtn) els.applySemanticTagsBtn.addEventListener("click", applySemanticTags);
if (els.semanticTagsMax) els.semanticTagsMax.addEventListener("change", previewSemanticTags);
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
if (els.semanticTagsModal) {
  els.semanticTagsModal.addEventListener("click", (event) => {
    if (event.target === els.semanticTagsModal) closeSemanticTagsModal();
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
els.viewBtn.addEventListener("click", async () => {
  if (state.mode === "edit" && state.currentPath) {
    await saveCurrentDoc({ keepEditorState: false });
  }
  setMode("view");
});
els.editBtn.addEventListener("click", () => state.currentPath && setMode("edit"));
els.graphBtn.addEventListener("click", () => setMode("graph"));
els.focusModeBtn.addEventListener("click", () => setImmersiveEditing(!state.immersive));
els.previewToggleBtn.addEventListener("click", () => setPreviewVisible(!state.previewVisible));
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
  updateLargeDocumentState(formatted);
  recordUndo(formatted);
  schedulePreviewUpdate();
  showToast("文档格式化完成");
});
els.fitGraphBtn.addEventListener("click", () => {
  fitGraphView();
});
els.graphZoomOutBtn.addEventListener("click", () => zoomGraph(0.82));
els.graphZoomInBtn.addEventListener("click", () => zoomGraph(1.22));
els.graphSearchInput.addEventListener("input", debounce(() => {
  state.graphView.query = els.graphSearchInput.value.trim().toLowerCase();
  scheduleGraphDraw();
}, 100));
els.graphScope.addEventListener("change", () => {
  if (els.graphScope.value === "local" && !state.currentPath) {
    els.graphScope.value = "global";
    showToast("请先打开一篇文档，再查看局部图谱");
  }
  state.graphView.scope = els.graphScope.value;
  els.graphDepth.value = state.graphView.scope === "local" ? String(state.graphView.depth) : "all";
  refreshGraphView(true);
});
els.graphDepth.addEventListener("change", () => {
  if (els.graphDepth.value === "all") {
    state.graphView.scope = "global";
    els.graphScope.value = "global";
    refreshGraphView(true);
    return;
  }
  if (!state.currentPath) {
    els.graphDepth.value = "all";
    state.graphView.scope = "global";
    els.graphScope.value = "global";
    showToast("请先打开一篇文档，再选择邻域深度");
    return;
  }
  state.graphView.depth = Number(els.graphDepth.value || 2);
  state.graphView.scope = "local";
  els.graphScope.value = "local";
  refreshGraphView(true);
});
els.graphShowTags.addEventListener("change", () => {
  state.graphView.showTags = els.graphShowTags.checked;
  applyGraphModeLayout();
});
els.graphShowKeywords.addEventListener("change", () => {
  state.graphView.showKeywords = els.graphShowKeywords.checked;
  applyGraphModeLayout();
});
els.graphShowOrphans.addEventListener("change", () => {
  state.graphView.showOrphans = els.graphShowOrphans.checked;
  applyGraphModeLayout();
});
els.graphShowMissing.addEventListener("change", () => {
  state.graphView.showMissing = els.graphShowMissing.checked;
  applyGraphModeLayout();
});
els.graphDynamic.addEventListener("change", () => {
  state.graphView.dynamic = els.graphDynamic.checked;
  localStorage.setItem("graphDynamic", state.graphView.dynamic ? "1" : "0");
  if (state.graphView.dynamic) {
    if (graphMotionReduced()) showToast("系统已开启减少动画，动态图谱保持暂停");
    startGraphSimulation();
  } else {
    stopGraphSimulation();
    scheduleGraphDraw();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopGraphSimulation();
  else startGraphSimulation();
});
const graphMotionPreference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
graphMotionPreference?.addEventListener?.("change", () => {
  if (graphMotionReduced()) stopGraphSimulation();
  else startGraphSimulation();
});
els.canvas.addEventListener("pointerdown", (event) => {
  if (state.mode !== "graph") return;
  const node = hitGraph(event);
  if (node) {
    if (state.graphView.reboundAnimation) cancelAnimationFrame(state.graphView.reboundAnimation);
    state.graphView.reboundAnimation = 0;
    state.graphView.hoveredId = "";
    const graphPos = screenToGraph(event.clientX, event.clientY);
    state.graphDrag = {
      type: "node",
      node,
      offsetX: node.x - graphPos.x,
      offsetY: node.y - graphPos.y,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      previousPositions: new Map(state.graphView.visibleNodes.map((item) => [item.id, { x: item.x, y: item.y }])),
    };
  } else {
    state.graphDrag = {
      type: "pan",
      startX: event.clientX,
      startY: event.clientY,
      tx: state.graphView.tx,
      ty: state.graphView.ty,
      moved: false,
    };
  }
  els.canvas.classList.add("dragging");
  els.canvas.setPointerCapture?.(event.pointerId);
});
els.canvas.addEventListener("pointermove", (event) => {
  if (!state.graphDrag) {
    const node = hitGraph(event);
    const nextId = node?.id || "";
    if (nextId !== state.graphView.hoveredId) {
      state.graphView.hoveredId = nextId;
      scheduleGraphDraw();
    }
    updateGraphTooltip(node, event);
    return;
  }
  const drag = state.graphDrag;
  drag.moved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
  if (drag.type === "node") {
    const graphPos = screenToGraph(event.clientX, event.clientY);
    const previousX = drag.node.x;
    const previousY = drag.node.y;
    const rect = els.canvas.getBoundingClientRect();
    const edgePadding = 20;
    drag.node.x = clamp(graphPos.x + drag.offsetX, (edgePadding - state.graphView.tx) / state.graphView.scale, (rect.width - edgePadding - state.graphView.tx) / state.graphView.scale);
    drag.node.y = clamp(graphPos.y + drag.offsetY, (edgePadding - state.graphView.ty) / state.graphView.scale, (rect.height - edgePadding - state.graphView.ty) / state.graphView.scale);
    if (drag.moved) exciteGraphNode(drag.node, drag.node.x - previousX, drag.node.y - previousY);
    relaxGraphCollisions(drag.node, 2);
  } else {
    state.graphView.tx = drag.tx + event.clientX - drag.startX;
    state.graphView.ty = drag.ty + event.clientY - drag.startY;
    constrainGraphPan();
  }
  state.graphView.fitted = true;
  els.graphTooltip.classList.add("hidden");
  scheduleGraphDraw();
});
els.canvas.addEventListener("pointerup", (event) => {
  if (!state.graphDrag) return;
  const drag = state.graphDrag;
  state.graphDrag = null;
  els.canvas.classList.remove("dragging");
  els.canvas.releasePointerCapture?.(event.pointerId);
  if (drag.type === "node" && drag.moved) {
    state.graphView.reboundUntil = performance.now() + 1800;
    state.graphView.hoveredId = "";
    els.graphTooltip.classList.add("hidden");
    startGraphRebound(drag.previousPositions);
  }
  if (!drag.moved && drag.type === "node") activateGraphNode(drag.node);
});
els.canvas.addEventListener("pointercancel", () => {
  state.graphDrag = null;
  els.canvas.classList.remove("dragging");
});
els.canvas.addEventListener("pointerleave", () => {
  if (!state.graphDrag) {
    state.graphView.hoveredId = "";
    els.graphTooltip.classList.add("hidden");
    scheduleGraphDraw();
  }
});
els.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  zoomGraph(Math.exp(-event.deltaY * 0.0012), event.clientX, event.clientY);
}, { passive: false });
els.canvas.addEventListener("dblclick", (event) => {
  if (!hitGraph(event)) fitGraphView();
});
els.canvas.addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 64 : 24;
  if (["+", "="].includes(event.key)) zoomGraph(1.2);
  else if (event.key === "-") zoomGraph(0.84);
  else if (event.key === "0") fitGraphView();
  else if (event.key === "ArrowLeft") state.graphView.tx += step;
  else if (event.key === "ArrowRight") state.graphView.tx -= step;
  else if (event.key === "ArrowUp") state.graphView.ty += step;
  else if (event.key === "ArrowDown") state.graphView.ty -= step;
  else return;
  event.preventDefault();
  scheduleGraphDraw();
});
window.addEventListener("resize", debounce(() => {
  restoreSidebarWidth();
  if (state.mode === "graph") {
    resizeCanvas();
    fitGraphView();
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
