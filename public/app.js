import { createMarkdownEditor } from "/editor-core.js?v=20260814-v1";
import { createPeriodicPerlin, generateSeamlessPaperTextureDataUrl, generateLargePaperTextureDataUrl, getPaperBackgroundUrl } from "./modules/paper-texture.js";
import { escapeHtml, displayName, displayRelativePath, splitPathRef, joinPathRef, parentPathRef, compactName, splitWorkspaceRef, plainText, headingId } from "./modules/path-utils.js";
import { extractOutline, addCnEnSpaces } from "./modules/editor-utils.js";
import { stripFrontmatter, escapeRegex, splitIntoLogicalBlocks, estimateBlockLines, splitMarkdownIntoSlides, normalizeAssetUrlsToRelative } from "./modules/export-utils.js";
import { highlightCode } from "./modules/preview-utils.js";

/*
 * 文档处理原则：企业级编辑器标准，对文档异常零容忍。
 * 任何涉及文档读取、写入、切换、渲染的异常都必须：
 *   1. 记录到 console.error（含上下文：文档路径、操作阶段、错误详情）；
 *   2. 向用户明确提示（toast），不得静默吞掉；
 *   3. 保证状态与显示一致——失败时回滚到上一个一致状态，不得残留半成品；
 *   4. 绝不因降级而覆盖、丢弃或错乱用户文档内容。
 * 例外：仅纯展示型可选增强（拼写高亮、纸纹纹理等）失败时允许静默降级。
 * 文档数据安全相关的 catch 一律使用 logDocError()，禁止空的 catch (_) {}。
 */

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
const CHUNKED_RENDER_BYTES = 500 * 1024;
const CHUNK_RENDER_SLICE_BYTES = 150 * 1024;
const GRAPH_WORKER_URL = "/graph-worker.js?v=20260810-graph-1";
const MARKDOWN_WORKER_URL = "/markdown-worker.js?v=20260829-v18102-fix-install-static-port-4";
// Markdown 渲染缓存版本戳：解析器或 CSS 规则升级时递增，确保旧缓存不被复用。
// 2026-08-29 v1.8.102：安装包 resources 包含 public/ 前端静态文件、端口回滚；修正其他电脑安装后 404 白屏。
const MARKDOWN_RENDER_VERSION = "20260829-v18102-install-static-bundle-port-scan";
const AI_HISTORY_KEY = "mytemple.ai.history.v1";
const AI_TRANSFORM_LABELS = { summary: "摘要", keypoints: "要点", terms: "术语解释", polish: "润色", continue: "续写", rewrite: "代写", translate: "翻译", hint: "编辑提示", code: "代码补全", comment: "生成注释" };

const state = {
  tree: [],
  flatFiles: [],
  currentPath: "",
  currentContent: "",
  currentDocCreated: 0,
  currentEncoding: "utf-8",
  currentIsMarkdown: true,
  mode: "view",
  graph: { nodes: [], edges: [] },
  graphSource: null,
  graphLayouts: new Map(),
  graphLayoutPromises: new Map(),
  graphLayoutSeq: 0,
  graphWorker: null,
  graphWorkerFailed: false,
  graphWorkerFailedUntil: 0, // Graph Worker 失败后的重试冷却截止时间，过期后允许重建
  graphWorkerSeq: 0,
  graphWorkerPending: new Map(),
  graphWorkerIdleTimer: 0,
  graphReady: false,
  currentVersion: "",
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
    lastInteraction: 0,
    simulationCache: null,
    motionTime: 0,
    chainUntil: 0,
    reboundUntil: 0,
    reboundAnimation: 0,
    pageActive: true,
    fitted: false,
    physics: {
      repulsion: parseFloat(localStorage.getItem("graphRepulsion")) || 1.25,
      attraction: parseFloat(localStorage.getItem("graphAttraction")) || 1.0,
      breathing: parseFloat(localStorage.getItem("graphBreathing")) || 1.0,
      restore: parseFloat(localStorage.getItem("graphRestore")) || 1.0,
    },
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
  createSubmitting: false,
  expandedFolders: new Set(),
  expandedWorkspaceRoots: new Set(),
  graphDrag: null,
  undo: { stack: [], index: -1, applying: false, lastRecordedAt: 0 },
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
  lightweight: false,
  lowGpuMode: false,
  licenseValidatedAt: 0,
  previewVisible: true,
  editorHidden: false,
  previewBeforeImmersive: true,
  outlineBeforeImmersive: true,
  previewTimer: 0,
  previewLastContent: "",
  previewRenderSeq: 0,
  readerRenderSeq: 0, // 阅读模式渲染序号，防止连续打开文档时过期渲染覆盖最新内容（含搜索打开场景）
  previewPending: null,
  previewAnchors: [],
  editorOutlineVisible: localStorage.getItem("editorOutlineVisible") !== "0",
  lowGpuMode: localStorage.getItem("lowGpuMode") !== "false", // 默认开启低显存
  editorOutlineTimer: 0,
  editorOutlineSeq: 0,
  currentContentBytes: 0,
  largeDocument: false,
  previewAutoHidden: false,
  markdownWorker: null,
  markdownWorkerSeq: 0,
  markdownWorkerPending: new Map(),
  markdownWorkerFailedUntil: 0, // Worker 失败后的重试冷却截止时间，过期后允许重建，避免永久不可恢复
  markdownWorkerFailed: false,
  markdownWorkerIdleTimer: 0,
  markdownCache: new Map(),
  markdownCacheBytes: 0,
  taskSaveQueue: Promise.resolve(),
  autoSave: {
    idleTimer: 0,
    idleCallback: 0,
    maxTimer: 0,
    inFlight: false,
    pending: false,
    composing: false,
  },
  semanticTagPreview: null,
  ai: {
    open: false,
    settings: null,
    status: null,
    messages: [],
    preview: null,
    selection: null,
    transform: null,
    configDirty: false,
    statusTimer: 0,
    chatProvider: "ollama",
  },
  aiInline: {
    visible: false,
    history: [],
    historyIndex: -1,
    inflight: false,
  },
  showSpellcheck: JSON.parse(localStorage.getItem('mt_showSpellcheck') ?? 'true'),
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
  editorBody: document.querySelector(".editor-body"),
  outlineSplitter: document.querySelector("#outlineSplitter"),
  previewSplitter: document.querySelector("#previewSplitter"),
  graphPanel: document.querySelector("#graphPanel"),
  markdownView: document.querySelector("#markdownView"),
  readerOutline: document.querySelector("#readerOutline"),
  editor: document.querySelector("#editor"),
  preview: document.querySelector("#preview"),
  modeToggleBtn: document.querySelector("#modeToggleBtn"),
  graphBtn: document.querySelector("#graphBtn"),
  exportPdfBtn: document.querySelector("#exportPdfBtn"),
  copyWechatBtn: document.querySelector("#copyWechatBtn"),
  deleteBtn: document.querySelector("#deleteBtn"),
  saveBtn: document.querySelector("#saveBtn"),
  focusModeBtn: document.querySelector("#focusModeBtn"),
  lowGpuToggle: document.querySelector("#lowGpuToggle"),
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
  editorOutline: document.querySelector("#editorOutline"),
  outlineToggleBtn: document.querySelector("#outlineToggleBtn"),
  headingSelect: document.querySelector("#headingSelect"),
  editorHideBtn: document.querySelector("#editorHideBtn"),
  textColor: document.querySelector("#textColor"),
  bgColor: document.querySelector("#bgColor"),
  fontSize: document.querySelector("#fontSize"),
  sidebarResizer: document.querySelector("#sidebarResizer"),
  sidebarHideBtn: document.querySelector("#sidebarHideBtn"),
  sidebarShowBtn: document.querySelector("#sidebarShowBtn"),
  settingsBtn: document.querySelector("#settingsBtn"),
  settingsModal: document.querySelector("#settingsModal"),
  closeSettingsBtn: document.querySelector("#closeSettingsBtn"),
  licenseModal: document.querySelector("#licenseModal"),
  goToLicenseBtn: document.querySelector("#goToLicenseBtn"),
  machineCodeDisplay: document.querySelector("#machineCodeDisplay"),
  copyMachineCodeBtn: document.querySelector("#copyMachineCodeBtn"),
  licenseKeyInput: document.querySelector("#licenseKeyInput"),
  activateLicenseBtn: document.querySelector("#activateLicenseBtn"),
  licenseStatus: document.querySelector("#licenseStatus"),
  licenseUnactivated: document.querySelector("#licenseUnactivated"),
  licenseActivated: document.querySelector("#licenseActivated"),
  activatedMachineCode: document.querySelector("#activatedMachineCode"),
  licenseExpiry: document.querySelector("#licenseExpiry"),
  licenseExpiryRow: document.querySelector("#licenseExpiryRow"),
  licenseWarning: document.querySelector("#licenseWarning"),
  deactivateLicenseBtn: document.querySelector("#deactivateLicenseBtn"),
  aboutVersion: document.querySelector("#aboutVersion"),
  aboutDate: document.querySelector("#aboutDate"),
  aboutReleaseNotes: document.querySelector("#aboutReleaseNotes"),
  checkUpdateBtn: document.querySelector("#checkUpdateBtn"),
  kmReviewDays: document.querySelector("#kmReviewDays"),
  kmEnableReminder: document.querySelector("#kmEnableReminder"),
  kmRefreshBtn: document.querySelector("#kmRefreshBtn"),
  kmStatus: document.querySelector("#kmStatus"),
  kmStats: document.querySelector("#kmStats"),
  kmHealthScore: document.querySelector("#kmHealthScore"),
  kmMissingTagsCount: document.querySelector("#kmMissingTagsCount"),
  kmMissingTagsList: document.querySelector("#kmMissingTagsList"),
  kmMissingLinksCount: document.querySelector("#kmMissingLinksCount"),
  kmMissingLinksList: document.querySelector("#kmMissingLinksList"),
  kmStaleCount: document.querySelector("#kmStaleCount"),
  kmStaleList: document.querySelector("#kmStaleList"),
  themeChoices: document.querySelector("#themeChoices"),
  bgImageInput: document.querySelector("#bgImageInput"),
  imageTextMode: document.querySelector("#imageTextMode"),
  pickImageColorBtn: document.querySelector("#pickImageColorBtn"),
  glowAccentRow: document.querySelector("#glowAccentRow"),
  glowAccentColor: document.querySelector("#glowAccentColor"),
  resetGlowAccentBtn: document.querySelector("#resetGlowAccentBtn"),
  graphRepulsion: document.querySelector("#graphRepulsion"),
  graphRepulsionValue: document.querySelector("#graphRepulsionValue"),
  graphAttraction: document.querySelector("#graphAttraction"),
  graphAttractionValue: document.querySelector("#graphAttractionValue"),
  graphBreathing: document.querySelector("#graphBreathing"),
  graphBreathingValue: document.querySelector("#graphBreathingValue"),
  graphRestore: document.querySelector("#graphRestore"),
  graphRestoreValue: document.querySelector("#graphRestoreValue"),
  resetGraphPhysicsBtn: document.querySelector("#resetGraphPhysicsBtn"),
  globalFontSize: document.querySelector("#globalFontSize"),
  globalFontSizeValue: document.querySelector("#globalFontSizeValue"),
  docFontSize: document.querySelector("#docFontSize"),
  docFontSizeValue: document.querySelector("#docFontSizeValue"),
  windowZoom: document.querySelector("#windowZoom"),
  windowZoomValue: document.querySelector("#windowZoomValue"),
  globalFontFamily: document.querySelector("#globalFontFamily"),
  mdColorHeading: document.querySelector("#mdColorHeading"),
  mdColorLink: document.querySelector("#mdColorLink"),
  mdColorCode: document.querySelector("#mdColorCode"),
  mdColorQuote: document.querySelector("#mdColorQuote"),
  mdColorTable: document.querySelector("#mdColorTable"),
  mdColorTag: document.querySelector("#mdColorTag"),
  defaultWorkspaceChoices: document.querySelector("#defaultWorkspaceChoices"),
  screenshotSaveChoices: document.querySelector("#screenshotSaveChoices"),
  pdfShowDate: document.querySelector("#pdfShowDate"),
  pdfShowAuthor: document.querySelector("#pdfShowAuthor"),
  pdfAuthorText: document.querySelector("#pdfAuthorText"),
  pdfShowFooter: document.querySelector("#pdfShowFooter"),
  pdfFooterText: document.querySelector("#pdfFooterText"),
  pdfWatermarkText: document.querySelector("#pdfWatermarkText"),
  pdfSettingsStatus: document.querySelector("#pdfSettingsStatus"),
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
  printRoot: document.querySelector("#printRoot"),
  recentDocs: document.querySelector("#recentDocs"),
  aiBtn: document.querySelector("#aiBtn"),
  aiDrawer: document.querySelector("#aiDrawer"),
  aiCloseBtn: document.querySelector("#aiCloseBtn"),
  aiStatusBadge: document.querySelector("#aiStatusBadge"),
  aiScope: document.querySelector("#aiScope"),
  aiClearBtn: document.querySelector("#aiClearBtn"),
  aiRewriteBtn: document.querySelector("#aiRewriteBtn"),
  aiMessages: document.querySelector("#aiMessages"),
  aiForm: document.querySelector("#aiForm"),
  aiQuestion: document.querySelector("#aiQuestion"),
  aiSendBtn: document.querySelector("#aiSendBtn"),
  aiBaseUrl: document.querySelector("#aiBaseUrl"),
  aiEmbeddingModel: document.querySelector("#aiEmbeddingModel"),
  aiChatModel: document.querySelector("#aiChatModel"),
  aiProviderChoices: document.querySelector("#aiProviderChoices"),
  aiDeepseekApiKey: document.querySelector("#aiDeepseekApiKey"),
  aiDeepseekBaseUrl: document.querySelector("#aiDeepseekBaseUrl"),
  aiDeepseekChatModel: document.querySelector("#aiDeepseekChatModel"),
  aiPptBtn: document.querySelector("#aiPptBtn"),
  aiModelChoices: document.querySelector("#aiModelChoices"),
  aiTestBtn: document.querySelector("#aiTestBtn"),
  aiSaveBtn: document.querySelector("#aiSaveBtn"),
  aiReindexBtn: document.querySelector("#aiReindexBtn"),
  aiDisableEmbeddingBtn: document.querySelector("#aiDisableEmbeddingBtn"),
  editorAiDialog: document.querySelector("#editorAiDialog"),
  editorAiDialogInput: document.querySelector("#editorAiDialogInput"),
  editorAiDialogSubmit: document.querySelector("#editorAiDialogSubmit"),
  aiEditHintToggle: document.querySelector("#aiEditHintToggle"),
  aiEditHintDelay: document.querySelector("#aiEditHintDelay"),
  aiSettingsStatus: document.querySelector("#aiSettingsStatus"),
  aiIndexMode: document.querySelector("#aiIndexMode"),
  aiIndexCount: document.querySelector("#aiIndexCount"),
  aiIndexStorage: document.querySelector("#aiIndexStorage"),
  aiIndexProgressBar: document.querySelector("#aiIndexProgressBar"),
  aiIndexProgressText: document.querySelector("#aiIndexProgressText"),
  aiSelectionMenu: document.querySelector("#aiSelectionMenu"),
  aiTransformModal: document.querySelector("#aiTransformModal"),
  aiTransformTitle: document.querySelector("#aiTransformTitle"),
  aiTransformSource: document.querySelector("#aiTransformSource"),
  aiTransformResult: document.querySelector("#aiTransformResult"),
  aiTransformInstruction: document.querySelector("#aiTransformInstruction"),
  aiTransformDocName: document.querySelector("#aiTransformDocName"),
  aiTransformCloseBtn: document.querySelector("#aiTransformCloseBtn"),
  aiTransformCancelBtn: document.querySelector("#aiTransformCancelBtn"),
  aiTransformGenerateBtn: document.querySelector("#aiTransformGenerateBtn"),
  aiTransformInsertBtn: document.querySelector("#aiTransformInsertBtn"),
  aiTransformCreateBtn: document.querySelector("#aiTransformCreateBtn"),
  standardizeFrontmatterBtn: document.querySelector("#standardizeFrontmatterBtn"),
  createAgentPolicyBtn: document.querySelector("#createAgentPolicyBtn"),
  agentPolicyStatus: document.querySelector("#agentPolicyStatus"),
  frontmatterModal: document.querySelector("#frontmatterModal"),
  frontmatterBefore: document.querySelector("#frontmatterBefore"),
  frontmatterAfter: document.querySelector("#frontmatterAfter"),
  cancelFrontmatterBtn: document.querySelector("#cancelFrontmatterBtn"),
  applyFrontmatterBtn: document.querySelector("#applyFrontmatterBtn"),
  editorSearchPopup: document.querySelector("#editorSearchPopup"),
  editorSearchInput: document.querySelector("#editorSearchInput"),
  editorSearchResults: document.querySelector("#editorSearchResults"),
  editorSearchCount: document.querySelector("#editorSearchCount"),
  editorSearchClose: document.querySelector("#editorSearchClose"),
  editorSearchReplace: document.querySelector("#editorSearchReplace"),
  editorSearchReplaceAll: document.querySelector("#editorSearchReplaceAll"),
  statusDocNameText: document.querySelector("#statusDocNameText"),
  statusWordCountText: document.querySelector("#statusWordCountText"),
  statusCursorText: document.querySelector("#statusCursorText"),
  statusLastSaveText: document.querySelector("#statusLastSaveText"),
  statusCreatedText: document.querySelector("#statusCreatedText"),
  statusSystemTimeText: document.querySelector("#statusSystemTimeText"),
  statusPomodoro: document.querySelector("#statusPomodoro"),
  statusPomodoroText: document.querySelector("#statusPomodoroText"),
  importModal: document.querySelector("#importModal"),
  importDropZone: document.querySelector("#importDropZone"),
  importFileInput: document.querySelector("#importFileInput"),
  importFileList: document.querySelector("#importFileList"),
  closeImportBtn: document.querySelector("#closeImportBtn"),
  cancelImportBtn: document.querySelector("#cancelImportBtn"),
  browseImportBtn: document.querySelector("#browseImportBtn"),
  confirmImportBtn: document.querySelector("#confirmImportBtn"),
  insertVideoBtn: document.querySelector("#insertVideoBtn"),
  videoFileInput: document.querySelector("#videoFileInput"),
};

els.editor = createMarkdownEditor(els.editor);

if (els.graphDynamic) els.graphDynamic.checked = state.graphView.dynamic;

let _placeholderIdleTimer = null;

function _cancelPlaceholderTimer() {
  if (_placeholderIdleTimer) {
    clearTimeout(_placeholderIdleTimer);
    _placeholderIdleTimer = null;
  }
}

function _isCursorLineBlank() {
  const value = els.editor.value || "";
  const cursorPos = els.editor.selectionStart ?? 0;
  const lineStart = value.lastIndexOf("\n", cursorPos - 1) + 1;
  const lineEndIdx = value.indexOf("\n", cursorPos);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const lineText = value.substring(lineStart, lineEnd);
  return lineText.trim().length === 0;
}

function _showPlaceholder() {
  const placeholder = document.getElementById("editorPlaceholder");
  if (!placeholder) return;
  if (state.mode !== "edit" || !state.currentPath) return;
  if (!_isCursorLineBlank()) return;
  const view = els.editor.view;
  if (!view) return;
  const cursorPos = els.editor.selectionStart ?? 0;
  const editorEl = document.getElementById("editor");
  if (!editorEl) return;
  const editorRect = editorEl.getBoundingClientRect();
  try {
    const coords = view.coordsAtPos(cursorPos);
    if (coords) {
      placeholder.style.top = `${coords.top - editorRect.top + 2}px`;
      placeholder.style.left = `${coords.left - editorRect.left + 8}px`;
      placeholder.style.right = "8px";
      placeholder.style.display = "block";
    } else {
      placeholder.style.display = "block";
    }
  } catch (e) {
    placeholder.style.display = "block";
  }
  requestAnimationFrame(() => {
    placeholder.classList.add("visible");
  });
}

function updateEditorPlaceholder() {
  const placeholder = document.getElementById("editorPlaceholder");
  if (!placeholder) return;
  const cursorLineBlank = _isCursorLineBlank();
  const shouldShow = state.mode === "edit" && cursorLineBlank && !!state.currentPath;
  _cancelPlaceholderTimer();
  if (!shouldShow) {
    placeholder.classList.remove("visible");
    placeholder.style.display = "none";
    return;
  }
  if (placeholder.classList.contains("visible")) {
    placeholder.classList.remove("visible");
    placeholder.style.display = "none";
  }
  _placeholderIdleTimer = setTimeout(() => {
    _showPlaceholder();
  }, 5000);
}

els.editor.addEventListener("input", () => {
  updateEditorPlaceholder();
  updateStatusWordCount();
});

els.editor.addEventListener("keyup", (e) => {
  if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(e.key)) {
    updateEditorPlaceholder();
    updateStatusCursor();
  }
});

els.editor.addEventListener("click", () => {
  updateEditorPlaceholder();
  updateStatusCursor();
});

const _editorPlaceholderEl = document.createElement("div");
_editorPlaceholderEl.id = "editorPlaceholder";
_editorPlaceholderEl.className = "cm-placeholder";
_editorPlaceholderEl.innerHTML = '试试 <span class="kbd">Ctrl U</span> 用AI智能检索，<span class="kbd">Ctrl I</span> 与AI一起编辑文档';
_editorPlaceholderEl.style.position = "absolute";
_editorPlaceholderEl.style.pointerEvents = "none";
_editorPlaceholderEl.style.zIndex = "5";
_editorPlaceholderEl.style.whiteSpace = "pre-wrap";
_editorPlaceholderEl.style.display = "none";
document.getElementById("editor")?.appendChild(_editorPlaceholderEl);

const api = {
  async get(path) {
      const response = await fetch(`${path}${path.includes("?") ? "&" : "?"}_license=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      const body = await response.text();
      let detail = {};
      try { detail = JSON.parse(body); } catch (_) {}
      if (response.status === 403 && detail.code === "LICENSE_REQUIRED") {
        window.dispatchEvent(new CustomEvent("license-required", { detail }));
      } else if (response.status === 503 && detail.code === "LICENSE_TEMPORARY") {
        console.warn("License temporarily unavailable:", detail.error);
      }
      throw new Error(detail.error || body);
    }
    return response.json();
  },
  async post(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      let detail = {};
      try { detail = JSON.parse(body); } catch (_) {}
      if (response.status === 403 && detail.code === "LICENSE_REQUIRED") {
        window.dispatchEvent(new CustomEvent("license-required", { detail }));
      } else if (response.status === 503 && detail.code === "LICENSE_TEMPORARY") {
        console.warn("License temporarily unavailable:", detail.error);
      }
      throw new Error(detail.error || body);
    }
    return response.json();
  },
};

function applyPaperTexture() {
  const existing = document.getElementById("paper-texture-style");
  if (existing?.dataset.ready === "1") return;
  const url = getPaperBackgroundUrl();
  if (!url) return;
  const ruleId = "paper-texture-style";
  let styleEl = document.getElementById(ruleId);
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = ruleId;
    document.head.appendChild(styleEl);
  }
  let _panelTex = "";
  try { _panelTex = generateSeamlessPaperTextureDataUrl(512, 67890); } catch (_) {}
  const panelVal = _panelTex ? `url("${_panelTex}")` : "none";
  styleEl.textContent = `
  body[data-theme="eye"] {
    --paper-bg: url("${url}");
    --paper-panel: ${panelVal};
    background-color: #f3f1e7;
    background-image:
      var(--paper-bg),
      radial-gradient(ellipse 55% 85% at 10% 0%, rgba(136, 169, 86, 0.12), transparent 60%),
      radial-gradient(ellipse 60% 85% at 92% 12%, rgba(223, 233, 203, 0.22), transparent 65%),
      radial-gradient(ellipse 70% 60% at 15% 90%, rgba(215, 224, 186, 0.14), transparent 60%),
      linear-gradient(90deg, rgba(229, 223, 201, 0.65) 0%, rgba(236, 231, 214, 0.42) 40%, rgba(241, 237, 226, 0.22) 72%, transparent 100%);
    background-size: 100% 100%, cover, cover, cover, cover;
    background-repeat: no-repeat, no-repeat, no-repeat, no-repeat, no-repeat;
    background-attachment: fixed, fixed, fixed, fixed, fixed;
  }
  body[data-theme="eye"]::after {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 9999;
    background:
      radial-gradient(ellipse 80% 60% at 50% 50%, transparent 68%, rgba(45, 55, 41, 0.04) 100%);
  }
  body[data-theme="eye"] .app-shell,
  body[data-theme="eye"] .sidebar,
  body[data-theme="eye"] .topbar,
  body[data-theme="eye"] .editor-body,
  body[data-theme="eye"] .reader-panel,
  body[data-theme="eye"] .graph-panel,
  body[data-theme="eye"] #editor,
  body[data-theme="eye"] #preview {
    background-color: transparent !important;
    background-image: none !important;
    background-size: auto !important;
    background-repeat: auto !important;
    background-attachment: auto !important;
    border-right: none !important;
    box-shadow: none !important;
  }
  body[data-theme="eye"] .editor-toolbar,
  body[data-theme="eye"] .graph-tools {
    background-color: transparent !important;
    background-image: none !important;
  }
  body[data-theme="eye"] ::-webkit-scrollbar-thumb {
    background: rgba(120, 141, 87, 0.20);
  }
  body[data-theme="eye"] ::-webkit-scrollbar-track {
    background: transparent;
  }
`;
  styleEl.dataset.ready = "1";
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  state.toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 1800);
}

function loadSettings() {
  const savedFontSize = localStorage.getItem("docFontSize");
  const savedContentFontSize = localStorage.getItem("docContentFontSize");
  let markdownColors = {};
  try { markdownColors = JSON.parse(localStorage.getItem("markdownColors") || "{}"); } catch (_) {}
  return {
    // 默认暗色主题；用户调整后保存于 docTheme，重启自动恢复用户习惯。
    theme: ["light","dark","eye","glow","image"].includes(localStorage.getItem("docTheme")) ? localStorage.getItem("docTheme") : "dark",
    bg: localStorage.getItem("docBgImage") || "",
    fontSize: Number(savedFontSize || computeOptimalFontSize()),
    contentFontSize: Number(savedContentFontSize || computeOptimalContentFontSize()),
    fontFamily: localStorage.getItem("docFontFamily") || els.globalFontFamily.value,
    markdownColors,
  };
}

function computeOptimalZoom() {
  const w = window.innerWidth;
  if (w < 1000) return 85;
  if (w < 1280) return 90;
  if (w < 1600) return 100;
  if (w < 1920) return 105;
  return 110;
}

function computeOptimalFontSize() {
  const w = window.innerWidth;
  if (w < 1000) return 14;
  if (w < 1280) return 15;
  return 16;
}

function computeOptimalContentFontSize() {
  const w = window.innerWidth;
  if (w < 1000) return 15;
  if (w < 1280) return 16;
  return 16;
}

function applyWindowZoom(zoom) {
  const z = clamp(Number(zoom) || 100, 80, 120);
  const scale = z / 100;
  document.documentElement.style.setProperty("--app-scale", scale);
  const settings = loadSettings();
  document.documentElement.style.setProperty("--app-font-size", `${Math.round(settings.fontSize * scale)}px`);
  document.documentElement.style.setProperty("--doc-font-size", `${Math.round(settings.contentFontSize * scale)}px`);
  if (els.windowZoom) els.windowZoom.value = z;
  if (els.windowZoomValue) els.windowZoomValue.textContent = `${z}%`;
}

function adjustEditorFontSize(delta) {
  const settings = loadSettings();
  if (delta === 0) {
    settings.contentFontSize = computeOptimalContentFontSize();
  } else {
    settings.contentFontSize = clamp(settings.contentFontSize + delta, 10, 32);
  }
  localStorage.setItem("docContentFontSize", String(settings.contentFontSize));
  const scale = (Number(localStorage.getItem("windowZoom")) || computeOptimalZoom()) / 100;
  const scopedPx = Math.round(settings.contentFontSize * scale);
  document.documentElement.style.setProperty("--doc-font-size", `${scopedPx}px`);
  // 编辑模式字号必须显式同步到 #editor 及 CodeMirror 子元素，
  // 仅靠 CSS 变量或单元素内联样式无法覆盖 .cm-line / gutters / cursor-overlay 等多节点。
  applyEditorFontSizeToDom(settings.contentFontSize, scopedPx);
  showToast(`编辑器字体 ${settings.contentFontSize}px`);
}

/**
 * 将编辑器字号同步到所有影响显示的 DOM 节点。
 * 同步设置变量与显式样式，保证：
 * 1) CodeMirror 重绘（cm-content/cm-line/cm-gutters/cm-activeLine）
 * 2) 普通 textarea 兼容（如果未来 #editor 退化）
 * 3) 光标覆盖层 #cursor-overlay 与编辑器行高/字号保持一致
 * 4) 行高、字间距、字体渲染选项随字号同步，避免编辑模式文字模糊/拥挤
 */
function applyEditorFontSizeToDom(basePx, scaledPx = basePx) {
  const root = document.documentElement;
  root.style.setProperty("--editor-font-size", `${basePx}px`);
  root.style.setProperty("--editor-font-size-scaled", `${scaledPx}px`);
  const editorHost = els.editor?.host || document.querySelector("#editor");
  if (editorHost) {
    // 字号按未缩放值（编辑器局部跟随 --doc-font-size 可能被全局zoom重复叠加）；
    // 这里统一使用 basePx，与用户"Ctrl+/-调整到多少就显示多少"的直觉一致。
    editorHost.style.setProperty("font-size", `${basePx}px`, "important");
    editorHost.style.setProperty("--editor-font-size-local", `${basePx}px`);
    editorHost.style.fontSize = `${basePx}px`;
    const scroller = editorHost.querySelector(".cm-scroller");
    const content = editorHost.querySelector(".cm-content");
    const gutters = editorHost.querySelector(".cm-gutters");
    const lines = editorHost.querySelectorAll(".cm-line");
    const layer = editorHost.querySelector(".cm-selectionLayer, .cm-cursorLayer, .cm-activeLineLayer");
    const targets = [content, scroller, gutters, layer].filter(Boolean);
    targets.forEach((el) => {
      el.style.setProperty("font-size", `${basePx}px`, "important");
    });
    lines.forEach((ln) => {
      ln.style.setProperty("font-size", `${basePx}px`, "important");
    });
    const overlay = document.querySelector("#cursor-overlay");
    if (overlay) overlay.style.fontSize = `${basePx}px`;
    // 强制 CodeMirror 重新测量视图尺寸，避免行高/滚动条错位
    if (typeof els.editor?.requestMeasure === "function") {
      try { els.editor.requestMeasure(); } catch (_) { /* ignore */ }
    }
    if (typeof editorHost.focus === "function") {
      // 触发一次滚动测量以刷新滚动条范围
      try { editorHost.dispatchEvent(new UIEvent("resize", { bubbles: false })); } catch (_) {}
    }
  }
}

function restoreWindowZoom() {
  const saved = localStorage.getItem("windowZoom");
  if (saved) {
    applyWindowZoom(Number(saved));
  } else {
    applyWindowZoom(computeOptimalZoom());
  }
}

function applySettings(settings = loadSettings()) {
  document.body.dataset.theme = settings.theme;
  const themeColorMap = { dark: "#252827", eye: "#f3f1e7", glow: "#f3f1e7", image: "#1a1a2e" };
  const themeBgMap = { dark: "#252827", eye: "#f3f1e7", glow: "#f3f1e7", image: "#1a1a2e" };
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.content = themeColorMap[settings.theme] || "#fafafa";
  }
  if (settings.theme === "eye") {
    applyPaperTexture();
  }
  // 图片主题文字明暗：根据背景图深浅切换文字配色，保证可读性。
  const imageTextMode = localStorage.getItem("imageTextMode") === "light" ? "light" : "dark";
  document.body.dataset.imageText = settings.theme === "image" ? imageTextMode : "";
  if (els.imageTextMode) els.imageTextMode.value = imageTextMode;
  // 图片主题取色结果持久化：重启后恢复用户从背景图取色的强调色；离开图片主题时移除内联覆盖，回归主题默认配色。
  if (settings.theme === "image") {
    const savedAccent = localStorage.getItem("imageAccentColor");
    if (savedAccent) document.documentElement.style.setProperty("--accent", savedAccent);
  } else if (settings.theme === "glow") {
    // 柔光主题支持自定义强调色，持久化恢复
    const savedGlowAccent = localStorage.getItem("glowAccentColor");
    if (savedGlowAccent) {
      document.documentElement.style.setProperty("--accent", savedGlowAccent);
      document.documentElement.style.setProperty("--accent-strong", savedGlowAccent);
      if (els.glowAccentColor) els.glowAccentColor.value = "#88a956";savedGlowAccent;
    } else if (els.glowAccentColor) {
      els.glowAccentColor.value = "#b08560";
    }
  } else {
    document.documentElement.style.removeProperty("--accent");
    document.documentElement.style.removeProperty("--accent-strong");
  }
  // 柔光强调色控件仅在柔光主题下显示
  if (els.glowAccentRow) {
    els.glowAccentRow.style.display = settings.theme === "glow" ? "flex" : "none";
  }
  const currentScale = parseFloat(document.documentElement.style.getPropertyValue("--app-scale")) || 1;
  document.documentElement.style.setProperty("--app-font-size", `${Math.round(settings.fontSize * currentScale)}px`);
  const scaledContentPx = Math.round(settings.contentFontSize * currentScale);
  document.documentElement.style.setProperty("--doc-font-size", `${scaledContentPx}px`);
  // 重启 / 重设设置后，编辑器实际字号要与持久化 contentFontSize 一致
  applyEditorFontSizeToDom(settings.contentFontSize, scaledContentPx);
  document.documentElement.style.setProperty("--app-font-family", settings.fontFamily);
  const markdownColorVars = {
    heading: "--md-heading",
    link: "--md-link",
    code: "--md-inline-code",
    quote: "--md-emphasis",
    table: "--md-table-accent",
    tag: "--md-tag",
  };
  Object.entries(markdownColorVars).forEach(([key, variable]) => {
    const value = settings.markdownColors?.[key];
    if (/^#[0-9a-f]{6}$/i.test(String(value || ""))) document.documentElement.style.setProperty(variable, value);
    else document.documentElement.style.removeProperty(variable);
  });
  if (settings.bg) document.documentElement.style.setProperty("--custom-bg", `url("${settings.bg}")`);
  else document.documentElement.style.removeProperty("--custom-bg");
  els.globalFontSize.value = settings.fontSize;
  els.globalFontSizeValue.textContent = `${settings.fontSize}px`;
  els.docFontSize.value = settings.contentFontSize;
  els.docFontSizeValue.textContent = `${settings.contentFontSize}px`;
  els.globalFontFamily.value = settings.fontFamily;
  const colorInputs = {
    heading: els.mdColorHeading,
    link: els.mdColorLink,
    code: els.mdColorCode,
    quote: els.mdColorQuote,
    table: els.mdColorTable,
    tag: els.mdColorTag,
  };
  Object.entries(colorInputs).forEach(([key, input]) => {
    if (input) input.value = settings.markdownColors?.[key] || getComputedStyle(document.documentElement).getPropertyValue(markdownColorVars[key]).trim() || input.value;
  });
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

// × 掉顶部最近文档后，编辑栏跟随刷新到当前最近打开的文档；
// 若没有最近打开的文档，显示备用预览文档（使用方法简介）。
async function refreshEditorAfterRecentClose(closedPath) {
  if (state.recentDocs.length === 0) {
    showBackupPreviewDoc();
    return;
  }
  const topDoc = state.recentDocs[0];
  // 当前编辑的文档仍是最近一篇：保持不变，仅刷新最近栏高亮。
  if (state.currentPath === topDoc.path) {
    syncTreeSelectionState();
    return;
  }
  // 关闭的正是当前编辑文档，或当前文档已不在最近列表：切换到新的最近一篇。
  const currentStillRecent = state.recentDocs.some((item) => item.path === state.currentPath);
  if (state.currentPath === closedPath || !currentStillRecent) {
    await openDoc(topDoc.path);
  }
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
    closeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const path = closeBtn.dataset.remove;
      if (!path) return;
      removeRecentDoc(path);
      await refreshEditorAfterRecentClose(path);
    });
  });
}

function displayPath(value = "") {
  const ref = splitPathRef(value);
  const workspace = state.workspaces.find((item) => item.id === ref.workspaceId);
  return `${workspace?.name || ref.workspaceId}${ref.relative ? `/${ref.relative}` : ""}`;
}



const SPELLCHECK_DICT = [
  ["做为", "作为"], ["已后", "以后"], ["以经", "已经"], ["既使", "即使"],
  ["既然...就", "竟然"], ["那怕", "哪怕"], ["那末", "那么"], ["因为...所以", null],
  ["必需", "必须"], ["度过", "渡过"], ["反应", "反映"], ["分开", "分隔"],
  ["浮浅", "肤浅"], ["供养", "供应"], ["厉害", "利害"], ["年轻", "年青"],
  ["启用", "起用"], ["人口", "人员"], ["擅长", "善长"], ["实足", "十足"],
  ["停留", "滞留"], ["违反", "违犯"], ["雄伟", "宏伟"], ["整顿", "整饬"],
  ["截至", "截止"], ["置疑", "质疑"], ["制定", "制订"], ["衷心", "忠心"],
  ["终身", "终生"], ["看重", "看中"], ["作客", "做客"], ["就序", "就绪"],
  ["座落", "坐落"], ["部份", "部分"], ["融汇", "融会"], ["年青", "年轻"],
  ["照像", "照相"], ["必竟", "毕竟"], ["连系", "联系"], ["记念", "纪念"],
  ["希奇", "稀奇"], ["想像", "想象"], ["坐位", "座位"], ["流览", "浏览"],
  ["循私", "徇私"], ["急待", "亟待"], ["妥贴", "妥帖"], ["题纲", "提纲"],
  ["消毁", "销毁"], ["偏面", "片面"], ["气慨", "气概"], ["赋予", "付与"],
  ["担搁", "耽搁"], ["疯茫", "锋芒"], ["杀一警百", "杀一儆百"],
];

function scanSpellErrors(text) {
  let count = 0;
  SPELLCHECK_DICT.forEach(([wrong]) => {
    if (!wrong) return;
    try {
      const re = new RegExp(wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "g");
      const m = text.match(re);
      if (m) count += m.length;
    } catch (_) {}
  });
  return count;
}

function applySpellCheckHighlight(html, source) {
  if (!state.showSpellcheck) return html;
  let result = html;
  SPELLCHECK_DICT.forEach(([wrong]) => {
    if (!wrong) return;
    try {
      const safe = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`(?<!<[^>]*)${safe}(?![^<]*>)`, "g"),
        `<span class="spell-error" title="疑似错字：${wrong}">${wrong}</span>`);
    } catch (_) {}
  });
  return result;
}



function formatDocument(source) {
  const normalizedSource = source.replace(/\r\n/g, "\n");
  let formatFixed = 0;
  let spellErrors = 0;

  let frontmatterEnd = 0;
  if (normalizedSource.startsWith("---\n")) {
    const idx = normalizedSource.indexOf("\n---\n", 4);
    if (idx !== -1) frontmatterEnd = idx + 5;
  }

  // ── 阶段 1：扫描所有 Markdown 标题，判断层级是否真正"混乱" ──────
  // 判定"混乱"的唯一标准：存在标题跳级超过 +1（例如 # 之后直接出现 ###，缺失 ## 过渡）
  // 对于已经自然递进的规范文档，不做任何标题层级修正，保留用户的手工结构。
  const lines = normalizedSource.split("\n");
  const mdHeadingLevels = [];
  let scanInCode = false;
  for (const line of lines) {
    if (line.startsWith("```")) { scanInCode = !scanInCode; continue; }
    if (scanInCode) continue;
    const m = line.match(/^#{1,6}\s+.+$/);
    if (m) mdHeadingLevels.push(m[0].indexOf(" ")); // "# 标题" → indexOf(" ") == 1 == 级别
  }
  let headingChaotic = false;
  let prevLevel = 0;
  for (const lv of mdHeadingLevels) {
    if (lv > prevLevel + 1) { headingChaotic = true; break; }
    prevLevel = lv;
  }

  // ── 阶段 2：执行规范化；仅在 headingChaotic 为 true 时才修正标题层级 ──
  const result = [];
  let inCode = false;
  let lastHeadingLevel = 0;
  let blankCount = 0;
  let headingLevelCorrected = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.startsWith("```")) {
      inCode = !inCode;
      result.push(line);
      blankCount = 0;
      continue;
    }

    if (inCode) {
      result.push(line);
      blankCount = 0;
      continue;
    }

    // 清理行尾空白
    const trimmed = line.replace(/[ \u3000]+$/g, "");
    if (trimmed !== line) {
      formatFixed += (line.length - trimmed.length);
      line = trimmed;
    }

    // 压缩连续空行（最多保留 2 行）
    if (line === "") {
      blankCount++;
      if (blankCount > 2) {
        formatFixed++;
        continue;
      }
      result.push(line);
      continue;
    }
    blankCount = 0;

    // Markdown 标题：仅检测到层级混乱时才做跳级修正
    const headingMatch = line.match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const indent = headingMatch[1];
      const rawLevel = headingMatch[2].length;
      const title = headingMatch[3];
      let correctedLevel = rawLevel;
      if (headingChaotic && rawLevel > lastHeadingLevel + 1) {
        correctedLevel = lastHeadingLevel + 1;
        headingLevelCorrected++;
      }
      if (rawLevel < lastHeadingLevel) {
        correctedLevel = rawLevel;
      }
      lastHeadingLevel = (headingChaotic ? correctedLevel : rawLevel);
      if (rawLevel !== correctedLevel) {
        formatFixed++;
      }
      result.push(`${indent}${"#".repeat(correctedLevel)} ${title}`);
      continue;
    }

    // 中文数字/点式编号标题：保留原文，仅更新 lastHeadingLevel 用于后续参照（同样只在 chaotic 时生效）
    const cnHeading = line.match(/^([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (cnHeading) {
      if (headingChaotic) lastHeadingLevel = 2;
      result.push(line);
      continue;
    }

    const dottedHeading = line.match(/^(\d+(?:\.\d+)+)[、.．]\s*(.+)$/);
    if (dottedHeading) {
      const dotCount = (dottedHeading[1].match(/\./g) || []).length;
      const level = Math.min(6, 3 + dotCount);
      if (headingChaotic) lastHeadingLevel = level;
      result.push(`${dottedHeading[1]}、${dottedHeading[2]}`);
      continue;
    }

    const numHeading = line.match(/^(\s*)(\((?:\d{1,3})\)|(\d{1,3})([、.．)]))\s*(.+)$/);
    if (numHeading && !/^\s*\d+[.)]\s+\[[ xX]\](?:\s|$)/.test(line)) {
      const indent = numHeading[1].length;
      const indentLevel = Math.floor(indent / 4);
      const level = Math.min(6, Math.max(3, 3 + indentLevel));
      let correctedLevel = level;
      if (headingChaotic && level > lastHeadingLevel + 1) {
        correctedLevel = lastHeadingLevel + 1;
        headingLevelCorrected++;
        formatFixed++;
      }
      if (headingChaotic) lastHeadingLevel = correctedLevel;
      result.push(`${numHeading[1]}${numHeading[2]}${numHeading[5]}`);
      continue;
    }

    // 中英文之间自动补空格（柔和优化）
    const afterSpace = addCnEnSpaces(line);
    if (afterSpace !== line) {
      formatFixed += Math.max(1, Math.abs(afterSpace.length - line.length));
      line = afterSpace;
    }

    result.push(line);
  }

  const output = result.join("\n");

  if (state.showSpellcheck) {
    spellErrors = scanSpellErrors(output);
  }

  return {
    content: output,
    formatFixed,
    spellErrors,
    headingChaotic,
    headingLevelCorrected,
  };
}

function renderOutline(source) {
  const outline = extractOutline(source);
  renderOutlineItems(outline);
}

function renderOutlineItems(outline) {
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

function scheduleEditorOutlineUpdate(content = els.editor.value) {
  if (!state.editorOutlineVisible || state.mode !== "edit") return;
  clearTimeout(state.editorOutlineTimer);
  const value = String(content || "");
  const wait = value.length > 100000 ? 450 : value.length > 20000 ? 180 : 80;
  state.editorOutlineTimer = setTimeout(() => {
    renderEditorOutline(value);
  }, wait);
}

function renderEditorOutline(content) {
  if (!els.editorOutline) return;
  const outline = extractOutline(content);
  if (!outline.length) {
    els.editorOutline.innerHTML = '<p class="editor-outline-empty">暂无标题</p>';
    return;
  }
  // 计算每个标题在文档中的出现次数（用于同名标题区分）
  const titleCountMap = new Map();
  const titleOccurrenceMap = new Map();
  for (const item of outline) {
    const key = item.title.toLowerCase();
    titleCountMap.set(key, (titleCountMap.get(key) || 0) + 1);
  }
  const itemButton = (item) => {
    const key = item.title.toLowerCase();
    const occurrence = titleOccurrenceMap.get(key) || 0;
    titleOccurrenceMap.set(key, occurrence + 1);
    const indent = Math.max(0, item.level - 1) * 14;
    const hasDuplicate = titleCountMap.get(key) > 1;
    const dupLabel = hasDuplicate ? ` (${occurrence + 1}/${titleCountMap.get(key)})` : "";
    return `<button class="editor-outline-item level-${item.level}" data-heading-text="${escapeHtml(item.title)}" data-heading-line="${Number.isFinite(item.line) ? item.line : -1}" data-heading-occurrence="${occurrence}" style="margin-left:${indent}px" title="${escapeHtml(item.title)}${escapeHtml(dupLabel)}">${escapeHtml(compactName(item.title, 15))}${escapeHtml(dupLabel)}</button>`;
  };
  // level <= 2 的标题作为可折叠分组父级，其后紧跟的 level > 2 子标题收进折叠区。
  const rows = [];
  for (let index = 0; index < outline.length; index += 1) {
    const item = outline[index];
    if (item.level > 2) continue;
    const children = [];
    let cursor = index + 1;
    while (cursor < outline.length && outline[cursor].level > 2) {
      children.push(outline[cursor]);
      cursor += 1;
    }
    if (!children.length) {
      rows.push(itemButton(item));
      continue;
    }
    const groupId = `editor-outline-group-${index}`;
    rows.push(`<section class="editor-outline-group">
      <div class="editor-outline-group-head">
        ${itemButton(item)}
        <button type="button" class="editor-outline-toggle" data-editor-outline-toggle="${groupId}" aria-controls="${groupId}" aria-expanded="false" title="展开子标题"><span aria-hidden="true">&#8250;</span></button>
      </div>
      <div id="${groupId}" class="editor-outline-children is-collapsed">${children.map((child) => itemButton(child)).join("")}</div>
    </section>`);
    index = cursor - 1;
  }
  els.editorOutline.innerHTML = `<p class="editor-outline-title">目录大纲</p>${rows.join("")}`;
}

function setEditorOutlineVisible(visible, { persist = true } = {}) {
  state.editorOutlineVisible = Boolean(visible);
  if (persist) localStorage.setItem("editorOutlineVisible", state.editorOutlineVisible ? "1" : "0");
  // 切换栏可见性会触发 grid 重排，可能引起 CodeMirror 滚动/选区错位。
  // 先记录当前编辑器视口，待布局稳定后恢复，做到平滑切换不改变编辑位置。
  const keepViewport = state.mode === "edit" && !state.editorHidden;
  const savedScroll = keepViewport ? els.editor.scrollTop : null;
  const savedSel = keepViewport ? [els.editor.selectionStart, els.editor.selectionEnd] : null;
  els.editorBody.classList.toggle("outline-hidden", !state.editorOutlineVisible);
  els.editorOutline.classList.toggle("hidden", !state.editorOutlineVisible);
  if (els.outlineToggleBtn) {
    els.outlineToggleBtn.setAttribute("aria-pressed", String(state.editorOutlineVisible));
    els.outlineToggleBtn.textContent = state.editorOutlineVisible ? "隐藏大纲" : "大纲";
  }
  if (state.editorOutlineVisible && state.mode === "edit") {
    scheduleEditorOutlineUpdate();
  }
  // 切换大纲可见性后必须重算 editor-body 的 grid 列宽，
  // 否则内联 gridTemplateColumns 会保留旧宽度，导致编辑/预览栏留白或未均分。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (typeof applyEditorSplitterLayout === "function") applyEditorSplitterLayout();
      if (state.mode === "edit") {
        els.editor.view?.requestMeasure?.();
        if (savedScroll !== null) {
          try { els.editor.scrollTop = savedScroll; } catch (_) {}
          if (savedSel) { try { els.editor.setSelectionRange(savedSel[0], savedSel[1]); } catch (_) {} }
        }
        syncPreviewToEditor();
      }
    });
  });
}

function findHeadingLineInEditor(headingText, occurrence = 0) {
  if (!headingText) return -1;
  const target = plainText(headingText).toLowerCase();
  const doc = els.editor.view?.state?.doc;
  if (doc) {
    const totalLines = doc.lines;
    let matchCount = 0;
    for (let index = 0; index < totalLines; index += 1) {
      const line = doc.line(index + 1);
      const text = line.text;
      const match = text.match(/^(\s*)(#{1,6})\s+(.+)$/);
      if (match && plainText(match[3]).toLowerCase() === target) {
        if (matchCount === occurrence) return index;
        matchCount += 1;
      }
      const autoMatch = text.match(/^(\s*)([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
      if (autoMatch && plainText(autoMatch[2]).toLowerCase() === target) {
        if (matchCount === occurrence) return index;
        matchCount += 1;
      }
    }
    return -1;
  }
  const value = els.editor.value;
  const lines = value.split("\n");
  let matchCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (match && plainText(match[3]).toLowerCase() === target) {
      if (matchCount === occurrence) return index;
      matchCount += 1;
    }
    const autoMatch = lines[index].match(/^(\s*)([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (autoMatch && plainText(autoMatch[2]).toLowerCase() === target) {
      if (matchCount === occurrence) return index;
      matchCount += 1;
    }
  }
  return -1;
}

function scrollEditorToHeading(headingText, occurrence = 0) {
  const lineIndex = findHeadingLineInEditor(headingText, occurrence);
  if (lineIndex < 0) return;
  els.editor.scrollToLine?.(lineIndex + 1);
  els.editor.focus?.();
}

// 隐藏编辑器后点击大纲标题，预览栏需要直接跳转到对应标题位置。
function scrollPreviewToSourceLine(lineIndex) {
  if (!Number.isFinite(lineIndex) || lineIndex < 0) return;
  if (!els.preview || state.mode !== "edit") return;
  const anchors = state.previewAnchors || [];
  let target = null;
  for (const anchor of anchors) {
    if (anchor.line <= lineIndex) target = anchor;
    else break;
  }
  if (!target && anchors.length) target = anchors[0];
  if (!target) {
    const explicit = els.preview.querySelector(`[data-source-line="${lineIndex}"]`);
    if (explicit) target = { element: explicit, line: lineIndex };
  }
  if (!target) return;
  const previewMax = Math.max(0, els.preview.scrollHeight - els.preview.clientHeight);
  if (previewMax <= 0) { els.preview.scrollTop = 0; return; }
  const top = Math.max(0, target.element.offsetTop - els.preview.clientHeight * 0.12);
  els.preview.scrollTop = Math.round(Math.min(top, previewMax));
  state.syncPreviewScroll.ratio = clamp(els.preview.scrollTop / previewMax, 0, 1);
}

function scrollPreviewToHeading(headingText, occurrence = 0) {
  const lineIndex = findHeadingLineInEditor(headingText, occurrence);
  if (lineIndex < 0) return;
  scrollPreviewToSourceLine(lineIndex);
}

// 没有 recentDocs 时显示的备用预览文档（简短介绍使用方法，200 字内）。
const BACKUP_PREVIEW_DOC = `# 欢迎使用 MyTemple Knowledge

本地优先的 Markdown 知识库，文档保存在普通文件夹中，不被绑架。

**快速开始**

- 左侧目录：点击文件树中的 Markdown 文档即可阅读。
- 顶部「最近」栏：快速跳回最近打开的文档，点击 × 可移除条目。
- 顶部「修改」按钮进入编辑模式，支持大纲、编辑器、实时预览三栏。
- 编辑工具栏：隐藏/显示大纲、编辑器、预览，或进入沉浸模式专注写作。
- 快捷键：Ctrl+U AI 智能检索，Ctrl+I AI 编辑，Ctrl+F 关键字检索，Ctrl+Shift+I 导入文档，Ctrl+Q 显示/隐藏工作区目录，Alt+Q 显示/隐藏大纲目录，Ctrl+W 显示/隐藏预览。

打开任意文档即可开始记录。`;

function showBackupPreviewDoc() {
  state.currentPath = "";
  state.currentContent = BACKUP_PREVIEW_DOC;
  state.currentVersion = "";
  state.currentDocCreated = 0;
  state.currentEncoding = "utf-8";
  state.currentIsMarkdown = true;
  state.lastSavedContent = BACKUP_PREVIEW_DOC;
  state.selectedNode = "";
  state.selectedFolder = "";
  state.folderExplicit = false;
  updateLargeDocumentState(BACKUP_PREVIEW_DOC, true);
  els.docPath.textContent = "docs";
  els.docPath.title = "";
  els.docTitle.textContent = "欢迎使用 MyTemple Knowledge";
  els.docTitle.title = "欢迎使用";
  els.markdownView.classList.remove("empty-state");
  try { els.editor.value = BACKUP_PREVIEW_DOC; } catch (e) { console.error("set backup editor value failed", e); }
  resetUndo(BACKUP_PREVIEW_DOC);
  lastInputLength = BACKUP_PREVIEW_DOC.length;
  lastInputValue = BACKUP_PREVIEW_DOC;
  setSaveStatus("\u4fdd\u5b58", false);
  if (state.mode === "view") {
    void renderReaderContent(BACKUP_PREVIEW_DOC).catch((e) => console.error("render backup reader failed", e));
  } else if (state.mode === "edit") {
    if (state.previewVisible) renderCurrentPreviewNow(BACKUP_PREVIEW_DOC);
    if (state.editorOutlineVisible) renderEditorOutline(BACKUP_PREVIEW_DOC);
  }
  els.preview.scrollTop = 0;
  state.syncPreviewScroll.ratio = 0;
  syncTreeSelectionState();
  updateEditorPlaceholder();
  renderRecentDocs();
  refreshStatusBar?.();
}

// 删除或关闭文档后统一清理：顶部栏标题/路径、编辑栏、预览栏、最近打开、视图状态。
// 删除后优先切到最近打开的下一篇文档，否则展示备用预览欢迎页。
async function handleDocsClosed(closedPaths = []) {
  if (!Array.isArray(closedPaths)) closedPaths = [closedPaths].filter(Boolean);
  const pathSet = new Set(closedPaths.filter(Boolean));
  let currentWasRemoved = state.currentPath && pathSet.has(state.currentPath);
  pathSet.forEach((p) => removeRecentDoc(p));
  pathSet.forEach((p) => {
    if (state.selectedFolder === p || p.startsWith(`${state.selectedFolder}/`)) state.selectedFolder = "";
    state.multiSelected.delete(p);
  });
  if (state.currentPath && pathSet.has(state.currentPath)) {
    state.currentPath = "";
  }
  // 如果当前编辑文档被删除，尝试切换到下一篇最近打开的文档。
  // openDoc 返回布尔值：成功则结束清理流程；失败（含被新 openDoc 覆盖）时回退到清空显示，
  // 避免旧文档内容残留在编辑器/预览中导致状态与显示不一致。
  if (currentWasRemoved && state.recentDocs.length > 0) {
    const nextDoc = state.recentDocs.find((item) => !pathSet.has(item.path));
    if (nextDoc?.path) {
      const ok = await openDoc(nextDoc.path);
      if (ok) return;
    }
  }
  // 没有最近文档可切换：清除全部显示，展示备用预览页。
  state.currentContent = "";
  state.selectedNode = "";
  state.folderExplicit = false;
  state.graphReady = false;
  state.currentDocCreated = 0;
  state.currentVersion = "";
  state.currentEncoding = "utf-8";
  state.currentIsMarkdown = false;
  state.lastSavedContent = "";
  state.previewLastContent = "";
  els.docPath.textContent = "docs";
  els.docPath.title = "";
  els.docTitle.textContent = "选择一篇 Markdown 文档";
  els.docTitle.title = "";
  els.markdownView.classList.add("empty-state");
  els.markdownView.innerHTML = "<h2>打开左侧目录中的文档</h2><p>支持文件夹分类、全文检索、文档切换、编辑保存和关联图谱浏览。</p>";
  renderOutline("");
  try { els.editor.value = ""; }
  catch (e) { logDocError("关闭文档时清空编辑器", e); }
  try { els.preview.replaceChildren(); }
  catch (e) { logDocError("关闭文档时清空预览", e); }
  els.preview.scrollTop = 0;
  state.syncPreviewScroll.ratio = 0;
  resetUndo("");
  lastInputLength = 0;
  lastInputValue = "";
  updateLargeDocumentState("", true);
  updateStatusDocName("");
  updateStatusCreated(0);
  setSaveStatus("保存", false);
  syncTreeSelectionState();
  renderRecentDocs();
  updateEditorPlaceholder();
  refreshStatusBar?.();
}



const PRINT_DOWNLOAD_URL = "https://mytemple.fshby.cc/";
const PRINT_BRAND_NAME = "MyTemple Knowledge";
const PRINT_BRAND_SLOGAN = "个人知识沉淀 · 本地 Markdown 知识库 · 让写作、阅读与管理都更安心";

function buildDocumentPrintHtml() {
  const title = els.docTitle?.textContent || state.currentDoc?.title || "MyTemple 文档";
  const rawContent = String(state.currentContent || els.editor.value || "");
  const content = stripFrontmatter(rawContent);
  const body = normalizeAssetUrlsToRelative(cachedRenderMarkdown(content));
  const pdfSettings = readPdfExportSettings();
  const showDate = pdfSettings.showDate;
  const showAuthor = pdfSettings.showAuthor;
  const showFooter = pdfSettings.showFooter;
  const updated = state.currentDoc?.updated || state.currentDoc?.modified;
  const dateLabel = showDate && updated ? new Date(updated).toLocaleString() : "";
  const authorLabel = escapeHtml(pdfSettings.authorText || "郑堃逢");
  const exportNote = showAuthor ? `<p class="print-author">由 ${PRINT_BRAND_NAME} 导出 · ${authorLabel}</p>` : "";
  const footerLabel = escapeHtml(pdfSettings.footerText || `${PRINT_BRAND_NAME} · 本地 Markdown 知识库`);
  const footer = showFooter ? `<footer class="print-footer"><span>${footerLabel}</span></footer>` : "";
  const watermark = buildExportWatermark(pdfSettings.watermarkText);
  // 默认品牌推荐条（即使用户把 showFooter 关了也保留。用户明确说"导出PDF默认带官网下载链接和简单推荐语"）。
  // 它放在 print-footer 之后，是文末一块单独的虚线卡片，不使用 fixed，不会覆盖正文。
  const brandRecommend = `
    <section class="print-brand-recommend" aria-label="${PRINT_BRAND_NAME} 推荐">
      <div class="print-brand-logo" aria-hidden="true">M</div>
      <div class="print-brand-body">
        <strong>本文档由「${PRINT_BRAND_NAME}」导出 · 欢迎体验官网最新版</strong>
        <div>${escapeHtml(PRINT_BRAND_SLOGAN)}</div>
        <div>官网下载地址：<a href="${PRINT_DOWNLOAD_URL}" target="_blank" rel="noreferrer noopener">${PRINT_DOWNLOAD_URL}</a></div>
      </div>
    </section>`;
  return `<article class="print-article">
    ${watermark}
    <header class="print-header">
      <h1 class="print-title">${escapeHtml(title)}</h1>
      ${dateLabel ? `<p class="print-meta">${escapeHtml(dateLabel)}</p>` : ""}
      ${exportNote}
    </header>
    <div class="print-body">${body}</div>
    ${footer}
    ${brandRecommend}
  </article>`;
}

/**
 * 将 Mermaid 渲染出的 <svg> 节点 + 用户文档里的本地 <img> 统一转换为 data URL，
 * 再把 KaTeX 的外部 CSS 依赖就地展开为 inline style。
 * 这样导出 iframe about:blank 无需任何外网、无需加载第三方字体/CSS，
 * 就能完整显示：公式、Mermaid 图表、本地引用图片。
 */
async function materializePrintArtifacts(container) {
  if (!container) return;

  // 1) Mermaid 图表渲染：把 .mermaid-source 源码 → mermaid.render → <svg> 写回 .mermaid-container
  const mermaidBlocks = container.querySelectorAll(".chart-block.mermaid-block");
  if (mermaidBlocks.length) {
    try {
      const mermaid = await loadMermaidAsync();
      if (mermaid) {
        if (!_mermaidInitialized) {
          try { mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" }); } catch(_) {}
          _mermaidInitialized = true;
        }
        const seq = ++_mermaidRenderSeq;
        for (let i = 0; i < mermaidBlocks.length; i++) {
          const block = mermaidBlocks[i];
          const sourcePre = block.querySelector(".mermaid-source");
          const containerDiv = block.querySelector(".mermaid-container");
          if (!sourcePre || !containerDiv) continue;
          const rawDef = sourcePre.textContent || "";
          const id = `print-mermaid-${Date.now()}-${i}-${seq}`;
          try {
            const { svg } = await mermaid.render(id, rawDef);
            if (seq === _mermaidRenderSeq) containerDiv.innerHTML = svg;
          } catch (err) {
            // 渲染失败：保留源码（等宽 pre 显示），不阻断整个 PDF 导出
            console.warn("PDF Mermaid 图表渲染降级为源码显示", err);
            if (seq === _mermaidRenderSeq) {
              sourcePre.style.display = "block";
              sourcePre.style.whiteSpace = "pre-wrap";
              sourcePre.style.fontSize = "12px";
              containerDiv.innerHTML = "";
            }
          }
        }
      }
    } catch (err) {
      console.warn("PDF Mermaid 加载失败，降级显示源码", err);
      mermaidBlocks.forEach((b) => {
        const pre = b.querySelector(".mermaid-source");
        if (pre) { pre.style.display = "block"; pre.style.whiteSpace = "pre-wrap"; }
      });
    }
  }

  // 1.5) Excalidraw 图表：没有 Excalidraw 运行期时降级显示源码文本，
  //      不会让导出 PDF 留一块空白（避免"导出后缺图"）。
  const excalidrawBlocks = container.querySelectorAll(".chart-block.excalidraw-block");
  excalidrawBlocks.forEach((block) => {
    const containerDiv = block.querySelector(".excalidraw-container");
    if (!containerDiv) return;
    if (containerDiv.children.length === 0 && !containerDiv.textContent.trim()) {
      const sourcePre = block.querySelector(".excalidraw-source");
      if (sourcePre) {
        sourcePre.style.display = "block";
        sourcePre.style.whiteSpace = "pre-wrap";
        sourcePre.style.fontSize = "12px";
      }
    }
  });

  // 2) KaTeX 数学公式渲染：对 .math-block / .math-inline (data-math) 使用 katex.render。
  const mathEls = container.querySelectorAll(".math-block[data-math], .math-inline[data-math]");
  if (mathEls.length) {
    try {
      const katex = await loadKatexAsync();
      if (katex) {
        mathEls.forEach((el) => {
          const math = el.getAttribute("data-math") || "";
          const isBlock = el.classList.contains("math-block");
          try {
            katex.render(math, el, {
              throwOnError: false,
              displayMode: isBlock,
              output: "htmlAndMathml",
              strict: false,
              errorColor: "#ef4444",
            });
          } catch (err) {
            // KaTeX 语法错误：显示红色源代码
            el.textContent = math;
            el.style.color = "#ef4444";
            el.style.fontFamily = "monospace";
          }
        });
      }
    } catch (err) {
      console.warn("PDF KaTeX 加载失败，降级显示源码", err);
      mathEls.forEach((el) => {
        const math = el.getAttribute("data-math") || "";
        el.textContent = (el.classList.contains("math-block") ? "$$" : "$") + math + (el.classList.contains("math-block") ? "$$" : "$");
        el.style.color = "#94a3b8";
        el.style.fontFamily = "monospace";
      });
    }
  }

  // 3) 将所有 <svg>（Mermaid产物/用户手写SVG/图表块）转换为独立 <img src="data:image/svg+xml;utf8,...">
  //    以兼容 Edge/Chromium 打印时丢失 SVG stroke/fill / 外部 class 样式的情况。
  const svgNodes = [...container.querySelectorAll("svg")];
  for (const svg of svgNodes) {
    try {
      if (!svg.parentElement) continue;
      // 加上 xmlns + width/height，保证 data URI 解码后不会是 0×0
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const vb = svg.getAttribute("viewBox") || "";
      if (!svg.hasAttribute("width")) {
        const m = vb.match(/\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/);
        if (m) { svg.setAttribute("width", m[1]); svg.setAttribute("height", m[2]); }
      }
      // 注入"样式兜底"：如果 <svg> 内大量 <path>/<line>/<rect> 等只有 class 没有 fill/stroke，
      // 我们从主页面计算好实际 style（fill, stroke, stroke-width, opacity）写到 inline，
      // 避免打印 iframe 缺 css 导致整个图表是黑线空心大色块。
      const styled = svg.querySelectorAll("path, line, rect, circle, ellipse, polygon, polyline, text, tspan, g");
      styled.forEach((node) => {
        try {
          const cs = window.getComputedStyle(node);
          const pick = (inline, computedKey, cssKey) => {
            if (!node.getAttribute(inline) || node.getAttribute(inline) === "none") {
              const v = cs.getPropertyValue(computedKey);
              if (v && v !== "" && v !== "none" && v !== "rgba(0, 0, 0, 0)") node.setAttribute(cssKey, v);
            }
          };
          pick("fill", "fill", "fill");
          pick("stroke", "stroke", "stroke");
          pick("stroke-width", "stroke-width", "stroke-width");
          pick("opacity", "opacity", "opacity");
          pick("color", "color", "color");
        } catch (_) {}
      });
      const raw = new XMLSerializer().serializeToString(svg);
      // encodeURIComponent 对大多数浏览器足够；但 '#' 需要转为 %23 避免被当作 URI fragment
      const encoded = encodeURIComponent(raw).replace(/#/g, "%23");
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encoded}`;
      const img = document.createElement("img");
      const w = svg.getAttribute("width") || "100%";
      const h = svg.getAttribute("height") || "auto";
      img.setAttribute("src", dataUrl);
      img.setAttribute("alt", "chart");
      img.style.maxWidth = "100%";
      img.style.height = h === "auto" ? "auto" : (String(h).endsWith("%") ? h : `${h}px`);
      img.style.width = String(w).endsWith("%") ? w : `${w}px`;
      img.style.display = "block";
      img.style.margin = "0 auto";
      img.style.pageBreakInside = "avoid";
      svg.replaceWith(img);
    } catch (e) {
      // 单个 svg 失败不要中断整体导出
      console.warn("PDF SVG 内联失败，保留原始 svg", e);
    }
  }

  // 4) 图片 data URL 化（重复 inlinePrintImages 逻辑，但这里只处理 container 内节点，避免重新 fetch）
  const imgs = [...container.querySelectorAll("img")];
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:") || /^https?:/i.test(src)) {
      img.removeAttribute("loading");
      return;
    }
    img.removeAttribute("loading");
    try {
      const r = await fetch(src, { credentials: "include" });
      if (!r.ok) return;
      const blob = await r.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const rd = new FileReader();
        rd.onload = () => resolve(rd.result);
        rd.onerror = reject;
        rd.readAsDataURL(blob);
      });
      img.setAttribute("src", dataUrl);
    } catch (_) { /* keep original */ }
  }));
}

/**
 * 新的 PDF 主 HTML 生成入口：先构建 → 离屏渲染 Mermaid + KaTeX → 内联图表与图片 →
 * 再返回最终纯字符串 HTML（不再有任何对外部 CSS/JS/字体/网络的依赖）。
 */
async function buildDocumentPrintHtmlRendered() {
  const html = buildDocumentPrintHtml();
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-99999px;top:-99999px;width:900px;height:auto;background:#fff;visibility:visible;pointer-events:none;z-index:-1;";
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    await materializePrintArtifacts(host);
    // 等待下一帧再取 innerHTML，保证浏览器把 inline style/size 真正算出来
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 120));
    return host.innerHTML;
  } finally {
    host.remove();
  }
}

async function inlinePrintImages(html) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  const images = [...wrapper.querySelectorAll("img")];
  await Promise.all(images.map(async (img) => {
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:") || /^https?:/i.test(src)) {
      img.removeAttribute("loading");
      return;
    }
    img.removeAttribute("loading");
    try {
      const response = await fetch(src, { credentials: "include" });
      if (!response.ok) return;
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      img.setAttribute("src", dataUrl);
    } catch (_) { /* keep original */ }
  }));
  return wrapper.innerHTML;
}

// 自定义对话框：替代原生 confirm/prompt/alert。
// 浏览器原生对话框会显示来源站点（如 127.0.0.1:4173），造成地址与端口外泄，
// 自定义对话框不暴露来源信息，兼顾安全防护与一致体验。
function buildCustomDialog({ title, message, input, confirmText = "确定", cancelText = "取消", danger = false }) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `<div class="modal-dialog custom-dialog">
    <div class="modal-head"><h2>${escapeHtml(title)}</h2></div>
    <p class="custom-dialog-message">${escapeHtml(message).replaceAll("\n", "<br />")}</p>
    ${input ? `<input class="custom-dialog-input" type="text" />` : ""}
    <div class="modal-actions">
      <button type="button" class="custom-dialog-cancel">${escapeHtml(cancelText)}</button>
      <button type="button" class="primary custom-dialog-confirm ${danger ? "danger" : ""}">${escapeHtml(confirmText)}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function customConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const { title = "确认操作", confirmText = "确定", cancelText = "取消", danger = false } = options;
    const overlay = buildCustomDialog({ title, message, confirmText, cancelText, danger });
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
      else if (e.key === "Enter") done(true);
    };
    const done = (result) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector(".custom-dialog-cancel").addEventListener("click", () => done(false));
    overlay.querySelector(".custom-dialog-confirm").addEventListener("click", () => done(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(false); });
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => overlay.querySelector(".custom-dialog-confirm")?.focus());
  });
}

function customPrompt(message, defaultValue = "", options = {}) {
  return new Promise((resolve) => {
    const { title = "请输入", confirmText = "确定", cancelText = "取消" } = options;
    const overlay = buildCustomDialog({ title, message, input: true, confirmText, cancelText });
    const inputEl = overlay.querySelector(".custom-dialog-input");
    if (inputEl) inputEl.value = String(defaultValue || "");
    const onKey = (e) => {
      if (e.key === "Escape") done(null);
      else if (e.key === "Enter") done(inputEl?.value ?? "");
    };
    const done = (result) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector(".custom-dialog-cancel").addEventListener("click", () => done(null));
    overlay.querySelector(".custom-dialog-confirm").addEventListener("click", () => done(inputEl?.value ?? ""));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(null); });
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => { inputEl?.focus(); inputEl?.select(); });
  });
}

function customAlert(message, options = {}) {
  return new Promise((resolve) => {
    const { title = "提示", confirmText = "知道了" } = options;
    const overlay = document.createElement("div");
    overlay.className = "modal";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `<div class="modal-dialog custom-dialog">
      <div class="modal-head"><h2>${escapeHtml(title)}</h2></div>
      <p class="custom-dialog-message">${escapeHtml(message).replaceAll("\n", "<br />")}</p>
      <div class="modal-actions">
        <button type="button" class="primary custom-dialog-confirm">${escapeHtml(confirmText)}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") done();
    };
    const done = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(true);
    };
    overlay.querySelector(".custom-dialog-confirm").addEventListener("click", done);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(); });
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => overlay.querySelector(".custom-dialog-confirm")?.focus());
  });
}

// KaTeX 打印样式：把 KaTeX 0.16 常用样式最小集合直接注入到打印 iframe，
// 避免 iframe about:blank 访问不到远程 CDN CSS 导致公式全部渲染出来却"糊成一团或错位"。
// 同时包含必要的 .katex-display / .katex / .mord / .mbin / .mfrac 等关键布局。
const KATEX_PRINT_CSS = `
.katex-display{display:block;margin:1em 0;text-align:center;white-space:nowrap;overflow-x:auto;overflow-y:hidden}
.katex{font:italic 1.21em "KaTeX_Main","Times New Roman",Times,serif;line-height:1.2;text-indent:0}
.katex *{-ms-high-contrast-adjust:none!important}
.katex .katex-version:after{content:"0.16.9"}
.katex .katex-mathml{position:absolute;overflow:clip;height:1px;width:1px;padding:0;border:0}
.katex .base{position:relative;display:inline-block;box-sizing:content-box;white-space:nowrap;width:min-content}
.katex .strut{display:inline-block}
.katex .mord,.katex .mbin,.katex .mrel,.katex .mopen,.katex .mclose,.katex .mpunct,.katex .minner,.katex .mop{position:relative;display:inline-flex;align-items:baseline}
.katex .mfrac>span>span>span{padding:0}
.katex .mfrac .frac-line{display:inline-block;width:100%;border-bottom-style:solid;border-bottom-width:1px}
.katex .mfrac .frac-line:before{content:"";display:block}
.katex .mfrac .frac-line:after{content:"";display:block}
.katex .mspace{display:inline-block}
.katex .llap,.katex .rlap{width:0;position:relative}
.katex .llap>span,.katex .rlap>span{position:absolute}
.katex .llap>span{right:0}
.katex .rlap>span{left:0}
.katex .katex-html{display:inline-block}
.katex .katex-mathml{position:absolute;clip:rect(1px,1px,1px,1px);padding:0;border:0;height:1px;width:1px;overflow:hidden}
.katex .op-symbol{position:relative}
.katex .op-symbol.small-op{font-family:"KaTeX_Size1";font-weight:400}
.katex .op-symbol.large-op{font-family:"KaTeX_Size2";font-weight:400}
.katex .op-limits{display:flex;flex-direction:column;align-items:center}.mtable{display:inline-table;text-align:center;vertical-align:middle;box-sizing:border-box;border-collapse:collapse;margin:0.25em 0}
.mtable .mtd{display:table-cell;text-align:center;vertical-align:middle;padding:0.25em 0.4em}
.mtable .mtd:empty{min-width:1ex}
.katex-display .mfrac,.katex .mfrac{text-align:center}
.katex .mfrac>span>span{display:flex;flex-direction:column;align-items:center}
.katex .mfrac .num{order:1}
.katex .mfrac .den{order:2}
.katex .rule{display:inline-block;border:0 solid currentColor;position:relative}
.katex .overline .overline-line{display:inline-block;width:100%;border-bottom-style:solid;border-bottom-width:1px;margin-bottom:3px}
.katex .underline .underline-line{display:inline-block;width:100%;border-top-style:solid;border-top-width:1px;margin-top:2px}
.katex .sqrt>span{display:inline-flex;align-items:center}
.katex .sqrt .sqrt-sign{font-family:"KaTeX_Main";line-height:1}
.katex .sqrt .sqrt-line{display:inline-block;width:100%;border-top-style:solid;border-top-width:1px;margin-left:3px}
.katex .sizing{display:inline-block}
.katex .sizing.reset-size1.size1,.katex .fontsize-ensurer.reset-size1.size1{font-size:1em}
.katex .sizing.reset-size2.size2,.katex .fontsize-ensurer.reset-size2.size2{font-size:1.4em}
.katex .sizing.reset-size3.size3,.katex .fontsize-ensurer.reset-size3.size3{font-size:1.6em}
.katex .sizing.reset-size4.size4,.katex .fontsize-ensurer.reset-size4.size4{font-size:1.8em}
.katex .sizing.reset-size5.size5,.katex .fontsize-ensurer.reset-size5.size5{font-size:2em}
.katex .sizing.reset-size6.size6,.katex .fontsize-ensurer.reset-size6.size6{font-size:2.4em}
.katex .sizing.reset-size7.size7,.katex .fontsize-ensurer.reset-size7.size7{font-size:2.88em}
.katex .sizing.reset-size8.size8,.katex .fontsize-ensurer.reset-size8.size8{font-size:3.46em}
.katex .sizing.reset-size9.size9,.katex .fontsize-ensurer.reset-size9.size9{font-size:4.14em}
.katex .sizing.reset-size10.size10,.katex .fontsize-ensurer.reset-size10.size10{font-size:4.97em}
.katex .stretchy{display:inline-block;white-space:nowrap;width:100%}
.katex .stretchy::before,.katex .stretchy::after{content:""}
.katex .vlist{display:inline-block}.katex .vlist>span{display:inline-flex;flex-direction:column;align-items:center}
.katex .vlist .vlist-s{align-self:baseline}
.katex .vlist .vlist-t{align-self:baseline;display:inline-table}
.katex .vlist .vlist-r{display:table-row}
.katex .vlist .vlist-b{display:table-cell}
.katex .vlist .vlist-a{display:table-cell;height:0;vertical-align:bottom}
.katex .accent-body{position:relative}
.katex .accent-body>span{position:absolute;left:0;width:100%}
.katex .accent-body>span>span{display:block}
.katex .math{font-family:"KaTeX_Main";font-style:italic}
.katex .mathit{font-family:"KaTeX_Math";font-style:italic}
.katex .mathbf{font-family:"KaTeX_Main";font-weight:700}
.katex .mathrm{font-family:"KaTeX_Main";font-style:normal}
.katex .mathsf{font-family:"KaTeX_SansSerif"}
.katex .mathbb{font-family:"KaTeX_AMS"}
.katex .mathcal{font-family:"KaTeX_Caligraphic"}
.katex .mathfrak{font-family:"KaTeX_Frak"}
.katex .mathtt{font-family:"KaTeX_Typewriter"}
.katex .mathbfit{font-family:"KaTeX_Main-BoldItalic"}
.katex .colortext::before,.katex .boldsymbol::before{content:attr(data-content)}
.katex .mord .rule{display:none}
@supports (display:inline-flex){
  .katex .vlist>span>span>span{display:inline-table}
  .katex .vlist>span>span>span>span{display:table-cell}
  .katex .vlist .vlist-a{height:auto}
}
.katex svg{fill:none;stroke-linecap:square}
.katex .delimsizing{display:inline-block}
.katex .delimsizing.size1{font-family:"KaTeX_Size1"}
.katex .delimsizing.size2{font-family:"KaTeX_Size2"}
.katex .delimsizing.size3{font-family:"KaTeX_Size3"}
.katex .delimsizing.size4{font-family:"KaTeX_Size4"}
`;

// 打印样式：注入到打印 iframe，使导出的 PDF 不依赖主页面样式，
// 同时 iframe 来源为 about:blank，浏览器页眉页脚不会显示本机地址与端口。
const PRINT_STYLES = `html,body{margin:0;padding:0;background:#fff;}
.print-article{background:#ffffff;color:#1f2937;font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;font-size:14px;line-height:1.75;padding:32px 40px 64px 40px;max-width:860px;margin:0 auto;position:relative;}
.print-header{text-align:center;border-bottom:2px solid #1f2937;padding-bottom:18px;margin-bottom:28px;}
.print-title{font-size:26px;font-weight:700;color:#111827;margin:0 0 8px;line-height:1.35;}
.print-meta{font-size:12px;color:#6b7280;margin:0 0 4px;}
.print-author{font-size:12px;color:#9ca3af;margin:0;}
.print-body h1,.print-body h2,.print-body h3,.print-body h4{color:#111827;font-weight:600;line-height:1.4;margin-top:1.6em;margin-bottom:0.6em;}
.print-body h1{font-size:22px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;}
.print-body h2{font-size:19px;border-bottom:1px solid #eef0f3;padding-bottom:4px;}
.print-body h3{font-size:16px;}
.print-body h4{font-size:14px;}
.print-body p{margin:0.7em 0;}
.print-body a{color:#2563eb;text-decoration:underline;word-break:break-all;}
.print-body img{max-width:100%;height:auto;display:block;margin:14px auto;border-radius:4px;page-break-inside:avoid;}
.print-body blockquote{margin:1em 0;padding:8px 16px;border-left:3px solid #2563eb;background:#f8fafc;color:#475569;}
.print-body blockquote p{margin:0.4em 0;}
.print-body .callout{margin:1em 0;padding:10px 16px;border-radius:6px;border-left:4px solid #94a3b8;background:#f8fafc;page-break-inside:avoid;}
.print-body .callout-title{display:block;font-weight:700;margin-bottom:4px;font-size:0.95em;}
.print-body .callout-body{font-size:0.93em;line-height:1.65;}
.print-body .callout-note{border-left-color:#4f8cf7;background:#eff6ff;}
.print-body .callout-info{border-left-color:#4f8cf7;background:#eff6ff;}
.print-body .callout-tip{border-left-color:#10b981;background:#ecfdf5;}
.print-body .callout-success{border-left-color:#10b981;background:#ecfdf5;}
.print-body .callout-warning{border-left-color:#f59e0b;background:#fffbeb;}
.print-body .callout-danger,.print-body .callout-failure,.print-body .callout-bug{border-left-color:#ef4444;background:#fef2f2;}
.print-body .callout-question{border-left-color:#8b5cf6;background:#f5f3ff;}
.print-body .callout-quote,.print-body .callout-abstract{border-left-color:#6b7280;background:#f9fafb;}
.print-body .callout-example{border-left-color:#06b6d4;background:#ecfeff;}
.print-body .callout-todo{border-left-color:#d97706;background:#fffbeb;}
.print-body .callout-important{border-left-color:#ea580c;background:#fff7ed;}
.print-body .callout-caution{border-left-color:#dc2626;background:#fef2f2;}
.print-body .callout-note .callout-title,.print-body .callout-info .callout-title{color:#2563eb;}
.print-body .callout-tip .callout-title,.print-body .callout-success .callout-title{color:#059669;}
.print-body .callout-warning .callout-title{color:#d97706;}
.print-body .callout-danger .callout-title,.print-body .callout-failure .callout-title,.print-body .callout-bug .callout-title{color:#dc2626;}
.print-body .callout-question .callout-title{color:#7c3aed;}
.print-body .callout-quote .callout-title,.print-body .callout-abstract .callout-title{color:#4b5563;}
.print-body .callout-example .callout-title{color:#0891b2;}
.print-body .callout-todo .callout-title{color:#b45309;}
.print-body .callout-important .callout-title{color:#c2410c;}
.print-body .callout-caution .callout-title{color:#b91c1c;}
.print-body .math-block{display:block;text-align:center;margin:14px 0;overflow-x:auto;padding:4px 0;}
.print-body .math-inline{display:inline-block;}
.print-body video{max-width:100%;max-height:480px;border-radius:6px;margin:12px 0;display:block;}
.print-body pre{background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;padding:14px 16px;overflow-x:auto;font-family:"Cascadia Code",Consolas,monospace;font-size:13px;line-height:1.6;page-break-inside:avoid;}
.print-body code{font-family:"Cascadia Code",Consolas,monospace;font-size:0.92em;background:rgba(15,23,42,0.06);padding:1px 5px;border-radius:3px;}
.print-body pre code{background:transparent;padding:0;border-radius:0;font-size:13px;}
.print-body table{width:100%;border-collapse:collapse;margin:1em 0;font-size:13px;page-break-inside:avoid;}
.print-body th,.print-body td{border:1px solid #d1d5db;padding:8px 12px;text-align:left;}
.print-body th{background:#f1f5f9;font-weight:600;}
.print-body ul,.print-body ol{margin:0.7em 0;padding-left:1.8em;}
.print-body li{margin:0.3em 0;}
.print-body hr{border:0;border-top:1px solid #e5e7eb;margin:1.8em 0;}
/* Mermaid/Excalidraw 图表块：完整显示 + 不跨页切断 */
.print-body .chart-block{margin:16px 0;padding:10px;border:1px solid #eef0f3;border-radius:6px;background:#ffffff;page-break-inside:avoid;text-align:center;}
.print-body .chart-block svg{max-width:100%;height:auto;display:block;margin:0 auto;}
.print-body .mermaid-source,.print-body .excalidraw-source{display:none;}
.print-footer{margin-top:32px;padding:12px 0 4px 0;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af;line-height:1.7;}
.print-footer a{color:#6b7280;text-decoration:none;}
.print-watermark{position:fixed;top:0;left:0;width:100%;height:100%;display:flex;justify-content:center;align-items:center;font-size:52px;color:rgba(15,23,42,0.05);pointer-events:none;transform:rotate(-30deg);z-index:9999;letter-spacing:6px;white-space:nowrap;font-weight:700;}
/* 官方品牌推荐条：绝对不遮挡正文；始终位于文章最末尾，颜色低调 + 宽度控制，多页仅出现在末页下方。
   它不使用 fixed，避免每页打印覆盖内容（"不能影响文档正常显示"）。 */
.print-brand-recommend{
  margin: 28px 0 0 0;
  padding: 12px 14px;
  border: 1px dashed #d1d5db;
  border-radius: 8px;
  background: linear-gradient(180deg, #ffffff 0%, #f9fafb 100%);
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11.5px;
  color: #6b7280;
  line-height: 1.7;
  page-break-inside: avoid;
  break-inside: avoid;
}
.print-brand-logo{
  width: 38px; height: 38px; border-radius: 9px;
  background: linear-gradient(135deg, #8b5cf6 0%, #2563eb 100%);
  color:#fff; display:flex; align-items:center; justify-content:center;
  font-weight:800; font-size: 16px; flex: 0 0 38px;
  box-shadow: 0 2px 6px rgba(139,92,246,0.2);
}
.print-brand-body{flex:1 1 auto;min-width:0;}
.print-brand-body strong{color:#111827;font-weight:600;font-size:12.5px;display:block;margin-bottom:2px;}
.print-brand-body a{color:#2563eb;text-decoration:underline;word-break:break-all;}
${KATEX_PRINT_CSS}
@page{margin:18mm 14mm;size:A4;}`;

async function buildExportableHtml({ withBrandFooter = true } = {}) {
  // 高品质离线 HTML 导出：
  //  - strip frontmatter（读者视角不需要写作者元数据）
  //  - 用 renderMarkdown 产出渲染后 body（含 KaTeX math-block / Mermaid chart-block / Excalidraw chart-block / MATH inline 占位）
  //  - 立即调用 renderMathInPreview + renderChartsInPreview 得到真实 KaTeX DOM 与 Mermaid SVG（等同于阅读栏最终视觉）
  //  - inlinePrintImages：本地相对路径 img → data URI（离线）
  //  - 把主站 styles.css 中 .markdown-body / 图表 / .katex-display 等关键类完整内联（避免 CDN）
  //  - 文末附品牌推荐卡（同 PDF，非 fixed 不挡正文）
  const rawContent = String(state.currentContent || els.editor.value || "");
  const noFm = stripFrontmatter(rawContent);
  const title = els.docTitle?.textContent || state.currentDoc?.title || state.currentPath?.split("/").pop()?.replace(/\.md$/i, "") || "MyTemple 文档";
  const pdfSettings = readPdfExportSettings();
  const showDate = pdfSettings.showDate;
  const showAuthor = pdfSettings.showAuthor;
  const showFooter = pdfSettings.showFooter;
  const updated = state.currentDoc?.updated || state.currentDoc?.modified;
  const dateLabel = showDate && updated ? new Date(updated).toLocaleString() : "";
  const authorLabel = escapeHtml(pdfSettings.authorText || "");
  const exportNote = showAuthor ? `<p class="print-author">由 ${PRINT_BRAND_NAME} 导出 · ${authorLabel}</p>` : "";
  const footerLabel = escapeHtml(pdfSettings.footerText || `${PRINT_BRAND_NAME} · 本地 Markdown 知识库`);
  const footer = showFooter ? `<footer class="print-footer"><span>${footerLabel}</span></footer>` : "";
  const watermark = buildExportWatermark(pdfSettings.watermarkText);
  const brandRecommend = withBrandFooter ? `
    <section class="print-brand-recommend" aria-label="${PRINT_BRAND_NAME} 推荐">
      <div class="print-brand-logo" aria-hidden="true">M</div>
      <div class="print-brand-body">
        <strong>本文档由「${PRINT_BRAND_NAME}」导出 · 欢迎体验官网最新版</strong>
        <div>${escapeHtml(PRINT_BRAND_SLOGAN)}</div>
        <div>官网下载地址：<a href="${PRINT_DOWNLOAD_URL}" target="_blank" rel="noreferrer noopener">${PRINT_DOWNLOAD_URL}</a></div>
      </div>
    </section>` : "";
  // 用离屏容器做 renderMarkdown → 渲染公式/图表 → 取 innerHTML
  const stage = document.createElement("div");
  stage.setAttribute("aria-hidden", "true");
  stage.style.position = "fixed";
  stage.style.left = "-99999px";
  stage.style.top = "-99999px";
  stage.style.width = "900px";
  stage.className = "markdown-body preview-container";
  stage.innerHTML = cachedRenderMarkdown(noFm);
  document.body.appendChild(stage);
  try {
    try { await renderMathInPreview(stage); } catch (_) {}
    try { await renderChartsInPreview(stage); } catch (_) {}
  } finally {
    // 即使 render 抛错也要移除 stage
  }
  let bodyHtml = normalizeAssetUrlsToRelative(stage.innerHTML);
  try { bodyHtml = await inlinePrintImages(bodyHtml); } catch (_) {}
  stage.remove();
  // 使用打印样式 + markdown-body + KATEX_PRINT_CSS 三合一内联 CSS
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
/* 导出页面统一背景与最大宽度，浏览器打开可读 + 打印按 A4 */
html,body{margin:0;padding:0;background:#fff;color:#1f2937;font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;}
body{padding:32px 16px 64px 16px;}
.print-article{max-width:900px;margin:0 auto;background:#fff;}
${PRINT_STYLES}
${KATEX_PRINT_CSS}
/* 图片内联打印边距（inlinePrintImages 会把 img src 改为 data URL，但显示样式要用当前 markdown-body 视觉） */
.print-body img{max-width:100%;height:auto;display:block;margin:16px auto;border-radius:6px;}
.print-body .chart-block{margin:16px 0;padding:12px;border:1px solid #e5e7eb;border-radius:8px;background:#fcfcfd;}
.print-body .mermaid-container svg{max-width:100%;height:auto;display:block;margin:0 auto;}
.print-body .excalidraw-block .excalidraw-preview{background:#f5f5f4;border:1px dashed #d6d3d1;border-radius:8px;padding:12px;}
.print-body .excalidraw-block .excalidraw-json{background:#fff;color:#44403c;font-family:"Cascadia Code",Consolas,monospace;font-size:12px;max-height:240px;overflow:auto;padding:10px;border-radius:6px;}
.print-body .excalidraw-block .excalidraw-hint{color:#78716c;font-size:12px;margin-top:6px;}
@media print {
  @page { size: A4; margin: 18mm 14mm; }
  body{padding:0;}
  .print-article{box-shadow:none;border:0;}
}
</style>
</head>
<body>
<article class="print-article">
  ${watermark}
  <header class="print-header">
    <h1 class="print-title">${escapeHtml(title)}</h1>
    ${dateLabel ? `<p class="print-meta">${escapeHtml(dateLabel)}</p>` : ""}
    ${exportNote}
  </header>
  <div class="print-body markdown-body">${bodyHtml}</div>
  ${footer}
  ${brandRecommend}
</article>
</body>
</html>`;
  return { html, title };
}

async function buildExportableDocxBlob() {
  // Word DOCX 降级方案：生成 Word 能原生打开的 MHTML(.doc)/HTML，
  // 浏览器端无 docx 生成库（避免引入庞大依赖仍失败），但该格式 Word/
  // WPS 直接双击打开，图表/图片/公式/中文都保留。
  const { html, title } = await buildExportableHtml({ withBrandFooter: true });
  // Word 喜欢带 BOM 的 UTF-8，避免中文变问号
  const BOM = "\uFEFF";
  const payload = BOM + html;
  return {
    blob: new Blob([payload], { type: "application/msword;charset=utf-8" }),
    title,
    ext: "doc",
  };
}

async function triggerBlobDownload({ blob, filename }) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    // setAttribute('download') 并加一个延迟，确保 Tauri/Chromium 主线程能把它
    // 推进到"允许下载"列表；经验上 0 偶发丢事件，50ms 稳
    await new Promise((r) => setTimeout(r, 50));
    a.click();
    setTimeout(() => {
      try { a.remove(); } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
    }, 3000);
  } catch (err) {
    try { URL.revokeObjectURL(url); } catch (_) {}
    throw err;
  }
}

async function exportCurrentDoc(format) {
  if (!state.currentPath && !state.currentContent) {
    showToast("请先打开一个文档");
    return;
  }
  const safeTitle = (title) => String(title || "导出文档").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "导出文档";
  const fmt = String(format || "md").toLowerCase();

  // 1) HTML / DOCX：直接前端本地生成最高质量（样式+图+公式+图表全内联）
  if (fmt === "html") {
    showToast("正在导出 HTML（含内联图片/公式/图表）…");
    try {
      const { html, title } = await buildExportableHtml({ withBrandFooter: true });
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      await triggerBlobDownload({ blob, filename: `${safeTitle(title)}.html` });
      showToast("已导出 HTML");
      return;
    } catch (e) {
      console.error("HTML export failed:", e);
      showToast(`HTML 导出失败: ${e.message}`);
      return;
    }
  }
  if (fmt === "docx" || fmt === "doc") {
    showToast("正在导出 Word（DOCX/DOC 兼容格式）…");
    try {
      const { blob, title, ext } = await buildExportableDocxBlob();
      await triggerBlobDownload({ blob, filename: `${safeTitle(title)}.${ext}` });
      showToast("已导出 Word 文档（用 Word/WPS 打开即可，支持图片/公式/中文）");
      return;
    } catch (e) {
      console.error("DOCX export failed:", e);
      showToast(`Word 导出失败: ${e.message}`);
      return;
    }
  }

  // 2) MD / TXT：调用后端 /api/export — 后端已经统一 strip_frontmatter，
  //    TXT 后端同时剥离 Markdown 语法糖（frontmatter / ``` / 标题 / 粗体 等）。
  //    如后端 HTTP 400 或网络失败：前端兜底用 stripFrontmatter + 轻量 txt 剥离，
  //    保证"绝不无法保存"。
  showToast(`正在导出 ${fmt.toUpperCase()}...`);
  const content = state.currentContent || "";
  const title = state.currentTitle || state.currentPath?.split("/").pop()?.replace(/\.md$/i, "") || "导出文档";
  const pdfSettings = readPdfExportSettings();
  const author = pdfSettings.showAuthor ? (pdfSettings.authorText || "") : "";
  const watermark = pdfSettings.watermarkText || "";

  try {
    const resp = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, format: fmt, title, author, watermark }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `导出失败 (HTTP ${resp.status})`);
    }
    const blob = await resp.blob();
    const ext = fmt === "markdown" ? "md" : (fmt === "text" ? "txt" : fmt);
    await triggerBlobDownload({ blob, filename: `${safeTitle(title)}.${ext}` });
    showToast(`已导出 ${fmt.toUpperCase()}`);
    return;
  } catch (e) {
    console.warn("Export via backend failed, fallback to local:", e);
  }

  // —— 前端本地兜底 ——
  try {
    const noFm = stripFrontmatter(content);
    if (fmt === "md" || fmt === "markdown") {
      const blob = new Blob([noFm], { type: "text/markdown;charset=utf-8" });
      await triggerBlobDownload({ blob, filename: `${safeTitle(title)}.md` });
      showToast("已导出 MD（本地降级）");
      return;
    }
    if (fmt === "txt" || fmt === "text") {
      const plain = await (async () => {
        const wrap = document.createElement("div");
        wrap.innerHTML = cachedRenderMarkdown(noFm);
        return plainText(wrap.innerHTML || wrap.textContent || noFm) || noFm;
      })();
      const BOM = "\uFEFF";
      const blob = new Blob([BOM + plain], { type: "text/plain;charset=utf-8" });
      await triggerBlobDownload({ blob, filename: `${safeTitle(title)}.txt` });
      showToast("已导出 TXT（本地降级）");
      return;
    }
    showToast(`导出失败: 不支持的格式 ${fmt}`);
  } catch (e2) {
    console.error("Export fallback failed:", e2);
    showToast(`导出失败: ${e2.message}`);
  }
}

async function exportCurrentDocToPdf() {
  if (!state.currentPath && !state.currentContent) {
    showToast("请先打开一个文档");
    return;
  }
  showToast("正在准备 PDF 导出（图表/公式正在渲染，请稍候…）");
  // 使用新的"渲染完成版"HTML：公式（KaTeX）、Mermaid 图表、Excalidraw 降级、本地图片、SVG→img data URL 全部处理完毕。
  let html;
  try {
    html = await buildDocumentPrintHtmlRendered();
  } catch (err) {
    console.error(err);
    // 任何渲染错误都回退到老的"原始字符串构建+只内联图片"，保证用户至少能导出
    showToast("图表/公式渲染降级为原始显示，继续导出");
    html = buildDocumentPrintHtml();
    try { html = await inlinePrintImages(html); } catch (_) {}
  }
  const title = els.docTitle?.textContent || state.currentDoc?.title || "MyTemple 文档";
  // 通过隐藏 iframe 打印：iframe 来源为 about:blank，浏览器打印页眉页脚不会显示本机地址与端口。
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;";
  document.body.appendChild(iframe);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { iframe.remove(); } catch (_) {}
  };
  try {
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_STYLES}</style></head><body>${html}</body></html>`);
    doc.close();
    const images = [...doc.querySelectorAll("img")];
    if (images.length) {
      await Promise.all(images.map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => {
        img.onload = img.onerror = () => resolve();
        setTimeout(resolve, 5000);
      })));
    }
    // 额外 rAF × 3 + 250ms 延迟：确保大 SVG dataURI、长公式、表格等高 DPR 图像全部栅格化完成
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 320));
    iframe.contentWindow.focus();
    showToast("提示：若不需要页眉页脚，请在打印对话框中取消勾选「页眉与页脚」，选择「另存为 PDF」即可完成导出");
    iframe.contentWindow.addEventListener("afterprint", cleanup);
    iframe.contentWindow.print();
  } catch (error) {
    console.error(error);
    showToast("无法调起打印对话框，请检查浏览器设置");
    cleanup();
  }
  setTimeout(cleanup, 120000);
}

async function buildWechatArticleHtml() {
  const title = els.docTitle?.textContent || state.currentDoc?.title || "MyTemple 文档";
  const rawContent = String(state.currentContent || els.editor.value || "");
  const content = stripFrontmatter(rawContent);
  const body = cachedRenderMarkdown(content);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = body;
  // 公众号编辑器无法访问本地相对路径，将本地图片转为 data URL 内联，
  // 粘贴后图片随内容一起进入公众号素材库。
  const images = [...wrapper.querySelectorAll("img")];
  await Promise.all(images.map(async (img) => {
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:") || /^https?:/i.test(src)) return;
    try {
      const response = await fetch(src, { credentials: "include" });
      if (!response.ok) return;
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      img.setAttribute("src", dataUrl);
    } catch (error) {
      console.warn("公众号图片内联失败", src, error);
    }
  }));
  return `<section class="wechat-article" style="max-width:677px;margin:0 auto;padding:8px 0;color:#3f3f3f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;font-size:16px;line-height:1.75;letter-spacing:0.05em;word-break:break-word;">
    <h1 style="font-size:24px;font-weight:600;color:#1a1a1a;text-align:center;margin:0 0 8px;line-height:1.4;">${escapeHtml(title)}</h1>
    ${wrapper.innerHTML}
  </section>`;
}

async function copyCurrentDocAsWechat() {
  if (!state.currentPath && !state.currentContent) {
    showToast("请先打开一个文档");
    return;
  }
  showToast("正在准备公众号格式…");
  const html = await buildWechatArticleHtml();
  const tempContainer = document.createElement("div");
  tempContainer.style.position = "fixed";
  tempContainer.style.left = "-9999px";
  tempContainer.style.top = "0";
  tempContainer.style.width = "677px";
  tempContainer.innerHTML = html;
  document.body.appendChild(tempContainer);
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(tempContainer);
  selection.removeAllRanges();
  selection.addRange(range);
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.write) {
      const blob = new Blob([html], { type: "text/html" });
      const textBlob = new Blob([plainText(html)], { type: "text/plain" });
      const item = new ClipboardItem({ "text/html": blob, "text/plain": textBlob });
      await navigator.clipboard.write([item]);
      ok = true;
    } else {
      ok = document.execCommand("copy");
    }
  } catch (error) {
    console.error(error);
    ok = document.execCommand("copy");
  }
  selection.removeAllRanges();
  document.body.removeChild(tempContainer);
  showToast(ok ? "已复制，可在公众号编辑器中粘贴" : "复制失败，请重试");
}

// 幻灯片导出：将 Markdown 按分隔符或标题拆分为多页，生成自包含 HTML 演示文稿。
// 离线优先，图片内联为 data URL，支持键盘/点击翻页与全屏演示。
// 拆分策略优先级：--- 分页符  >  #/## 标题分页  >  逻辑块（代码块/表格/列表/段落）自动分页


async function exportCurrentDocToPpt() {
  if (!state.currentPath && !state.currentContent) {
    showToast("请先打开一个文档");
    return;
  }
  showToast("正在准备幻灯片导出...");
  const title = els.docTitle?.textContent || state.currentDoc?.title || "MyTemple 文档";
  const rawContent = String(state.currentContent || els.editor.value || "");
  const slides = splitMarkdownIntoSlides(rawContent);
  if (!slides.length) {
    showToast("文档内容为空，无法生成幻灯片");
    return;
  }
  const pdfSettings = readPdfExportSettings();
  const watermarkText = escapeHtml(pdfSettings.watermarkText || "MyTemple Knowledge");
  // 渲染每页幻灯片，图片内联为 data URL
  const slideHtmlArray = await Promise.all(slides.map(async (slide) => {
    let html = normalizeAssetUrlsToRelative(cachedRenderMarkdown(slide));
    html = await inlinePrintImages(html);
    return html;
  }));
  const slidesJson = JSON.stringify(slideHtmlArray);
  const presentationHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} - 幻灯片</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:100%;height:100%;overflow:hidden;background:#1a1a2e;font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;}
.deck{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;position:relative;}
.slide{width:min(960px,92vw);height:min(600px,80vh);background:#fff;border-radius:12px;padding:0;overflow:visible;box-shadow:0 20px 60px rgba(0,0,0,0.3);display:none;position:relative;transition:opacity 0.3s ease;}
.slide.active{display:block;animation:fadeIn 0.4s ease;}
@keyframes fadeIn{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
/* 幻灯片采用三层结构：顶条装饰 + 内容区域 + 页码。内容区使用 block + overflow:auto 自然流式布局，
   避免 flex + justify-content:center 组合在溢出时把顶部内容挤出可视区域导致"内容丢失"观感。 */
.slide-title-bar{position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#6366f1,#8b5cf6,#6366f1);border-radius:12px 12px 0 0;z-index:2;}
.slide-inner{display:block;padding:44px 52px 40px 52px;height:100%;overflow:auto;}
.slide-page-num{position:absolute;bottom:8px;right:18px;font-size:12px;color:#9ca3af;font-weight:400;z-index:2;}
.slide h1{font-size:36px;font-weight:700;color:#1a1a2e;margin-bottom:24px;line-height:1.35;border-bottom:3px solid #6366f1;padding-bottom:12px;}
.slide h2{font-size:30px;font-weight:600;color:#312e81;margin:20px 0 14px;}
.slide h3{font-size:24px;font-weight:600;color:#4338ca;margin:16px 0 10px;}
.slide h4{font-size:20px;font-weight:600;color:#4f46e5;margin:14px 0 8px;}
.slide p{font-size:20px;line-height:1.8;color:#374151;margin:12px 0;word-break:break-word;}
.slide ul,.slide ol{margin:12px 0;padding-left:32px;font-size:20px;line-height:1.8;color:#374151;}
.slide li{margin:6px 0;}
.slide li::marker{color:#6366f1;}
.slide blockquote{border-left:4px solid #6366f1;background:linear-gradient(135deg,#f5f3ff,#ede9fe);padding:14px 24px;margin:16px 0;border-radius:0 12px 12px 0;color:#4b5563;font-size:19px;box-shadow:0 2px 8px rgba(99,102,241,0.08);}
.slide pre{background:#1e293b;color:#e2e8f0;border-radius:10px;padding:18px 22px;overflow:auto;font-family:"Cascadia Code",Consolas,monospace;font-size:16px;line-height:1.6;margin:14px 0;box-shadow:0 4px 12px rgba(0,0,0,0.15);white-space:pre-wrap;word-break:break-word;}
.slide code{font-family:"Cascadia Code",Consolas,monospace;background:rgba(99,102,241,0.12);padding:2px 6px;border-radius:4px;font-size:0.9em;color:#4338ca;word-break:break-word;}
.slide pre code{background:transparent;padding:0;color:inherit;white-space:inherit;}
.slide table{width:100%;border-collapse:collapse;margin:16px 0;font-size:18px;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);table-layout:fixed;}
.slide th,.slide td{border:1px solid #e5e7eb;padding:10px 14px;text-align:left;vertical-align:top;word-break:break-word;}
.slide th{background:linear-gradient(135deg,#eef2ff,#e0e7ff);font-weight:600;color:#312e81;border-bottom:2px solid #6366f1;}
.slide tr:nth-child(even){background:#f9fafb;}
.slide img{max-width:100%;max-height:380px;height:auto;border-radius:10px;margin:14px auto;display:block;box-shadow:0 4px 16px rgba(0,0,0,0.1);}
.slide a{color:#4338ca;text-decoration:underline;transition:color 0.2s;}
.slide a:hover{color:#6366f1;}
.slide hr{border:0;border-top:2px solid #e5e7eb;margin:20px 0;}
.slide strong{color:#1a1a2e;font-weight:700;}
.slide em{color:#4338ca;font-style:italic;}
.deck-watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:48px;color:rgba(99,102,241,0.06);pointer-events:none;z-index:9999;font-weight:700;letter-spacing:6px;white-space:nowrap;}
.nav{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:16px;background:rgba(255,255,255,0.1);backdrop-filter:blur(8px);padding:8px 20px;border-radius:999px;z-index:10000;}
.nav button{background:rgba(255,255,255,0.15);border:0;color:#fff;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:18px;transition:background 0.2s,transform 0.15s;}
.nav button:hover{background:rgba(255,255,255,0.3);transform:scale(1.08);}
.nav .counter{color:rgba(255,255,255,0.8);font-size:14px;min-width:60px;text-align:center;}
.progress{position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#6366f1,#8b5cf6);transition:width 0.3s ease;z-index:10000;}
.hint{position:fixed;top:16px;right:20px;color:rgba(255,255,255,0.4);font-size:12px;z-index:10000;}
/* 打印模式：去除所有 hidden/overflow 限制，每页独立成纸，确保内容不被截断且可打印成 PPT */
@media print{
  @page{size:landscape;margin:12mm 14mm;}
  .nav,.hint,.progress,.deck-watermark{display:none!important;}
  html,body{background:#fff;overflow:visible!important;width:auto!important;height:auto!important;}
  .deck{display:block!important;width:auto!important;height:auto!important;padding:0!important;}
  .slide{display:block!important;width:100%!important;max-width:100%!important;height:auto!important;min-height:0!important;overflow:visible!important;page-break-after:always;break-after:page;box-shadow:none!important;border-radius:0!important;border:1px solid #e5e7eb;margin:0 0 8px 0!important;}
  .slide:last-child{page-break-after:auto;break-after:auto;}
  .slide-inner{height:auto!important;max-height:none!important;overflow:visible!important;padding:18mm 20mm 14mm 20mm!important;}
  .slide-title-bar{border-radius:0!important;}
  .slide-page-num{position:static!important;text-align:right!important;margin-top:8px!important;font-size:11px!important;color:#6b7280!important;}
  .slide pre{white-space:pre-wrap!important;overflow:visible!important;}
  .slide img{max-height:150mm!important;}
}
</style>
</head>
<body>
<div class="deck" id="deck"></div>
<div class="deck-watermark" aria-hidden="true">${watermarkText}</div>
<div class="progress" id="progress" style="width:0%"></div>
<div class="nav">
  <button id="prevBtn" title="上一页 (←)">‹</button>
  <span class="counter" id="counter">1 / 1</span>
  <button id="nextBtn" title="下一页 (→)">›</button>
  <button id="fsBtn" title="全屏 (F)">⛶</button>
</div>
<div class="hint">← → 翻页 · F 全屏 · P 打印</div>
<script>
(function(){
  var slides = ${slidesJson};
  var deck = document.getElementById("deck");
  var current = 0;
  slides.forEach(function(html, i){
    var div = document.createElement("div");
    div.className = "slide" + (i === 0 ? " active" : "");
    div.innerHTML = '<div class="slide-title-bar"></div><div class="slide-inner">' + html + '</div><div class="slide-page-num">' + (i+1) + ' / ' + slides.length + '</div>';
    deck.appendChild(div);
  });
  var counter = document.getElementById("counter");
  var progress = document.getElementById("progress");
  function show(i){
    current = Math.max(0, Math.min(slides.length - 1, i));
    var els = deck.querySelectorAll(".slide");
    els.forEach(function(el, idx){ el.classList.toggle("active", idx === current); });
    counter.textContent = (current + 1) + " / " + slides.length;
    progress.style.width = ((current + 1) / slides.length * 100) + "%";
    var activeInner = deck.querySelector(".slide.active .slide-inner");
    if (activeInner) {
      activeInner.scrollTop = 0;
      autoFit(activeInner);
    }
  }
  // autoFit: 如果内容溢出，按阶梯从 20px 缩到 12px；若仍溢出则保留滚动条，用户仍可滚动查看，不会丢失。
  function autoFit(inner){
    var slideEl = inner.closest(".slide");
    if (!slideEl) return;
    var innerPad = (parseInt(getComputedStyle(inner).paddingTop)||0) + (parseInt(getComputedStyle(inner).paddingBottom)||0);
    var avail = Math.max(120, slideEl.clientHeight - innerPad - 16);
    var fs = 20;
    inner.style.fontSize = fs + "px";
    // 重置所有子元素的基准字号（段落/列表/代码内字号相对这个）
    while (inner.scrollHeight > avail && fs > 12) {
      fs -= 1;
      inner.style.fontSize = fs + "px";
    }
  }
  document.getElementById("prevBtn").addEventListener("click", function(e){ e.stopPropagation(); show(current - 1); });
  document.getElementById("nextBtn").addEventListener("click", function(e){ e.stopPropagation(); show(current + 1); });
  document.getElementById("fsBtn").addEventListener("click", function(e){ e.stopPropagation(); toggleFs(); });
  function toggleFs(){
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
  deck.addEventListener("click", function(e){
    if (e.target.closest("a")) return;
    var rect = deck.getBoundingClientRect();
    if (e.clientX > rect.left + rect.width / 2) show(current + 1);
    else show(current - 1);
  });
  document.addEventListener("keydown", function(e){
    if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") { e.preventDefault(); show(current + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); show(current - 1); }
    else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFs(); }
    else if (e.key === "Home") { e.preventDefault(); show(0); }
    else if (e.key === "End") { e.preventDefault(); show(slides.length - 1); }
    else if (e.key === "Escape" && document.fullscreenElement) document.exitFullscreen();
    else if (e.key === "p" || e.key === "P") { e.preventDefault(); window.print(); }
  });
  window.addEventListener("resize", function(){
    var activeInner = deck.querySelector(".slide.active .slide-inner");
    if (activeInner) autoFit(activeInner);
  });
  // 初始首屏也要做一次自适应（特别是首屏内容多的情况），并在全部资源加载完成后再补一次，
  // 避免图片/font 异步加载完造成的尺寸重算导致首屏已经"溢出"但字号未缩小。
  show(0);
  window.addEventListener("load", function(){
    var activeInner = deck.querySelector(".slide.active .slide-inner");
    if (activeInner) autoFit(activeInner);
  });
})();
</script>
</body>
</html>`;
  const blob = new Blob([presentationHtml], { type: "text/html;charset=utf-8" });
  const safeName = String(title).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "幻灯片";
  try {
    await triggerBlobDownload({ blob, filename: `${safeName}_幻灯片.html` });
    showToast(`已导出 ${slides.length} 页幻灯片，双击 HTML 即可演示，按 P 可打印为 PPT`);
  } catch (e) {
    console.error("PPT 导出失败:", e);
    showToast(`幻灯片导出失败: ${e.message}`);
  }
}

function ensureMarkdownWorker() {
  if (state.markdownWorkerIdleTimer) {
    clearTimeout(state.markdownWorkerIdleTimer);
    state.markdownWorkerIdleTimer = 0;
  }
  // Worker 失败后进入 5 秒冷却期，过期后允许重建，避免一次性错误导致永久退回主线程渲染
  if (state.markdownWorker) return state.markdownWorker;
  if (state.markdownWorkerFailed && Date.now() < state.markdownWorkerFailedUntil) return null;
  state.markdownWorkerFailed = false;
  try {
    state.markdownWorker = new Worker(MARKDOWN_WORKER_URL);
    state.markdownWorker.addEventListener("message", (event) => {
      const data = event.data || {};
      const seq = data.seq;
      const pending = state.markdownWorkerPending.get(seq);
      if (!pending) return;
      state.markdownWorkerPending.delete(seq);
      // 传递完整 data，由 pending.resolve 处理 Blob/非 Blob 两种响应
      pending.resolve(data);
    });
    state.markdownWorker.addEventListener("error", (event) => {
      state.markdownWorkerFailed = true;
      state.markdownWorkerFailedUntil = Date.now() + 5000;
      const error = event?.error || new Error("Markdown worker failed");
      for (const pending of state.markdownWorkerPending.values()) pending.reject(error);
      state.markdownWorkerPending.clear();
      if (state.markdownWorker) state.markdownWorker.terminate();
      state.markdownWorker = null;
    });
  } catch (error) {
    state.markdownWorkerFailed = true;
    state.markdownWorkerFailedUntil = Date.now() + 5000;
    console.error(error);
  }
  return state.markdownWorker;
}

function scheduleMarkdownWorkerIdle() {
  if (state.markdownWorkerIdleTimer) clearTimeout(state.markdownWorkerIdleTimer);
  state.markdownWorkerIdleTimer = setTimeout(() => {
    if (state.markdownWorkerPending.size === 0 && state.markdownWorker) {
      state.markdownWorker.terminate();
      state.markdownWorker = null;
    }
    state.markdownWorkerIdleTimer = 0;
  }, 60000);
}

function requestMarkdownRender({ source = "", searchTerm = "", includeHtml = true, includeOutline = false } = {}) {
  const worker = ensureMarkdownWorker();
  if (!worker) {
    return Promise.resolve({
      html: includeHtml ? cachedRenderMarkdown(source, { searchTerm }) : null,
      outline: includeOutline ? extractOutline(source) : null,
    });
  }
  const seq = ++state.markdownWorkerSeq;
  // 大文档用 Blob 传输（零拷贝转移），避免结构化克隆在主线程产生内存峰值
  const BLOB_THRESHOLD = 100 * 1024; // 100KB
  const useBlob = source.length > BLOB_THRESHOLD;
  const payload = { seq, searchTerm, includeHtml, includeOutline, useBlob };
  const transferList = [];
  if (useBlob) {
    payload.blob = new Blob([source]);
    transferList.push(payload.blob);
  } else {
    payload.source = source;
  }
  return new Promise((resolve, reject) => {
    state.markdownWorkerPending.set(seq, {
      resolve: async (value) => {
        // 响应也可能是 Blob（大 html），需要解包
        try {
          if (value && value.useBlob && value.htmlBlob) {
            const html = await value.htmlBlob.text();
            resolve({ html, outline: value.outline });
          } else {
            resolve(value);
          }
        } catch (err) {
          resolve(value); // 降级：直接返回原值
        }
        scheduleMarkdownWorkerIdle();
      },
      reject: (err) => { reject(err); scheduleMarkdownWorkerIdle(); },
    });
    worker.postMessage(payload, transferList);
  });
}

async function renderReaderContent(source, options = {}) {
  const content = String(source || "");
  const searchTerm = options.searchTerm || "";
  const byteLen = contentByteLength(content);
  const useChunked = byteLen > CHUNKED_RENDER_BYTES;
  // 用独立的渲染序号做竞态防护：连续打开文档时，旧请求即使晚返回也不会覆盖最新内容。
  // 此前的守卫 `state.currentContent !== content && !searchTerm` 在 searchTerm 非空时被绕过，
  // 导致从全局搜索连续打开文档时，旧文档渲染会覆盖新文档显示。
  const seq = ++state.readerRenderSeq;
  try {
    const { html, outline } = await requestMarkdownRender({
      source: content,
      searchTerm,
      includeHtml: true,
      includeOutline: true,
    });
    if (seq !== state.readerRenderSeq) return;
    let finalHtml = html ?? cachedRenderMarkdown(content, { searchTerm });
    try { if (typeof applySpellCheckHighlight === "function") finalHtml = applySpellCheckHighlight(finalHtml, content); } catch (_) {}
    if (useChunked) {
      await renderReaderContentChunked(finalHtml, outline || extractOutline(content), seq);
    } else {
      if (seq !== state.readerRenderSeq) return;
      els.markdownView.innerHTML = finalHtml;
      renderOutlineItems(outline || extractOutline(content));
    }
  } catch (error) {
    console.error(error);
    if (seq !== state.readerRenderSeq) return;
    let finalHtml = cachedRenderMarkdown(content, { searchTerm });
    try { if (typeof applySpellCheckHighlight === "function") finalHtml = applySpellCheckHighlight(finalHtml, content); } catch (_) {}
    if (useChunked) {
      await renderReaderContentChunked(finalHtml, extractOutline(content), seq);
    } else {
      if (seq !== state.readerRenderSeq) return;
      els.markdownView.innerHTML = finalHtml;
      renderOutline(content);
      // bugfix: Worker 成功非 chunked 分支没有调用公式/图表渲染；catch 非 chunked 分支这里补齐，
      // 与 chunked 分支尾部 L2552-2554 对齐，保证阅读栏/阅读模式下 placeholder 节点真正产出 KaTeX/Mermaid/Excalidraw。
      renderMathInPreview(els.markdownView);
      renderChartsInPreview(els.markdownView);
    }
    return;
  }
  // bugfix: Worker 成功分支（主路径）写入 markdownView.innerHTML 后没有调用公式/图表渲染，
  // 此前只有 useChunked 分支 L2552-2554 才会触发，导致 <=500KB 文档下所有 $$...$$ / excalidraw / mermaid
  // 都是空占位不显示——阅读栏（Worker 主渲染源）和阅读模式（renderReaderContent）都受影响。
  // 与编辑模式预览 swapPreviewHtml L5902-5903 / renderReaderContentChunked L2552-2554 保持一致。
  if (seq !== state.readerRenderSeq) return;
  renderMathInPreview(els.markdownView);
  renderChartsInPreview(els.markdownView);
}

async function renderReaderContentChunked(html, outline, seq) {
  const slices = splitHtmlForChunkedRender(html, CHUNK_RENDER_SLICE_BYTES);
  if (slices.length <= 1) {
    if (seq != null && seq !== state.readerRenderSeq) return;
    els.markdownView.innerHTML = html;
    renderOutlineItems(outline);
    // bugfix: 只有 1 片时直接 return，没调公式/图表渲染——表现为 150KB<=文件<=500KB 的文档：
    // 用 Worker 且启用 chunked（150KB）但只产出 1 片时，公式、mermaid、excalidraw 全不显示。
    // 与其他路径保持一致：写入 innerHTML + renderOutlineItems 后立即调用。
    renderMathInPreview(els.markdownView);
    renderChartsInPreview(els.markdownView);
    return;
  }
  if (seq != null && seq !== state.readerRenderSeq) return;
  els.markdownView.innerHTML = slices[0];
  renderOutlineItems(outline);
  for (let i = 1; i < slices.length; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    // 分片渲染前再次校验：连续打开文档时旧请求应立即停止后续分片写入
    if (seq != null && seq !== state.readerRenderSeq) return;
    const temp = document.createElement("div");
    temp.innerHTML = slices[i];
    const frag = document.createDocumentFragment();
    while (temp.firstChild) frag.appendChild(temp.firstChild);
    els.markdownView.appendChild(frag);
  }
  if (seq != null && seq !== state.readerRenderSeq) return;
  renderMathInPreview(els.markdownView);
  renderChartsInPreview(els.markdownView);
}

function splitHtmlForChunkedRender(html, sliceBytes) {
  if (!html || html.length <= sliceBytes) return [html || ""];
  const slices = [];
  let remaining = html;
  while (remaining.length > sliceBytes) {
    let cutoff = sliceBytes;
    const safeTags = ["</p>", "</div>", "</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>", "</li>", "</ul>", "</ol>", "</blockquote>", "</pre>", "</table>", "</tr>", "</section>", "</article>", "</hr/>", "</br/>"];
    let bestCutoff = -1;
    for (const tag of safeTags) {
      const idx = remaining.lastIndexOf(tag, cutoff);
      if (idx > bestCutoff) bestCutoff = idx;
    }
    if (bestCutoff > 0) cutoff = bestCutoff;
    else {
      const nextLt = remaining.indexOf(">", cutoff);
      if (nextLt > 0) cutoff = nextLt + 1;
    }
    slices.push(remaining.slice(0, cutoff));
    remaining = remaining.slice(cutoff);
  }
  if (remaining) slices.push(remaining);
  return slices;
}

function inlineMarkdown(value, searchTerm = "") {
  let html = escapeHtml(value)
    .replace(/%%[\s\S]*?%%/g, "")
    // 块级数学公式 $$...$$
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => `<span class="math-block" data-math="${escapeHtml(math.trim())}"></span>`)
    // 行内数学公式 $...$（不匹配 $$ 和行首独立 $）
    .replace(/(?<!\$)\$(?!\$)([^\n$]+?)(?<!\$)\$/g, (_, math) => `<span class="math-inline" data-math="${escapeHtml(math.trim())}"></span>`)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
      const lowerSrc = String(src || "").toLowerCase();
      if (/\.(mp4|webm|mov|avi)(\?|#|$)/.test(lowerSrc)) {
        return `<video src="${src}" alt="${alt}" class="auto-size-video" controls preload="metadata"></video>`;
      }
      return `<img src="${src}" alt="${alt}" class="auto-size-image" loading="lazy" />`;
    })
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
    .replace(/\[\^([\w-]+)\]/g, '<sup class="footnote-ref"><a href="#fn-$1">[^$1]</a></sup>')
    .replace(/(^|[\s>])#([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]{1,30})(?![\w\u4e00-\u9fa5-])/g, '$1<span class="md-tag">#$2</span>')
    .replace(/\[\[([^\]]+)\]\]/g, '<a href="#" data-doc-link="$1">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `<a href="${safeMarkdownUrl(url)}">${label}</a>`);
}

function safeMarkdownUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "#";
  if (url.startsWith("#")) return url;
  const protocol = url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (protocol) {
    if (!["http", "https", "mailto"].includes(protocol)) return "#";
    return url;
  }
  // 无协议前缀的 URL：自动补 http://（如 mytemple.fshby.cc、example.com/path）
  if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+(:\d+)?(\/|$)/.test(url)) {
    return "http://" + url;
  }
  // IP 地址格式（如 127.0.0.1:8080/path）
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/|$)/.test(url)) {
    return "http://" + url;
  }
  return url;
}

function splitMarkdownTableRow(line) {
  let value = String(line || "").trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells = [];
  let cell = "";
  let escaped = false;
  let inCode = false;
  for (const char of value) {
    if (escaped) {
      cell += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
      cell += char;
    } else if (char === "`") {
      inCode = !inCode;
      cell += char;
    } else if (char === "|" && !inCode) {
      cells.push(cell.trim().replace(/\\\|/g, "|"));
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim().replace(/\\\|/g, "|"));
  return cells;
}

function markdownTableAlignment(cell) {
  const value = String(cell || "").trim();
  if (!/^:?-{3,}:?$/.test(value)) return null;
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function normalizeCodeLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", py: "python", rb: "ruby",
    sh: "bash", shell: "bash", zsh: "bash", ps: "powershell", ps1: "powershell",
    yml: "yaml", md: "markdown", c: "c", h: "c", cc: "cpp", cxx: "cpp",
    "c++": "cpp", cs: "csharp", "c#": "csharp", rs: "rust", golang: "go",
    txt: "text", plain: "text", "text/plain": "text",
  };
  const normalized = aliases[raw] || raw;
  return /^[a-z0-9_+-]{1,24}$/.test(normalized) ? normalized : "text";
}



function renderMarkdown(source, options = {}) {
  const searchTerm = options.searchTerm || "";
  const editTools = options.editTools === true;
  // bugfix: 多行块级公式 $$\n公式体\n$$ 会被逐行 for + <p>${inlineMarkdown(line)}</p> 拆开，
  // inlineMarkdown 的 $$[\s\S]+? 正则跨不过 <p> 边界（且逐行正则本质也跨行不到），
  // 导致阅读模式/编辑预览里常见的"换行写的块级公式"全部空白。
  // 处理流程与 markdown-worker 保持一致：先按代码 fence 分段，非 fence 段把 $$...$$
  // 整段替换为占位符，HTML 生成完再还原为 math-block span。
  const mathBlockPlaceholders = [];
  const preprocessed = (() => {
    const rawLines = String(source || "").replace(/\r\n/g, "\n").split("\n");
    let inF = false;
    const segments = [];
    let buf = "";
    for (const line of rawLines) {
      if (line.startsWith("```")) {
        if (!inF) {
          segments.push({ fence: false, text: buf });
          buf = line + "\n";
          inF = true;
        } else {
          buf += line + "\n";
          segments.push({ fence: true, text: buf });
          buf = "";
          inF = false;
        }
        continue;
      }
      buf += line + "\n";
    }
    if (buf) segments.push({ fence: inF, text: buf });
    let rebuilt = "";
    for (const seg of segments) {
      if (seg.fence) rebuilt += seg.text;
      else rebuilt += seg.text.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
        const idx = mathBlockPlaceholders.length;
        mathBlockPlaceholders.push(math);
        return `\u0000MBLK_${idx}_MBLK\u0000`;
      });
    }
    if (rebuilt.endsWith("\n")) rebuilt = rebuilt.slice(0, -1);
    return rebuilt;
  })();
  const lines = preprocessed.split("\n");
  const html = [];
  let h1Index = 0;
  let h2Index = 0;
  let h3Index = 0;
  let h4Index = 0;
  let inCode = false;
  let code = [];
  let codeLanguage = "text";
  let list = null;
  let table = [];
  let tableStartLine = -1;
  let blockquote = [];
  let blockquoteStartLine = -1;
  let codeStartLine = -1;
  let detailsBlock = null; // { startLine, lines: [] }
  const footnoteDefs = [];

  const flushList = () => {
    if (!list) return;
    const hasTasks = list.items.some((item) => item.task);
    const listClass = hasTasks ? ' class="contains-task-list"' : "";
    const items = list.items.map((item) => `<li${item.task ? ' class="task-list-item"' : ""}>${item.html}</li>`).join("");
     html.push(`<${list.type}${listClass} data-source-line="${list.startLine}">${items}</${list.type}>`);
    list = null;
  };
  const CALLOUT_DEFAULT_TITLES = {
    note: "备注", info: "信息", tip: "提示", success: "成功", warning: "警告",
    todo: "待办", important: "重要", caution: "注意", danger: "危险",
    failure: "失败", bug: "缺陷", question: "疑问", quote: "引用",
    abstract: "摘要", example: "示例",
  };
  // callout 类型集合（用于 indexOf 快速校验，避免长正则漏匹配）
  const CALLOUT_TYPES = new Set(["note","info","tip","warning","danger","quote","success","question","bug","example","failure","abstract","todo","important","caution"]);
  const flushBlockquote = () => {
    if (!blockquote.length) return;
    const rawFirst = blockquote[0];
    // 1. 递归剥除所有嵌套层级的 > 前缀，支持 > > [!type] 多层嵌套写法。
    let firstClean = rawFirst;
    while (/^>\s?/.test(firstClean)) firstClean = firstClean.replace(/^>\s?/, "");
    firstClean = firstClean.trim();
    // 2. 用 indexOf 定位第一个 [! 标记，兼容任意前导污染字符。
    const anchorIdx = firstClean.indexOf("[!");
    let calloutHeader = anchorIdx >= 0 ? firstClean.slice(anchorIdx) : firstClean;
    // 3. 再次清理：确保 [! 是行首真正的起点，去除 [! 之前残留的空白或标点
    calloutHeader = calloutHeader.replace(/^\s+/, "");
    // 4. 用 indexOf + Set 提取类型，不依赖复杂正则锚定：
    //    格式是 [!type] 标题文本 → 定位 "]" 后即可切片出类型和标题。
    let type = null;
    let explicitTitle = "";
    if (calloutHeader.startsWith("[!")) {
      const closeBracket = calloutHeader.indexOf("]");
      if (closeBracket > 2) {
        const rawType = calloutHeader.slice(2, closeBracket).trim().toLowerCase();
        if (CALLOUT_TYPES.has(rawType)) {
          type = rawType;
          explicitTitle = calloutHeader.slice(closeBracket + 1).trim();
        }
      }
    }
    if (type) {
      const defaultTitle = CALLOUT_DEFAULT_TITLES[type] || type.charAt(0).toUpperCase() + type.slice(1);
      const title = explicitTitle || defaultTitle;
      // 内容行：剥离所有层级 `> ` 前缀，支持 > > 内容、> > > 内容等多层嵌套
      const body = blockquote.slice(1).map((l) => {
        let clean = l;
        while (/^>\s?/.test(clean)) clean = clean.replace(/^>\s?/, "");
        return clean;
      });
      const titleHtml = `<strong class="callout-title">${inlineMarkdown(title, searchTerm)}</strong>`;
      const bodyHtml = body.map((l) => inlineMarkdown(l, searchTerm)).filter(Boolean).join("<br />");
      // data-callout-type 用作 CSS 属性选择器的双重保障，避免 class 特异性丢失导致同色
       html.push(`<div class="callout callout-${type}" data-callout-type="${type}" data-source-line="${blockquoteStartLine}">${titleHtml}${bodyHtml ? `<div class="callout-body">${bodyHtml}</div>` : ""}</div>`);
    } else {
      const content = blockquote.map((l) => inlineMarkdown(l, searchTerm)).join("<br />");
       html.push(`<blockquote data-source-line="${blockquoteStartLine}">${content}</blockquote>`);
    }
     blockquote = [];
     blockquoteStartLine = -1;
  };
  const flushDetails = () => {
    if (!detailsBlock) return;
    const { lines, startLine } = detailsBlock;
    // 按行处理 details 块：先替换摘要标签内联渲染，再逐行分类输出。
    // 关键：不要把「已包含 HTML 标签（details/summary 开闭）」的行送入 inlineMarkdown，
    // 否则 inlineMarkdown 内部 escapeHtml 会把 < 转义为 &lt;，导致折叠块退化为纯文本。
    let processed = lines.slice();
    // 1) 先做跨行的 summary 内容渲染（<summary>文本</summary> → 文本走 inlineMarkdown 后包回标签）
    try {
      const joined = processed.join("\u0001"); // 用不可见字符做连接，避免与原始内容冲突
      const rendered = joined.replace(/<summary>([\s\S]*?)<\/summary>/g, (_, content) => {
        const text = String(content || "").replace(/\u0001/g, "\n").trim();
        return `<summary>${inlineMarkdown(text, searchTerm)}</summary>`;
      });
      processed = rendered.split("\u0001");
    } catch (_) { /* fallback 不做跨行渲染 */ }
    // 2) 逐行分类输出：含 HTML 标签行 → 直接保留原始标签；纯文本行 → inlineMarkdown + <p> 包装
    const renderedParts = [];
    for (let j = 0; j < processed.length; j++) {
      const p = processed[j];
      const trimmed = p.trim();
      // 快速判断该行是否包含 HTML 标签字符：
      //   检查是否存在「<」紧跟「字母或 /」（HTML 开闭标签特征）。
      // 有则认为该行应直接保留（我们已在上一步渲染了 summary 内容），不再二次转义；
      // 无则当作普通 Markdown 段落文本，用 inlineMarkdown 渲染。
      const hasHtmlTag = /<[a-zA-Z\/!?]/.test(p);
      if (hasHtmlTag) {
        renderedParts.push(p);
      } else if (trimmed) {
        renderedParts.push(`<p>${inlineMarkdown(trimmed, searchTerm)}</p>`);
      } else {
        renderedParts.push(p);
      }
    }
    html.push(`<div data-source-line="${startLine}">${renderedParts.join("\n")}</div>`);
    detailsBlock = null;
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map(splitMarkdownTableRow);
    if (rows.length > 1) {
      const [head, divider, ...body] = rows;
      const alignments = divider.map(markdownTableAlignment);
      const columnCount = head.length;
      const cell = (tag, value, index) => `<${tag} style="text-align:${alignments[index] || "left"}">${inlineMarkdown(value || "", searchTerm)}</${tag}>`;
      const tableHtml = `<table><thead><tr>${head.map((value, index) => cell("th", value, index)).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${Array.from({ length: columnCount }, (_, index) => cell("td", row[index], index)).join("")}</tr>`).join("")}</tbody></table>`;
      // 编辑模式预览中提供行/列扩展工具，回写源码；阅读模式与导出不含工具。
      if (editTools && tableStartLine >= 0) {
        const tools = `<div class="md-table-tools" data-table-start="${tableStartLine}">
          <button type="button" class="md-table-tool" data-table-action="addRow" title="在末尾追加一行">+ 行</button>
          <button type="button" class="md-table-tool" data-table-action="addCol" title="追加一列">+ 列</button>
          <button type="button" class="md-table-tool" data-table-action="removeCol" title="删除最后一列" ${columnCount <= 1 ? "disabled" : ""}>- 列</button>
        </div>`;
         html.push(`<div class="markdown-table-wrap" data-source-line="${tableStartLine}">${tools}${tableHtml}</div>`);
      } else {
         html.push(`<div class="markdown-table-wrap" data-source-line="${tableStartLine}">${tableHtml}</div>`);
      }
    }
    table = [];
    tableStartLine = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ===== details 细节块（HTML5 折叠块）累积状态机 =====
    // 使用小写化 + indexOf 进行检测，绕过正则对空白/标签属性的敏感性，
    // 兼容：行首空白、行尾 \r、<details open>、<details class="x">、同行摘要写法等。
    const lowerLine = line.toLowerCase().replace(/\r/g, "");
    const hasOpenTag = lowerLine.indexOf("<details") >= 0;
    const hasCloseTag = lowerLine.indexOf("</details>") >= 0;
    // 确认 <details 是真正的 HTML 标签：其后必须紧跟空白、'>' 或在行尾。
    // 避免误匹配 "xxx<detailsxxx" 这种纯文本里的子串。
    let detailsStart = false;
    if (hasOpenTag) {
      const openPos = lowerLine.indexOf("<details");
      const afterTag = lowerLine.charAt(openPos + 8);
      if (!afterTag || afterTag === ">" || /\s/.test(afterTag)) {
        // 额外保险：<details 之前只允许空白字符或行首，避免 "abc<details>" 这种文本
        const beforeOpen = lowerLine.slice(0, openPos);
        if (!beforeOpen || /^\s*$/.test(beforeOpen)) detailsStart = true;
      }
    }
    const detailsEnd = hasCloseTag;
    if (detailsBlock) {
      detailsBlock.lines.push(line);
      if (detailsEnd) flushDetails();
      continue;
    }
    if (detailsStart) {
      flushList();
      flushTable();
      flushBlockquote();
      detailsBlock = { startLine: i, lines: [line] };
      if (detailsEnd && lowerLine.indexOf("</details>") > lowerLine.indexOf("<details")) {
        // 单行闭合的极简 details（如 <details><summary>x</summary>y</details> 写在一行）
        flushDetails();
      }
      continue;
    }
    if (line.startsWith("```")) {
      flushList();
      flushTable();
      flushBlockquote();
      if (inCode) {
        const raw = code.join("\n");
        const normalizedLang = normalizeCodeLanguage(codeLanguage);
        if (normalizedLang === "mermaid") {
          html.push(`<div class="chart-block mermaid-block" data-chart="mermaid" data-source-line="${codeStartLine}"><pre class="mermaid-source">${escapeHtml(raw)}</pre><div class="mermaid-container" aria-label="Mermaid 图表"></div></div>`);
        } else if (normalizedLang === "excalidraw") {
          html.push(`<div class="chart-block excalidraw-block" data-chart="excalidraw" data-source-line="${codeStartLine}"><pre class="excalidraw-source">${escapeHtml(raw)}</pre><div class="excalidraw-container" aria-label="Excalidraw 绘图"></div></div>`);
        } else {
          html.push(`<div class="code-block" data-language="${codeLanguage}"><span class="code-language">${escapeHtml(codeLanguage)}</span><button class="code-copy" type="button">\u590d\u5236</button><pre><code class="language-${codeLanguage}">${highlightCode(raw, codeLanguage)}</code></pre></div>`);
        }
        code = [];
        codeLanguage = "text";
       } else {
         codeStartLine = i;
        codeLanguage = normalizeCodeLanguage(line.slice(3).trim().split(/\s+/)[0]);
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
      flushBlockquote();
       html.push(`<hr data-source-line="${i}" />`);
      continue;
    }
    const row = line.includes("|") ? splitMarkdownTableRow(line) : [];
    const nextRow = lines[i + 1]?.includes("|") ? splitMarkdownTableRow(lines[i + 1]) : [];
    const startsTable = !table.length && row.length >= 2 && nextRow.length === row.length
      && nextRow.every((cell) => markdownTableAlignment(cell));
    if (startsTable) {
      flushList();
      flushBlockquote();
      tableStartLine = i;
      table.push(line, lines[i + 1]);
      i += 1;
      continue;
    }
    if (table.length && row.length >= 2) {
      table.push(line);
      continue;
    }
    flushTable();
    // 引用块：累积连续 > 行，支持 Obsidian callout（> [!type] 标题）。
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushList();
       blockquote.push(quote[1]);
       if (blockquoteStartLine < 0) blockquoteStartLine = i;
      continue;
    }
    flushBlockquote();
    // 脚注定义：[^id]: 文本，收集后文末统一渲染。
    const fnDef = line.match(/^\[\^([\w-]+)\]:\s*(.*)$/);
    if (fnDef) {
      flushList();
      footnoteDefs.push({ id: fnDef[1], text: fnDef[2] });
      continue;
    }
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
       html.push(`<h${level}${idAttr} data-source-line="${i}" style="margin-left: ${marginLeft}px;">${inlineMarkdown(indentedHeading[3], searchTerm)}</h${level}>`);
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
       html.push(`<h${level}${id ? ` id="${escapeHtml(id)}"` : ""} data-source-line="${i}" style="margin-left: ${marginLeft}px;">${inlineMarkdown(cnHeading[2], searchTerm)}</h${level}>`);
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
         html.push(`<h${level}${id ? ` id="${escapeHtml(id)}"` : ""} data-source-line="${i}" style="margin-left: ${marginLeft}px;">${inlineMarkdown(dottedHeading[2] + dottedHeading[3] + dottedHeading[4], searchTerm)}</h${level}>`);
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
         html.push(`<h${level}${id ? ` id="${escapeHtml(id)}"` : ""} data-source-line="${i}" style="margin-left: ${marginLeft}px;">${inlineMarkdown(numHeading[2] + numHeading[5], searchTerm)}</h${level}>`);
        continue;
      }
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
        list = { type, items: [], startLine: i };
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
       html.push(`<div data-source-line="${i}" style="margin-left: ${marginLeft}px; width: ${widthPercent};"><p>${inlineMarkdown(indentedImage[2], searchTerm)}</p></div>`);
      continue;
    }
    if (!line.trim()) {
      flushList();
      flushBlockquote();
      html.push("");
      continue;
    }
    flushList();
     html.push(`<p data-source-line="${i}">${inlineMarkdown(line, searchTerm)}</p>`);
  }
  flushList();
  flushTable();
  flushBlockquote();
  flushDetails();
  if (inCode) {
    const raw = code.join("\n");
    html.push(`<div class="code-block" data-language="${codeLanguage}"><span class="code-language">${escapeHtml(codeLanguage)}</span><button class="code-copy" type="button">\u590d\u5236</button><pre><code class="language-${codeLanguage}">${highlightCode(raw, codeLanguage)}</code></pre></div>`);
  }
  // 脚注定义统一渲染到文末。
  if (footnoteDefs.length) {
    const items = footnoteDefs.map((fn) => `<li id="fn-${escapeHtml(fn.id)}">${inlineMarkdown(fn.text || "", searchTerm)}</li>`).join("");
    html.push(`<section class="footnotes"><ol>${items}</ol></section>`);
  }
  // bugfix: 还原块级公式占位符（与 markdown-worker 同步）。
  const joinedHtml = html.join("\n");
  if (!mathBlockPlaceholders.length) return joinedHtml;
  try {
    return joinedHtml
      .replace(/\u0000MBLK_(\d+)_MBLK\u0000/g, (_, idx) => {
        const i = parseInt(idx, 10);
        const math = (i >= 0 && i < mathBlockPlaceholders.length) ? mathBlockPlaceholders[i] : "";
        return `<span class="math-block" data-math="${escapeHtml(String(math).trim())}"></span>`;
      })
      .replace(/\u0000MBLK_(\d+)[\s\S]*?_MBLK\u0000/g, (_, idx) => {
        const i = parseInt(idx, 10);
        const math = (i >= 0 && i < mathBlockPlaceholders.length) ? mathBlockPlaceholders[i] : "";
        return `<span class="math-block" data-math="${escapeHtml(String(math).trim())}"></span>`;
      });
  } catch (_) {
    return joinedHtml;
  }
}

function markdownCacheKey(source, options = {}) {
  const text = String(source || "");
  const mode = options.editTools ? "edit" : "read";
  const searchTerm = options.searchTerm || "";
  return `${MARKDOWN_RENDER_VERSION}\n${mode}\n${searchTerm}\n${text.length}\n${text}`;
}

function cachedRenderMarkdown(source, options = {}) {
  const text = String(source || "");
  const searchTerm = options.searchTerm || "";
  if (searchTerm || text.length > 900000) return renderMarkdown(text, options);
  const key = markdownCacheKey(text, options);
  const hit = state.markdownCache.get(key);
  if (hit) {
    state.markdownCache.delete(key);
    state.markdownCache.set(key, hit);
    return hit.html;
  }
  const html = renderMarkdown(text, options);
  const size = text.length + html.length;
  state.markdownCache.set(key, { html, size });
  state.markdownCacheBytes += size;
  while (state.markdownCache.size > 18 || state.markdownCacheBytes > 8_000_000) {
    const oldestKey = state.markdownCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = state.markdownCache.get(oldestKey);
    state.markdownCacheBytes -= oldest?.size || 0;
    state.markdownCache.delete(oldestKey);
  }
  return html;
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
    .then(() => api.post("/api/save", { path: taskPath, content: nextContent, baseHash: state.currentVersion || "" }));
  state.taskSaveQueue = saveJob;
  try {
    const result = await saveJob;
    if (state.currentPath === taskPath && state.currentContent === nextContent) {
      state.lastSavedContent = nextContent;
      state.currentVersion = result.contentSha256 || state.currentVersion;
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
        <span class="ws-actions-inline">
          <button class="ws-new" title="新建文件 (Ctrl+N)" data-action="new-file">+</button>
          <button class="ws-new-folder" title="新建文件夹" data-action="new-folder">&#128194;</button>
        </span>
        <button class="ws-open-folder" title="在文件管理器中打开"></button>
      `;
      head.addEventListener("click", (e) => {
        if (e.target.closest(".ws-open-folder")) {
          if (node.root) {
            api.post("/api/open-folder", { path: node.root }).catch(() => showToast("无法打开文件夹"));
          }
          return;
        }
        if (e.target.closest("[data-action='new-file']")) {
          state.activeWorkspaceId = node.workspaceId;
          state.selectedFolder = node.path;
          openCreateModal("file");
          return;
        }
        if (e.target.closest("[data-action='new-folder']")) {
          state.activeWorkspaceId = node.workspaceId;
          state.selectedFolder = node.path;
          openCreateModal("folder");
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
      const rootFiles = node.children.filter((c) => c.type === "file");
      const allFiles = [];
      function collectFiles(nodes) {
        for (const n of nodes) {
          if (n.type === "file") allFiles.push(n);
          if (n.children) collectFiles(n.children);
        }
      }
      collectFiles(node.children);
      // 收集已展开子文件夹内可见的文件路径。工作区根目录收起时，这些文件
      // 已通过 updateLazyFolderMount 在子文件夹内渲染，若再纳入根目录扁平
      // 列表会造成同一文件在根目录与子文件夹内重复展示（即"根目录重复创建"缺陷）。
      const expandedFolderFilePaths = new Set();
      function collectExpandedFolderFiles(nodes) {
        for (const n of nodes) {
          if (n.type === "folder" && state.expandedFolders.has(n.path) && n.children) {
            for (const child of n.children) {
              if (child.type === "file") expandedFolderFilePaths.add(child.path);
            }
          }
          if (n.children) collectExpandedFolderFiles(n.children);
        }
      }
      collectExpandedFolderFiles(node.children);
      const isExpanded = state.expandedWorkspaceRoots.has(node.workspaceId);
      let displayFiles;
      if (isExpanded) {
        // 展开态：渲染真正的目录树（所有文件夹+文件，层级结构，独立可展开/收起）
        // 文件夹先渲染（子文件/子文件夹递归由 renderTree 处理），然后渲染根级文件。
        renderTree(folders, children);
        displayFiles = rootFiles || [];
      } else {
        // 折叠态：扁平整个工作区所有文件，按 modified 倒序（保存时间新→旧）取前10个展示。
        // 确保当前打开文档可见：若不在top10中则显式追加到末尾（避免用户"找不到当前文件"的困惑）
        const sortedAll = [...allFiles].sort((a, b) => (Number(b.modified) || 0) - (Number(a.modified) || 0));
        const topN = sortedAll.slice(0, 10);
        if (state.currentPath && !topN.some((f) => f.path === state.currentPath)) {
          const openFile = allFiles.find((f) => f.path === state.currentPath);
          if (openFile) topN.push(openFile);
        }
        displayFiles = topN;
      }
      const displayTotal = displayFiles.length;
      const workspaceTotal = allFiles.length;

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
            // openDoc 失败时回滚多选高亮，避免目录树高亮与实际显示文档不一致
            openDoc(file.path).then((ok) => {
              if (!ok && state.multiSelected.has(file.path) && state.currentPath !== file.path) {
                state.multiSelected.delete(file.path);
                syncTreeSelectionState();
              }
            });
          }
        });
        button.addEventListener("dragstart", (event) => startTreeDrag(event, { type: "file", path: file.path }));
        button.addEventListener("dragend", endTreeDrag);
        children.append(button);
      }

      if (isExpanded) {
        // 展开状态：显示"收起"按钮
        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "more-files-btn";
        moreBtn.textContent = `收起（目录树共 ${workspaceTotal} 项）`;
        const workspaceId = node.workspaceId;
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.expandedWorkspaceRoots.delete(workspaceId);
          rerenderWorkspacePanel(node, panel);
        });
        children.append(moreBtn);
      } else if (workspaceTotal > displayTotal || workspaceTotal > 0) {
        // 收起状态：显示"展开全部"按钮（展示整个工作区的目录树结构）
        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "more-files-btn";
        moreBtn.textContent = `共 ${workspaceTotal} 项，展开查看全部`;
        const workspaceId = node.workspaceId;
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.expandedWorkspaceRoots.add(workspaceId);
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
      title.innerHTML = `<span class="folder-icon">v</span><span>${escapeHtml(compactName(node.name))}</span><span class="folder-actions-inline"><span class="folder-new" title="在此处新建文件" data-action="new-file" role="button" tabindex="0">+</span></span>`;
      title.addEventListener("click", (event) => {
        event.stopPropagation();
        if (event.target.closest("[data-action='new-file']")) {
          state.activeWorkspaceId = node.workspaceId;
          state.selectedFolder = node.path;
          state.folderExplicit = true;
          openCreateModal("file");
          return;
        }
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
          const ok = await customConfirm(`确认移除工作路径「${target.name}」？\n（仅移除记录，不会删除磁盘文件）`, { title: "移除工作路径", danger: true });
          if (!ok) return;
          await api.post("/api/workspaces/remove", { id });
          state.graphReady = false;
          await bootstrap(true);
          openWorkspaceModal();
        } else if (action === "rename") {
          const target = state.workspaces.find((ws) => ws.id === id);
          if (!target) return;
          const newName = await customPrompt("输入新的工作路径名称", target.name, { title: "重命名工作路径" });
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

function setMode(mode, { deferReaderRender = false } = {}) {
  if (state.mode === mode) return;
  if (mode !== "edit" && state.immersive) setImmersiveEditing(false);
  // 切换前按相对比例保存当前模式的滚动位置，用于模式切换后恢复到相同阅读位置
  if (state.mode === "view") {
    const readerMax = Math.max(1, els.markdownView.scrollHeight - els.markdownView.clientHeight);
    state.readerScrollRatio = readerMax > 0 ? els.markdownView.scrollTop / readerMax : 0;
  } else if (state.mode === "edit") {
    const editorMax = Math.max(1, els.editor.scrollHeight - els.editor.clientHeight);
    state.editorScrollRatio = editorMax > 0 ? els.editor.scrollTop / editorMax : 0;
  }
  state.mode = mode;
  try { localStorage.setItem("lastMode", mode); } catch (_) {}
  document.body.classList.toggle("graph-mode", mode === "graph");
  lastInputLength = els.editor.value.length;
  lastInputValue = els.editor.value;
  els.readerPanel.classList.toggle("hidden", mode !== "view");
  els.editorPanel.classList.toggle("hidden", mode !== "edit");
  els.graphPanel.classList.toggle("hidden", mode !== "graph");
  els.saveBtn.classList.toggle("hidden", mode !== "edit" || !state.currentPath);
  els.formatBtn.classList.toggle("hidden", mode !== "edit" || !state.currentPath);
  if (mode === "view") {
    els.modeToggleBtn.textContent = "修改";
    els.modeToggleBtn.classList.remove("active");
  } else if (mode === "edit") {
    els.modeToggleBtn.textContent = "阅读";
    els.modeToggleBtn.classList.add("active");
  } else if (mode === "graph") {
    els.modeToggleBtn.textContent = state.currentPath ? "阅读" : "修改";
    els.modeToggleBtn.classList.remove("active");
  }
  els.graphBtn.classList.toggle("active", mode === "graph");
  updateMultiCursorDisplay();
  if (mode === "edit") {
    syncPreviewToEditor();
    renderCurrentPreviewNow(state.currentContent);
    setEditorOutlineVisible(state.editorOutlineVisible);
    setPreviewVisible(state.previewVisible);
    setEditorVisible(!state.editorHidden);
    // 进入编辑态立即重放一次用户字号设置（CodeMirror重建视图后会重置尺寸，
    // 不加此行会导致：打开非md默认edit / 切回edit 时，字号被CSS默认值覆盖，
    // Ctrl+/- 调整过的大小在编辑态中"看起来没生效"。）
    const s = loadSettings();
    const sc = parseFloat(document.documentElement.style.getPropertyValue("--app-scale")) || 1;
    applyEditorFontSizeToDom(s.contentFontSize, Math.round(s.contentFontSize * sc));
    if (state.editorOutlineVisible) {
      renderEditorOutline(els.editor.value);
    }
    // 按项目规范用 rAF×3 确保 CSS 过渡和多轮 reflow 完成后再恢复滚动位置，
    // 避免 scrollHeight 未稳定时比例换算错误导致位置错位。
    const restoreEditorScroll = () => {
      const editorMax = Math.max(1, els.editor.scrollHeight - els.editor.clientHeight);
      els.editor.scrollTop = Math.round(editorMax * (state.readerScrollRatio ?? 0));
    };
    requestAnimationFrame(() => {
      if (typeof applyEditorSplitterLayout === "function") applyEditorSplitterLayout();
      restoreEditorScroll();
      requestAnimationFrame(() => {
        restoreEditorScroll();
        requestAnimationFrame(restoreEditorScroll);
      });
    });
    if (state.previewVisible && !state.largeDocument) {
      requestAnimationFrame(() => schedulePreviewUpdate({ immediate: true, forceContent: state.currentContent }));
    }
  }
  if (mode === "view") {
    // deferReaderRender: 调用方（如 openGsResult）即将 openDoc 渲染新内容，
    // 跳过本次旧内容渲染与滚动恢复，避免重复渲染浪费与视觉闪烁。
    if (!deferReaderRender) {
      // 阅读模式：先 await 渲染完成，再恢复滚动，避免 scrollHeight 未稳定时比例换算错位；
      // rAF×3 确保 reflow 完成后应用滚动位置，和编辑模式切出时保存的 editorScrollRatio 对齐。
      (async () => {
        await renderReaderContent(state.currentContent);
        if (state.mode !== "view") return;
        const restoreReaderScroll = () => {
          const readerMax = Math.max(1, els.markdownView.scrollHeight - els.markdownView.clientHeight);
          els.markdownView.scrollTop = Math.round(readerMax * (state.editorScrollRatio ?? state.readerScrollRatio ?? 0));
        };
        restoreReaderScroll();
        requestAnimationFrame(() => {
          restoreReaderScroll();
          requestAnimationFrame(restoreReaderScroll);
        });
      })();
    }
  }
  if (mode !== "graph") {
    stopGraphSimulation();
    releaseGraphCanvas();
    state.graphSource = null;
    state.graphLayouts.clear();
    state.graphLayoutPromises.clear();
    state.graphWorkerPending.clear();
    if (state.graphWorker) { state.graphWorker.terminate(); state.graphWorker = null; }
    if (state.graphWorkerIdleTimer) { clearTimeout(state.graphWorkerIdleTimer); state.graphWorkerIdleTimer = 0; }
  }
  if (mode === "graph") {
    state.graphView.lastInteraction = performance.now();
    requestAnimationFrame(() => initGraph());
  }
  updateEditorPlaceholder();
  refreshStatusBar();
}

function resetUndo(content) {
  state.undo.stack = [content];
  state.undo.index = 0;
  state.undo.applying = false;
  state.undo.lastRecordedAt = 0;
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

function recordUndo(value, { force = false } = {}) {
  // Undo/redo history is owned by CodeMirror's native history() extension.
  // Keeping a parallel snapshot stack would cause double-undo and flicker.
  void value;
  void force;
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
  // Use CodeMirror's native history so transactions replay incrementally
  // instead of replacing the whole document (which caused flicker).
  els.editor.undo?.();
}

function redoEditor() {
  els.editor.redo?.();
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
  // 切换文档前同步保存旧文档草稿（此时 state.currentPath 仍指向旧文档），
  // 避免 800ms 防抖窗口内切换导致旧文档未保存内容丢失。
  saveDraftNow();
  clearAutoSaveTimers();
  let doc;
  try {
    doc = await api.get(`/api/doc?path=${encodeURIComponent(docPath)}`);
  } catch (error) {
    console.error("openDoc failed", error);
    showToast(`打开文档失败：${error?.message || "未知错误"}`);
    return false;
  }
  // 被 newer openDoc 覆盖时返回 true：表示已有文档在打开流程中，调用方（如 handleDocsClosed）
  // 不应执行清空逻辑，否则会清空正在打开的新文档内容，造成文档丢失。
  if (seq !== state.openSeq) return true;

  // 数据完整性校验：服务端返回必须含 path 与字符串 content，否则视为打开失败，
  // 避免后续把 undefined 写入编辑器导致内容错乱
  if (!doc || typeof doc.path !== "string" || typeof doc.content !== "string") {
    logDocError("打开文档-数据校验", new Error("返回数据缺失 path 或 content"), docPath);
    return false;
  }

  const item = state.flatFiles.find((file) => file.path === doc.path) || doc;
  state.activeWorkspaceId = item.workspaceId || doc.path.split(":", 1)[0] || state.activeWorkspaceId;
  state.currentPath = doc.path;
  state.currentContent = doc.content;
  state.currentVersion = doc.contentSha256 || "";
  state.currentDocCreated = doc.created || item?.created || 0;
  state.currentEncoding = doc.encoding || "utf-8";
  state.currentIsMarkdown = /\.md$/i.test(doc.path || "");
  updateLargeDocumentState(doc.content, true);
  state.selectedNode = doc.path;
  state.selectedFolder = doc.path.includes("/") ? doc.path.split("/").slice(0, -1).join("/") : "";
  state.folderExplicit = false;
  els.docPath.textContent = displayPath(doc.path);
  els.docPath.title = doc.path;
  els.docTitle.textContent = displayName(item);
  els.docTitle.title = doc.title || displayName(item);
  els.markdownView.classList.remove("empty-state");
  // 检查草稿并设置编辑器内容——必须在 await renderReaderContent 之前完成，
  // 避免 await 期间 auto-save 把旧文档内容保存到新路径
  const draftContent = restoreDraft(doc.path);
  const effectiveContent = (draftContent != null && draftContent !== doc.content) ? draftContent : doc.content;
  els.editor.value = effectiveContent;
  state.lastSavedContent = doc.content;
  if (draftContent != null && draftContent !== doc.content) {
    state.currentContent = draftContent;
    setSaveStatus("\u672a\u4fdd\u5b58", true);
    scheduleAutoSave();
  }
  if (state.currentIsMarkdown) {
    try {
      await renderReaderContent(doc.content, { searchTerm: options.searchTerm || "" });
    } catch (error) {
      console.error("renderReaderContent failed", error);
      els.markdownView.innerHTML = `<p style="color: var(--danger);">文档渲染失败：${escapeHtml(error?.message || "未知错误")}</p>`;
    }
  } else {
    // 非Markdown文件（代码/文本）：默认进入编辑态以便直接修改+自动保存；
    // readerPanel 里仍然渲染一份代码预览作为参考（但编辑态下readerPanel隐藏，
    // 不影响正常使用；用户切回view态时可见）。
    els.markdownView.innerHTML = "";
    const preview = document.createElement("pre");
    preview.className = "code-preview";
    preview.textContent = doc.content || "";
    preview.style.whiteSpace = "pre-wrap";
    preview.style.wordBreak = "break-word";
    preview.style.padding = "16px";
    preview.style.fontFamily = "var(--mono-font, 'Cascadia Code', 'Fira Code', Consolas, monospace)";
    preview.style.fontSize = "var(--doc-font-size, 14px)";
    preview.style.lineHeight = "1.6";
    preview.style.tabSize = "4";
    els.markdownView.appendChild(preview);
    renderOutlineItems([]);
    // 非Markdown文档：默认进入编辑态，允许输入、自动保存与手动保存。
    if (state.mode !== "edit") setMode("edit");
    // 双重保障：强制刷新保存状态 + 清除旧版本遗留的"非Markdown不支持保存"等拒绝性UI
    if (els.saveBtn) {
      els.saveBtn.disabled = false;
      els.saveBtn.removeAttribute("title");
      els.saveBtn.title = "保存 (Ctrl+S)";
      els.saveBtn.classList.remove("readonly", "disabled", "unsupported");
    }
    // 按当前编辑器内容重新判断保存状态（确保底部lastSaveText 不出现"不可保存"）
    if (els.editor.value === (doc.content || "")) {
      setSaveStatus("\u4fdd\u5b58", false);
    } else {
      setSaveStatus("\u672a\u4fdd\u5b58", true);
      scheduleAutoSave();
    }
  }
  els.preview.classList.remove("preview-pending");
  if (state.largeDocument) {
    clearTimeout(state.previewTimer);
    els.preview.replaceChildren();
    state.previewLastContent = "";
    if (state.previewVisible) setPreviewVisible(false, { automatic: true });
  } else if (!state.currentIsMarkdown) {
    // 非 Markdown 文档不渲染预览，避免按 Markdown 解析导致卡顿或错位
    clearTimeout(state.previewTimer);
    els.preview.replaceChildren();
    state.previewLastContent = "";
    if (state.previewVisible) setPreviewVisible(false, { automatic: true });
  } else {
    if (state.previewAutoHidden) setPreviewVisible(true, { automatic: true });
    if (state.previewVisible) {
      renderCurrentPreviewNow(doc.content);
      schedulePreviewUpdate({ immediate: true, forceContent: doc.content });
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
  lastInputValue = effectiveContent;
  // 统一在 openDoc 末尾最终设置一次保存状态：
  // - 如果有草稿且不等于原内容 → 未保存 + 调度自动保存
  // - 其他情况（包括非Markdown代码/文本文件）→ 保存（等同原始内容）
  //   对非Markdown还需再次同步 saveBtn 的可见性/可用性/提示，
  //   避免旧版本遗留"非Markdown不支持保存"title或disabled。
  if (draftContent != null && draftContent !== doc.content) {
    setSaveStatus("\u672a\u4fdd\u5b58", true);
    scheduleAutoSave();
  } else {
    setSaveStatus("\u4fdd\u5b58", false);
  }
  if (els.saveBtn && !!state.currentPath && !state.currentIsMarkdown) {
    els.saveBtn.disabled = false;
    els.saveBtn.removeAttribute("title");
    els.saveBtn.title = "保存 (Ctrl+S)";
    els.saveBtn.classList.remove("readonly", "disabled", "unsupported");
  }
  syncTreeSelectionState();
  // 二次校验：确保编辑器内容与当前文档一致（CodeMirror setter 可能异步或被覆盖）
  const _resyncEditor = (label) => {
    if (!state.currentPath || state.currentPath !== doc.path) return;
    if (els.editor.value !== effectiveContent) {
      console.warn(`[openDoc] editor content mismatch (${label}), resyncing. path=${doc.path} editor_len=${els.editor.value?.length || 0} target_len=${effectiveContent.length}`);
      try {
        if (els.editor.view && typeof els.editor.view.dispatch === "function") {
          els.editor.view.dispatch({
            changes: { from: 0, to: els.editor.value.length, insert: effectiveContent },
            selection: { anchor: 0, head: 0 },
            scrollIntoView: true,
          });
        } else {
          els.editor.value = effectiveContent;
        }
      } catch (e) {
        console.error("resyncEditor dispatch failed, using fallback setter:", e);
        try { els.editor.value = effectiveContent; }
        catch (e2) { logDocError("编辑器内容同步", e2); }
      }
      state.lastSavedContent = doc.content;
      if (draftContent != null && draftContent !== doc.content) state.currentContent = draftContent;
    }
  };
  _resyncEditor("immediate");
  requestAnimationFrame(() => { if (seq === state.openSeq) _resyncEditor("rAF-1"); });
  requestAnimationFrame(() => requestAnimationFrame(() => { if (seq === state.openSeq) _resyncEditor("rAF-2"); }));
  if (state.mode === "edit" && state.editorOutlineVisible) {
    renderEditorOutline(effectiveContent);
  }
  if (state.mode === "graph") scheduleGraphDraw();
  if (options.searchTerm) {
    requestAnimationFrame(() => scrollReaderToElement(els.markdownView.querySelector(".search-hit"), "auto"));
    if (state.mode === "edit" && els.editor.searchInEditor) {
      const term = String(options.searchTerm).trim();
      if (term) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (seq !== state.openSeq) return;
          _resyncEditor("pre-search");
          const result = els.editor.searchInEditor(term);
          if (result.total > 0 && result.matches && result.matches[0]) {
            els.editor.jumpToMatch(result.matches[0].from, result.matches[0].to);
          }
        }));
      }
    }
  }
  addRecentDoc(doc.path);
  try { localStorage.setItem("lastOpenedDoc", doc.path); } catch (_) {}
  // 智能化工作区：当前打开文档变化时，重新渲染目录树以更新收起状态下显示的文件
  if (state.tree) renderTree(state.tree);
  updateEditorPlaceholder();
  updateStatusDocName(els.docTitle?.textContent || "");
  updateStatusCreated(state.currentDocCreated);
  updateStatusEncoding(state.currentEncoding);
  refreshStatusBar();
  return true;
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
  updateStatusLastSave(label);
}

// ============ 编辑器底部状态栏 ============
const _pomodoroState = {
  mode: "idle", // idle | focus | break
  remaining: 0, // 秒
  timer: 0,
  focusMinutes: 25,
  breakMinutes: 5,
};

function _formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function _formatDateTime(ms) {
  if (!ms || !Number.isFinite(ms)) return "--";
  try {
    const d = new Date(ms);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch (_) {
    return "--";
  }
}

function _formatClock(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mi}:${ss}`;
}

const _statusFieldCache = new Map();
function _getStatusFieldEls(field) {
  let els = _statusFieldCache.get(field);
  if (!els) {
    els = [...document.querySelectorAll(`[data-status-field="${field}"]`)];
    _statusFieldCache.set(field, els);
  }
  return els;
}
function _invalidateStatusCache(field) {
  if (field) _statusFieldCache.delete(field);
  else _statusFieldCache.clear();
}
function _setStatusField(field, text) {
  for (const el of _getStatusFieldEls(field)) {
    el.textContent = text;
  }
}

function _setStatusItemState(field, className, on) {
  for (const el of _getStatusFieldEls(field)) {
    el.classList.toggle(className, !!on);
  }
}

function _countVisibleChars(text) {
  return String(text || "")
    .replace(/^---[\s\S]*?---\n?/, "")
    .replace(/[#>*_`~\[\]()!|-]/g, "")
    .replace(/\s+/g, "")
    .length;
}

function updateStatusDocName(name) {
  _setStatusField("docNameText", name || "未选择文档");
}

function updateStatusWordCount() {
  let count = 0;
  if (state.currentPath) {
    const source = state.mode === "edit"
      ? (els.editor.value || "")
      : (state.currentContent || els.markdownView?.innerText || "");
    count = _countVisibleChars(source);
  }
  _setStatusField("wordCountText", `${count} 字`);
}

function updateStatusCursor() {
  let text = "行 1, 列 1";
  if (state.mode === "edit" && state.currentPath) {
    const value = els.editor.value || "";
    const pos = els.editor.selectionStart ?? 0;
    const before = value.substring(0, pos);
    const line = before.split("\n").length;
    const col = pos - (before.lastIndexOf("\n") + 1) + 1;
    text = `行 ${line}, 列 ${col}`;
  }
  _setStatusField("cursorText", text);
}

function updateStatusLastSave(label) {
  let text;
  if (!state.currentPath) {
    text = "未保存";
  } else {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    text = label === "已保存" || label === "已自动保存"
      ? `${label} ${hh}:${mi}`
      : (label || "未保存");
  }
  _setStatusField("lastSaveText", text);
}

function updateStatusCreated(createdMs) {
  _setStatusField("createdText", createdMs ? `创建于 ${_formatDateTime(createdMs)}` : "创建于 --");
}

function updateStatusEncoding(enc) {
  const normalized = (enc || "utf-8").toString().toUpperCase().replace(/_/g, "-");
  _setStatusField("encodingText", normalized);
}

function updateStatusSystemTime() {
  _setStatusField("systemTimeText", _formatClock(new Date()));
}

function updateSidebarDocCount() {
  _setStatusField("docCountText", els.docCount?.textContent || "--");
}

function _renderPomodoro() {
  _setStatusField("pomodoroText", _formatTime(_pomodoroState.remaining));
  _setStatusItemState("pomodoro", "running", _pomodoroState.mode === "focus");
  _setStatusItemState("pomodoro", "break", _pomodoroState.mode === "break");
  const focusLabel = _pomodoroState.mode === "focus" ? "专注中" : (_pomodoroState.mode === "break" ? "休息中" : "空闲");
  for (const el of _getStatusFieldEls("pomodoro")) {
    el.title = `番茄钟 · ${focusLabel}（点击切换启动/停止）`;
  }
}

function _tickPomodoro() {
  if (_pomodoroState.mode === "idle") return;
  _pomodoroState.remaining = Math.max(0, _pomodoroState.remaining - 1);
  if (_pomodoroState.remaining === 0) {
    if (_pomodoroState.mode === "focus") {
      _pomodoroState.mode = "break";
      _pomodoroState.remaining = _pomodoroState.breakMinutes * 60;
      showToast(`专注完成，进入 ${_pomodoroState.breakMinutes} 分钟休息`);
    } else {
      _pomodoroState.mode = "focus";
      _pomodoroState.remaining = _pomodoroState.focusMinutes * 60;
      showToast(`休息结束，进入 ${_pomodoroState.focusMinutes} 分钟专注`);
    }
  }
  _renderPomodoro();
}

function _togglePomodoro() {
  if (_pomodoroState.mode === "idle") {
    _pomodoroState.mode = "focus";
    _pomodoroState.remaining = _pomodoroState.focusMinutes * 60;
    if (_pomodoroState.timer) clearInterval(_pomodoroState.timer);
    _pomodoroState.timer = setInterval(_tickPomodoro, 1000);
    showToast(`番茄钟启动：${_pomodoroState.focusMinutes} 分钟专注`);
  } else {
    _pomodoroState.mode = "idle";
    _pomodoroState.remaining = 0;
    if (_pomodoroState.timer) {
      clearInterval(_pomodoroState.timer);
      _pomodoroState.timer = 0;
    }
    showToast("番茄钟已停止");
  }
  _renderPomodoro();
}

function refreshStatusBar() {
  updateStatusDocName(els.docTitle?.textContent || "");
  updateStatusWordCount();
  updateStatusCursor();
  updateStatusLastSave(els.saveBtn?.textContent || "未保存");
  updateStatusSystemTime();
  updateSidebarDocCount();
  _renderPomodoro();
}

// 系统时间刷新（页面隐藏时暂停以节省 CPU）
let _systemTimeInterval = null;
function _startSystemTimeInterval() {
  if (_systemTimeInterval) return;
  _systemTimeInterval = setInterval(updateStatusSystemTime, 1000);
}
function _stopSystemTimeInterval() {
  if (_systemTimeInterval) {
    clearInterval(_systemTimeInterval);
    _systemTimeInterval = null;
  }
}
_startSystemTimeInterval();
// 番茄钟按钮：绑定到所有状态栏中的番茄钟项
document.querySelectorAll('[data-action="toggle-pomodoro"]').forEach((el) => {
  el.addEventListener("click", _togglePomodoro);
});
// 初始渲染
refreshStatusBar();

function friendlyAiError(value, embeddingModel = "") {
  const message = String(value || "").trim();
  if (!message) return "";
  if (/does not support embeddings|不支持 embeddings/i.test(message)) {
    return `向量模型“${embeddingModel || "当前模型"}”不支持 Embeddings，请改用 qwen3-embedding 或 nomic-embed-text。`;
  }
  if (/fetch failed|ECONNREFUSED|无法连接.*Ollama/i.test(message)) {
    return "无法连接本地 Ollama 服务，请先启动 Ollama，再点击“检测连接”。";
  }
  return message.replace(/\s+/g, " ").slice(0, 320);
}

function setAiStatus(status) {
  state.ai.status = status;
  if (!els.aiStatusBadge) return;
  const indexing = status?.indexing;
  const hasError = friendlyAiError(status?.lastError, status?.embeddingModel);
  els.aiStatusBadge.classList.toggle("ready", !indexing && !hasError && status?.mode === "hybrid");
  els.aiStatusBadge.classList.toggle("warn", Boolean(hasError) || status?.mode === "keyword");
  if (indexing) els.aiStatusBadge.textContent = `正在建立索引 ${status.progress?.done || 0}/${status.progress?.total || 0}`;
  else if (hasError) els.aiStatusBadge.textContent = "关键词降级";
  else if (status?.mode === "hybrid") els.aiStatusBadge.textContent = `语义索引 · ${status.chunkCount || 0} 段`;
  else els.aiStatusBadge.textContent = `关键词模式 · ${status?.chunkCount || 0} 段`;
  if (els.aiIndexMode) els.aiIndexMode.textContent = status?.mode === "hybrid" ? "混合语义" : "关键词";
  if (els.aiIndexCount) els.aiIndexCount.textContent = `${status?.chunkCount || 0} 段`;
  if (els.aiIndexStorage) {
    const bytes = Number(status?.storageBytes || 0);
    els.aiIndexStorage.textContent = bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(0, Math.round(bytes / 1024))} KB`;
  }
  if (els.aiIndexProgressBar) {
    const done = Number(status?.progress?.done || 0);
    const total = Number(status?.progress?.total || 0);
    els.aiIndexProgressBar.style.width = total ? `${Math.min(100, Math.round(done / total * 100))}%` : (status?.indexing ? "35%" : "0%");
  }
  if (els.aiIndexProgressText) {
    const done = Number(status?.progress?.done || 0);
    const total = Number(status?.progress?.total || 0);
    els.aiIndexProgressText.textContent = status?.indexing
      ? `正在更新索引 · ${done}/${total || "待计算"}`
      : `最近更新：${status?.indexedAt ? new Date(status.indexedAt).toLocaleString() : "尚未建立"}`;
  }
  if (els.aiSettingsStatus) {
    const model = status?.embeddingModel || "未设置向量模型";
    els.aiSettingsStatus.textContent = `${els.aiStatusBadge.textContent} · ${model}${hasError ? ` · ${hasError}` : ""}`;
  }
}

function saveAiHistory() {
  try {
    const compact = state.ai.messages.slice(-40).map((message) => ({
      role: message.role,
      content: String(message.content || "").slice(0, 12000),
      sources: (message.sources || []).slice(0, 8),
    }));
    localStorage.setItem(AI_HISTORY_KEY, JSON.stringify(compact));
  } catch {}
}

function loadAiHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_HISTORY_KEY) || "[]");
    if (Array.isArray(parsed)) state.ai.messages = parsed.filter((item) => item && ["user", "assistant"].includes(item.role) && item.content);
  } catch {
    state.ai.messages = [];
  }
}

async function loadAiStatus() {
  try {
    const status = await api.get("/api/ai/status");
    setAiStatus(status);
    state.ai.settings = status;
    if (!state.ai.configDirty) {
      if (els.aiBaseUrl) els.aiBaseUrl.value = status.baseUrl || "http://127.0.0.1:11434";
      if (els.aiEmbeddingModel) els.aiEmbeddingModel.value = status.embeddingModel || "";
      if (els.aiChatModel) els.aiChatModel.value = status.chatModel || "";
      if (els.aiDeepseekApiKey) {
        els.aiDeepseekApiKey.value = "";
        els.aiDeepseekApiKey.placeholder = status.deepseekApiKeyConfigured
          ? "已配置，留空则保持不变"
          : "sk-...";
      }
      if (els.aiDeepseekBaseUrl) els.aiDeepseekBaseUrl.value = status.deepseekBaseUrl || "https://api.deepseek.com";
      if (els.aiDeepseekChatModel) els.aiDeepseekChatModel.value = status.deepseekChatModel || "deepseek-chat";
      setAiProvider(status.chatProvider === "deepseek" ? "deepseek" : "ollama");
    }
    clearTimeout(state.ai.statusTimer);
    if (status.indexing && (state.ai.open || !els.settingsModal.classList.contains("hidden"))) {
      state.ai.statusTimer = setTimeout(loadAiStatus, 900);
    }
  } catch (error) {
    if (els.aiSettingsStatus) els.aiSettingsStatus.textContent = error.message || "无法读取 AI 状态";
  }
}

function renderAiMessages() {
  if (!els.aiMessages) return;
  saveAiHistory();
  els.aiMessages.replaceChildren();
  if (!state.ai.messages.length) {
    const empty = document.createElement("div");
    empty.className = "ai-empty";
    empty.innerHTML = "<strong>查找存过但记不清位置的内容</strong><span>回答会列出原文来源；点击来源即可返回文档核对。</span>";
    els.aiMessages.append(empty);
    return;
  }
  for (const message of state.ai.messages) {
    const item = document.createElement("article");
    item.className = `ai-message ${message.role}`;
    const bubble = document.createElement("div");
    bubble.className = "ai-message-bubble";
    bubble.textContent = message.content;
    item.append(bubble);
    // 助手回复增加快捷操作：润色、续写、插入到文档。仅在编辑模式且当前有文档时显示。
    if (message.role === "assistant" && state.currentPath) {
      const actions = document.createElement("div");
      actions.className = "ai-message-actions";
      const polishBtn = document.createElement("button");
      polishBtn.type = "button";
      polishBtn.className = "ai-action-btn";
      polishBtn.textContent = "润色";
      polishBtn.title = "将此回答润色为更流畅的表达";
      polishBtn.addEventListener("click", () => runAiTransformOnText(message.content, "polish"));
      const continueBtn = document.createElement("button");
      continueBtn.type = "button";
      continueBtn.className = "ai-action-btn";
      continueBtn.textContent = "续写";
      continueBtn.title = "基于此回答继续扩展内容";
      continueBtn.addEventListener("click", () => runAiTransformOnText(message.content, "continue"));
      const insertBtn = document.createElement("button");
      insertBtn.type = "button";
      insertBtn.className = "ai-action-btn";
      insertBtn.textContent = "插入文档";
      insertBtn.title = "将此回答插入到当前编辑器光标位置";
      insertBtn.addEventListener("click", () => insertTextAtCursor(message.content));
      actions.append(polishBtn, continueBtn, insertBtn);
      item.append(actions);
    }
    if (message.sources?.length) {
      const sources = document.createElement("div");
      sources.className = "ai-sources";
      for (const source of message.sources) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ai-source";
        button.dataset.path = source.path;
        button.dataset.heading = source.heading || "";
        const title = document.createElement("span");
        title.className = "ai-source-title";
        title.textContent = `[${source.rank}] ${source.title || source.path}`;
        const meta = document.createElement("span");
        meta.className = "ai-source-meta";
        meta.textContent = `${source.heading || "正文"} · 第 ${source.startLine}-${source.endLine} 行`;
        const excerpt = document.createElement("span");
        excerpt.className = "ai-source-excerpt";
        excerpt.textContent = source.excerpt || "";
        button.append(title, meta, excerpt);
        sources.append(button);
      }
      item.append(sources);
    }
    els.aiMessages.append(item);
  }
  els.aiMessages.scrollTop = els.aiMessages.scrollHeight;
}

function toggleAiDrawer(open = !state.ai.open) {
  state.ai.open = open;
  els.aiDrawer?.classList.toggle("hidden", !open);
  els.aiBtn?.setAttribute("aria-pressed", String(open));
  els.aiBtn?.classList.toggle("active", open);
  if (open) {
    loadAiStatus();
    els.aiQuestion?.focus();
  }
}

async function jumpToAiSource(source) {
  if (!source?.path) return;
  toggleAiDrawer(false);
  setMode("view");
  await openDoc(source.path);
  requestAnimationFrame(() => {
    const target = [...els.markdownView.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .find((heading) => !source.heading || heading.textContent.trim() === source.heading.trim() || heading.textContent.includes(source.heading.trim()));
    scrollReaderToElement(target, "smooth");
  });
}

// 将指定文本以指定模式进行 AI 转换（润色/续写等），结果在转换弹窗中展示。
async function runAiTransformOnText(text, mode) {
  if (!text || !text.trim()) return showToast("没有可处理的内容");
  // 构造一个虚拟选区，让 runAiTransform 直接处理这段文本。
  state.ai.selection = { text: text.trim(), source: "editor", start: 0, end: 0, path: state.currentPath };
  await runAiTransform(mode);
}

// 在编辑器当前光标位置插入文本（用于 AI 回答快速插入）。
async function insertTextAtCursor(text) {
  if (!text || !state.currentPath) return;
  if (state.mode !== "edit") setMode("edit");
  const content = text.trim();
  if (!content) return;
  const cursorPos = els.editor.selectionStart ?? els.editor.value.length;
  const prefix = cursorPos > 0 && els.editor.value[cursorPos - 1] !== "\n" ? "\n\n" : "";
  const suffix = els.editor.value[cursorPos] && els.editor.value[cursorPos] !== "\n" ? "\n\n" : "";
  const insert = `${prefix}${content}${suffix}`;
  if (await replaceEditorRange(insert, cursorPos, cursorPos, "end")) {
    showToast("已插入到当前光标位置");
  } else {
    showToast("插入失败，请重试");
  }
}

function positionAiInlineDialog() {
  if (!els.editorAiDialog) return;
  const view = els.editor.view;
  if (!view) return;
  const cursorPos = els.editor.selectionStart ?? 0;
  const parentEl = els.editorAiDialog.parentElement;
  if (!parentEl) return;
  const parentRect = parentEl.getBoundingClientRect();
  const editorEl = document.getElementById("editor");
  if (!editorEl) return;
  const editorRect = editorEl.getBoundingClientRect();
  const editorWidth = editorEl.clientWidth;
  try {
    const coords = view.coordsAtPos(cursorPos);
    if (coords) {
      const top = coords.top - parentRect.top + 4;
      const left = editorRect.left - parentRect.left + 4;
      els.editorAiDialog.style.top = `${top}px`;
      els.editorAiDialog.style.left = `${left}px`;
      els.editorAiDialog.style.width = `${Math.max(200, editorWidth - 8)}px`;
      return;
    }
  } catch (e) { }
  const lineHeight = 22;
  const valueUntilCursor = (els.editor.value || "").substring(0, cursorPos);
  const lineCount = valueUntilCursor.split("\n").length;
  const top = editorRect.top - parentRect.top + Math.max(0, (lineCount - 1) * lineHeight) + 4;
  const left = editorRect.left - parentRect.left + 4;
  els.editorAiDialog.style.top = `${top}px`;
  els.editorAiDialog.style.left = `${left}px`;
  els.editorAiDialog.style.width = `${editorWidth - 8}px`;
}

function openAiInlineDialog() {
  if (!els.editorAiDialog || !els.editorAiDialogInput) return;
  if (state.mode !== "edit" || !state.currentPath) return;
  if (!_isCursorLineBlank()) {
    showToast("请将光标放在空白行上再使用 AI 对话");
    return;
  }
  if (state.aiInline.visible) {
    closeAiInlineDialog();
    return;
  }
  state.aiInline.visible = true;
  els.editorAiDialog.classList.add("visible");
  els.editorAiDialog.setAttribute("aria-hidden", "false");
  els.editorAiDialogInput.value = "";
  positionAiInlineDialog();
  requestAnimationFrame(() => {
    els.editorAiDialogInput.focus();
    els.editorAiDialogInput.select();
  });
}

function closeAiInlineDialog() {
  state.aiInline.visible = false;
  state.aiInline.historyIndex = -1;
  els.editorAiDialog?.classList.remove("visible");
  els.editorAiDialog?.setAttribute("aria-hidden", "true");
  if (state.aiInline.inflight) {
    state.aiInline.inflight = false;
    els.editorAiDialogSubmit?.classList.remove("ai-inline-spinner");
    if (els.editorAiDialogSubmit) els.editorAiDialogSubmit.textContent = "↑";
  }
  els.editor.focus();
}

async function submitAiInlineDialog() {
  if (!els.editorAiDialogInput) return;
  const text = els.editorAiDialogInput.value.trim();
  if (!text || state.aiInline.inflight) return;
  state.aiInline.inflight = true;
  if (els.editorAiDialogSubmit) {
    els.editorAiDialogSubmit.classList.add("ai-inline-spinner");
    els.editorAiDialogSubmit.textContent = "";
  }
  els.editorAiDialogInput.value = text;
  if (!state.aiInline.history.length || state.aiInline.history[state.aiInline.history.length - 1] !== text) {
    state.aiInline.history.push(text);
    if (state.aiInline.history.length > 30) state.aiInline.history.shift();
  }
  state.aiInline.historyIndex = -1;
  try {
    const result = await api.post("/api/ai/query", {
      question: text,
      scope: "all",
      path: state.currentPath,
    });
    if (result?.answer) {
      await insertTextAtCursor(result.answer);
      closeAiInlineDialog();
    } else if (result?.error) {
      showToast(result.error);
    }
  } catch (err) {
    showToast("AI 检索失败：" + (err.message || err));
  } finally {
    state.aiInline.inflight = false;
    if (els.editorAiDialogSubmit) {
      els.editorAiDialogSubmit.classList.remove("ai-inline-spinner");
      els.editorAiDialogSubmit.textContent = "↑";
    }
  }
}

els.editorAiDialogInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitAiInlineDialog();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeAiInlineDialog();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!state.aiInline.history.length) return;
    const idx = state.aiInline.historyIndex === -1
      ? state.aiInline.history.length - 1
      : Math.max(0, state.aiInline.historyIndex - 1);
    state.aiInline.historyIndex = idx;
    els.editorAiDialogInput.value = state.aiInline.history[idx];
    els.editorAiDialogInput.setSelectionRange(els.editorAiDialogInput.value.length, els.editorAiDialogInput.value.length);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!state.aiInline.history.length) return;
    if (state.aiInline.historyIndex === -1) return;
    const idx = state.aiInline.historyIndex + 1;
    if (idx >= state.aiInline.history.length) {
      state.aiInline.historyIndex = -1;
      els.editorAiDialogInput.value = "";
    } else {
      state.aiInline.historyIndex = idx;
      els.editorAiDialogInput.value = state.aiInline.history[idx];
    }
    els.editorAiDialogInput.setSelectionRange(els.editorAiDialogInput.value.length, els.editorAiDialogInput.value.length);
    return;
  }
});

els.editorAiDialogSubmit?.addEventListener("click", () => {
  submitAiInlineDialog();
});

// ===== 编辑器关键字检索弹窗 =====
const _editorSearch = { selectedIndex: -1, results: [], debounceTimer: null };

function openEditorSearch() {
  if (!els.editorSearchPopup) return;
  els.editorSearchPopup.classList.remove("hidden");
  els.editorSearchPopup.setAttribute("aria-hidden", "false");
  els.editorSearchInput.value = "";
  if (els.editorSearchReplace) els.editorSearchReplace.value = "";
  els.editorSearchResults.innerHTML = "";
  els.editorSearchCount.textContent = "";
  _editorSearch.results = [];
  _editorSearch.selectedIndex = -1;
  requestAnimationFrame(() => els.editorSearchInput.focus());
}

function closeEditorSearch() {
  if (!els.editorSearchPopup) return;
  els.editorSearchPopup.classList.add("hidden");
  els.editorSearchPopup.setAttribute("aria-hidden", "true");
  if (_editorSearch.debounceTimer) {
    clearTimeout(_editorSearch.debounceTimer);
    _editorSearch.debounceTimer = null;
  }
  els.editor.focus();
}

function _escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _highlightKeyword(text, keyword) {
  if (!keyword) return _escapeHtml(text);
  const lowerText = text.toLowerCase();
  const lowerKey = keyword.toLowerCase();
  let result = "";
  let lastIdx = 0;
  let idx = lowerText.indexOf(lowerKey);
  while (idx !== -1) {
    result += _escapeHtml(text.slice(lastIdx, idx));
    result += "<mark>" + _escapeHtml(text.slice(idx, idx + keyword.length)) + "</mark>";
    lastIdx = idx + keyword.length;
    idx = lowerText.indexOf(lowerKey, lastIdx);
  }
  result += _escapeHtml(text.slice(lastIdx));
  return result;
}

function _performEditorSearch(keyword) {
  if (!keyword) {
    _editorSearch.results = [];
    _editorSearch.selectedIndex = -1;
    els.editorSearchResults.innerHTML = "";
    els.editorSearchCount.textContent = "";
    return;
  }
  const doc = els.editor.view?.state?.doc;
  const results = [];
  if (doc) {
    const totalLines = doc.lines;
    const lowerKey = keyword.toLowerCase();
    for (let i = 1; i <= totalLines; i++) {
      const line = doc.line(i);
      if (line.text.toLowerCase().includes(lowerKey)) {
        const trimmed = line.text.trim();
        const preview = trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed || "(空行)";
        results.push({ lineNum: i, text: line.text, preview });
      }
    }
  } else {
    const lines = els.editor.value.split("\n");
    const lowerKey = keyword.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerKey)) {
        const trimmed = lines[i].trim();
        const preview = trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed || "(空行)";
        results.push({ lineNum: i + 1, text: lines[i], preview });
      }
    }
  }
  _editorSearch.results = results;
  _editorSearch.selectedIndex = results.length > 0 ? 0 : -1;
  els.editorSearchCount.textContent = results.length > 0 ? `${results.length} 个匹配` : "无匹配";
  _renderEditorSearchResults(keyword);
}

function _renderEditorSearchResults(keyword) {
  const container = els.editorSearchResults;
  if (!container) return;
  if (_editorSearch.results.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:16px;font-size:13px;color:var(--muted,#999);">未找到匹配行</div>';
    return;
  }
  const items = _editorSearch.results.map((r, i) => {
    const cls = i === _editorSearch.selectedIndex ? "editor-search-item selected" : "editor-search-item";
    return `<div class="${cls}" data-line="${r.lineNum}" data-index="${i}">
      <span class="editor-search-item-line">${r.lineNum}</span>
      <span class="editor-search-item-text">${_highlightKeyword(r.preview, keyword)}</span>
    </div>`;
  }).join("");
  container.innerHTML = items;
  const selected = container.querySelector(".selected");
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function _jumpToSearchLine(lineNum) {
  if (!lineNum || lineNum < 1) return;
  els.editor.scrollToLine?.(lineNum);
}

els.editorSearchInput?.addEventListener("input", () => {
  if (_editorSearch.debounceTimer) clearTimeout(_editorSearch.debounceTimer);
  const keyword = els.editorSearchInput.value.trim();
  _editorSearch.debounceTimer = setTimeout(() => _performEditorSearch(keyword), 150);
});

els.editorSearchInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeEditorSearch();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (_editorSearch.results.length === 0) return;
    _editorSearch.selectedIndex = (_editorSearch.selectedIndex + 1) % _editorSearch.results.length;
    _renderEditorSearchResults(els.editorSearchInput.value.trim());
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (_editorSearch.results.length === 0) return;
    _editorSearch.selectedIndex = _editorSearch.selectedIndex <= 0
      ? _editorSearch.results.length - 1
      : _editorSearch.selectedIndex - 1;
    _renderEditorSearchResults(els.editorSearchInput.value.trim());
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (_editorSearch.selectedIndex >= 0 && _editorSearch.results[_editorSearch.selectedIndex]) {
      _jumpToSearchLine(_editorSearch.results[_editorSearch.selectedIndex].lineNum);
    }
    return;
  }
});

els.editorSearchResults?.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

els.editorSearchResults?.addEventListener("click", (event) => {
  const item = event.target.closest(".editor-search-item");
  if (!item) return;
  const lineNum = parseInt(item.dataset.line, 10);
  _jumpToSearchLine(lineNum);
});

els.editorSearchClose?.addEventListener("click", closeEditorSearch);

els.editorSearchReplaceAll?.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

els.editorSearchReplaceAll?.addEventListener("click", () => {
  const keyword = els.editorSearchInput.value.trim();
  if (!keyword) return;
  const replacement = els.editorSearchReplace?.value ?? "";
  if (typeof els.editor.replaceAll !== "function") return;
  const count = els.editor.replaceAll(keyword, replacement);
  if (count > 0) {
    els.editorSearchCount.textContent = `已替换 ${count} 处`;
    _performEditorSearch(keyword);
    els.editor.dispatchEvent(new Event("input"));
  } else {
    els.editorSearchCount.textContent = "无匹配";
  }
});

els.editorSearchPopup?.addEventListener("mousedown", (event) => {
  event.stopPropagation();
});

document.addEventListener("mousedown", (event) => {
  if (!state.aiInline.visible) return;
  if (els.editorAiDialog && !els.editorAiDialog.contains(event.target)) {
    if (event.target === els.editor || els.editor?.contains?.(event.target)) {
      closeAiInlineDialog();
    }
  }
});

async function submitAiQuestion(event) {
  event?.preventDefault();
  const question = els.aiQuestion?.value.trim();
  if (!question || els.aiSendBtn?.disabled) return;
  state.ai.messages.push({ role: "user", content: question });
  if (state.ai.messages.length > 60) state.ai.messages = state.ai.messages.slice(-50);
  saveAiHistory();
  els.aiQuestion.value = "";
  renderAiMessages();
  els.aiSendBtn.disabled = true;
  els.aiSendBtn.textContent = "检索中...";
  try {
    const result = await api.post("/api/ai/query", {
      question,
      scope: els.aiScope?.value || "all",
      path: state.currentPath,
    });
    state.ai.messages.push({ role: "assistant", content: result.answer || "没有返回内容", sources: result.sources || [] });
    if (state.ai.messages.length > 60) state.ai.messages = state.ai.messages.slice(-50);
    saveAiHistory();
    if (result.warning) showToast(result.warning);
    setAiStatus({ ...(state.ai.status || {}), mode: result.retrievalMode === "hybrid" ? "hybrid" : "keyword", lastError: result.warning || "" });
  } catch (error) {
    state.ai.messages.push({ role: "assistant", content: `检索失败：${error.message || "未知错误"}` });
    saveAiHistory();
  } finally {
    els.aiSendBtn.disabled = false;
    els.aiSendBtn.textContent = "提问";
    renderAiMessages();
  }
}

function selectionNodeElement(node) {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function getAiSelection() {
  if (!state.currentPath) return null;
  if (state.mode === "edit" && els.editor.hasFocus) {
    const start = els.editor.selectionStart ?? 0;
    const end = els.editor.selectionEnd ?? 0;
    if (end > start) return { text: els.editor.value.slice(start, end), start, end, source: "editor", path: state.currentPath };
  }
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return null;
  const anchor = selectionNodeElement(selection.anchorNode);
  const focus = selectionNodeElement(selection.focusNode);
  const root = state.mode === "view" ? els.markdownView : els.preview;
  if (!root?.contains(anchor) || !root.contains(focus)) return null;
  return { text: selection.toString().trim(), source: "reader", path: state.currentPath };
}

function refreshAiSelectionMenu() {
  const selection = getAiSelection();
  state.ai.selection = selection;
  if (!els.aiSelectionMenu) return;
  if (!selection || selection.text.length < 8) {
    els.aiSelectionMenu.classList.add("hidden");
    return;
  }
  els.aiSelectionMenu.classList.remove("hidden");
  if (selection.source === "editor") {
    els.aiSelectionMenu.style.left = "50%";
    els.aiSelectionMenu.style.transform = "translateX(-50%)";
    // 下移弹窗：避开顶部栏(58px)+编辑工具栏(46px)，不遮挡编辑工具栏和文档内容。
    let topPx = 116;
    try {
      const tb = els.editorToolbar?.getBoundingClientRect();
      if (tb && Number.isFinite(tb.bottom)) topPx = Math.max(96, Math.round(tb.bottom + 8));
    } catch (_) {}
    els.aiSelectionMenu.style.top = `${topPx}px`;
  } else {
    const range = window.getSelection().getRangeAt(0);
    const rect = range.getBoundingClientRect();
    els.aiSelectionMenu.style.left = `${Math.max(12, Math.min(window.innerWidth - 300, rect.left + rect.width / 2 - 120))}px`;
    els.aiSelectionMenu.style.top = `${Math.max(12, rect.top - 52)}px`;
    els.aiSelectionMenu.style.transform = "";
  }
}

let aiTransformRequestSeq = 0;

function closeAiTransformModal() {
  aiTransformRequestSeq += 1;
  els.aiTransformModal?.classList.add("hidden");
  state.ai.transform = null;
}

async function runAiTransform(mode, { preserveInstruction = false } = {}) {
  const requestId = ++aiTransformRequestSeq;
  const selection = state.ai.selection || getAiSelection();
  const isRewrite = mode === "rewrite";
  // 代写、代码补全、生成注释模式允许无选区（基于上下文/光标位置生成），其余模式需选中文本。
  const allowEmpty = isRewrite || mode === "code" || mode === "comment";
  if (!allowEmpty && !selection?.text) return showToast("请先选中一段文本");
  state.ai.selection = selection || { source: "editor", text: "", start: 0, end: 0 };
  els.aiSelectionMenu?.classList.add("hidden");
  els.aiTransformModal?.classList.remove("hidden");
  // 双向翻译：标题根据源语言显示"英译中/中译英"，与后端 prompt 判定保持一致。
  function detectLanguageDirection(source) {
    const s = String(source || "");
    if (!s) return "zh2en";
    const cjkCount = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) || []).length;
    const letterCount = (s.match(/[A-Za-z]/g) || []).length;
    if (letterCount === 0 && cjkCount === 0) return "zh2en";
    const cjkRatio = cjkCount / Math.max(1, cjkCount + letterCount);
    return cjkRatio >= 0.3 ? "zh2en" : "en2zh";
  }
  let titleLabel = AI_TRANSFORM_LABELS[mode] || "结果";
  if (mode === "translate") {
    const direction = detectLanguageDirection(selection?.text || "");
    titleLabel = direction === "zh2en" ? "中译英" : "英译中";
  }
  els.aiTransformTitle.textContent = `生成${titleLabel}`;
  // 代写模式显示「写作要求」输入框，其余模式隐藏。
  const instrWrap = document.querySelector("#aiTransformInstructionWrap");
  if (instrWrap) instrWrap.classList.toggle("hidden", !isRewrite);
  if (els.aiTransformInstruction && !preserveInstruction) els.aiTransformInstruction.value = "";
  if (els.aiTransformGenerateBtn) {
    els.aiTransformGenerateBtn.classList.toggle("hidden", !isRewrite);
    els.aiTransformGenerateBtn.disabled = isRewrite;
  }
  els.aiTransformCreateBtn.textContent = isRewrite ? "新建文档" : "新建摘要文档";
  state.ai.transform = null;
  const sourceText = selection?.text || "";
  els.aiTransformSource.textContent = sourceText
    ? `${selection.source === "editor" ? "编辑器选区" : "阅读器选区"} · ${sourceText.length} 字`
    : (mode === "code" ? "代码补全：根据光标处上下文生成代码" : mode === "comment" ? "生成注释：为当前段落添加注释" : "代写模式：根据写作要求生成新文档");
  els.aiTransformResult.value = isRewrite ? "正在根据要求生成文档…" : "正在处理选中文本…";
  els.aiTransformResult.disabled = true;
  const canInsertFromEditor = selection?.source === "editor" || mode === "code" || mode === "comment" || isRewrite;
  els.aiTransformInsertBtn.disabled = !canInsertFromEditor;
  els.aiTransformCreateBtn.disabled = true;
  const instruction = isRewrite ? (els.aiTransformInstruction?.value || "").trim() : "";
  if (isRewrite && !instruction) {
    els.aiTransformResult.value = "";
    els.aiTransformResult.disabled = false;
    if (els.aiTransformGenerateBtn) els.aiTransformGenerateBtn.disabled = false;
    return showToast("请在「写作要求」中填写需求");
  }
  try {
    const payload = { text: sourceText, mode };
    if (instruction) payload.instruction = instruction;
    // 代码补全/生成注释模式：无选区时，传入光标附近上下文作为生成依据。
    if ((mode === "code" || mode === "comment") && !sourceText && state.mode === "edit") {
      const para = currentEditorParagraph();
      if (para?.text) {
        payload.text = para.text;
        payload.context = els.editor.value.slice(Math.max(0, para.start - 400), para.start)
          + "[[CURSOR]]" + els.editor.value.slice(para.end, para.end + 400);
      }
    }
    const result = await api.post("/api/ai/transform", payload);
    if (requestId !== aiTransformRequestSeq) return;
    els.aiTransformResult.value = result.content || "";
    state.ai.transform = { ...(selection || {}), mode, result: result.content || "" };
    els.aiTransformCreateBtn.disabled = !result.content;
    if (result.warning) showToast(result.warning);
  } catch (error) {
    if (requestId !== aiTransformRequestSeq) return;
    els.aiTransformResult.value = "";
    showToast(error.message || "文本处理失败");
    closeAiTransformModal();
  } finally {
    if (requestId === aiTransformRequestSeq) {
      els.aiTransformResult.disabled = false;
      if (els.aiTransformGenerateBtn) els.aiTransformGenerateBtn.disabled = false;
    }
  }
}

async function insertAiTransform() {
  const transform = state.ai.transform;
  const content = els.aiTransformResult.value.trim();
  if (!transform || !content) return;
  const mode = transform.mode;
  const hasSelection = Boolean(transform.text);
  const isComment = mode === "comment";
  const isRewrite = mode === "rewrite";
  const range = hasSelection ? resolveAiEditorRange(transform) : null;
  if (hasSelection && !range) return showToast("原文已变化，请重新生成 AI 结果后再插入");
  if (hasSelection && !isComment && content === els.editor.value.slice(range.start, range.end).trim()) {
    return showToast("AI 结果与原文相同，请重新生成后再插入");
  }
  if (isComment && hasSelection) {
    const commentText = content.startsWith("\n>") ? content : `\n> ${content.split("\n").join("\n> ")}\n`;
    if (!await replaceEditorRange(commentText, range.end, range.end, "end")) {
      return showToast("注释未能写入编辑器，请重试");
    }
  } else if (hasSelection) {
    if (!await replaceEditorRange(content, range.start, range.end, "end")) {
      return showToast("AI 结果未能写入编辑器，请重试");
    }
  } else {
    const cursorPos = els.editor.selectionStart ?? els.editor.value.length;
    if (!await replaceEditorRange(content, cursorPos, cursorPos, "end")) {
      return showToast("AI 结果未能写入编辑器，请重试");
    }
  }
  closeAiTransformModal();
  showToast(isComment ? "注释已插入" : isRewrite ? "AI 代写内容已插入当前位置" : "AI 结果已插入当前位置");
}

async function createAiTransformDocument() {
  const transform = state.ai.transform;
  const content = els.aiTransformResult.value.trim();
  if (!transform || !content) return;
  // 代写模式可能无选区路径，回退到当前文档路径或活跃工作区。
  const basePath = transform.path || state.currentPath || "";
  const baseName = String(splitPathRef(basePath).relative.split("/").pop() || "文档").replace(/\.md$/i, "");
  const name = (els.aiTransformDocName.value.trim() || `${baseName}-${AI_TRANSFORM_LABELS[transform.mode] || "整理"}`).slice(0, 80);
  const parent = parentPathRef(basePath);
  els.aiTransformCreateBtn.disabled = true;
  try {
    const created = await api.post("/api/create-doc", { parent, name });
    const body = `# ${name}\n\n> 来源：${transform.path}\n> 处理方式：${AI_TRANSFORM_LABELS[transform.mode] || "AI"}\n\n${content}\n`;
    await api.post("/api/save", { path: created.path, content: body });
    closeAiTransformModal();
    await bootstrap(true);
    await openDoc(created.path);
    setMode("edit");
    showToast("已新建 AI 整理文档");
  } catch (error) {
    showToast(error.message || "新建文档失败");
  } finally {
    els.aiTransformCreateBtn.disabled = false;
  }
}

// ===== AI 智能编辑提示：光标停留分析并给出改写/注释/翻译建议 =====
const aiHintState = { timer: null, lastKey: "", lastShownAt: 0, inflight: false };

function aiEditHintEnabled() {
  // 仅在编辑模式且编辑器获得焦点（光标停留于编辑栏）时启用，避免阅读/图谱模式误触发。
  const editorFocused = Boolean(els.editor?.hasFocus)
    || Boolean(els.editor?.contains?.(document.activeElement));
  return localStorage.getItem("aiEditHint") === "1" && state.mode === "edit" && editorFocused;
}

function initAiEditHintSettings() {
  if (els.aiEditHintToggle) {
    els.aiEditHintToggle.checked = localStorage.getItem("aiEditHint") === "1";
    els.aiEditHintToggle.addEventListener("change", () => {
      localStorage.setItem("aiEditHint", els.aiEditHintToggle.checked ? "1" : "0");
      if (!els.aiEditHintToggle.checked) { clearAiEditHintTimer(); hideAiEditHintPopover(); }
    });
  }
  if (els.aiEditHintDelay) {
    const saved = parseFloat(localStorage.getItem("aiEditHintDelay"));
    if (Number.isFinite(saved)) els.aiEditHintDelay.value = String(saved);
    els.aiEditHintDelay.addEventListener("change", () => {
      // 最大等待时长 60s，允许长停留分析；最小 1s。
      const v = Math.min(60, Math.max(1, parseFloat(els.aiEditHintDelay.value) || 2.5));
      els.aiEditHintDelay.value = String(v);
      localStorage.setItem("aiEditHintDelay", String(v));
    });
  }
  // 点击提示弹窗时编辑器会先失焦，但弹窗按钮仍需完成 click 回写。
  // 只有真正离开编辑器和提示弹窗时才清理提示，避免按钮在 click 前被移除。
  els.editor?.addEventListener("blur", (event) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget && document.getElementById("aiEditHintPopover")?.contains(nextTarget)) return;
    clearAiEditHintTimer();
    hideAiEditHintPopover();
  });
}

function clearAiEditHintTimer() {
  if (aiHintState.timer) { clearTimeout(aiHintState.timer); aiHintState.timer = null; }
}

function scheduleAiEditHint() {
  clearAiEditHintTimer();
  if (!aiEditHintEnabled()) return;
  const delaySec = parseFloat(localStorage.getItem("aiEditHintDelay")) || 2.5;
  // 上限 60s，与设置面板最大值一致，支持长停留分析。
  const delay = Math.min(60000, Math.max(1000, delaySec * 1000));
  aiHintState.timer = setTimeout(requestAiEditHint, delay);
}

function currentEditorParagraph() {
  const value = els.editor.value;
  if (!value) return null;
  const pos = els.editor.selectionStart ?? 0;
  const before = value.slice(0, pos);
  const after = value.slice(pos);
  const lastBreak = before.lastIndexOf("\n\n");
  const paraStart = lastBreak === -1 ? 0 : lastBreak + 2;
  const nextBreak = after.indexOf("\n\n");
  const paraEnd = nextBreak === -1 ? value.length : pos + nextBreak;
  const text = value.slice(paraStart, paraEnd).trim();
  return text ? { text, start: paraStart, end: paraEnd } : null;
}

async function requestAiEditHint() {
  if (aiHintState.inflight || !aiEditHintEnabled()) return;
  const para = currentEditorParagraph();
  if (!para || para.text.length < 8) return;
  const requestPath = state.currentPath;
  const requestContent = els.editor.value;
  const key = `${requestPath}:${para.start}:${para.text}`;
  // 同一段落 5 分钟内不重复提示。
  if (key === aiHintState.lastKey && Date.now() - aiHintState.lastShownAt < 300000) return;
  aiHintState.inflight = true;
  try {
    const result = await api.post("/api/ai/transform", { text: para.text, mode: "hint" });
    if (!result || !result.content) return;
    if (result.answerMode === "local-fallback") {
      if (result.warning) showToast(result.warning);
      return;
    }
    const activeParagraph = currentEditorParagraph();
    if (!aiEditHintEnabled()
      || state.currentPath !== requestPath
      || els.editor.value !== requestContent
      || activeParagraph?.start !== para.start) return;
    let hint = null;
    let suggestion = "";
    try {
      const cleaned = result.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const parsed = JSON.parse(cleaned);
      hint = parsed.hint || null;
      suggestion = parsed.suggestion || "";
    } catch (_) {
      hint = String(result.content).slice(0, 120);
      suggestion = String(result.content);
    }
    aiHintState.lastKey = key;
    aiHintState.lastShownAt = Date.now();
    showAiEditHintPopover({
      hint,
      suggestion,
      para: { ...para, path: requestPath, contentSnapshot: requestContent },
      warning: result.warning,
    });
  } catch (_) { /* AI 不可用时静默不弹 */ } finally {
    aiHintState.inflight = false;
  }
}

function showAiEditHintPopover({ hint, suggestion, para, warning }) {
  hideAiEditHintPopover();
  if (!hint) return;
  // 双向翻译：自动识别源语言方向，按钮文案显示"翻译为中文/英文"。
  function detectLanguageDirection(source) {
    const s = String(source || "");
    if (!s) return "zh2en";
    const cjkCount = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) || []).length;
    const letterCount = (s.match(/[A-Za-z]/g) || []).length;
    if (letterCount === 0 && cjkCount === 0) return "zh2en";
    const cjkRatio = cjkCount / Math.max(1, cjkCount + letterCount);
    return cjkRatio >= 0.3 ? "zh2en" : "en2zh";
  }
  const direction = detectLanguageDirection(para?.text || "");
  const translateLabel = direction === "zh2en" ? "翻译为英文" : "翻译为中文";
  const popover = document.createElement("div");
  popover.id = "aiEditHintPopover";
  popover.className = "ai-edit-hint-popover";
  popover.innerHTML = `<div class="ai-edit-hint-head"><strong>AI 编辑提示</strong><button type="button" class="ai-edit-hint-close" aria-label="关闭">×</button></div>
    <p class="ai-edit-hint-text">${escapeHtml(hint)}</p>
    <div class="ai-edit-hint-actions">
      <button type="button" data-hint-action="rewrite">采纳改写</button>
      <button type="button" data-hint-action="insert">插入注释</button>
      <button type="button" data-hint-action="translate">${translateLabel}</button>
    </div>`;
  document.body.appendChild(popover);
  const rect = els.editor.getBoundingClientRect();
  popover.style.top = `${Math.max(12, rect.top + 16)}px`;
  popover.style.right = `${Math.max(12, window.innerWidth - rect.right + 16)}px`;
  popover.querySelector(".ai-edit-hint-close").addEventListener("click", hideAiEditHintPopover);
  // WebView2/Chromium 可能在 pointerdown 阶段将焦点移到按钮，导致编辑器 blur。
  // 阻止按钮抢焦点，保留后续 click 事件，让编辑器回写稳定完成。
  popover.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-hint-action], .ai-edit-hint-close")) event.preventDefault();
  });
  popover.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-hint-action]");
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    const action = btn.dataset.hintAction;
    hideAiEditHintPopover();
    if (para.path && (state.currentPath !== para.path || els.editor.value !== para.contentSnapshot)) {
      showToast("文档已变化，请重新获取智能提示");
      return;
    }
    state.ai.selection = { source: "editor", text: para.text, start: para.start, end: para.end, path: para.path || state.currentPath };
    if (action === "rewrite") applyAiHintRewrite(suggestion, para);
    else if (action === "insert") insertAiHintComment(suggestion, para);
    else if (action === "translate") runAiTransform("translate");
  });
  if (warning) showToast(warning);
}

function resolveAiEditorRange(range) {
  const value = els.editor.value;
  const text = String(range?.text || "").trim();
  const clamp = (position) => Math.max(0, Math.min(value.length, Number(position) || 0));
  const start = clamp(range?.start);
  const end = Math.max(start, clamp(range?.end));

  if (!text || value.slice(start, end).trim() === text) return { start, end };

  let matchStart = -1;
  let nearestStart = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  while ((matchStart = value.indexOf(text, matchStart + 1)) !== -1) {
    const distance = Math.abs(matchStart - start);
    if (distance < nearestDistance) {
      nearestStart = matchStart;
      nearestDistance = distance;
    }
  }
  return nearestStart === -1 ? null : { start: nearestStart, end: nearestStart + text.length };
}

async function applyAiHintRewrite(suggestion, para) {
  const replacement = String(suggestion || "").trim();
  if (!replacement) return showToast("本次提示没有可采纳的改写内容");
  const range = resolveAiEditorRange(para);
  if (!range) return showToast("原段落已变化，请重新获取智能提示");
  if (replacement === els.editor.value.slice(range.start, range.end).trim()) {
    return showToast("AI 没有生成不同内容，请重新获取提示或检查模型配置");
  }
  if (!await replaceEditorRange(replacement, range.start, range.end, "end")) {
    return showToast("改写内容未能写入编辑器，请重试");
  }
  showToast("已采纳 AI 改写并实时保存");
}

async function insertAiHintComment(suggestion, para) {
  if (!suggestion) return;
  const comment = `\n> ${String(suggestion).split("\n").join("\n> ")}\n`;
  const range = resolveAiEditorRange(para);
  if (!range) return showToast("原段落已变化，请重新获取智能提示");
  if (!await replaceEditorRange(comment, range.end, range.end, "end")) {
    return showToast("注释未能写入编辑器，请重试");
  }
  showToast("已插入 AI 注释并实时保存");
}

function hideAiEditHintPopover() {
  document.getElementById("aiEditHintPopover")?.remove();
}

async function loadAgentPolicyStatus() {
  if (!els.agentPolicyStatus) return;
  try {
    const workspaceId = state.activeWorkspaceId || state.defaultWorkspaceId;
    const policy = await api.get(`/api/agent/policy?workspaceId=${encodeURIComponent(workspaceId)}`);
    els.agentPolicyStatus.textContent = policy.exists ? `规则已启用：${policy.writeMode}，最多 ${policy.maxFilesPerAction} 个文件/次` : "当前工作区尚未创建规则文件，将使用内置安全规则";
    els.createAgentPolicyBtn.textContent = policy.exists ? "规则已存在" : "创建规则文件";
    els.createAgentPolicyBtn.disabled = policy.exists;
  } catch (error) { els.agentPolicyStatus.textContent = error.message || "无法读取规则状态"; }
}

async function openFrontmatterPreview() {
  if (!state.currentPath) return showToast("请先打开一篇文档");
  try {
    const result = await api.post("/api/frontmatter/preview", { path: state.currentPath });
    state.ai.preview = result;
    els.frontmatterBefore.textContent = result.before;
    els.frontmatterAfter.textContent = result.after;
    els.applyFrontmatterBtn.disabled = !result.changed;
    els.frontmatterModal.classList.remove("hidden");
  } catch (error) { showToast(error.message || "无法生成预览"); }
}

async function applyFrontmatterPreview() {
  const preview = state.ai.preview;
  if (!preview || !preview.changed) return;
  els.applyFrontmatterBtn.disabled = true;
  try {
    await api.post("/api/frontmatter/apply", { path: preview.path, baseHash: preview.baseHash, confirmed: true });
    els.frontmatterModal.classList.add("hidden");
    await openDoc(preview.path);
    showToast("Frontmatter 已标准化，原文已备份");
  } catch (error) { showToast(error.message || "应用失败"); }
  finally { els.applyFrontmatterBtn.disabled = false; }
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
  // 目录折叠/展开改变 workspace 宽度，需重算编辑器分栏列宽，避免留白或未均分。
  requestAnimationFrame(() => {
    if (typeof applyEditorSplitterLayout === "function") applyEditorSplitterLayout();
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

function syncPreviewToEditor(preferCursor = true) {
  if (state.mode !== "edit") return;
  cancelAnimationFrame(state.syncPreviewScroll.frame);
  state.syncPreviewScroll.frame = requestAnimationFrame(() => {
    const previewMax = Math.max(0, els.preview.scrollHeight - els.preview.clientHeight);
    if (!previewMax) {
      els.preview.scrollTop = 0;
      return;
    }
    // CodeMirror 内容区带有底部留白（用于舒适编辑），不能直接用
    // scrollHeight 比例映射，否则编辑到中后段时预览会明显错位。
    const editorDom = els.editor.host || document.querySelector("#editor");
    const firstLine = editorDom?.querySelector(".cm-line");
    const lineHeight = Number.parseFloat(firstLine ? getComputedStyle(firstLine).lineHeight : "") || 27;
    const topPadding = Number.parseFloat(getComputedStyle(editorDom?.querySelector(".cm-content") || editorDom).paddingTop) || 26;
    const totalLines = Math.max(1, String(state.currentContent || els.editor.value || "").split(/\r?\n/).length);
    const visibleLines = Math.max(1, Math.floor(els.editor.clientHeight / lineHeight));
    const editorValue = String(state.currentContent || els.editor.value || "");
    const cursor = Number(els.editor.selectionEnd ?? 0);
    const cursorLine = editorValue.slice(0, Math.max(0, cursor)).split("\n").length - 1;
    const scrollLine = Math.floor(Math.max(0, els.editor.scrollTop - topPadding) / lineHeight);
    const currentLine = clamp(preferCursor && els.editor.hasFocus ? cursorLine : scrollLine, 0, Math.max(0, totalLines - 1));
    const anchors = state.previewAnchors || [];
    if (anchors.length >= 2) {
      let previous = anchors[0];
      let next = anchors[anchors.length - 1];
      for (let index = 1; index < anchors.length; index += 1) {
        if (anchors[index].line >= currentLine) {
          next = anchors[index];
          previous = anchors[index - 1];
          break;
        }
        previous = anchors[index];
      }
      const previousTop = previous.element.offsetTop;
      const nextTop = next.element.offsetTop;
      const span = Math.max(1, next.line - previous.line);
      const localRatio = clamp((currentLine - previous.line) / span, 0, 1);
      const anchoredTop = previousTop + (nextTop - previousTop) * localRatio;
      els.preview.scrollTop = Math.round(clamp(anchoredTop - els.preview.clientHeight * 0.12, 0, previewMax));
      state.syncPreviewScroll.ratio = clamp(els.preview.scrollTop / previewMax, 0, 1);
      return;
    }
    const ratio = clamp(currentLine / Math.max(1, totalLines - visibleLines), 0, 1);
    state.syncPreviewScroll.ratio = ratio;
    els.preview.scrollTop = Math.round(previewMax * ratio);
  });
}

function syncPreviewSourceAnchors(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const explicit = [...els.preview.querySelectorAll("[data-source-line]")]
    .map((element) => ({ element, line: Number(element.dataset.sourceLine) }))
    .filter((anchor) => Number.isFinite(anchor.line) && anchor.line >= 0)
    .sort((a, b) => a.line - b.line);
  if (explicit.length) {
    state.previewAnchors = explicit;
    return;
  }
  const normalize = (value) => String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[\s`*_~#>|{}()[\]]+/g, "")
    .toLowerCase();
  let cursor = 0;
  const anchors = [];
  [...els.preview.children].forEach((element) => {
    const text = normalize(element.textContent).slice(0, 180);
    if (!text) return;
    let found = -1;
    for (let index = cursor; index < lines.length; index += 1) {
      const line = normalize(lines[index]);
      if (line && (line.includes(text.slice(0, Math.min(80, text.length))) || text.includes(line.slice(0, Math.min(80, line.length))))) {
        found = index;
        break;
      }
    }
    if (found >= 0) {
      element.dataset.sourceLine = String(found);
      anchors.push({ element, line: found });
      cursor = found + 1;
    }
  });
  state.previewAnchors = anchors.sort((a, b) => a.line - b.line);
}

function attachImageDeleteButtons(root = els.preview) {
  if (!root) return;
  const images = root.querySelectorAll("img");
  images.forEach((img) => {
    if (img.dataset.deleteAttached) return;
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:") || (!src.includes("source/") && !src.includes("ws-asset/"))) return;
    img.dataset.deleteAttached = "1";
    const parent = img.parentElement;
    if (!parent) return;
    parent.classList.add("image-delete-wrapper");
    if (parent.querySelector(".image-delete-btn")) return;
    const btn = document.createElement("button");
    btn.className = "image-delete-btn";
    btn.type = "button";
    btn.title = "删除该图片（同时清理磁盘文件）";
    btn.setAttribute("aria-label", "删除图片");
    btn.textContent = "×";
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await deleteImageFromDoc(src);
    });
    parent.appendChild(btn);
  });
  // 视频删除按钮
  const videos = root.querySelectorAll("video.auto-size-video");
  videos.forEach((video) => {
    if (video.dataset.deleteAttached) return;
    const src = video.getAttribute("src") || "";
    if (!src || (!src.includes("source/") && !src.includes("ws-asset/"))) return;
    video.dataset.deleteAttached = "1";
    const parent = video.parentElement;
    if (!parent) return;
    parent.classList.add("video-delete-wrapper");
    if (parent.querySelector(".video-delete-btn")) return;
    const btn = document.createElement("button");
    btn.className = "video-delete-btn";
    btn.type = "button";
    btn.title = "删除该视频（同时清理磁盘文件）";
    btn.setAttribute("aria-label", "删除视频");
    btn.textContent = "×";
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await deleteVideoFromDoc(src);
    });
    parent.appendChild(btn);
  });
}

async function deleteImageFromDoc(imageSrc) {
  if (!imageSrc) return;
  const confirmed = await customConfirm("确定删除该图片吗？\n\n将同时执行：\n1. 移除文档中的图片引用\n2. 删除磁盘上的图片文件以释放空间", { title: "删除图片", danger: true });
  if (!confirmed) return;
  const content = els.editor.value;
  const escapedSrc = imageSrc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\s*!\\[[^\\]]*\\]\\(${escapedSrc}\\)\\s*\\n?`, "g");
  const newContent = content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
  if (newContent !== content) {
    els.editor.value = newContent;
    state.currentContent = newContent;
    recordUndo(newContent);
    setSaveStatus("\u672a\u4fdd\u5b58", true);
    schedulePreviewUpdate({ immediate: true, forceContent: newContent });
    scheduleAutoSave();
  }
  try {
    await api.post("/api/asset/delete", { path: imageSrc });
    showToast("图片已删除，磁盘文件已清理");
  } catch (error) {
    console.error(error);
    showToast("图片引用已移除，磁盘文件清理失败");
  }
}

async function deleteVideoFromDoc(videoSrc) {
  if (!videoSrc) return;
  const confirmed = await customConfirm("确定删除该视频吗？\n\n将同时执行：\n1. 移除文档中的视频引用\n2. 删除磁盘上的视频文件以释放空间", { title: "删除视频", danger: true });
  if (!confirmed) return;
  const content = els.editor.value;
  const escapedSrc = videoSrc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\s*!\\[[^\\]]*\\]\\(${escapedSrc}\\)\\s*\\n?`, "g");
  const newContent = content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
  if (newContent !== content) {
    els.editor.value = newContent;
    state.currentContent = newContent;
    recordUndo(newContent);
    setSaveStatus("\u672a\u4fdd\u5b58", true);
    schedulePreviewUpdate({ immediate: true, forceContent: newContent });
    scheduleAutoSave();
  }
  try {
    await api.post("/api/asset/delete", { path: videoSrc });
    showToast("视频已删除，磁盘文件已清理");
  } catch (error) {
    console.error(error);
    showToast("视频引用已移除，磁盘文件清理失败");
  }
}

function renderCurrentPreview() {
  return renderCurrentPreviewAsync();
}

// 数学公式渲染：动态加载 KaTeX 并渲染 .math-block / .math-inline
let _katexLoadingPromise = null;
function loadKatexAsync() {
  if (window.katex) return Promise.resolve(window.katex);
  if (_katexLoadingPromise) return _katexLoadingPromise;
  _katexLoadingPromise = new Promise((resolve, reject) => {
    // 先加载 CSS
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css";
    document.head.appendChild(link);
    // 再加载 JS
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js";
    script.onload = () => resolve(window.katex);
    script.onerror = () => {
      _katexLoadingPromise = null;
      reject(new Error("KaTeX 库加载失败（可能无外网连接）"));
    };
    script.async = true;
    document.head.appendChild(script);
  });
  return _katexLoadingPromise;
}

let _mathRenderSeq = 0;
async function renderMathInPreview(container) {
  if (!container) return;
  const mathElements = container.querySelectorAll(".math-block[data-math], .math-inline[data-math]");
  if (!mathElements.length) return;
  const seq = ++_mathRenderSeq;
  try {
    const katex = await loadKatexAsync();
    if (!katex) throw new Error("KaTeX 库不可用");
    if (seq !== _mathRenderSeq) return;
    mathElements.forEach((el) => {
      const math = el.getAttribute("data-math") || "";
      const isBlock = el.classList.contains("math-block");
      try {
        katex.render(math, el, {
          throwOnError: false,
          displayMode: isBlock,
          errorColor: "#ef4444",
        });
      } catch (err) {
        el.textContent = math;
        el.style.color = "#ef4444";
      }
    });
  } catch (err) {
    // KaTeX 加载失败，降级显示原始 LaTeX 源码
    mathElements.forEach((el) => {
      const math = el.getAttribute("data-math") || "";
      el.textContent = math;
      el.style.fontFamily = "monospace";
      el.style.color = "#94a3b8";
    });
  }
}

// 需求12：Mermaid / Excalidraw 图表渲染
let _mermaidRenderSeq = 0;
let _mermaidInitialized = false;
let _mermaidLoadingPromise = null;
function loadMermaidAsync() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (_mermaidLoadingPromise) return _mermaidLoadingPromise;
  _mermaidLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js";
    script.onload = () => resolve(window.mermaid);
    script.onerror = () => {
      _mermaidLoadingPromise = null;
      reject(new Error("Mermaid 库加载失败（可能无外网连接）"));
    };
    script.async = true;
    document.head.appendChild(script);
  });
  return _mermaidLoadingPromise;
}
async function renderChartsInPreview(container) {
  if (!container) return;
  // Mermaid 渲染
  const mermaidBlocks = container.querySelectorAll(".chart-block.mermaid-block");
  if (mermaidBlocks.length) {
    // 先显示加载占位
    mermaidBlocks.forEach((block) => {
      const containerDiv = block.querySelector(".mermaid-container");
      if (containerDiv && !containerDiv.innerHTML) {
        containerDiv.innerHTML = `<div class="chart-placeholder">正在加载 Mermaid 图表库…</div>`;
      }
    });
    try {
      const mermaid = await loadMermaidAsync();
      if (!mermaid) throw new Error("Mermaid 库不可用");
      if (!_mermaidInitialized) {
        mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });
        _mermaidInitialized = true;
      }
      const seq = ++_mermaidRenderSeq;
      for (let i = 0; i < mermaidBlocks.length; i++) {
        const block = mermaidBlocks[i];
        const sourcePre = block.querySelector(".mermaid-source");
        const containerDiv = block.querySelector(".mermaid-container");
        if (!sourcePre || !containerDiv) continue;
        const rawDef = sourcePre.textContent || "";
        const id = `mermaid-svg-${Date.now()}-${i}-${seq}`;
        try {
          const { svg } = await mermaid.render(id, rawDef);
          if (seq === _mermaidRenderSeq) {
            containerDiv.innerHTML = svg;
          }
        } catch (err) {
          if (seq === _mermaidRenderSeq) {
            containerDiv.innerHTML = `<div class="chart-error">Mermaid 渲染失败: ${escapeHtml(err?.message || String(err))}</div>`;
          }
        }
      }
    } catch (outerErr) {
      // Mermaid 库加载失败，降级显示源码 + 错误提示
      mermaidBlocks.forEach((block) => {
        const containerDiv = block.querySelector(".mermaid-container");
        if (containerDiv) {
          containerDiv.innerHTML = `<div class="chart-error">Mermaid 库加载失败（需外网连接 CDN）。图表源码仍可在编辑模式查看。</div>`;
        }
      });
    }
  }
  // Excalidraw 渲染
  const excalidrawBlocks = container.querySelectorAll(".chart-block.excalidraw-block");
  if (excalidrawBlocks.length) {
    excalidrawBlocks.forEach((block) => {
      const sourcePre = block.querySelector(".excalidraw-source");
      const containerDiv = block.querySelector(".excalidraw-container");
      if (!sourcePre || !containerDiv) return;
      const rawText = sourcePre.textContent || "";
      try {
        const data = JSON.parse(rawText);
        containerDiv.innerHTML = `<div class="excalidraw-preview" data-excalidraw='${escapeHtml(rawText)}'><pre class="excalidraw-json" contenteditable="false">${escapeHtml(rawText)}</pre><p class="excalidraw-hint">Excalidraw 绘图（JSON 数据，双击可编辑源码）</p></div>`;
      } catch (_) {
        containerDiv.innerHTML = `<div class="chart-error">Excalidraw 数据格式错误</div>`;
      }
    });
  }
}

// 降低全量替换 innerHTML 造成的视觉抖动：先微降不透明度，rAF 写回内容后恢复，
// 用淡入掩盖 DOM 重建瞬间，避免心流编辑被打断。
// 保留滚动位置：innerHTML 重建会重置 scrollTop，导致表格操作等增量编辑后预览跳至文档尾部。
let _previewSwapScheduled = false;
function swapPreviewHtml(html) {
  const preview = els.preview;
  if (!preview) return;
  const savedScroll = preview.scrollTop;
  preview.style.opacity = "0.75";
  let finalHtml = html;
  try { if (typeof applySpellCheckHighlight === "function") finalHtml = applySpellCheckHighlight(html, state.currentContent); } catch (_) {}
  preview.innerHTML = finalHtml;
  preview.scrollTop = savedScroll;
  renderChartsInPreview(preview);
  renderMathInPreview(preview);
  if (_previewSwapScheduled) return;
  _previewSwapScheduled = true;
  requestAnimationFrame(() => {
    _previewSwapScheduled = false;
    if (els.preview) els.preview.style.opacity = "";
  });
}

function renderCurrentPreviewNow(content = state.currentContent) {
  if (!state.previewVisible || state.mode !== "edit") return;
  const nextContent = String(content || els.editor.value || state.currentContent || "");
  swapPreviewHtml(cachedRenderMarkdown(nextContent, { editTools: true }));
  syncPreviewSourceAnchors(nextContent);
  attachImageDeleteButtons();
  els.preview.classList.remove("preview-pending");
  state.previewLastContent = nextContent;
  syncPreviewToEditor();
}

async function renderCurrentPreviewAsync(content = state.currentContent, seq = ++state.previewRenderSeq) {
  if (!state.previewVisible || state.mode !== "edit") return;
  content = String(content || els.editor.value || state.currentContent || "");
  if (state.previewLastContent === content) {
    els.preview.classList.remove("preview-pending");
    syncPreviewToEditor();
    return;
  }
  try {
    const html = cachedRenderMarkdown(content, { editTools: true });
    if (seq !== state.previewRenderSeq || content !== state.currentContent) return;
    swapPreviewHtml(html);
    syncPreviewSourceAnchors(content);
    attachImageDeleteButtons();
  } catch (error) {
    console.error(error);
    if (seq !== state.previewRenderSeq || content !== state.currentContent) return;
    swapPreviewHtml(cachedRenderMarkdown(content, { editTools: true }));
    syncPreviewSourceAnchors(content);
    attachImageDeleteButtons();
  }
  els.preview.classList.remove("preview-pending");
  state.previewLastContent = content;
  syncPreviewToEditor();
}

let previewRafScheduled = false;
function queuePreviewRender(content, seq) {
  state.previewPending = { content, seq };
  if (previewRafScheduled) return;
  previewRafScheduled = true;
  requestAnimationFrame(() => {
    previewRafScheduled = false;
    const pending = state.previewPending;
    state.previewPending = null;
    if (!pending) return;
    renderCurrentPreviewAsync(pending.content, pending.seq);
  });
}

function schedulePreviewUpdate({ immediate = false, forceContent = state.currentContent } = {}) {
  clearTimeout(state.previewTimer);
  if (!state.previewVisible || state.mode !== "edit") return;
  const content = String(forceContent || els.editor.value || state.currentContent || "");
  const length = content.length;
  const wait = immediate ? 0 : state.largeDocument ? LARGE_PREVIEW_DELAY : length > 500000 ? 420 : length > 100000 ? 240 : 120;
  const nextSeq = ++state.previewRenderSeq;
  els.preview.classList.toggle("preview-pending", state.previewLastContent !== content);
  if (wait === 0) {
    queuePreviewRender(content, nextSeq);
  } else {
    state.previewTimer = setTimeout(() => {
      queuePreviewRender(content, nextSeq);
    }, wait);
  }
  scheduleEditorOutlineUpdate(content);
}

function setPreviewVisible(visible, { automatic = false } = {}) {
  // 非 Markdown 文档不支持预览，避免按 Markdown 语法解析引起卡顿或错位
  if (visible && state.currentPath && !state.currentIsMarkdown) {
    visible = false;
    state.previewAutoHidden = true;
  }
  state.previewVisible = Boolean(visible);
  if (!automatic) state.previewAutoHidden = false;
  else state.previewAutoHidden = !state.previewVisible;
  // 切换预览栏会重排 grid 列宽，记录编辑器视口并在布局稳定后恢复，避免编辑位置跳动。
  const keepViewport = state.mode === "edit" && !state.editorHidden;
  const savedScroll = keepViewport ? els.editor.scrollTop : null;
  const savedSel = keepViewport ? [els.editor.selectionStart, els.editor.selectionEnd] : null;
  els.editorBody.classList.toggle("preview-hidden", !state.previewVisible);
  els.editorPanel.classList.toggle("preview-hidden", !state.previewVisible);
  els.previewToggleBtn.textContent = state.previewVisible
    ? "\u9690\u85cf\u9884\u89c8"
    : state.largeDocument ? "\u663e\u793a\u9884\u89c8\uff08\u5927\u6587\u6863\uff09" : (!state.currentIsMarkdown ? "\u9884\u89c8\u4e0d\u53ef\u7528" : "\u663e\u793a\u9884\u89c8");
  els.previewToggleBtn.setAttribute("aria-pressed", String(state.previewVisible));
  els.previewToggleBtn.disabled = !state.currentIsMarkdown && !!state.currentPath;
  if (state.previewVisible) {
    if (state.largeDocument) schedulePreviewUpdate();
    else requestAnimationFrame(() => schedulePreviewUpdate({ immediate: true }));
  } else {
    clearTimeout(state.previewTimer);
    els.preview.classList.remove("preview-pending");
  }
  // 切换预览可见性后重算 grid 列宽，避免编辑栏未占满或右侧留白。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (typeof applyEditorSplitterLayout === "function") applyEditorSplitterLayout();
      if (keepViewport) {
        try { if (savedScroll !== null) els.editor.scrollTop = savedScroll; } catch (_) {}
        if (savedSel) { try { els.editor.setSelectionRange(savedSel[0], savedSel[1]); } catch (_) {} }
        els.editor.view?.requestMeasure?.();
      }
    });
  });
}

function setEditorVisible(visible) {
  // ▸ 两个方向（显示/隐藏）切换前都按「比例」保存预览栏 & 大纲栏的滚动位置。
  //   比例 0..1 与容器宽度/高度无直接关联，切换 editor-hidden 导致 scrollHeight
  //   变化时仍然能映射到正确的相对位置，不会出现"向上偏移"抖动。
  const previewRatio = (() => {
    if (!state.previewVisible || !els.preview) return null;
    const max = Math.max(0, els.preview.scrollHeight - els.preview.clientHeight);
    return max <= 0 ? 0 : clamp(els.preview.scrollTop / max, 0, 1);
  })();
  const outlineRatio = (() => {
    if (!els.editorOutline) return null;
    const max = Math.max(0, els.editorOutline.scrollHeight - els.editorOutline.clientHeight);
    return max <= 0 ? 0 : clamp(els.editorOutline.scrollTop / max, 0, 1);
  })();

  state.editorHidden = !visible;
  els.editorPanel.classList.toggle("editor-hidden", state.editorHidden);
  els.editorHideBtn.textContent = state.editorHidden ? "显示编辑器" : "隐藏编辑器";
  els.editorHideBtn.setAttribute("aria-pressed", String(state.editorHidden));

  // ▸ 不区分方向：显示/隐藏 两种切换都会改变布局宽度，都需要等布局稳定后恢复。
  //   三帧 requestAnimationFrame：保证 CSS 过渡（若有）+ 浏览器 reflow/relayout 完全完成，
  //   避免"看起来稳定了但 scrollHeight 还在变化"导致恢复值不准。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (typeof applyEditorSplitterLayout === "function") applyEditorSplitterLayout();
        if (els.editor?.view?.requestMeasure) els.editor.view.requestMeasure();
        try {
          if (state.previewVisible && previewRatio != null && els.preview) {
            const max = Math.max(0, els.preview.scrollHeight - els.preview.clientHeight);
            els.preview.scrollTop = Math.round(max * previewRatio);
            state.syncPreviewScroll.ratio = max > 0 ? clamp(els.preview.scrollTop / max, 0, 1) : 0;
          }
          if (outlineRatio != null && els.editorOutline) {
            const max = Math.max(0, els.editorOutline.scrollHeight - els.editorOutline.clientHeight);
            els.editorOutline.scrollTop = Math.round(max * outlineRatio);
          }
        } catch (_) {}
      });
    });
  });
}

// 低 GPU 模式：移除所有 backdrop-filter 和大范围 box-shadow，节省 GPU 合成层
function setLowGpuMode(enabled) {
  state.lowGpuMode = Boolean(enabled);
  document.body.classList.toggle("low-gpu-mode", state.lowGpuMode);
  if (els.lowGpuToggle) els.lowGpuToggle.checked = state.lowGpuMode;
  try {
    localStorage.setItem("lowGpuMode", String(state.lowGpuMode));
  } catch (_) {}
  // 强制重排以应用新样式
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (state.mode === "view" && state.currentContent) {
        void renderReaderContent(state.currentContent);
      }
    });
  });
}

function setImmersiveEditing(enabled) {
  if (enabled && !state.currentPath) return showToast("请先打开一篇文档");
  const wasImmersive = state.immersive;
  state.immersive = Boolean(enabled);
  state.lightweight = state.immersive;
  els.appShell.classList.toggle("immersive", state.immersive);
  document.body.classList.toggle("immersive-editing", state.immersive);
  document.body.classList.toggle("lightweight-editor", state.lightweight);
  els.focusModeBtn.textContent = state.immersive ? "退出沉浸 (轻量)" : "⚡ 沉浸";
  els.focusModeBtn.setAttribute("aria-pressed", String(state.immersive));
  if (state.immersive) {
    if (!wasImmersive) {
      state.previewBeforeImmersive = state.previewVisible;
      state.outlineBeforeImmersive = state.editorOutlineVisible;
    }
    if (state.mode !== "edit") setMode("edit");
    setEditorOutlineVisible(false, { persist: false });
    setPreviewVisible(false);
    // 轻量模式：终止 Markdown Worker，清除待渲染队列，释放内存
    if (state.markdownWorker) {
      state.markdownWorkerPending.forEach((p) => p.reject(new Error("轻量模式终止")));
      state.markdownWorkerPending.clear();
      state.markdownWorker.terminate();
      state.markdownWorker = null;
      state.markdownWorkerFailed = false;
      state.markdownWorkerFailedUntil = 0;
    }
    if (state.previewTimer) {
      clearTimeout(state.previewTimer);
      state.previewTimer = 0;
    }
    requestAnimationFrame(() => els.editor.focus());
  } else if (wasImmersive) {
    // 退出沉浸：恢复完整功能
    setEditorOutlineVisible(true);
    setPreviewVisible(true);
    // 重建 Markdown Worker 并刷新预览
    if (state.currentPath && state.currentIsMarkdown) {
      ensureMarkdownWorker();
      requestAnimationFrame(() => schedulePreviewUpdate({ immediate: true }));
    }
    requestAnimationFrame(() => els.editor.focus());
  }
}

async function saveCurrentDoc({ refreshTree = false, keepEditorState = true, renderAfterSave = true } = {}) {
  if (!state.currentPath) return false;
  const content = els.editor.value;
  if (!refreshTree && content === state.lastSavedContent) return true;
  
  const selectionStart = keepEditorState ? els.editor.selectionStart : 0;
  const selectionEnd = keepEditorState ? els.editor.selectionEnd : 0;
  const scrollTop = keepEditorState ? els.editor.scrollTop : 0;
  
  const seq = ++state.saveSeq;
  setSaveStatus("\u4fdd\u5b58\u4e2d", true);
  try {
    const result = await api.post("/api/save", { path: state.currentPath, content, baseHash: state.currentVersion || "" });
    // currentVersion 更新必须在 seq 检查之后：连续保存时旧请求晚返回会用旧 hash 覆盖新 hash，
    // 导致后续保存的 baseHash 不对，可能引发冲突或覆盖他人修改。
    if (seq !== state.saveSeq) return true;
    // 服务端应返回 contentSha256 用于乐观锁；缺失时视为保存成功但跳过版本号更新，
    // 兼容旧服务端（仅返回 {ok, path}），同时记录警告便于排查
    if (!result || typeof result.contentSha256 !== "string" || !result.contentSha256) {
      console.warn("[文档异常] stage=保存-返回校验 服务端未返回 contentSha256，跳过版本号更新");
      // 保存成功但无 hash：不更新 currentVersion，下次保存 baseHash 为空字符串，
      // 仅乐观锁检查可能失效，不影响基本保存功能
    } else {
      state.currentVersion = result.contentSha256;
    }
  } catch (e) {
    const errorMessage = e?.response?.data?.error || e?.message || "保存失败";
    setSaveStatus("保存失败", false);
    showToast(errorMessage);
    return false;
  }
  const editorUnchanged = els.editor.value === content;
  const latestContent = els.editor.value;
  state.currentContent = editorUnchanged ? content : latestContent;
  updateLargeDocumentState(state.currentContent);
  state.lastSavedContent = content;
  clearDraft(state.currentPath);
  if (renderAfterSave && editorUnchanged && state.mode === "view") {
    await renderReaderContent(content);
  } else if (renderAfterSave && editorUnchanged && state.previewVisible) {
    schedulePreviewUpdate({ immediate: true, forceContent: content });
  } else if (editorUnchanged) {
    state.previewLastContent = "";
  }
  state.graphReady = false;
  setSaveStatus(refreshTree ? "\u5df2\u4fdd\u5b58" : "\u5df2\u81ea\u52a8\u4fdd\u5b58", false);
  if (refreshTree) {
    const path = state.currentPath;
    await bootstrap(true);
    // Refresh the tree metadata without reopening the document. Reopening
    // rebuilt the editor content and caused caret/scroll jumps after Ctrl+S.
    if (state.currentPath === path) syncTreeSelectionState();
  }
  
  if (keepEditorState && editorUnchanged) {
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

function clearAutoSaveTimers() {
  clearTimeout(state.autoSave.idleTimer);
  clearTimeout(state.autoSave.maxTimer);
  if (state.autoSave.idleCallback && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(state.autoSave.idleCallback);
  }
  state.autoSave.idleTimer = 0;
  state.autoSave.maxTimer = 0;
  state.autoSave.idleCallback = 0;
}

function getAutoSaveDelays(content = els.editor.value || "") {
  const length = String(content || "").length;
  if (length > 500000) return { idle: 6500, max: 26000 };
  if (length > 120000) return { idle: 4800, max: 22000 };
  if (length > 40000) return { idle: 3600, max: 18000 };
  return { idle: 2600, max: 14000 };
}

function requestAutoSaveRun(timeout = 3000) {
  if (typeof requestIdleCallback === "function") {
    state.autoSave.idleCallback = requestIdleCallback(() => {
      state.autoSave.idleCallback = 0;
      void runAutoSave();
    }, { timeout });
    return;
  }
  void runAutoSave();
}

async function runAutoSave() {
  clearAutoSaveTimers();
  if (state.autoSave.composing || state.mode !== "edit" || !state.currentPath) return;
  if (state.autoSave.inFlight) {
    state.autoSave.pending = true;
    return;
  }
  if (els.editor.value === state.lastSavedContent) return;
  // 安全检查：如果编辑器内容包含的 frontmatter title/头部文本 与当前文档路径明显不匹配
  // （例如当前路径=湖南移动MC.md，但编辑器frontmatter title=青海移动MR622-CK），跳过保存。
  // 仅当编辑器内容与state.currentContent/草稿的SHA一致或用户确认手动编辑过才保存。
  const _safeEditorVal = String(els.editor.value || "");
  const _safeCurrent = String(state.currentContent || state.lastSavedContent || "");
  if (_safeCurrent && _safeCurrent.length > 16 && _safeEditorVal.length > 16) {
    const _shortCurr = _safeCurrent.slice(0, 64);
    const _shortEdit = _safeEditorVal.slice(0, 64);
    if (_shortCurr !== _shortEdit && els.editor.value.length === state.lastSavedContent.length) {
      // 长度相同但前64字节不同 — 很可能是编辑器错位未同步，拒绝保存
      console.warn("[runAutoSave] skipped: editor head mismatch vs currentContent (likely unsynced editor). state.currentPath=", state.currentPath);
      return;
    }
  }
  state.autoSave.inFlight = true;
  try {
    await saveCurrentDoc({ keepEditorState: false, renderAfterSave: false });
  } catch (error) {
    setSaveStatus("\u4fdd\u5b58\u5931\u8d25", true);
    console.error(error);
  } finally {
    state.autoSave.inFlight = false;
    if (state.autoSave.pending || els.editor.value !== state.lastSavedContent) {
      state.autoSave.pending = false;
      scheduleAutoSave();
    }
  }
}

function scheduleAutoSave() {
  clearTimeout(state.autoSave.idleTimer);
  if (state.autoSave.idleCallback && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(state.autoSave.idleCallback);
    state.autoSave.idleCallback = 0;
  }
  const { idle, max } = getAutoSaveDelays(els.editor.value);
  state.autoSave.idleTimer = setTimeout(() => requestAutoSaveRun(2800), idle);
  if (!state.autoSave.maxTimer) state.autoSave.maxTimer = setTimeout(() => requestAutoSaveRun(1200), max);
}

// 文档数据安全异常统一处理：记录上下文 + 提示用户，禁止静默吞掉
function logDocError(stage, error, docPath) {
  const path = docPath || state.currentPath || "(unknown)";
  const msg = error?.message || String(error);
  console.error(`[文档异常] stage=${stage} path=${path}`, error);
  showToast(`文档处理异常（${stage}）：${msg}`);
}

// 草稿保存：将未保存的编辑内容暂存到 localStorage，防止意外关闭丢失
let draftSaveTimer = 0;
function saveDraft() {
  if (!state.currentPath || state.mode !== "edit") return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    try {
      const content = els.editor.value;
      if (content !== state.lastSavedContent) {
        localStorage.setItem("draft:" + state.currentPath, content);
      } else {
        localStorage.removeItem("draft:" + state.currentPath);
      }
    } catch (e) {
      // 草稿保存失败（如 localStorage 满）：必须提示用户，否则编辑内容可能在崩溃时丢失
      logDocError("草稿保存", e);
    }
  }, 800);
}

// 同步保存草稿（无防抖）：用于切换文档前立即持久化旧文档编辑，
// 避免 800ms 防抖窗口内切换导致旧文档未保存内容丢失。
function saveDraftNow() {
  clearTimeout(draftSaveTimer);
  if (!state.currentPath || state.mode !== "edit") return;
  try {
    const content = els.editor.value;
    if (content !== state.lastSavedContent) {
      localStorage.setItem("draft:" + state.currentPath, content);
    } else {
      localStorage.removeItem("draft:" + state.currentPath);
    }
  } catch (e) {
    logDocError("切换前草稿保存", e);
  }
}

function restoreDraft(docPath) {
  try {
    const draft = localStorage.getItem("draft:" + docPath);
    if (draft != null) return draft;
  } catch (e) {
    // 草稿读取失败：不阻断打开流程，但必须提示用户草稿可能存在但无法恢复
    logDocError("草稿恢复", e, docPath);
  }
  return null;
}

function clearDraft(docPath) {
  try { localStorage.removeItem("draft:" + docPath); }
  catch (e) { logDocError("草稿清理", e, docPath); }
}

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
  const fragment = document.createDocumentFragment();
  if (results.length) {
    const fileByPath = new Map(state.flatFiles.map((entry) => [entry.path, entry]));
    const visible = results.slice(0, 80);
    for (const item of visible) {
      const file = fileByPath.get(item.path) || item;
      const button = document.createElement("button");
      button.className = "search-item";
      button.dataset.path = item.path;
      button.dataset.query = query;
      const title = document.createElement("strong");
      title.textContent = displayName(file);
      const snippet = document.createElement("span");
      snippet.textContent = item.snippet || displayRelativePath(item.path);
      button.append(title, snippet);
      fragment.appendChild(button);
    }
    if (results.length > visible.length) {
      const more = document.createElement("div");
      more.className = "search-item search-more";
      const title = document.createElement("strong");
      title.textContent = `已显示 ${visible.length} 条`;
      const detail = document.createElement("span");
      detail.textContent = `还有 ${results.length - visible.length} 条结果，继续输入可缩小范围`;
      more.append(title, detail);
      fragment.appendChild(more);
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "search-item";
    const title = document.createElement("strong");
    title.textContent = text.emptyResult;
    const detail = document.createElement("span");
    detail.textContent = text.retryKeyword;
    empty.append(title, detail);
    fragment.appendChild(empty);
  }
  els.searchResults.replaceChildren(fragment);
}

function currentParent() {
  if (state.selectedFolder) return state.selectedFolder;
  if (!state.currentPath || !state.currentPath.includes("/")) return "";
  const parts = state.currentPath.split("/");
  return parts.slice(0, -1).join("/");
}

function openCreateModal(mode) {
  state.createMode = mode;
  state.createSubmitting = false;
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

  // 防止重复提交
  if (state.createSubmitting) return;
  state.createSubmitting = true;

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
    const isFolder = state.createMode === "folder";
    const endpoint = isFolder ? "/api/create-folder" : "/api/create-doc";
    const created = await api.post(endpoint, { parent, name });
    await bootstrap(true);
    // 立即关闭新建弹窗，避免 openDoc/setMode 耗时或抛错导致弹窗残留
    closeCreateModal();
    if (!isFolder && created.path) {
      await openDoc(created.path);
      if (state.mode !== "edit") setMode("edit");
      requestAnimationFrame(() => {
        els.editor.focus?.();
        try {
          const len = els.editor.value?.length || 0;
          els.editor.setSelectionRange?.(len, len);
        } catch (_) {}
      });
      showToast("新建文档成功，已进入编辑模式");
      return;
    }
    if (isFolder && created.path) {
      state.selectedFolder = created.path;
      state.folderExplicit = true;
      state.expandedFolders.add(created.path);
      renderTree(state.tree);
      showToast("新建文件夹成功");
      return;
    }
  } catch (error) {
    // 出错时也确保弹窗关闭，避免卡死
    closeCreateModal();
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
  } finally {
    state.createSubmitting = false;
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
    // 调用删除API后统一清理：从 recentDocs 移除被删文档，刷新顶部栏+编辑栏+最近打开，
    // 若当前编辑文档被删则自动跳到最近下一篇或展示备用预览页。
    await handleDocsClosed(paths);
    await bootstrap(true);
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

function deleteTreeItem(path) {
  if (!path) return;
  state.deleteTarget = path;
  els.deleteTarget.textContent = path;
  els.deleteModal.classList.remove("hidden");
}

async function renameCurrentDoc() {
  if (!state.currentPath) return showToast("请先打开一篇文档");
  // 重命名前先保存未提交的编辑，避免重命名后丢失草稿内容
  if (state.mode === "edit" && els.editor.value !== state.lastSavedContent) {
    const saved = await saveCurrentDoc({ keepEditorState: true, renderAfterSave: false });
    if (!saved) return;
  }
  await renameTreeItem(state.currentPath);
}

async function renameTreeItem(path) {
  if (!path) return;
  const currentName = displayNameFromPath(path);
  const newName = await customPrompt("重命名为：", currentName, { title: "重命名" });
  if (!newName || newName.trim() === currentName) return;
  try {
    const response = await api.post("/api/rename", {
      path,
      newName: newName.trim()
    });
    state.graphReady = false;
    await bootstrap(true);
    if (response?.newPath) {
      // 移除旧路径的最近文档记录，避免顶部栏残留旧文档名
      removeRecentDoc(path);
      openDoc(response.newPath);
    }
    showToast("重命名成功");
  } catch (error) {
    showToast(error.message || "重命名失败");
  }
}

function displayNameFromPath(path) {
  const ref = splitPathRef(path);
  const parts = (ref.relative || "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function closeSearchWhenIdle(event) {
  if (event.target.closest(".search-box") || event.target.closest("#searchResults")) return;
  els.searchResults.classList.add("hidden");
}

function resizeCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  const deviceRatio = window.devicePixelRatio || 1;
  const area = Math.max(1, rect.width * rect.height);
  const pixelBudget = state.graphView.visibleNodes.length > 600 ? 2200000 : 3000000;
  const ratio = clamp(Math.min(deviceRatio, 1.5, Math.sqrt(pixelBudget / area)), 1, 1.5);
  els.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  els.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  els.canvas.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
}

function releaseGraphCanvas() {
  if (state.graphView.frame) cancelAnimationFrame(state.graphView.frame);
  state.graphView.frame = 0;
  els.canvas.width = 1;
  els.canvas.height = 1;
  els.canvas.getContext("2d").setTransform(1, 0, 0, 1, 0, 0);
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

function scheduleGraphWorkerIdle() {
  if (state.graphWorkerIdleTimer) clearTimeout(state.graphWorkerIdleTimer);
  state.graphWorkerIdleTimer = setTimeout(() => {
    if (state.graphWorkerPending.size === 0 && state.graphWorker) {
      state.graphWorker.terminate();
      state.graphWorker = null;
    }
    state.graphWorkerIdleTimer = 0;
  }, 60000);
}

function ensureGraphWorker() {
  // Graph Worker 失败后进入 5 秒冷却期，过期后允许重建，避免图谱布局永久退回主线程
  if (state.graphWorker || typeof Worker === "undefined") return state.graphWorker;
  if (state.graphWorkerFailed && Date.now() < state.graphWorkerFailedUntil) return null;
  state.graphWorkerFailed = false;
  try {
    const worker = new Worker(GRAPH_WORKER_URL);
    worker.onmessage = (event) => {
      const { id, layout, error } = event.data || {};
      const pending = state.graphWorkerPending.get(id);
      if (!pending) return;
      state.graphWorkerPending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve(layout);
      scheduleGraphWorkerIdle();
    };
    worker.onerror = (event) => {
      state.graphWorkerFailed = true;
      state.graphWorkerFailedUntil = Date.now() + 5000;
      for (const pending of state.graphWorkerPending.values()) pending.reject(event.error || new Error("Graph worker unavailable"));
      state.graphWorkerPending.clear();
      worker.terminate();
      state.graphWorker = null;
      if (state.graphWorkerIdleTimer) { clearTimeout(state.graphWorkerIdleTimer); state.graphWorkerIdleTimer = 0; }
    };
    state.graphWorker = worker;
  } catch {
    state.graphWorkerFailed = true;
    state.graphWorkerFailedUntil = Date.now() + 5000;
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
      resolve: (layout) => { clearTimeout(timeout); resolve(layout); scheduleGraphWorkerIdle(); },
      reject: (error) => { clearTimeout(timeout); reject(error); scheduleGraphWorkerIdle(); },
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
    // 计算组件内文档的时间范围，用于"最新文档居中"的偏好打分。
    const docNodes = component.filter((node) => node.kind === "doc" && node.modified);
    const newestMtime = docNodes.length ? Math.max(...docNodes.map((node) => node.modified)) : 0;
    const oldestMtime = docNodes.length ? Math.min(...docNodes.map((node) => node.modified)) : 0;
    const timeSpan = Math.max(1, newestMtime - oldestMtime);
    const root = [...component].sort((a, b) => {
      const docBiasA = a.kind === "doc" ? 0.18 : 0;
      const docBiasB = b.kind === "doc" ? 0.18 : 0;
      // 最新文档获得额外加分，使其更可能成为中心节点。
      const recencyA = a.kind === "doc" && a.modified ? (a.modified - oldestMtime) / timeSpan * 0.22 : 0;
      const recencyB = b.kind === "doc" && b.modified ? (b.modified - oldestMtime) / timeSpan * 0.22 : 0;
      return b.centrality + docBiasB + recencyB - a.centrality - docBiasA - recencyA;
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
  const iterations = nodes.length < 120 ? 72 : nodes.length < 420 ? 44 : nodes.length < 800 ? 24 : 12;
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
  const pruned = state.graph.stats?.pruned ? " · 已裁剪" : "";
  els.graphStats.textContent = `${graphModeName()} · ${docLabel} 篇文档 · ${backboneCount} 条主干 · ${edges.length} 条关联${pruned}`;
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
  const neighborSets = Array.from({ length: nodes.length }, () => new Set());
  for (const edge of edges) {
    const a = nodeIndex.get(edge.source);
    const b = nodeIndex.get(edge.target);
    if (a === undefined || b === undefined) continue;
    springs.push({ edge, a, b });
    adjacency[a].push({ index: b, edge });
    adjacency[b].push({ index: a, edge });
    neighborSets[a].add(b);
    neighborSets[b].add(a);
  }

  const cache = {
    nodes,
    edges,
    nodeIndex,
    nodeById,
    springs,
    adjacency,
    neighborSets,
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

function startGraphRebound() {
  if (state.graphView.reboundAnimation) cancelAnimationFrame(state.graphView.reboundAnimation);
  state.graphView.reboundAnimation = 0;
  // 拖拽结束后不再用固定时长插值覆盖节点轨迹，而是交由 runGraphSimulation
  // 以引力 + 回弹力规则沿物理轨迹缓慢复原至平衡位置（target）。reboundUntil
  // 维持较长的回弹窗口，配合压低的 returnStrength 呈现舒缓的自然复原。
  state.graphView.reboundUntil = performance.now() + 3600;
  startGraphSimulation();
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
  // 用户显式开启动态时优先用户偏好，否则遵循系统减少动画设置。
  // 集成显卡笔记本常被系统自动标记为 reduce，导致图谱无动态，这里让用户能强制启用。
  if (state.graphView.dynamic && localStorage.getItem("graphDynamicOverride") === "1") return false;
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
  if (urgent) return count > 900 ? 48 : count > 500 ? 42 : 36;
  if (state.graphView.hoveredId || cache.maxEnergy > 0.08) return count > 900 ? 64 : count > 500 ? 54 : 48;
  return count > 900 ? 120 : count > 500 ? 100 : count > 250 ? 84 : 70;
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
  if (state.mode !== "graph" || document.hidden || !state.graphView.pageActive) return;
  if (state.graphView.lastInteraction && now - state.graphView.lastInteraction > 10000 && !state.graphDrag && !state.graphView.hoveredId) {
    stopGraphSimulation();
    return;
  }
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
  if ((!state.graphView.dynamic && !temporaryChain && !rebound) || state.mode !== "graph" || document.hidden || !state.graphView.pageActive || graphMotionReduced()) return;
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
          // 联系紧密（有直接链接）的节点对减弱排斥，让引力把它们聚拢；
          // 联系松散的节点对增强排斥，使无关节点彼此散开、层级清晰。
          const repelScale = (cache.neighborSets[index].has(otherIndex) ? 0.4 : 1.25) * state.graphView.physics.repulsion;
          const force = (24 / (1 + distanceSq / 900)) * repelScale;
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
    const desired = edge.type === "tag" ? 74 : edge.type === "keyword" ? 88 : 104;
    // 有链接的文档对引力更强，强关联聚集成核心集群，松散连接只维持弱牵引。
    const strength = (edge.backbone ? 0.052 : 0.008) * state.graphView.physics.attraction;
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
    // 游离呼吸幅度收束到自然和谐区间，避免长时间观察时的晃动疲劳。
    const drift = (node.layoutRoot ? 0.014 : 0.034) * state.graphView.physics.breathing;
    fx[index] += Math.sin(timestamp * 0.00047 + phase) * drift;
    fy[index] += Math.cos(timestamp * 0.00039 + phase * 1.31) * drift;
    // 拖拽复原期以引力规则缓慢拉回平衡位置（target），轨迹由物理自然产生，
    // 而非固定时长插值；强度刻意压低以呈现"缓慢复原"的舒缓感。
    const returnStrength = (rebound
      ? (node.layoutRoot ? 0.02 : 0.014)
      : (node.layoutRoot ? 0.006 : 0.0014)) * state.graphView.physics.restore;
    fx[index] += (node.targetX - node.x) * returnStrength;
    fy[index] += (node.targetY - node.y) * returnStrength;
    node.vx = (node.vx + fx[index] * dt) * 0.86;
    node.vy = (node.vy + fy[index] * dt) * 0.86;
    node.energy = Math.max(0, (node.energy || 0) * 0.95);
    maxEnergy = Math.max(maxEnergy, node.energy);
    const speed = Math.max(0.001, Math.hypot(node.vx, node.vy));
    const limit = Math.min(node.layoutRoot ? 1.0 : 2.0, speed);
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
  const crowdedGraph = nodes.length > 280;
  const denseGraph = nodes.length > 600;
  const edgeOpacityScale = denseGraph ? 0.52 : crowdedGraph ? 0.72 : 1;
  const glowScale = denseGraph ? 0.22 : crowdedGraph ? 0.48 : 1;
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
    ctx.globalAlpha = focused && queryRelated ? Math.min(0.78, (baseAlpha + energy * 0.24) * edgeOpacityScale) : 0.022 * edgeOpacityScale;
    ctx.lineWidth = (edge.backbone ? 0.86 : 0.34) + Math.min(1.35, edge.weight * (edge.backbone ? 0.14 : 0.055)) + energy * 0.8;
    ctx.shadowColor = edge.backbone && focused ? ctx.strokeStyle : "transparent";
    ctx.shadowBlur = edge.backbone && focused ? (2 + energy * 4) * glowScale : 0;
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
  const viewMargin = 40;
  for (const node of nodes) {
    const p = point(node);
    // 视口裁剪：跳过完全在画布外的节点
    if (p.x < -viewMargin || p.x > rect.width + viewMargin || p.y < -viewMargin || p.y > rect.height + viewMargin) {
      if (!node.id || !connected.has(node.id)) continue;
    }
    const active = node.id === state.selectedNode;
    const hovered = node.id === focusId;
    const related = !focusId || connected.has(node.id);
    const queryMatch = !query || matches.has(node.id);
    const energy = clamp(node.energy || 0, 0, 1);
    const idlePulse = view.dynamic ? Math.sin(motionTime * 0.0015 + graphHash(node.id) * Math.PI * 2) * 0.008 : 0;
    const radius = graphNodeRadius(node) * clamp(view.scale, 0.72, 1.18) * (1 + idlePulse + energy * 0.12);
    const kindColor = node.kind === "tag" ? palette.tag : node.kind === "keyword" ? palette.keyword : node.kind === "missing" ? palette.missing : palette.doc;
    ctx.globalAlpha = related && queryMatch ? 1 : query && matches.has(node.id) ? 1 : 0.18;
    ctx.fillStyle = active || hovered ? palette.active : kindColor;
    ctx.strokeStyle = active || hovered ? palette.active : node.kind === "doc" ? palette.docBorder : kindColor;
    ctx.lineWidth = active || hovered ? 2.6 : 1.2;
    ctx.shadowColor = active || hovered ? palette.active : energy > 0.08 ? kindColor : "transparent";
    ctx.shadowBlur = active || hovered ? 10 * glowScale : energy > 0.08 ? (3 + energy * 6) * glowScale : 0;
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

let graphHoverFrame = 0;
let graphHoverPoint = null;
function scheduleGraphHover(clientX, clientY) {
  graphHoverPoint = { clientX, clientY };
  if (graphHoverFrame) return;
  graphHoverFrame = requestAnimationFrame(() => {
    graphHoverFrame = 0;
    if (!graphHoverPoint || state.mode !== "graph" || state.graphDrag) return;
    const eventLike = graphHoverPoint;
    graphHoverPoint = null;
    const node = hitGraph(eventLike);
    const nextId = node?.id || "";
    if (nextId !== state.graphView.hoveredId) {
      state.graphView.hoveredId = nextId;
      state.graphView.lastInteraction = performance.now();
      scheduleGraphDraw();
    }
    updateGraphTooltip(node, eventLike);
  });
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

async function replaceEditorRange(value, start, end, selectionMode = "end") {
  const replacement = String(value ?? "");
  const before = els.editor.value;
  const clamp = (position) => Math.max(0, Math.min(before.length, Number(position) || 0));
  const from = clamp(start);
  const to = Math.max(from, clamp(end));
  const expected = `${before.slice(0, from)}${replacement}${before.slice(to)}`;
  const scrollTop = els.editor.scrollTop;
  const scrollLeft = els.editor.scrollLeft;

  try {
    els.editor.setRangeText(replacement, from, to, selectionMode);
  } catch (_) {
    return false;
  }

  // The CodeMirror adapter normally commits the transaction above. Keep a
  // narrow fallback for a rare native bridge no-op without risking a second edit.
  if (els.editor.value === before && expected !== before) {
    try {
      els.editor.view?.dispatch?.({ changes: { from, to, insert: replacement } });
    } catch (_) { /* The post-condition below reports a failed write. */ }
  }
  if (els.editor.value !== expected) return false;

  els.editor.focus();
  els.editor.scrollTop = scrollTop;
  els.editor.scrollLeft = scrollLeft;
  requestAnimationFrame(() => {
    els.editor.scrollTop = scrollTop;
    els.editor.scrollLeft = scrollLeft;
  });
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
  // AI actions are explicit user decisions, so persist them immediately.
  return saveCurrentDoc({ keepEditorState: true, renderAfterSave: false });
}

function insertAtCursor(value) {
  const text = String(value ?? "");
  const start = els.editor.selectionStart ?? els.editor.value.length;
  const end = els.editor.selectionEnd ?? start;
  const before = els.editor.value;
  els.editor.setRangeText(text, start, end);
  // 安全校验：封装 setRangeText 对超大单次插入偶发静默失败，
  // 检测到内容未变化时回退到 CodeMirror 原生事务，避免粘贴整体丢失。
  if (text && els.editor.value === before) {
    try {
      els.editor.view?.dispatch?.({ changes: { from: start, to: end, insert: text } });
    } catch (_) { /* 已尽力兜底，忽略 */ }
  }
  const next = start + text.length;
  els.editor.setSelectionRange(next, next);
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
  if (event.key !== "Enter" || event.shiftKey || event.defaultPrevented) return false;
  const start = els.editor.selectionStart ?? 0;
  const end = els.editor.selectionEnd ?? start;
  if (start !== end) return false;
  const value = els.editor.value;
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const line = value.slice(lineStart, start);
  const arabic = line.match(/^(\s*)(?:##\s*)?(\d+)([.)、])(\s*)(.*)$/);
  const chinese = line.match(/^(\s*)(##\s*)?([一二三四五六七八九十百千]{1,6})([.)、])(\s*)(.*)$/);
  if (!arabic && !chinese) return false;

  event.preventDefault();

  const isArabic = !!arabic;
  const separator = isArabic ? arabic[3] : chinese[4];
  const indent = isArabic ? arabic[1] : chinese[1];
  const hasMd = isArabic ? (line.includes("##") ? "## " : "") : (chinese[2] || "");
  const currentNum = isArabic ? Number(arabic[2]) : parseChineseNumber(chinese[3]);

  if (!currentNum || currentNum <= 0) {
    const marker = isArabic ? `${indent}1${separator} ` : `${indent}${hasMd}一${separator} `;
    insertAtCursor(`\n${marker}`);
    return true;
  }

  const lines = value.split("\n");
  let headerLineIdx = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const ls = lines.slice(0, idx).reduce((acc, ll) => acc + ll.length + 1, 0);
    if (ls === lineStart) { headerLineIdx = idx; break; }
  }

  let parentHeadingLine = -1;
  for (let i = headerLineIdx - 1; i >= 0; i--) {
    const hMatch = lines[i].match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (hMatch && hMatch[2].length <= 3 && hMatch[1].length <= indent.length) {
      parentHeadingLine = i; break;
    }
    const cnMatch = lines[i].match(/^(\s*)(##\s*)?([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (cnMatch && cnMatch[2] && cnMatch[1].length <= indent.length) {
      parentHeadingLine = i; break;
    }
    const numMatch = lines[i].match(/^(\s*)(\d{1,3})[、.．]\s*(.+)$/);
    if (numMatch) {
      const numLevel = Math.min(6, Math.max(3, numMatch[2].length + 2));
      if (numLevel < 6 && numMatch[1].length < indent.length) {
        parentHeadingLine = i; break;
      }
    }
  }

  const rows = [];
  for (let i = (parentHeadingLine >= 0 ? parentHeadingLine + 1 : 0); i < lines.length; i++) {
    const cl = lines[i];
    let m;
    if (isArabic) {
      m = cl.match(/^(\s*)(?:##\s*)?(\d+)([.)、])(.*)$/);
      if (m && m[1] === indent && m[3] === separator) {
        rows.push({ lineIndex: i, number: Number(m[2]), prefix: m[1], sep: m[3], rest: m[4], mdPrefix: cl.includes("##") ? "## " : "" });
      } else {
        const stop =
          (cl.match(/^(\s*)(#{1,6})\s/) && RegExp.$2.length <= 3 && RegExp.$1.length <= indent.length) ||
          (cl.match(/^(\s*)(##\s*)?[一二三四五六七八九十]{1,4}[、.．]/) && RegExp.$2 && RegExp.$1.length <= indent.length) ||
          (cl.match(/^(\s*)(\d{1,3})[、.．]/) && RegExp.$1.length < indent.length);
        if (stop) break;
      }
    } else {
      m = cl.match(/^(\s*)(##\s*)?([一二三四五六七八九十百千]{1,6})([.)、])(.*)$/);
      if (m && m[1] === indent && m[4] === separator) {
        const num = parseChineseNumber(m[3]);
        if (num > 0) rows.push({ lineIndex: i, number: num, prefix: m[1], sep: m[4], rest: m[5], mdPrefix: m[2] || "" });
      } else {
        const stop =
          (cl.match(/^(\s*)(##\s*)?[一二三四五六七八九十]{1,4}[、.．]/) && RegExp.$2 && RegExp.$1.length <= indent.length) ||
          (cl.match(/^(\s*)(#{1,6})\s/) && RegExp.$2.length <= 3 && RegExp.$1.length <= indent.length) ||
          (cl.match(/^(\s*)(\d{1,3})[、.．]/) && RegExp.$1.length < indent.length);
        if (stop) break;
      }
    }
  }

  let needRenumber = false;
  if (rows.length >= 1) {
    if (rows[0].number !== 1) {
      needRenumber = true;
    } else {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].number !== i + 1) { needRenumber = true; break; }
      }
    }
  }

  if (needRenumber && rows.length > 0) {
    const targetMdPrefix = rows.some(r => r.mdPrefix) ? "## " : "";
    const newLines = lines.slice();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const newNumStr = isArabic ? String(i + 1) : numberToChinese(i + 1);
      const restTrimmed = row.rest.replace(/^\s+/, "");
      const sepSpace = restTrimmed.length ? (restTrimmed.startsWith(" ") ? restTrimmed : " " + restTrimmed) : " ";
      newLines[row.lineIndex] = `${row.prefix}${targetMdPrefix}${newNumStr}${row.sep}${sepSpace}`.trimEnd();
    }
    const newValue = newLines.join("\n");
    // 使用 CodeMirror 原生 dispatch 做原子替换，避免 value setter 导致光标跳动
    const oldDocLength = els.editor.value.length;
    try {
      els.editor.view?.dispatch?.({
        changes: { from: 0, to: oldDocLength, insert: newValue },
        selection: { anchor: start },
        scrollIntoView: true,
      });
    } catch (_) {
      els.editor.value = newValue;
    }
    let offset = 0;
    for (let i = 0; i < headerLineIdx; i++) offset += newLines[i].length + 1;
    offset += Math.min(start - lineStart, newLines[headerLineIdx].length);
    els.editor.setSelectionRange(offset, offset);
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    const nextMarker = isArabic ? `${indent}${rows.length + 1}${separator} ` : `${indent}${targetMdPrefix}${numberToChinese(rows.length + 1)}${separator} `;
    insertAtCursor(`\n${nextMarker}`);
    return true;
  }

  const nextNum = rows.length > 0 ? rows.length + 1 : (isArabic ? currentNum + 1 : (currentNum + 1));
  const nextMarker = isArabic
    ? `${indent}${nextNum}${separator} `
    : `${indent}${hasMd}${numberToChinese(nextNum)}${separator} `;
  insertAtCursor(`\n${nextMarker}`);
  return true;
}

function cursorInsideFence(value, position) {
  const before = value.slice(0, position);
  return (before.match(/```/g) || []).length % 2 === 1;
}

function shouldWrapPastedCode(text) {
  if (!text || text.includes("```")) return false;
  if (!text.includes("\n")) return false;
  // 超长文本交由 CodeMirror 原生粘贴，避免大事务插入异常导致整段丢失。
  if (text.length > 20000) return false;
  const lines = text.split("\n");
  if (lines.length < 3) return false;
  const KEYWORDS = /\b(function|const|let|var|class|import|export|return|interface|namespace|package|func|fn|require|module|SELECT|FROM|WHERE|def|public|private)\b/;
  const hasKeyword = KEYWORDS.test(text);
  const keywordHits = (text.match(KEYWORDS) || []).length;
  const hasStructure = /[{};]/.test(text) && /[{(]/.test(text);
  // 需同时命中关键字与结构特征，或关键字多次出现，才判定为代码；
  // 避免含 = / < 的长篇中文文案被误判为代码后整段丢失。
  return hasKeyword && (hasStructure || keywordHits >= 2);
}

function detectPastedCodeLanguage(source) {
  const text = String(source || "").trim();
  const lower = text.toLowerCase();
  if (!text) return "text";
  if (/^\s*(```|~~~)/.test(text)) return "text";
  if (/^\s*<!doctype\s+html|<html[\s>]|<\/(?:div|body|html)>/i.test(text)) return "html";
  if (/^\s*FROM\s+\S+\s+AS\s+\S+|^\s*RUN\s+|^\s*CMD\s+\[|^\s*EXPOSE\s+\d+/im.test(text)) return "dockerfile";
  if (/^\s*#\s*!\/bin\/(?:ba)?sh\b|\b(?:echo|printf)\s+['\"]?\$?[A-Z_]+/im.test(text)) return "bash";
  if (/\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|CREATE\s+TABLE|ALTER\s+TABLE)\b[\s\S]*\b(?:FROM|VALUES|WHERE|PRIMARY\s+KEY)\b/i.test(text)) return "sql";
  if (/^\s*(?:interface|type)\s+\w+\s*[{=]|\b(?:string|number|boolean)\[\]|:\s*(?:string|number|boolean)\b/.test(text)) return "typescript";
  if (/\b(?:const|let|var)\s+\w+\s*=|=>|\bconsole\.(?:log|error|warn)\s*\(|\b(?:function|async)\s+\w+\s*\(/.test(text)) return "javascript";
  if (/^\s*(?:def\s+\w+\s*\(|class\s+\w+\s*[:(]|from\s+\w+\s+import\s+|import\s+\w+|if\s+__name__\s*==|print\s*\()/m.test(text)) return "python";
  if (/\b(?:public\s+class|private\s+(?:static\s+)?(?:void|int|String)|System\.out\.|@Override)\b/.test(text)) return "java";
  if (/\b(?:using\s+System|namespace\s+\w+|Console\.WriteLine|public\s+partial\s+class)\b/.test(text)) return "csharp";
  if (/^\s*#include\s*[<\"]|\b(?:std::|printf\s*\(|int\s+main\s*\()/m.test(text)) return "cpp";
  if (/^\s*package\s+\w+|\bfunc\s+\w+\s*\(/m.test(text)) return "go";
  if (/\bfn\s+main\s*\(|\blet\s+mut\s+|\buse\s+std::/.test(text)) return "rust";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return "json";
  } catch { /* not JSON */ }
  if (/[.#]?[a-z][\w-]*(?:\s+[.#:]?[\w*-]+)*\s*\{/.test(text) && /\b[a-z-]+\s*:\s*[^;{}]+;/.test(text)) return "css";
  if (/^\s*(?:[-*]\s+|\w[\w -]*:\s+|---\s*$)/m.test(text) && /:\s+[^\n]+/.test(text)) return "yaml";
  if (/^\s*#{1,6}\s+|\[[^\]]+\]\(https?:\/\//m.test(text)) return "markdown";
  if (/\b(?:SELECT|FROM|WHERE)\b/i.test(lower)) return "sql";
  return "text";
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
  els.editor.setRangeText(before + selected + after, start, end);
  els.editor.focus();
  els.editor.setSelectionRange(start + before.length, start + before.length + selected.length);
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertDivider() {
  const cursor = els.editor.selectionEnd ?? els.editor.value.length;
  const nextLine = els.editor.value.indexOf("\n", cursor);
  const insertAt = nextLine === -1 ? els.editor.value.length : nextLine;
  const prefix = els.editor.value.slice(0, insertAt).endsWith("\n") ? "" : "\n";
  const value = `${prefix}---\n`;
  els.editor.setRangeText(value, insertAt, insertAt);
  const next = insertAt + value.length;
  els.editor.focus();
  els.editor.setSelectionRange(next, next);
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectedLineRange() {
  const value = els.editor.value;
  const start = els.editor.selectionStart ?? 0;
  const end = els.editor.selectionEnd ?? start;
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const effectiveEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = value.indexOf("\n", effectiveEnd);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  return { value, start, end, lineStart, lineEnd };
}

function prefixSelectedLines(prefix) {
  const range = selectedLineRange();
  const selected = range.value.slice(range.lineStart, range.lineEnd);
  const lines = selected.split("\n");
  const next = lines.map((line, index) => {
    const value = typeof prefix === "function" ? prefix(line, index) : prefix;
    return `${value}${line}`;
  }).join("\n");
  els.editor.setRangeText(next, range.lineStart, range.lineEnd, "select");
  els.editor.focus();
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertMarkdownLink() {
  const start = els.editor.selectionStart ?? 0;
  const end = els.editor.selectionEnd ?? start;
  const label = els.editor.value.slice(start, end) || "链接文字";
  const markdown = `[${label}](https://)`;
  els.editor.setRangeText(markdown, start, end, "end");
  els.editor.focus();
  const urlStart = start + label.length + 3;
  els.editor.setSelectionRange(urlStart, urlStart + 8);
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertMarkdownTable() {
  const cursor = els.editor.selectionEnd ?? els.editor.value.length;
  const prefix = cursor > 0 && els.editor.value[cursor - 1] !== "\n" ? "\n\n" : "";
  const table = `${prefix}| 列 1 | 列 2 | 列 3 |\n| :--- | :---: | ---: |\n| 内容 | 内容 | 内容 |\n`;
  els.editor.setRangeText(table, cursor, cursor, "end");
  els.editor.focus();
  els.editor.setSelectionRange(cursor + prefix.length + 2, cursor + prefix.length + 5);
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

// 编辑模式预览中表格行/列扩展：根据预览按钮记录的起始行定位源码表格块，
// 改写 Markdown 后回填编辑器，保留光标位置。
function expandMarkdownTable(startLine, action) {
  const start = Number(startLine);
  if (!Number.isInteger(start) || start < 0) return;
  const value = els.editor.value;
  const lines = value.split("\n");
  if (start >= lines.length) return;
  let end = start;
  while (end < lines.length && splitMarkdownTableRow(lines[end]).length >= 2) end += 1;
  const tableLines = lines.slice(start, end);
  if (tableLines.length < 2) return;
  const rows = tableLines.map(splitMarkdownTableRow);
  const colCount = rows[0].length;
  let nextLines;
  if (action === "addRow") {
    const cells = Array.from({ length: colCount }, () => "内容");
    nextLines = [...tableLines, `| ${cells.join(" | ")} |`];
  } else if (action === "addCol") {
    nextLines = rows.map((cells, idx) => {
      const isDivider = idx === 1 && cells.every((c) => markdownTableAlignment(c));
      const extra = isDivider ? "---" : (idx === 0 ? "新列" : "内容");
      return `| ${[...cells, extra].join(" | ")} |`;
    });
  } else if (action === "removeCol") {
    if (colCount <= 1) return;
    nextLines = rows.map((cells) => `| ${cells.slice(0, -1).join(" | ")} |`);
  } else {
    return;
  }
  const blockStart = lines.slice(0, start).reduce((n, l) => n + l.length + 1, 0);
  const blockEnd = blockStart + lines.slice(start, end).join("\n").length;
  const replacement = nextLines.join("\n");
  // 保留编辑器与预览滚动位置，避免表格增删行列后预览跳转至文档尾部干扰编辑。
  const savedEditorTop = els.editor.scrollTop;
  const savedEditorLeft = els.editor.scrollLeft;
  const savedPreviewTop = els.preview.scrollTop;
  els.editor.setRangeText(replacement, blockStart, blockEnd);
  const next = blockStart + replacement.length;
  els.editor.setSelectionRange(next, next);
  els.editor.focus();
  els.editor.scrollTop = savedEditorTop;
  els.editor.scrollLeft = savedEditorLeft;
  els.preview.scrollTop = savedPreviewTop;
  requestAnimationFrame(() => {
    els.editor.scrollTop = savedEditorTop;
    els.editor.scrollLeft = savedEditorLeft;
    els.preview.scrollTop = savedPreviewTop;
  });
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function moveSelectedLines(direction) {
  const range = selectedLineRange();
  const scrollTop = els.editor.scrollTop;
  const scrollLeft = els.editor.scrollLeft;
  const lines = range.value.split("\n");
  const startLine = range.value.slice(0, range.lineStart).split("\n").length - 1;
  const endLine = startLine + range.value.slice(range.lineStart, range.lineEnd).split("\n").length - 1;
  if ((direction < 0 && startLine === 0) || (direction > 0 && endLine >= lines.length - 1)) return false;
  const blockStart = lines.slice(0, startLine).reduce((total, line) => total + line.length + 1, 0);
  const relativeStart = range.start - blockStart;
  const relativeEnd = range.end - blockStart;
  const block = lines.splice(startLine, endLine - startLine + 1);
  const insertLine = direction < 0 ? startLine - 1 : startLine + 1;
  lines.splice(insertLine, 0, ...block);
  const nextValue = lines.join("\n");
  const nextBlockStart = lines.slice(0, insertLine).reduce((total, line) => total + line.length + 1, 0);
  els.editor.value = nextValue;
  els.editor.focus();
  els.editor.setSelectionRange(
    Math.max(0, nextBlockStart + relativeStart),
    Math.min(nextValue.length, nextBlockStart + relativeEnd),
  );
  els.editor.scrollTop = scrollTop;
  els.editor.scrollLeft = scrollLeft;
  requestAnimationFrame(() => {
    els.editor.scrollTop = scrollTop;
    els.editor.scrollLeft = scrollLeft;
  });
  state.secondaryCursors = [];
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function applyFormat(format) {
  const color = els.textColor?.value || "#0f766e";
  const bg = els.bgColor?.value || "#fff3a3";
  const size = document.getElementById('fontSizeSelect')?.value || els.fontSize?.value || "16";
  // 插入 Obsidian 兼容 callout 高亮提示块：`> [!type] 标题\n> 内容行`
  // 若用户已选中多行，则每行前加 "> "，并在首行前插入类型标题行。
  function insertCallout(type, defaultTitle) {
    const range = selectedLineRange();
    const selected = range.value.slice(range.lineStart, range.lineEnd);
    const hasSelection = range.end > range.start || selected.trim().length > 0;
    const header = `> [!${type}] ${defaultTitle}`;
    let body;
    if (hasSelection) {
      body = selected.split("\n").map((l) => `> ${l}`).join("\n");
    } else {
      body = "> 在这里写内容";
    }
    const inserted = `${header}\n${body}`;
    const oldValue = range.value;
    const newValue = oldValue.slice(0, range.lineStart) + inserted + oldValue.slice(range.lineEnd);
    // 按项目规范优先走 CodeMirror 事务，避免长文档丢失
    let nextAnchor = range.lineStart + header.length + 2 + 2; // 光标定位到"在这里写内容"起始
    let nextHead = range.lineStart + header.length + 2 + 10;
    if (hasSelection) {
      nextAnchor = range.lineStart;
      nextHead = range.lineStart + inserted.length;
    }
    try {
      const view = els.editor.view;
      if (view && view.dispatch) {
        view.dispatch({
          changes: { from: range.lineStart, to: range.lineEnd, insert: inserted },
          selection: { anchor: nextAnchor, head: nextHead },
          scrollIntoView: true,
        });
        els.editor.value = newValue;
      } else {
        els.editor.value = newValue;
        els.editor.setSelectionRange?.(nextAnchor, nextHead);
      }
    } catch (_) {
      els.editor.value = newValue;
      els.editor.setSelectionRange?.(nextAnchor, nextHead);
    }
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    schedulePreviewUpdate({ immediate: true });
  }
  // 插入/包裹 HTML 原生折叠块（<details>），兼容现有 Markdown 渲染器。
  function insertDetailsFold() {
    const start = els.editor.selectionStart ?? els.editor.value.length;
    const end = els.editor.selectionEnd ?? start;
    const value = els.editor.value;
    const content = value.slice(start, end) || "在这里写折叠内容";
    const summary = "折叠标题";
    const inserted = `<details>\n<summary>${summary}</summary>\n\n${content}\n\n</details>`;
    const newValue = value.slice(0, start) + inserted + value.slice(end);
    const summaryStart = start + `<details>\n<summary>`.length;
    const summaryEnd = summaryStart + summary.length;
    try {
      const view = els.editor.view;
      if (view && view.dispatch) {
        view.dispatch({
          changes: { from: start, to: end, insert: inserted },
          selection: { anchor: summaryStart, head: summaryEnd },
          scrollIntoView: true,
        });
        els.editor.value = newValue;
      } else {
        els.editor.value = newValue;
        els.editor.setSelectionRange?.(summaryStart, summaryEnd);
      }
    } catch (_) {
      els.editor.value = newValue;
      els.editor.setSelectionRange?.(summaryStart, summaryEnd);
    }
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    schedulePreviewUpdate({ immediate: true });
  }
  // 需求11：数学公式 — 块级公式 `$$...$$`
  function insertMathBlock() {
    const cursor = els.editor.selectionEnd ?? els.editor.value.length;
    const value = els.editor.value;
    const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
    const lineEnd = value.indexOf("\n", cursor);
    const insertAtStart = lineStart;
    const insertAtEnd = lineEnd === -1 ? value.length : lineEnd;
    const selected = value.slice(insertAtStart, insertAtEnd).trim();
    const content = selected || "E = mc^2";
    const block = `\n$$\n${content}\n$$\n`;
    const newValue = value.slice(0, insertAtStart) + block + value.slice(insertAtEnd);
    const anchor = insertAtStart + 3;
    const head = anchor + content.length;
    try {
      const view = els.editor.view;
      if (view && view.dispatch) {
        view.dispatch({
          changes: { from: insertAtStart, to: insertAtEnd, insert: block },
          selection: { anchor, head },
          scrollIntoView: true,
        });
        els.editor.value = newValue;
      } else {
        els.editor.value = newValue;
        els.editor.setSelectionRange?.(anchor, head);
      }
    } catch (_) {
      els.editor.value = newValue;
      els.editor.setSelectionRange?.(anchor, head);
    }
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    schedulePreviewUpdate({ immediate: true });
  }
  // 需求11：数学公式 — 行内公式 `$...$`
  function insertMathInline() {
    wrapSelection("$", "$", "x^2 + y^2");
  }
  // 需求11：数学公式 — LaTeX 模板
  function insertMathTemplate(type) {
    const templates = {
      fraction: "$\\frac{a}{b}$",
      sum: "$\\sum_{i=1}^{n} i$",
      integral: "$\\int_{a}^{b} f(x)\\,dx$",
      limit: "$\\lim_{x \\to \\infty}$",
      matrix: "$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$",
      piecewise: "$\\begin{cases} f(x) & \\text{if } x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}$",
    };
    const template = templates[type] || "$x$";
    const placeholderMap = {
      fraction: ["a", "b"],
      sum: ["i=1", "n"],
      integral: ["a", "b", "f(x)"],
      limit: ["x \\to \\infty"],
      matrix: ["a & b \\\\ c & d"],
      piecewise: ["f(x)", "x > 0"],
    };
    const placeholders = placeholderMap[type] || [];
    const selected = (els.editor.value.slice(
      els.editor.selectionStart ?? els.editor.value.length,
      els.editor.selectionEnd ?? els.editor.selectionStart ?? els.editor.value.length
    ) || "").trim();
    let finalText = template;
    if (selected && placeholders.length) {
      finalText = template.replace(placeholders[0], selected);
    }
    wrapSelection("", "", finalText);
  }
  // 需求12：插入图表代码块（Mermaid / Excalidraw）
  function insertChartBlock(lang, diagramType) {
    const mermaidTemplates = {
      flowchart: `flowchart TD\n    A[开始] --> B{判断}\n    B -->|是| C[执行操作]\n    B -->|否| D[结束]`,
      sequenceDiagram: `sequenceDiagram\n    participant U as 用户\n    participant S as 系统\n    U->>S: 发送请求\n    S-->>U: 返回响应`,
      gantt: `gantt\n    title 项目计划\n    dateFormat  YYYY-MM-DD\n    section 设计\n    需求分析 :a1, 2024-01-01, 7d\n    原型设计 :after a1, 5d\n    section 开发\n    编码实现 :2024-01-13, 14d`,
      pie: `pie title 用户来源\n    "搜索引擎" : 40\n    "直接访问" : 30\n    "社交媒体" : 20\n    "其他" : 10`,
      classDiagram: `classDiagram\n    class Animal {\n      +String name\n      +int age\n      +makeSound()\n    }\n    class Dog {\n      +String breed\n      +bark()\n    }\n    Animal <|-- Dog`,
      "stateDiagram-v2": `stateDiagram-v2\n    [*] --> 空闲\n    空闲 --> 运行: 启动\n    运行 --> 停止: 停止\n    停止 --> [*]`,
      erDiagram: `erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    ORDER ||--|{ LINE-ITEM : contains\n    PRODUCT ||--o{ LINE-ITEM : includes`,
      journey: `journey\n    title 我的工作日\n    section 早晨\n      起床: 5: 用户\n      早餐: 4: 用户\n    section 工作\n      开会: 3: 用户\n      写代码: 5: 用户`,
      gitGraph: `gitGraph\n    commit id: "初始提交"\n    branch develop\n    checkout develop\n    commit id: "开发功能"\n    checkout main\n    merge develop\n    commit id: "合并发布"`,
      mindmap: `mindmap\n  root((思维导图))\n    核心功能\n      功能一\n      功能二\n    技术架构\n      前端\n      后端`,
      "architecture-beta": `architecture-beta\n    root(应用)\n    group 前端\n      direction TB\n      A[UI组件] --> B[状态管理]\n    end\n    group 后端\n      direction TB\n      C[API服务] --> D[数据存储]\n    end\n    A --> C`,
    };
    const excalidrawTemplate = `{\n  "type": "excalidraw",\n  "version": 2,\n  "source": "MyTemple Knowledge",\n  "elements": [\n    {\n      "id": "rect1",\n      "type": "rectangle",\n      "x": 100,\n      "y": 100,\n      "width": 200,\n      "height": 100,\n      "text": "双击编辑"\n    }\n  ]\n}`;
    let block;
    if (lang === "excalidraw") {
      block = `\n\`\`\`excalidraw\n${excalidrawTemplate}\n\`\`\`\n`;
    } else {
      const template = mermaidTemplates[diagramType] || "flowchart TD\n  A[Start] --> B[End]";
      block = `\n\`\`\`mermaid\n${template}\n\`\`\`\n`;
    }
    const cursor = els.editor.selectionEnd ?? els.editor.value.length;
    const source = els.editor.value;
    const lineStart = source.lastIndexOf("\n", cursor - 1) + 1;
    const lineEnd = source.indexOf("\n", cursor);
    const insertAtStart = lineStart;
    const insertAtEnd = lineEnd === -1 ? source.length : lineEnd;
    const newValue = source.slice(0, insertAtStart) + block + source.slice(insertAtEnd);
    const anchor = insertAtStart + 3;
    const head = anchor + (block.split("\n")[1]?.length || 0);
    try {
      const view = els.editor.view;
      if (view && view.dispatch) {
        view.dispatch({
          changes: { from: insertAtStart, to: insertAtEnd, insert: block },
          selection: { anchor, head },
          scrollIntoView: true,
        });
        els.editor.value = newValue;
      } else {
        els.editor.value = newValue;
        els.editor.setSelectionRange?.(anchor, head);
      }
    } catch (_) {
      els.editor.value = newValue;
      els.editor.setSelectionRange?.(anchor, head);
    }
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    schedulePreviewUpdate({ immediate: true });
  }
  // 插入目录大纲：遵循项目规范，用 headingId(title, idx+1) + 去重；
  // 存在 `(^|\n)\s*(##|#)\s*(目录|TOC)` 标题行则替换其后的列表，否则在合适位置插入新段落。
  function insertTableOfContents() {
    const source = els.editor.value || "";
    const outline = extractOutline(source);
    // 1. 生成 TOC 列表文本
    const used = new Map();
    const lines = [];
    outline.forEach((h, idx) => {
      const baseId = headingId(h.title, idx + 1);
      let id = baseId;
      // 重复 id 去重，与渲染锚点一致
      const n = used.get(id) || 0;
      if (n > 0) {
        id = `${baseId}-${n + 1}`;
        used.set(baseId, n + 1);
      } else {
        used.set(baseId, 1);
      }
      const indent = "  ".repeat(Math.max(0, h.level - 1));
      lines.push(`${indent}- [${h.title}](#${id})`);
    });
    const tocLines = lines.length
      ? lines.join("\n")
      : "- 暂无（请先添加标题）";
    const tocBlock = `## 目录\n\n${tocLines}\n`;
    // 2. 定位已有目录块
    const tocPattern = /(^|\n)(\s*)(##|#)\s*(目录|TOC)\b([^\n]*)\n/i;
    const normalized = source.replace(/\r\n/g, "\n");
    const existing = normalized.match(tocPattern);
    const oldLen = source.length;
    let finalContent;
    let selAnchor;
    let selHead;
    if (existing) {
      const blockStart = existing.index + existing[1].length; // 含开头换行则跳过
      const titleEnd = existing.index + existing[0].length;
      // 向后扫描直到下一个一级/二级标题或文档结束
      const rest = normalized.slice(titleEnd);
      // 匹配：空行 + 列表，然后遇到下一个非列表标题前停止
      // 简化：扫描连续缩进列表/空行直到遇到非列表的有效 Markdown 标题
      let scan = 0;
      const restLines = rest.split("\n");
      let contentLineCount = 0;
      for (let i = 0; i < restLines.length; i += 1) {
        const l = restLines[i];
        if (/^\s*$/.test(l)) {
          contentLineCount += 1;
          continue;
        }
        if (/^\s{0,3}[-*+]\s+/.test(l) || /^\s{1,}[-*+]\s+/.test(l)) {
          contentLineCount += 1;
          continue;
        }
        if (/^\s{0,3}\d+[.)]\s+/.test(l)) {
          contentLineCount += 1;
          continue;
        }
        break;
      }
      let blockEnd = titleEnd;
      for (let i = 0; i < contentLineCount; i += 1) {
        blockEnd += (restLines[i] || "").length + 1;
      }
      // 去掉 trailing \n
      while (blockEnd > titleEnd && normalized[blockEnd - 1] === "\n") blockEnd -= 1;
      finalContent = source.slice(0, blockStart) + tocBlock + source.slice(blockEnd);
      // 去掉可能多插入的空行：若插入段前后存在 3 个以上换行，适度压缩
      selAnchor = blockStart;
      selHead = blockStart + tocBlock.length;
    } else {
      // 3. 未找到现有目录：在 frontmatter 之后或文档开头插入；如果光标在标题下方，则在光标前插入
      let insertAt = 0;
      if (normalized.startsWith("---\n")) {
        const endIdx = normalized.indexOf("\n---\n", 4);
        if (endIdx !== -1) insertAt = Math.min(normalized.length, endIdx + 5);
      }
      // 如果用户光标/选区在 frontmatter 之后的文档正文区域，则优先插在光标位置
      const cursor = els.editor.selectionStart ?? 0;
      if (cursor >= insertAt) insertAt = cursor;
      const prefix = insertAt > 0 && source[insertAt - 1] !== "\n" ? "\n\n" : "";
      const suffix = insertAt < source.length && source[insertAt] !== "\n" ? "\n\n" : "\n";
      const injected = `${prefix}${tocBlock}${suffix}`;
      finalContent = source.slice(0, insertAt) + injected + source.slice(insertAt);
      selAnchor = insertAt + prefix.length;
      selHead = selAnchor + tocBlock.length;
    }
    try {
      const view = els.editor.view;
      if (view && view.dispatch) {
        view.dispatch({
          changes: { from: 0, to: oldLen, insert: finalContent },
          selection: { anchor: selAnchor, head: selHead },
          scrollIntoView: true,
        });
        els.editor.value = finalContent; // 二次同步 bridge
      } else {
        els.editor.value = finalContent;
        els.editor.setSelectionRange?.(selAnchor, selHead);
      }
    } catch (_) {
      els.editor.value = finalContent;
      els.editor.setSelectionRange?.(selAnchor, selHead);
    }
    state.currentContent = finalContent;
    updateLargeDocumentState(finalContent);
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    schedulePreviewUpdate({ immediate: true, forceContent: finalContent });
    showToast("已生成目录大纲");
  }
  const actions = {
    h1: () => prefixSelectedLines("# "),
    h2: () => prefixSelectedLines("## "),
    h3: () => prefixSelectedLines("### "),
    bold: () => wrapSelection("**", "**"),
    italic: () => wrapSelection("*", "*"),
    underline: () => wrapSelection("++", "++"),
    strike: () => wrapSelection("~~", "~~"),
    highlight: () => wrapSelection("==", "=="),
    code: () => wrapSelection("`", "`", "code"),
    link: () => insertMarkdownLink(),
    quote: () => prefixSelectedLines("> "),
    ul: () => prefixSelectedLines("- "),
    ol: () => prefixSelectedLines((line, index) => `${index + 1}. `),
    task: () => prefixSelectedLines("- [ ] "),
    table: () => insertMarkdownTable(),
    color: () => wrapSelection(`{color:${color}|`, "}"),
    bg: () => wrapSelection(`{bg:${bg}|`, "}"),
    size: () => wrapSelection(`{size:${size}|`, "}"),
    hr: () => insertDivider(),
    // 需求10：高亮提示块 callout
    tip: () => insertCallout("tip", "提示"),
    warning: () => insertCallout("warning", "警告"),
    note: () => insertCallout("note", "备注"),
    important: () => insertCallout("important", "重要"),
    caution: () => insertCallout("caution", "注意"),
    // 需求10：目录大纲
    toc: () => insertTableOfContents(),
    // 需求10：折叠块
    details: () => insertDetailsFold(),
    // 需求11：数学公式
    "block-math": () => insertMathBlock(),
    "inline-math": () => insertMathInline(),
    "math-fraction": () => insertMathTemplate("fraction"),
    "math-sum": () => insertMathTemplate("sum"),
    "math-integral": () => insertMathTemplate("integral"),
    "math-limit": () => insertMathTemplate("limit"),
    "math-matrix": () => insertMathTemplate("matrix"),
    "math-piecewise": () => insertMathTemplate("piecewise"),
    // 需求12：插入图表（Mermaid / Excalidraw）
    "chart-excalidraw": () => insertChartBlock("excalidraw"),
    "chart-flowchart": () => insertChartBlock("mermaid", "flowchart"),
    "chart-sequence": () => insertChartBlock("mermaid", "sequenceDiagram"),
    "chart-gantt": () => insertChartBlock("mermaid", "gantt"),
    "chart-pie": () => insertChartBlock("mermaid", "pie"),
    "chart-class": () => insertChartBlock("mermaid", "classDiagram"),
    "chart-state": () => insertChartBlock("mermaid", "stateDiagram-v2"),
    "chart-entity": () => insertChartBlock("mermaid", "erDiagram"),
    "chart-journey": () => insertChartBlock("mermaid", "journey"),
    "chart-git": () => insertChartBlock("mermaid", "gitGraph"),
    "chart-mindmap": () => insertChartBlock("mermaid", "mindmap"),
    "chart-architecture": () => insertChartBlock("mermaid", "architecture-beta"),
    clearFormat: () => {
      let start = els.editor.selectionStart ?? els.editor.value.length;
      let end = els.editor.selectionEnd ?? start;
      if (start === end) {
        const lineStart = els.editor.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
        const nextLine = els.editor.value.indexOf("\n", start);
        const lineEnd = nextLine === -1 ? els.editor.value.length : nextLine;
        if (lineEnd > lineStart) {
          start = lineStart;
          end = lineEnd;
        } else {
          return;
        }
      }
      let selected = els.editor.value.slice(start, end);
      if (!selected) return;
      selected = selected.replace(/\*\*([^*]+?)\*\*/g, "$1");
      selected = selected.replace(/\*([^*]+?)\*/g, "$1");
      selected = selected.replace(/\+\+(.+?)\+\+/g, "$1");
      selected = selected.replace(/~~(.+?)~~/g, "$1");
      selected = selected.replace(/==(.+?)==/g, "$1");
      selected = selected.replace(/`([^`]+?)`/g, "$1");
      selected = selected.replace(/\{color:[^|}]+\|([^}]+?)\}/g, "$1");
      selected = selected.replace(/\{bg:[^|}]+\|([^}]+?)\}/g, "$1");
      selected = selected.replace(/\{size:[^|}]+\|([^}]+?)\}/g, "$1");
      els.editor.setRangeText(selected, start, end);
      els.editor.focus();
      els.editor.setSelectionRange(start, start + selected.length);
      els.editor.dispatchEvent(new Event("input", { bubbles: true }));
    },
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

async function createBoundedImageBitmap(source, maxSide) {
  try {
    return await createImageBitmap(source, {
      resizeWidth: Math.max(1, Math.round(maxSide)),
      resizeQuality: "high",
    });
  } catch {
    return createImageBitmap(source);
  }
}

async function compressImage(file) {
  const bitmap = await createBoundedImageBitmap(file, 1600);
  const maxSide = 1600;
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  bitmap.close?.();
  canvas.width = 1;
  canvas.height = 1;
  return blob || file;
}

async function handleEditorPaste(event) {
  const image = [...(event.clipboardData?.items || [])]
    .find((item) => item.kind === "file" && item.type.startsWith("image/"))
    ?.getAsFile();
  if (image) {
    event.preventDefault();
    try {
      const compressed = await compressImage(image);
      const dataUrl = await blobToDataUrl(compressed);
      const targetWorkspaceId = resolveScreenshotWorkspaceId();
      const uploaded = await api.post("/api/asset", {
        dataUrl,
        name: `screenshot-${Date.now()}.webp`,
        workspaceId: targetWorkspaceId || undefined,
      });
      if (!uploaded || !uploaded.markdown) {
        throw new Error("服务器返回格式异常（缺少 markdown 字段）");
      }
      insertAtCursor(`\n${uploaded.markdown}\n`);
      if (!state.previewVisible) setPreviewVisible(true, { automatic: true });
      schedulePreviewUpdate({ immediate: true });
    } catch (e) {
      showToast(`粘贴截图失败：${e.message || e}`);
    }
    return;
  }
  const textValue = event.clipboardData?.getData("text/plain") || "";
  const cursor = els.editor.selectionStart ?? 0;
  if (shouldWrapPastedCode(textValue) && !cursorInsideFence(els.editor.value, cursor)) {
    event.preventDefault();
    const language = detectPastedCodeLanguage(textValue);
    insertAtCursor(`\n\`\`\`${language}\n${textValue.trim()}\n\`\`\`\n`);
  }
}

function resolveScreenshotWorkspaceId() {
  const mode = localStorage.getItem("screenshotSaveLocation") || "workspace";
  // Extract workspace id from path — can be separated by ":" OR "/"
  // e.g. "ws_6c24c9ac:/xxx/xxx.md"  →  "ws_6c24c9ac"
  // e.g. "ws_6c24c9ac/pon/xxx.md"   →  "ws_6c24c9ac"
  function extractWsId(path) {
    if (!path) return "";
    // splitWorkspaceRef returns { id: everything-before-:, relative } or { id: whole, relative: "" }
    const ref = splitWorkspaceRef(path);
    if (ref.id && !ref.relative) {
      // No colon separator → path itself might be "ws_id/relative" → extract first segment
      const slashIdx = ref.id.indexOf("/");
      if (slashIdx > 0) return ref.id.slice(0, slashIdx);
    }
    return ref.id || "";
  }

  let result = "";
  if (mode === "default") {
    const d = state.defaultWorkspaceId;
    if (d && d !== "default") result = d;
    else if (d === "default") result = "default";
  } else {
    const fromPath = extractWsId(state.currentPath);
    if (fromPath) result = fromPath;
    else if (state.activeWorkspaceId) {
      const a = extractWsId(state.activeWorkspaceId);
      if (a) result = a;
    }
    if (!result && state.defaultWorkspaceId) result = state.defaultWorkspaceId;
  }
  console.log("[截图] resolveScreenshotWorkspaceId →", {
    mode, currentPath: state.currentPath, activeWs: state.activeWorkspaceId,
    defaultWs: state.defaultWorkspaceId, result
  });
  return result;
}

async function handleVideoUpload(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    showToast("请选择视频文件");
    return;
  }
  const targetWorkspaceId = resolveScreenshotWorkspaceId();
  const formData = new FormData();
  formData.append("video", file);
  if (targetWorkspaceId) formData.append("workspaceId", targetWorkspaceId);
  showToast(`正在上传视频（${formatFileSizeLocal(file.size)}）…`);
  try {
    const response = await fetch("/api/upload-video", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `上传失败 (${response.status})`);
    }
    const result = await response.json();
    insertAtCursor(`\n${result.markdown}\n`);
    if (!state.previewVisible) setPreviewVisible(true, { automatic: true });
    schedulePreviewUpdate({ immediate: true });
    const sizeNote = result.compressed
      ? `（已压缩至 ${formatFileSizeLocal(result.size)}，${result.note}）`
      : `（${formatFileSizeLocal(result.size)}）`;
    showToast(`视频已插入${sizeNote}`);
  } catch (e) {
    showToast(`视频上传失败：${e.message}`);
  }
}

function formatFileSizeLocal(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 1)} ${units[i]}`;
}

if (els.insertVideoBtn) {
  els.insertVideoBtn.addEventListener("click", () => {
    els.videoFileInput?.click();
  });
}
if (els.videoFileInput) {
  els.videoFileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) handleVideoUpload(file);
    e.target.value = "";
  });
}

els.searchInput.addEventListener("input", debounce(runSearch, 160));
els.searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && state.mode === "edit" && els.editor.openSearchPanelWithQuery) {
    const term = els.searchInput.value.trim();
    if (term) {
      e.preventDefault();
      els.editor.openSearchPanelWithQuery(term);
    }
  }
});
els.tree.addEventListener("dragover", allowRootDrop);
els.tree.addEventListener("dragleave", clearRootDrop);
els.tree.addEventListener("drop", dropOnRoot);

let treeContextMenu = null;
function showTreeContextMenu(x, y, items) {
  hideTreeContextMenu();
  const menu = document.createElement("div");
  menu.className = "tree-context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  items.forEach((item) => {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menu.append(sep);
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = item.label;
    if (item.disabled) btn.disabled = true;
    btn.addEventListener("click", () => {
      hideTreeContextMenu();
      item.action();
    });
    menu.append(btn);
  });
  document.body.append(menu);
  treeContextMenu = menu;
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;
  });
}
function hideTreeContextMenu() {
  if (treeContextMenu) {
    treeContextMenu.remove();
    treeContextMenu = null;
  }
}
document.addEventListener("click", hideTreeContextMenu);
document.addEventListener("contextmenu", hideTreeContextMenu);
els.tree.addEventListener("contextmenu", (e) => {
  const folderItem = e.target.closest(".folder-title");
  const workspaceHead = e.target.closest(".tree-workspace-head");
  const fileItem = e.target.closest(".file-item");
  if (!folderItem && !workspaceHead && !fileItem) return;
  e.preventDefault();
  e.stopPropagation();
  let path = "";
  let workspaceId = "";
  let isFolder = false;
  let isWorkspace = false;
  if (folderItem) {
    path = folderItem.dataset.treePath;
    workspaceId = folderItem.closest(".tree-workspace")?.dataset.workspaceId || "";
    isFolder = true;
  } else if (fileItem) {
    path = fileItem.dataset.treePath;
    workspaceId = fileItem.closest(".tree-workspace")?.dataset.workspaceId || "";
  } else if (workspaceHead) {
    const panel = workspaceHead.closest(".tree-workspace");
    workspaceId = panel?.dataset.workspaceId || "";
    const node = state.tree.find((n) => n.type === "workspace" && n.workspaceId === workspaceId);
    path = node?.path || "";
    isWorkspace = true;
  }
  if (!path && !isWorkspace) return;
  state.activeWorkspaceId = workspaceId;
  state.selectedFolder = path;
  state.folderExplicit = isFolder;
  const items = [];
  if (isFolder || isWorkspace) {
    items.push({ label: "新建文件", action: () => openCreateModal("file") });
    items.push({ label: "新建文件夹", action: () => openCreateModal("folder") });
    items.push({ separator: true });
  }
  if (fileItem) {
    items.push({ label: "打开", action: () => openDoc(path) });
    items.push({ separator: true });
  }
  if (isFolder) {
    items.push({ label: "重命名", action: () => renameTreeItem(path) });
    items.push({ label: "删除", action: () => deleteTreeItem(path) });
    items.push({ separator: true });
    items.push({ label: "复制路径", action: () => { navigator.clipboard.writeText(path); showToast("已复制路径"); } });
  }
  if (fileItem) {
    items.push({ label: "复制路径", action: () => { navigator.clipboard.writeText(path); showToast("已复制路径"); } });
  }
  if (items.length === 0) return;
  showTreeContextMenu(e.clientX, e.clientY, items);
});

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
  if (els.editor.contains(event.target)) {
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
  const target = event.target;
  const editableTarget = target && typeof target.closest === "function"
    && (target.closest(".cm-editor") || target.closest("input, textarea, select, [contenteditable='true']"));
  const inFormField = target && typeof target.closest === "function"
    && target.closest("input, textarea, select, [contenteditable='true']");
  if (event.key === "F2" && !inFormField && !event.defaultPrevented) {
    event.preventDefault();
    renameCurrentDoc();
    return;
  }
  // Ctrl/Cmd + Q: 显示/隐藏工作区目录（编辑模式下也生效）
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "q") {
    event.preventDefault();
    event.stopPropagation();
    setSidebarCollapsed(!state.sidebarCollapsed);
    return;
  }
  // Alt + Q: 编辑模式下显示/隐藏大纲目录
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "q" && state.mode === "edit") {
    event.preventDefault();
    event.stopPropagation();
    setEditorOutlineVisible(!state.editorOutlineVisible);
    return;
  }
  // Alt + W: 编辑模式下显示/隐藏预览栏
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "w" && state.mode === "edit") {
    event.preventDefault();
    event.stopPropagation();
    setPreviewVisible(!state.previewVisible);
    return;
  }
  // Alt + E: 切换编辑/阅读模式
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "e") {
    event.preventDefault();
    event.stopPropagation();
    const next = state.mode === "edit" ? "view" : "edit";
    setMode(next);
    return;
  }
  // Alt + O: 切换沉浸模式
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    event.stopPropagation();
    setImmersiveEditing(!state.immersive);
    return;
  }
  // Ctrl/Cmd + +/-: 编辑模式下调整编辑器字体大小
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === "=" || event.key === "+")) {
    event.preventDefault();
    event.stopPropagation();
    adjustEditorFontSize(1);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === "-") {
    event.preventDefault();
    event.stopPropagation();
    adjustEditorFontSize(-1);
    return;
  }
  // Ctrl/Cmd + 0: 重置编辑器字体大小
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === "0") {
    event.preventDefault();
    event.stopPropagation();
    adjustEditorFontSize(0);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "u") {
    event.preventDefault();
    toggleAiDrawer(!state.ai.open);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "i" && state.mode === "edit") {
    event.preventDefault();
    openAiInlineDialog();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "i") {
    if (inFormField) return;
    event.preventDefault();
    openImportModal();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
    if (editableTarget) return;
    event.preventDefault();
    return setImmersiveEditing(!state.immersive);
  }
  if (event.key === "Escape" && state.immersive) {
    if (editableTarget) return;
    event.preventDefault();
    return setImmersiveEditing(false);
  }
  if (editableTarget) return;
  if ((event.ctrlKey || event.metaKey) && event.key && event.key.toLowerCase() === "c") return keyboardCopy(event);
  if ((event.ctrlKey || event.metaKey) && event.key && event.key.toLowerCase() === "v") return keyboardPaste(event);
  if ((event.ctrlKey || event.metaKey) && event.key && event.key.toLowerCase() === "d") return keyboardDelete(event);
  if (event.key === "Delete") return keyboardDelete(event);
});

// ===== 双击 Shift 唤起全局搜索 =====
const _shiftTracker = { lastTime: 0 };
document.addEventListener("keydown", (event) => {
  if (event.key === "Shift" && !event.repeat) {
    const now = Date.now();
    if (now - _shiftTracker.lastTime < 350) {
      event.preventDefault();
      _shiftTracker.lastTime = 0;
      openGlobalSearch();
    } else {
      _shiftTracker.lastTime = now;
    }
  } else if (event.key !== "Shift") {
    _shiftTracker.lastTime = 0;
  }
});

// ===== 全局搜索 =====
const gsOverlay = document.getElementById("globalSearchOverlay");
const gsInput = document.getElementById("globalSearchInput");
const gsResults = document.getElementById("globalSearchResults");
const gsCount = document.getElementById("globalSearchCount");
let gsSeq = 0;
let gsSelectedIndex = -1;
let gsCurrentItems = [];
let gsDisplayOrder = [];

function openGlobalSearch() {
  if (!gsOverlay) return;
  gsOverlay.classList.remove("hidden");
  gsInput.value = "";
  gsResults.innerHTML = "";
  gsCount.textContent = "";
  gsCurrentItems = [];
  gsSelectedIndex = -1;
  requestAnimationFrame(() => gsInput.focus());
}

function closeGlobalSearch() {
  gsOverlay.classList.add("hidden");
}

gsOverlay?.addEventListener("click", (e) => {
  if (e.target === gsOverlay) closeGlobalSearch();
});

function escapeHtmlGs(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function highlightSnippet(text, query) {
  const escaped = escapeHtmlGs(text);
  if (!query) return escaped;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return escaped;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 60);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const before = escapeHtmlGs(text.slice(start, idx));
  const match = escapeHtmlGs(text.slice(idx, idx + query.length));
  const after = escapeHtmlGs(text.slice(idx + query.length, end));
  return prefix + before + `<mark>${match}</mark>` + after + suffix;
}

const gsDebounced = debounce(async (query) => {
  const seq = ++gsSeq;
  if (!query) {
    gsResults.innerHTML = "";
    gsCount.textContent = "";
    gsCurrentItems = [];
    gsDisplayOrder = [];
    gsSelectedIndex = -1;
    return;
  }
  try {
    const { results } = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
    if (seq !== gsSeq) return;
    gsCurrentItems = results.slice(0, 50);
    gsCount.textContent = `${results.length} 个结果`;
    if (!gsCurrentItems.length) {
      gsResults.innerHTML = `<div style="text-align:center;padding:32px 0;color:var(--muted,#999);font-size:13px;">未找到匹配内容</div>`;
      gsDisplayOrder = [];
      gsSelectedIndex = -1;
      return;
    }
    // 按文件分组，记录渲染顺序与原始数组索引的映射（gsDisplayOrder 按显示顺序存 origIdx）
    const groups = {};
    const order = [];
    for (let i = 0; i < gsCurrentItems.length; i++) {
      const item = gsCurrentItems[i];
      const file = state.flatFiles.find((f) => f.path === item.path) || item;
      const refPath = displayRelativePath(item.path); const folder = refPath.split(/[\\/]/).slice(0, -1).join("/") || "根目录";
      if (!groups[folder]) { groups[folder] = []; order.push(folder); }
      groups[folder].push({ item, file, origIdx: i });
    }
    gsDisplayOrder = [];
    let html = "";
    for (const folder of order) {
      html += `<div class="global-search-group">${escapeHtmlGs(folder)}</div>`;
      for (const { item, file, origIdx } of groups[folder]) {
        gsDisplayOrder.push(origIdx);
        html += `<button class="global-search-item" data-idx="${origIdx}" data-path="${escapeHtmlGs(item.path)}" data-query="${escapeHtmlGs(query)}">
          <span class="global-search-item-title">${escapeHtmlGs(displayName(file))}</span>
          <span class="global-search-item-path">${escapeHtmlGs(displayRelativePath(item.path))}</span>
          <span class="global-search-item-snippet">${highlightSnippet(item.snippet || item.content || "", query)}</span>
        </button>`;
      }
    }
    gsSelectedIndex = gsDisplayOrder.length ? 0 : -1;
    gsResults.innerHTML = html;
    updateGsSelection();
  } catch (err) {
    gsResults.innerHTML = `<div style="text-align:center;padding:24px;color:var(--warn,#d97706);font-size:13px;">搜索出错，请重试</div>`;
  }
}, 200);

gsInput?.addEventListener("input", () => {
  gsDebounced(gsInput.value.trim());
});

gsInput?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeGlobalSearch(); return; }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (gsDisplayOrder.length === 0) return;
    gsSelectedIndex = Math.min(gsSelectedIndex + 1, gsDisplayOrder.length - 1);
    updateGsSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (gsDisplayOrder.length === 0) return;
    gsSelectedIndex = Math.max(gsSelectedIndex - 1, 0);
    updateGsSelection();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (gsSelectedIndex >= 0 && gsSelectedIndex < gsDisplayOrder.length) {
      const origIdx = gsDisplayOrder[gsSelectedIndex];
      openGsResult(gsCurrentItems[origIdx], gsInput.value.trim());
    }
  }
});

function updateGsSelection() {
  const currentOrigIdx = (gsSelectedIndex >= 0 && gsSelectedIndex < gsDisplayOrder.length)
    ? gsDisplayOrder[gsSelectedIndex] : -1;
  gsResults.querySelectorAll(".global-search-item").forEach((el) => {
    el.classList.toggle("selected", Number(el.dataset.idx) === currentOrigIdx);
  });
  const sel = gsResults.querySelector(".global-search-item.selected");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

gsResults?.addEventListener("click", (e) => {
  const btn = e.target.closest(".global-search-item");
  if (!btn) return;
  const origIdx = Number(btn.dataset.idx);
  if (origIdx >= 0 && origIdx < gsCurrentItems.length) {
    gsSelectedIndex = gsDisplayOrder.indexOf(origIdx);
    openGsResult(gsCurrentItems[origIdx], gsInput.value.trim());
  }
});

function openGsResult(item, query) {
  closeGlobalSearch();
  // 跳过 setMode 的旧内容渲染：openDoc 马上会渲染新文档，避免重复渲染与闪烁
  setMode("view", { deferReaderRender: true });
  openDoc(item.path, { searchTerm: query });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && gsOverlay && !gsOverlay.classList.contains("hidden")) {
    closeGlobalSearch();
  }
});

if (els.workspaceBtn) {
  els.workspaceBtn.addEventListener("click", openWorkspaceModal);
}

(function initMenuBar() {
  const menuItems = document.querySelectorAll(".menu-item");
  const dropdowns = document.querySelectorAll(".menu-dropdown");
  const menuDropdowns = document.getElementById("menuDropdowns");
  if (!menuItems.length || !menuDropdowns) return;

  function closeAllMenus() {
    menuItems.forEach((m) => m.classList.remove("active"));
    dropdowns.forEach((d) => d.classList.add("hidden"));
  }

  function positionDropdown(item, dropdown) {
    const itemRect = item.getBoundingClientRect();
    const dropdownWidth = dropdown.offsetWidth || 220;
    const dropdownHeight = dropdown.offsetHeight || 0;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    let left = Math.round(itemRect.left);
    // 右侧溢出时向左收束，保证下拉菜单完整可见
    if (left + dropdownWidth > viewportWidth - 8) {
      left = Math.max(8, Math.round(viewportWidth - dropdownWidth - 8));
    }
    let top = Math.round(itemRect.bottom + 4);
    // 底部溢出时上移贴近视口底部
    if (dropdownHeight > 0 && top + dropdownHeight > viewportHeight - 8) {
      top = Math.max(8, Math.round(viewportHeight - dropdownHeight - 8));
    }
    dropdown.style.left = left + "px";
    dropdown.style.top = top + "px";
  }

  menuItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = item.dataset.menu;
      const dropdown = menuDropdowns.querySelector(`.menu-dropdown[data-dropdown="${name}"]`);
      const isActive = item.classList.contains("active");
      closeAllMenus();
      if (!isActive && dropdown) {
        item.classList.add("active");
        dropdown.classList.remove("hidden");
        positionDropdown(item, dropdown);
      }
    });

    item.addEventListener("mouseenter", () => {
      if (menuDropdowns.querySelector(".menu-item.active")) {
        closeAllMenus();
        item.classList.add("active");
        const dropdown = menuDropdowns.querySelector(`.menu-dropdown[data-dropdown="${item.dataset.menu}"]`);
        if (dropdown) {
          dropdown.classList.remove("hidden");
          positionDropdown(item, dropdown);
        }
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-item") && !e.target.closest(".menu-dropdown")) {
      closeAllMenus();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllMenus();
  });

  // 窗口尺寸变化后菜单项位置会偏移，直接关闭已展开的下拉，避免错位

  const actions = {
    "new-doc": () => openCreateModal("doc"),
    "new-folder": () => openCreateModal("folder"),
    save: () => saveCurrentDoc(),
    "rename-doc": () => renameCurrentDoc(),
    workspace: () => openWorkspaceModal(),
    "export-html": () => exportCurrentDoc("html"),
    "export-docx": () => exportCurrentDoc("docx"),
    "export-pdf": () => exportCurrentDocToPdf(),
    "export-ppt": () => exportCurrentDocToPpt(),
    "export-txt": () => exportCurrentDoc("txt"),
    "export-md": () => exportCurrentDoc("md"),
    "export-wechat": () => copyCurrentDocAsWechat(),
    settings: () => openSettings(),
    "toggle-edit": () => state.currentPath && setMode("edit"),
    "toggle-reading": () => state.currentPath && setMode("view"),
    "toggle-sidebar": () => setSidebarCollapsed(!state.sidebarCollapsed),
    "toggle-outline": () => state.currentPath && setEditorOutlineVisible(!state.editorOutlineVisible),
    "zoom-in": () => applyWindowZoom((parseInt(els.windowZoom?.value) || 100) + 10),
    "zoom-out": () => applyWindowZoom((parseInt(els.windowZoom?.value) || 100) - 10),
    "zoom-reset": () => applyWindowZoom(100),
    undo: () => { const ed = els.editor; if (ed) document.execCommand("undo"); },
    redo: () => { const ed = els.editor; if (ed) document.execCommand("redo"); },
    find: () => { if (state.mode === "edit" && state.currentPath) openEditorSearch(); else els.searchInput?.focus(); },
    replace: () => els.searchInput?.focus(),
    "import-file": () => openImportModal(),
    "import-txt": () => openImportModal("txt"),
    "import-html": () => openImportModal("html"),
    "import-csv": () => openImportModal("csv"),
    "import-json": () => openImportModal("json"),
  };

  document.querySelectorAll(".menu-option").forEach((option) => {
    option.addEventListener("click", () => {
      const action = option.dataset.action;
      const fn = actions[action];
      if (fn) fn();
      closeAllMenus();
    });
  });
})();

let importFiles = [];

function openImportModal(format) {
  importFiles = [];
  renderImportFileList();
  els.importModal?.classList.remove("hidden");
}

function closeImportModal() {
  importFiles = [];
  renderImportFileList();
  els.importModal?.classList.add("hidden");
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getFileIcon(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const icons = {
    pdf: "📄", docx: "📝", doc: "📝", html: "🌐", htm: "🌐",
    pptx: "📊", ppt: "📊", xlsx: "📗", xls: "📗", csv: "📊",
    odt: "📝", rtf: "📝", epub: "📘", txt: "📝", md: "📄",
    tex: "📐", png: "🖼️", jpg: "🖼️", jpeg: "🖼️", webp: "🖼️", gif: "🖼️",
    json: "📋",
  };
  return icons[ext] || "📄";
}

function renderImportFileList() {
  if (!els.importFileList) return;
  els.importFileList.innerHTML = "";
  importFiles.forEach((file, idx) => {
    const item = document.createElement("div");
    item.className = "import-file-item";
    item.innerHTML = `
      <span class="import-file-item-icon">${getFileIcon(file.name)}</span>
      <span class="import-file-item-name" title="${file.name}">${file.name}</span>
      <span class="import-file-item-size">${formatFileSize(file.size)}</span>
      <button class="import-file-item-remove" title="移除" data-idx="${idx}">×</button>
    `;
    els.importFileList.appendChild(item);
  });
  els.confirmImportBtn.disabled = importFiles.length === 0;
}

function addImportFiles(fileList) {
  for (const file of fileList) {
    if (file.size > 50 * 1024 * 1024) {
      showToast(`文件 ${file.name} 超过 50MB，已跳过`);
      continue;
    }
    importFiles.push(file);
  }
  renderImportFileList();
}

function removeImportFile(idx) {
  importFiles.splice(idx, 1);
  renderImportFileList();
}

function convertFileToMarkdown(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const baseName = file.name.replace(/\.[^.]+$/, "");

  const binaryExts = ["pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "odt", "rtf", "epub", "tex"];
  const imageExts = ["png", "jpg", "jpeg", "webp", "gif"];

  if (binaryExts.includes(ext)) {
    const content = `# ${baseName}\n\n> 此文件为 .${ext.toUpperCase()} 格式，已创建占位文档。如需转换为 Markdown，请使用专业工具（如 pandoc）转换后再导入。\n\n\`\`\`\n[原始文件: ${file.name}]\n大小: ${formatFileSize(file.size)}\n\`\`\``;
    return Promise.resolve({ title: baseName, content, ext });
  }

  if (imageExts.includes(ext)) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const content = await imageToMarkdown(file, reader.result, baseName);
          resolve({ title: baseName, content, ext });
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        let content = "";
        let title = baseName;

        if (["txt", "md"].includes(ext)) {
          content = reader.result;
          if (ext === "txt") {
            content = `# ${baseName}\n\n${content}`;
          }
        } else if (ext === "csv") {
          content = csvToMarkdown(reader.result);
        } else if (["html", "htm"].includes(ext)) {
          content = htmlToMarkdown(reader.result);
        } else if (ext === "json") {
          try {
            const parsed = JSON.parse(reader.result);
            content = `# ${baseName}\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
          } catch {
            content = `# ${baseName}\n\n\`\`\`json\n${reader.result}\n\`\`\``;
          }
        } else {
          content = `# ${baseName}\n\n${reader.result}`;
        }

        resolve({ title, content, ext });
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function csvToMarkdown(csv) {
  const lines = csv.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "";

  const parseRow = (line) => {
    const cells = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += ch;
      }
    }
    cells.push(cell.trim());
    return cells;
  };

  const headers = parseRow(lines[0]);
  let md = "| " + headers.join(" | ") + " |\n";
  md += "| " + headers.map(() => "---").join(" | ") + " |\n";
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    md += "| " + row.map((c) => c || " ").join(" | ") + " |\n";
  }
  return md;
}

function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let md = "";

  const convertNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      md += node.textContent;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    const children = Array.from(node.childNodes);

    switch (tag) {
      case "h1": md += "\n# "; break;
      case "h2": md += "\n## "; break;
      case "h3": md += "\n### "; break;
      case "h4": md += "\n#### "; break;
      case "h5": md += "\n##### "; break;
      case "h6": md += "\n###### "; break;
      case "p": md += "\n\n"; break;
      case "br": md += "\n"; break;
      case "strong":
      case "b": md += "**"; break;
      case "em":
      case "i": md += "*"; break;
      case "code": md += "`"; break;
      case "a": {
        const href = node.getAttribute("href") || "";
        md += "[";
        children.forEach(convertNode);
        md += `](${href})`;
        return;
      }
      case "img": {
        const src = node.getAttribute("src") || "";
        const alt = node.getAttribute("alt") || "";
        md += `![${alt}](${src})`;
        return;
      }
      case "ul":
      case "ol": {
        md += "\n";
        const items = node.querySelectorAll(":scope > li");
        items.forEach((li, i) => {
          md += tag === "ol" ? `${i + 1}. ` : "- ";
          md += li.textContent.trim() + "\n";
        });
        return;
      }
      case "table": {
        md += "\n";
        const trs = node.querySelectorAll("tr");
        trs.forEach((tr, ri) => {
          const tds = tr.querySelectorAll("th,td");
          md += "| " + Array.from(tds).map((td) => td.textContent.trim()).join(" | ") + " |\n";
          if (ri === 0) {
            md += "| " + Array.from(tds).map(() => "---").join(" | ") + " |\n";
          }
        });
        return;
      }
      case "blockquote": md += "\n> "; break;
      case "pre": md += "\n```\n"; break;
      case "script":
      case "style":
      case "head":
      case "meta":
      case "link":
      case "title":
        return;
      default: break;
    }

    children.forEach(convertNode);

    switch (tag) {
      case "strong":
      case "b": md += "**"; break;
      case "em":
      case "i": md += "*"; break;
      case "code": md += "`"; break;
      case "pre": md += "\n```\n"; break;
      case "p": md += "\n"; break;
      case "blockquote": md += "\n"; break;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        md += "\n"; break;
    }
  };

  convertNode(doc.body || doc.documentElement);
  return md.trim();
}

async function imageToMarkdown(file, dataUrl, baseName) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const fileName = `${Date.now()}_${baseName}.${ext}`;
  const targetWorkspaceId = resolveScreenshotWorkspaceId();
  try {
    const resp = await fetch("/api/asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl, name: fileName, workspaceId: targetWorkspaceId || undefined }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.markdown) return data.markdown;
      const assetPath = data.path || `source/${fileName}`;
      return `![${baseName}](${assetPath})`;
    }
  } catch {}
  return `![${baseName}](${dataUrl})`;
}

async function confirmImport() {
  if (importFiles.length === 0) return;
  els.confirmImportBtn.disabled = true;
  els.confirmImportBtn.textContent = "导入中...";

  const visibleWorkspaces = state.workspaces.filter((ws) => ws.visible);
  const workspaceId =
    state.activeWorkspaceId ||
    state.defaultWorkspaceId ||
    (visibleWorkspaces.length > 0 ? visibleWorkspaces[0].id : null);
  if (!workspaceId) {
    showToast("没有可用的工作路径");
    els.confirmImportBtn.disabled = false;
    els.confirmImportBtn.textContent = "导入";
    return;
  }

  let importedCount = 0;
  let failedCount = 0;

  for (const file of importFiles) {
    try {
      const fileData = await readFileAsBase64(file);
      const resp = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileData, workspaceId }),
      });
      if (resp.ok) {
        importedCount++;
      } else {
        const err = await resp.json().catch(() => ({}));
        console.error("Import failed for", file.name, err.error);
        failedCount++;
      }
    } catch (e) {
      console.error("Import failed for", file.name, e);
      failedCount++;
    }
  }

  closeImportModal();

  if (importedCount > 0) {
    try {
      await bootstrap(true);
    } catch (e) {
      console.warn("Bootstrap after import failed:", e);
    }
    showToast(`成功导入 ${importedCount} 个文档`);
  }
  if (failedCount > 0) {
    showToast(`${failedCount} 个文件导入失败`);
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = result.split(",")[1] || result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

if (els.importDropZone) {
  els.importDropZone.addEventListener("click", () => {
    els.importFileInput?.click();
  });

  els.importDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.importDropZone.classList.add("dragover");
  });

  els.importDropZone.addEventListener("dragleave", () => {
    els.importDropZone.classList.remove("dragover");
  });

  els.importDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.importDropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) {
      addImportFiles(e.dataTransfer.files);
    }
  });
}

if (els.importFileInput) {
  els.importFileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      addImportFiles(e.target.files);
    }
    e.target.value = "";
  });
}

if (els.importFileList) {
  els.importFileList.addEventListener("click", (e) => {
    if (e.target.classList.contains("import-file-item-remove")) {
      const idx = parseInt(e.target.dataset.idx, 10);
      removeImportFile(idx);
    }
  });
}

if (els.closeImportBtn) {
  els.closeImportBtn.addEventListener("click", closeImportModal);
}
if (els.cancelImportBtn) {
  els.cancelImportBtn.addEventListener("click", closeImportModal);
}
if (els.browseImportBtn) {
  els.browseImportBtn.addEventListener("click", () => {
    els.importFileInput?.click();
  });
}
if (els.confirmImportBtn) {
  els.confirmImportBtn.addEventListener("click", confirmImport);
}
if (els.importModal) {
  els.importModal.addEventListener("click", (e) => {
    if (e.target === els.importModal) closeImportModal();
  });
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
  const img = event.target.closest("img");
  if (img && !img.closest(".code-block")) {
    event.preventDefault();
    openImagePreview(img.src, img.alt || "");
    return;
  }
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
  event.stopPropagation();
  const label = link.dataset.docLink.toLowerCase();
  const file = state.flatFiles.find((item) => item.title.toLowerCase() === label || item.path.toLowerCase().endsWith(`${label}.md`));
  if (file) openDoc(file.path);
  else showToast("未找到对应文档");
});
els.markdownView.addEventListener("copy", (event) => {
  const selection = window.getSelection();
  if (selection && selection.toString().trim()) {
    showToast("已复制到剪贴板");
  }
});
els.preview.addEventListener("click", async (event) => {
  const img = event.target.closest("img");
  if (img && !img.closest(".code-block")) {
    event.preventDefault();
    openImagePreview(img.src, img.alt || "");
    return;
  }
  // 需求8：编辑模式预览栏中，http/https/mailto/tel 链接不内部打开，
  // 跳转到系统默认浏览器，减少内嵌 WebView 或当前页签离开导致的稳定性损失。
  const link = event.target.closest("a[href]");
  if (link && link.getAttribute("href")) {
    const href = link.getAttribute("href");
    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      event.preventDefault();
      event.stopPropagation();
      try {
        await api.post("/api/open-url", { url: href });
      } catch (_) {
        // 失败回退：新标签打开，避免当前页签被替换离开应用
        window.open(href, "_blank", "noopener,noreferrer");
      }
      return;
    }
  }
  const wikiLink = event.target.closest("[data-doc-link]");
  if (wikiLink) {
    event.preventDefault();
    event.stopPropagation();
    const label = wikiLink.dataset.docLink.toLowerCase();
    const file = state.flatFiles.find((item) => item.title.toLowerCase() === label || item.path.toLowerCase().endsWith(`${label}.md`));
    if (file) openDoc(file.path);
    else showToast("未找到对应文档");
    return;
  }
  const taskInput = event.target.closest("input[data-task-line]");
  if (taskInput) {
    event.stopPropagation();
    toggleMarkdownTask(taskInput);
    return;
  }
  const tableTool = event.target.closest("[data-table-action]");
  if (tableTool) {
    event.stopPropagation();
    const tools = tableTool.closest(".md-table-tools");
    const start = tools?.dataset.tableStart;
    if (start != null) expandMarkdownTable(start, tableTool.dataset.tableAction);
    return;
  }
  const copy = event.target.closest(".code-copy");
  if (!copy) return;
  const code = copy.closest(".code-block")?.querySelector("code")?.innerText || "";
  navigator.clipboard?.writeText(code).then(() => showToast("\u4ee3\u7801\u5df2\u590d\u5236"));
});
// 需求8：阅读模式（阅读栏）markdownView 中链接同样处理：外部链接走系统默认浏览器
els.markdownView.addEventListener("click", async (event) => {
  const img = event.target.closest("img");
  if (img && !img.closest(".code-block")) {
    event.preventDefault();
    openImagePreview(img.src, img.alt || "");
    return;
  }
  const wikiLink = event.target.closest("[data-doc-link]");
  if (wikiLink) return;
  const link = event.target.closest("a[href]");
  if (link && link.getAttribute("href")) {
    const href = link.getAttribute("href");
    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      event.preventDefault();
      try {
        await api.post("/api/open-url", { url: href });
      } catch (_) {
        window.open(href, "_blank", "noopener,noreferrer");
      }
      return;
    }
  }
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
  scheduleAutoSave();
  saveDraft();
  hideAiEditHintPopover();
  scheduleAiEditHint();
});
els.editor.addEventListener("compositionstart", () => {
  state.autoSave.composing = true;
  clearAiEditHintTimer();
});
els.editor.addEventListener("compositionend", () => {
  state.autoSave.composing = false;
  scheduleAutoSave();
  scheduleAiEditHint();
});
els.editor.addEventListener("select", () => { syncPreviewToEditor(); scheduleAiEditHint(); }, { passive: true });

function addLineCursor(direction) {
  const value = els.editor.value;
  const start = els.editor.selectionStart ?? 0;
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const column = start - lineStart;
  const targetStart = direction < 0 ? lineStart - 1 : value.indexOf("\n", start);
  if (targetStart < 0 || targetStart > value.length) return false;
  const nextLineStart = direction < 0
    ? value.lastIndexOf("\n", Math.max(0, targetStart - 1)) + 1
    : targetStart + 1;
  const nextLineEnd = value.indexOf("\n", nextLineStart);
  const target = Math.min(nextLineStart + column, nextLineEnd < 0 ? value.length : nextLineEnd);
  if (target === start || state.secondaryCursors.includes(target)) return false;
  state.secondaryCursors = [...new Set([...state.secondaryCursors, target])].sort((a, b) => a - b);
  lastInputLength = value.length;
  lastInputValue = value;
  updateMultiCursorDisplay();
  return true;
}

function selectAllMatchingWords() {
  const value = els.editor.value;
  let start = els.editor.selectionStart ?? 0;
  let end = els.editor.selectionEnd ?? start;
  if (start === end) {
    const match = value.slice(0, start).match(/[\\p{L}\\p{N}_-]+$/u);
    const right = value.slice(start).match(/^[\\p{L}\\p{N}_-]+/u);
    start -= match?.[0].length || 0;
    end += right?.[0].length || 0;
  }
  const word = value.slice(start, end);
  if (!word.trim()) return false;
  const positions = [];
  let cursor = 0;
  while (true) {
    const found = value.indexOf(word, cursor);
    if (found < 0) break;
    if (found !== start) positions.push(found);
    cursor = found + Math.max(1, word.length);
  }
  els.editor.setSelectionRange(start, end);
  state.secondaryCursors = positions;
  lastInputLength = value.length;
  lastInputValue = value;
  updateMultiCursorDisplay();
  return true;
}

els.editor.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  // 编辑器内 Ctrl/Cmd + +/-/0：调整编辑器字体大小。
  // 必须在这里（捕获到 #editor 本身的 keydown）高优先前置处理：
  // CodeMirror 会吞掉编辑区内的大量快捷键，document级监听常常拿不到事件，导致用户反馈"没生效"。
  // 对 +/-/= 三处位置均识别（= 键按 Shift 会生成 +，不按 Shift 就是 =，两者都是Ctrl+放大）。
  if (mod && !event.altKey && !event.shiftKey && (event.key === "=" || event.key === "+")) {
    event.preventDefault();
    event.stopPropagation();
    adjustEditorFontSize(1);
    return;
  }
  if (mod && !event.altKey && !event.shiftKey && event.key === "-") {
    event.preventDefault();
    event.stopPropagation();
    adjustEditorFontSize(-1);
    return;
  }
  if (mod && !event.altKey && !event.shiftKey && event.key === "0") {
    event.preventDefault();
    event.stopPropagation();
    adjustEditorFontSize(0);
    return;
  }
  const handled = (() => {
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      if (!els.editorSearchPopup.classList.contains("hidden")) {
        closeEditorSearch();
      } else {
        openEditorSearch();
      }
      return true;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      setImmersiveEditing(!state.immersive);
      return true;
    }
    if (event.key === "Escape" && state.immersive) {
      event.preventDefault();
      event.stopPropagation();
      setImmersiveEditing(false);
      return true;
    }
    if (expandSequenceOnEnter(event)) {
      event.stopPropagation();
      return true;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
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
      return true;
    }
    if (mod && event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      addLineCursor(event.key === "ArrowUp" ? -1 : 1);
      return true;
    }
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "i" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        openAiInlineDialog();
        return true;
      }
      if (key === "u" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        toggleAiDrawer(!state.ai.open);
        return true;
      }
      const format = {
        b: "bold",
        k: "link",
        "`": "code",
        "1": "h1",
        "2": "h2",
        "3": "h3",
      }[key];
      if (format && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        applyFormat(format);
        return true;
      }
      if (event.shiftKey && key === "7") {
        event.preventDefault();
        event.stopPropagation();
        applyFormat("ol");
        return true;
      }
      if (event.shiftKey && key === "8") {
        event.preventDefault();
        event.stopPropagation();
        applyFormat("ul");
        return true;
      }
    }
    if (mod && event.key === ";") {
      event.preventDefault();
      event.stopPropagation();
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      insertAtCursor(dateStr);
      return true;
    }
    if (mod && event.key === "'") {
      event.preventDefault();
      event.stopPropagation();
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      insertAtCursor(timeStr);
      return true;
    }
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      saveCurrentDoc({ refreshTree: true });
      return true;
    }
    // Ctrl+D 向下复制选中行（多行选区复制全部所选行）。
    // 直接在捕获阶段处理，避免 CodeMirror keymap 与搜索扩展的 Mod-d 冲突。
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      event.stopPropagation();
      const value = els.editor.value;
      const start = els.editor.selectionStart;
      const end = els.editor.selectionEnd;
      // 选区落在下一行行首时归属上一行，避免多复制一条空行。
      const effectiveEnd = Math.max(start, end - 1);
      const firstLineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      let lastLineEnd = value.indexOf("\n", effectiveEnd);
      if (lastLineEnd === -1) lastLineEnd = value.length;
      const text = value.slice(firstLineStart, lastLineEnd);
      const insert = "\n" + text;
      // 在最后一行行尾插入复制内容，保留滚动位置避免闪烁。
      const savedScrollTop = els.editor.scrollTop;
      const savedScrollLeft = els.editor.scrollLeft;
      els.editor.setRangeText(insert, lastLineEnd, lastLineEnd, "end");
      els.editor.scrollTop = savedScrollTop;
      els.editor.scrollLeft = savedScrollLeft;
      requestAnimationFrame(() => {
        els.editor.scrollTop = savedScrollTop;
        els.editor.scrollLeft = savedScrollLeft;
      });
      els.editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    // AI 快捷键：Ctrl+Shift+A 代码补全 / Ctrl+Shift+/ 生成注释 / Ctrl+Shift+P 润色 / Ctrl+Shift+X 续写
    if (mod && event.shiftKey) {
      const aiKey = event.key.toLowerCase();
      // Shift+/ 在多数键盘上产出 "?"，两者均识别为"生成注释"。
      const aiMode = { a: "code", "/": "comment", "?": "comment", p: "polish", x: "continue" }[aiKey];
      if (aiMode) {
        event.preventDefault();
        event.stopPropagation();
        runAiTransform(aiMode);
        return true;
      }
    }
    if (mod && event.key.toLowerCase() === "m") {
      event.preventDefault();
      event.stopPropagation();
      const value = els.editor.value;
      const start = els.editor.selectionStart;
      const end = els.editor.selectionEnd;
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = value.indexOf("\n", end);
      const removeEnd = lineEnd === -1 ? value.length : lineEnd + 1;
      // 保留编辑器滚动位置，避免删行后光标跳行与界面闪烁打断心流。
      const savedScrollTop = els.editor.scrollTop;
      const savedScrollLeft = els.editor.scrollLeft;
      els.editor.setRangeText("", lineStart, removeEnd, "start");
      const newCursorPos = Math.max(0, Math.min(els.editor.value.length, lineStart));
      els.editor.setSelectionRange(newCursorPos, newCursorPos);
      els.editor.scrollTop = savedScrollTop;
      els.editor.scrollLeft = savedScrollLeft;
      requestAnimationFrame(() => {
        els.editor.scrollTop = savedScrollTop;
        els.editor.scrollLeft = savedScrollLeft;
      });
      els.editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    if (event.altKey && event.shiftKey && !["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const value = els.editor.value;
      const start = els.editor.selectionStart;
      const lineNum = (pos) => value.substring(0, pos).split("\n").length;
      const posFromLine = (line) => {
        const lines = value.split("\n");
        if (line <= 1) return 0;
        if (line > lines.length) return value.length;
        return lines.slice(0, line - 1).reduce((acc, l) => acc + l.length + 1, 0);
      };
      const currentLine = lineNum(start);
      if (event.key === "ArrowDown") {
        if (currentLine < value.split("\n").length) {
          const targetPos = posFromLine(currentLine + 1);
          if (!state.secondaryCursors.includes(targetPos)) {
            state.secondaryCursors.push(targetPos);
            state.secondaryCursors.sort((a, b) => a - b);
          }
        }
      } else if (event.key === "ArrowUp") {
        if (currentLine > 1) {
          const targetPos = posFromLine(currentLine - 1);
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
      return true;
    }
    if (mod && !event.altKey && !event.shiftKey && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
      if (event.defaultPrevented) return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        undoEditor();
      } else {
        redoEditor();
      }
      return true;
    }
    return false;
  })();
  if (handled) return;
}, true);

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
  const oldValue = lastInputValue;
  let changeStart = 0;
  while (changeStart < oldValue.length && changeStart < newValue.length && oldValue[changeStart] === newValue[changeStart]) changeStart += 1;
  let oldTail = oldValue.length;
  let newTail = newValue.length;
  while (oldTail > changeStart && newTail > changeStart && oldValue[oldTail - 1] === newValue[newTail - 1]) {
    oldTail -= 1;
    newTail -= 1;
  }
  const removedText = oldValue.slice(changeStart, oldTail);
  const insertedText = newValue.slice(changeStart, newTail);
  const diff = newValue.length - lastInputLength;
  
  if (diff !== 0) {
    isMultiCursorEditing = true;
    
    const primaryStart = els.editor.selectionStart;
    const primaryEnd = els.editor.selectionEnd;
    const primaryDelta = insertedText.length - removedText.length;
    [...state.secondaryCursors].sort((a, b) => b - a).forEach((cursorPos) => {
      const targetPos = cursorPos + (cursorPos >= changeStart ? primaryDelta : 0);
      els.editor.value = els.editor.value.slice(0, targetPos) + insertedText + els.editor.value.slice(targetPos + removedText.length);
    });
    els.editor.selectionStart = primaryStart;
    els.editor.selectionEnd = primaryEnd;
    state.secondaryCursors = state.secondaryCursors.map(pos => pos + (pos >= changeStart ? primaryDelta : 0));
    
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
  const editorHost = els.editor.host || els.editor;
  const editorRect = editorHost.getBoundingClientRect();
  const panelRect = els.editorPanel.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(editorHost);
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

els.editor.addEventListener("scroll", () => {
  syncPreviewToEditor(false);
  hideAiEditHintPopover();
  updateMultiCursorDisplay();
}, { passive: true });

// Capture before CodeMirror's native paste handler so auto-wrapping replaces
// the paste instead of inserting a second, unwrapped copy afterwards.
els.editor.addEventListener("paste", handleEditorPaste, { capture: true });
els.sidebarResizer.addEventListener("pointerdown", startSidebarResize);
els.sidebarResizer.addEventListener("pointermove", moveSidebarResize);
els.sidebarResizer.addEventListener("pointerup", endSidebarResize);
els.sidebarResizer.addEventListener("pointercancel", endSidebarResize);
els.sidebarHideBtn.addEventListener("click", () => setSidebarCollapsed(true));
els.sidebarShowBtn.addEventListener("click", () => setSidebarCollapsed(!state.sidebarCollapsed));
els.aiBtn?.addEventListener("click", () => toggleAiDrawer());
els.aiCloseBtn?.addEventListener("click", () => toggleAiDrawer(false));
els.aiClearBtn?.addEventListener("click", () => {
  state.ai.messages = [];
  saveAiHistory();
  renderAiMessages();
  showToast("本地对话已清理");
});
els.aiRewriteBtn?.addEventListener("click", () => {
  state.ai.selection = null;
  runAiTransform("rewrite");
});
els.aiForm?.addEventListener("submit", submitAiQuestion);
els.aiQuestion?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitAiQuestion(event);
  }
});
els.aiMessages?.addEventListener("click", (event) => {
  const button = event.target.closest(".ai-source");
  if (button) jumpToAiSource({ path: button.dataset.path, heading: button.dataset.heading });
});
els.aiSelectionMenu?.addEventListener("pointerdown", (event) => event.preventDefault());
els.aiSelectionMenu?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-ai-transform]");
  if (button) runAiTransform(button.dataset.aiTransform);
});
els.aiTransformCloseBtn?.addEventListener("click", closeAiTransformModal);
els.aiTransformCancelBtn?.addEventListener("click", closeAiTransformModal);
els.aiTransformModal?.addEventListener("click", (event) => {
  if (event.target === els.aiTransformModal) closeAiTransformModal();
});
els.aiTransformGenerateBtn?.addEventListener("click", () => runAiTransform("rewrite", { preserveInstruction: true }));
els.aiTransformInsertBtn?.addEventListener("click", insertAiTransform);
els.aiTransformCreateBtn?.addEventListener("click", createAiTransformDocument);
document.addEventListener("selectionchange", debounce(refreshAiSelectionMenu, 80));
els.editor?.addEventListener("select", refreshAiSelectionMenu);
els.editor?.addEventListener("mouseup", refreshAiSelectionMenu);
els.editor?.addEventListener("keyup", refreshAiSelectionMenu);

async function openSettings() {
  applySettings();
  renderDefaultWorkspaceChoices();
  renderScreenshotSaveChoices();
  els.settingsModal.classList.remove("hidden");
  await checkLicenseStatus();
  await Promise.all([loadAiStatus(), loadAgentPolicyStatus()]);
}
els.settingsBtn?.addEventListener("click", openSettings);

els.goToLicenseBtn?.addEventListener("click", () => {
  els.licenseModal.classList.add("hidden");
  els.settingsModal.classList.remove("hidden");
  document.querySelectorAll(".settings-nav-item").forEach((t) => {
    t.classList.toggle("active", t.dataset.settingsTab === "license");
  });
  document.querySelectorAll(".settings-panel").forEach((p) => {
    p.classList.toggle("active", p.dataset.settingsPanel === "license");
  });
  checkLicenseStatus();
});

// 授权管理
async function checkLicenseStatus() {
  try {
    const result = await api.get("/api/license/check");
    if (result.activated) {
      state.licenseValidatedAt = Date.now();
      els.licenseUnactivated?.classList.add("hidden");
      els.licenseActivated?.classList.remove("hidden");
      if (els.activatedMachineCode) els.activatedMachineCode.textContent = result.machineCode || "";
      if (els.licenseExpiry) {
        if (result.expiry > 0) {
          els.licenseExpiry.textContent = new Date(result.expiry).toLocaleDateString("zh-CN");
          els.licenseExpiryRow.classList.remove("hidden");
        } else {
          els.licenseExpiry.textContent = "永久";
          els.licenseExpiryRow.classList.remove("hidden");
        }
      }
      if (result.timeRolledBack && els.licenseWarning) {
        els.licenseWarning.textContent = "⚠️ 检测到系统时间曾回拨，当前授权仍有效。请勿再次回拨时间。";
        els.licenseWarning.classList.remove("hidden");
      } else if (els.licenseWarning) {
        els.licenseWarning.classList.add("hidden");
      }
    } else {
      state.licenseValidatedAt = 0;
      els.licenseUnactivated?.classList.remove("hidden");
      els.licenseActivated?.classList.add("hidden");
      if (els.machineCodeDisplay) els.machineCodeDisplay.textContent = result.machineCode || "获取失败";
      if (els.licenseWarning && result.error && result.error.includes("时间回拨")) {
        els.licenseWarning.textContent = `⚠️ ${result.error}`;
        els.licenseWarning.classList.remove("hidden");
      } else if (els.licenseWarning) {
        els.licenseWarning.classList.add("hidden");
      }
    }
    return result;
  } catch (err) {
    console.error("License check failed:", err);
    els.licenseActivated?.classList.add("hidden");
    els.licenseUnactivated?.classList.remove("hidden");
    if (els.licenseWarning) {
      els.licenseWarning.textContent = "授权状态暂时无法确认，请稍后重试";
      els.licenseWarning.classList.remove("hidden");
    }
    return { activated: false };
  }
}

async function openLicenseModal() {
  els.settingsModal.classList.remove("hidden");
  document.querySelectorAll(".settings-nav-item").forEach((t) => {
    t.classList.toggle("active", t.dataset.settingsTab === "license");
  });
  document.querySelectorAll(".settings-panel").forEach((p) => {
    p.classList.toggle("active", p.dataset.settingsPanel === "license");
  });
  await checkLicenseStatus();
}

if (els.licenseModal) {
  els.licenseModal.addEventListener("click", (event) => {
    if (startupLicensePending) return;
    if (event.target === els.licenseModal) els.licenseModal.classList.add("hidden");
  });
}
if (els.copyMachineCodeBtn) {
  els.copyMachineCodeBtn.addEventListener("click", async () => {
    const code = els.machineCodeDisplay?.textContent || "";
    if (!code || code === "加载中...") return;
    try {
      await navigator.clipboard.writeText(code);
      els.copyMachineCodeBtn.textContent = "已复制";
      setTimeout(() => { els.copyMachineCodeBtn.textContent = "复制"; }, 2000);
    } catch (_) {
      els.machineCodeDisplay?.select?.();
      document.execCommand?.("copy");
    }
  });
}
if (els.activateLicenseBtn) {
  els.activateLicenseBtn.addEventListener("click", async () => {
    const licenseKey = els.licenseKeyInput?.value?.trim();
    if (!licenseKey) {
      els.licenseStatus.textContent = "请输入授权码";
      els.licenseStatus.className = "license-status error";
      return;
    }
    els.activateLicenseBtn.disabled = true;
    els.activateLicenseBtn.textContent = "验证中...";
    try {
      const result = await api.post("/api/license/activate", { licenseKey });
      if (result.valid) {
        els.licenseStatus.textContent = "激活成功！";
        els.licenseStatus.className = "license-status success";
        await checkLicenseStatus();
        clearLicenseGate();
        window.dispatchEvent(new CustomEvent("license-activated", { detail: result }));
      } else {
        els.licenseStatus.textContent = result.error || "激活失败";
        els.licenseStatus.className = "license-status error";
      }
    } catch (err) {
      els.licenseStatus.textContent = `激活失败: ${err.message}`;
      els.licenseStatus.className = "license-status error";
    } finally {
      els.activateLicenseBtn.disabled = false;
      els.activateLicenseBtn.textContent = "激活授权";
    }
  });
}
if (els.deactivateLicenseBtn) {
  els.deactivateLicenseBtn.addEventListener("click", async () => {
    if (!await customConfirm("确定要解除当前设备的授权吗？", { title: "解除授权", danger: true })) return;
    els.deactivateLicenseBtn.disabled = true;
    try {
      await api.post("/api/license/deactivate", {});
      const result = await checkLicenseStatus();
      if (result.activated) throw new Error("授权凭据仍然有效，请重试");
      showToast("授权已解除，请重新授权");
      els.settingsModal?.classList.add("hidden");
      showLicenseGate("授权已解除，请重新授权");
    } catch (err) {
      showToast(`解除授权失败：${err.message}`);
    } finally {
      els.deactivateLicenseBtn.disabled = false;
    }
  });
}

[els.aiBaseUrl, els.aiEmbeddingModel, els.aiChatModel, els.aiDeepseekApiKey, els.aiDeepseekBaseUrl, els.aiDeepseekChatModel].filter(Boolean).forEach((input) => {
  input.addEventListener("input", () => {
    state.ai.configDirty = true;
  });
});

function aiCurrentProvider() {
  return state.ai.chatProvider === "deepseek" ? "deepseek" : "ollama";
}

function aiConfigPayload(embeddingModel) {
  const deepseekApiKey = els.aiDeepseekApiKey?.value.trim() || "";
  return {
    baseUrl: els.aiBaseUrl.value.trim(),
    embeddingModel: embeddingModel ?? els.aiEmbeddingModel.value.trim(),
    chatModel: els.aiChatModel.value.trim(),
    chatProvider: aiCurrentProvider(),
    // An empty password field means "keep the saved key", never erase it by accident.
    ...(deepseekApiKey ? { deepseekApiKey } : {}),
    deepseekBaseUrl: els.aiDeepseekBaseUrl?.value.trim() || "https://api.deepseek.com",
    deepseekChatModel: els.aiDeepseekChatModel?.value.trim() || "deepseek-chat",
    enabled: true,
  };
}

function setAiProvider(provider) {
  const current = provider === "deepseek" ? "deepseek" : "ollama";
  state.ai.chatProvider = current;
  if (els.aiProviderChoices) {
    els.aiProviderChoices.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", button.dataset.provider === current);
    });
  }
  document.querySelectorAll(".ai-provider-fields").forEach((field) => {
    field.classList.toggle("hidden", field.dataset.providerFields !== current);
  });
}

if (els.aiProviderChoices) {
  els.aiProviderChoices.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-provider]");
    if (!button) return;
    setAiProvider(button.dataset.provider);
    state.ai.configDirty = true;
  });
}

els.aiTestBtn?.addEventListener("click", async () => {
  els.aiTestBtn.disabled = true;
  const provider = aiCurrentProvider();
  els.aiSettingsStatus.textContent = provider === "deepseek" ? "正在检测 DeepSeek..." : "正在检测 Ollama...";
  try {
    const requestedEmbeddingModel = els.aiEmbeddingModel.value.trim();
    const result = await api.post("/api/ai/test", aiConfigPayload());
    if (Array.isArray(result.models)) {
      els.aiModelChoices.innerHTML = result.models.map((model) => `<option value="${escapeHtml(model.name)}"></option>`).join("");
    }
    if (!els.aiEmbeddingModel.value) els.aiEmbeddingModel.value = result.recommendedEmbeddingModel || "";
    if (provider === "ollama" && !els.aiChatModel.value) els.aiChatModel.value = result.models?.find((model) => !/embed/i.test(model.name))?.name || "";
    if (result.embeddingCheck?.ok === false) {
      const recommendation = result.recommendedEmbeddingModel;
      if (recommendation && recommendation !== requestedEmbeddingModel) {
        els.aiEmbeddingModel.value = recommendation;
        state.ai.configDirty = true;
      }
      els.aiSettingsStatus.textContent = recommendation
        ? `${result.embeddingCheck.error} 已在输入框中建议本机可用模型“${recommendation}”，确认后保存配置。`
        : `${result.embeddingCheck.error} 本机未发现专用向量模型，可执行：ollama pull qwen3-embedding`;
      showToast("当前向量模型不可用，已给出修复建议");
      return;
    }
    if (result.chatCheck?.ok === false) {
      els.aiSettingsStatus.textContent = result.chatCheck.error;
      showToast(provider === "deepseek" ? "DeepSeek 连接失败" : "当前对话模型未安装或不可用");
      return;
    }
    const dimension = result.embeddingCheck?.dimension ? `，向量维度 ${result.embeddingCheck.dimension}` : "";
    const resolvedEmbedding = result.compatibility?.embedding?.resolvedName;
    const resolvedChat = result.compatibility?.chat?.resolvedName;
    const resolved = resolvedEmbedding || resolvedChat
      ? `；已匹配 ${[resolvedEmbedding, resolvedChat].filter(Boolean).join(" / ")}`
      : "";
    if (provider === "deepseek") {
      els.aiSettingsStatus.textContent = `DeepSeek 连接正常，对话模型 ${result.compatibility?.chat?.resolvedName || "deepseek-chat"}${dimension ? `；${dimension}` : ""}`;
    } else {
      els.aiSettingsStatus.textContent = `连接正常，发现 ${result.models?.length || 0} 个本地模型${dimension}${resolved}`;
    }
  } catch (error) { els.aiSettingsStatus.textContent = error.message || "连接失败"; }
  finally { els.aiTestBtn.disabled = false; }
});

els.aiSaveBtn?.addEventListener("click", async () => {
  els.aiSaveBtn.disabled = true;
  try {
    const result = await api.post("/api/ai/config", aiConfigPayload());
    state.ai.configDirty = false;
    setAiStatus(result.status);
    if (els.aiDeepseekApiKey) {
      els.aiDeepseekApiKey.value = "";
      els.aiDeepseekApiKey.placeholder = result.status?.deepseekApiKeyConfigured
        ? "已配置，留空则保持不变"
        : "sk-...";
    }
    showToast(result.rebuildRequired ? "配置已保存，正在重建语义索引" : "AI 配置已保存");
  } catch (error) {
    els.aiSettingsStatus.textContent = error.message || "保存失败";
    showToast(error.message || "保存失败");
  }
  finally { els.aiSaveBtn.disabled = false; }
});

els.aiDisableEmbeddingBtn?.addEventListener("click", async () => {
  els.aiDisableEmbeddingBtn.disabled = true;
  els.aiEmbeddingModel.value = "";
  state.ai.configDirty = true;
  els.aiSettingsStatus.textContent = "正在关闭向量索引并保留关键词检索…";
  try {
    const result = await api.post("/api/ai/config", aiConfigPayload(""));
    state.ai.configDirty = false;
    setAiStatus(result.status);
    showToast("已切换为仅关键词模式，可继续使用知识问答");
  } catch (error) {
    els.aiSettingsStatus.textContent = error.message || "切换失败";
    showToast(error.message || "切换失败");
  } finally {
    els.aiDisableEmbeddingBtn.disabled = false;
  }
});

els.aiReindexBtn?.addEventListener("click", async () => {
  els.aiReindexBtn.disabled = true;
  try {
    const result = await api.post("/api/ai/reindex", {});
    setAiStatus(result.status);
    showToast("已开始后台重建索引");
  } catch (error) { showToast(error.message || "无法重建索引"); }
  finally { els.aiReindexBtn.disabled = false; }
});

els.standardizeFrontmatterBtn?.addEventListener("click", openFrontmatterPreview);
els.cancelFrontmatterBtn?.addEventListener("click", () => els.frontmatterModal.classList.add("hidden"));
els.applyFrontmatterBtn?.addEventListener("click", applyFrontmatterPreview);
els.frontmatterModal?.addEventListener("click", (event) => {
  if (event.target === els.frontmatterModal) els.frontmatterModal.classList.add("hidden");
});
els.createAgentPolicyBtn?.addEventListener("click", async () => {
  const workspaceId = state.activeWorkspaceId || state.defaultWorkspaceId;
  if (!await customConfirm("将在当前工作区的 .mytemple 目录创建 AGENTS.md。\nAI 写入仍需逐次确认，是否继续？", { title: "创建 AI 规则文件" })) return;
  try {
    await api.post("/api/agent/policy/create", { workspaceId, confirmed: true });
    await loadAgentPolicyStatus();
    showToast("AI 规则文件已创建");
  } catch (error) { showToast(error.message || "创建失败"); }
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

function renderScreenshotSaveChoices() {
  if (!els.screenshotSaveChoices) return;
  const current = localStorage.getItem("screenshotSaveLocation") || "workspace";
  els.screenshotSaveChoices.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.save === current);
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
    if (result.latestReleaseNotes || result.releaseNotes) {
      els.aboutReleaseNotes.textContent = result.latestReleaseNotes || result.releaseNotes;
    }
  } catch (error) {
    els.aboutVersion.textContent = "1.0.0";
    els.aboutDate.textContent = "";
    els.aboutReleaseNotes.textContent = "暂无更新日志";
  }
}

function loadKnowledgeSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("knowledgeSettings") || "{}");
    if (els.kmReviewDays) els.kmReviewDays.value = saved.reviewDays || 30;
    if (els.kmEnableReminder) els.kmEnableReminder.checked = saved.enableReminder !== false;
  } catch {
    if (els.kmReviewDays) els.kmReviewDays.value = 30;
    if (els.kmEnableReminder) els.kmEnableReminder.checked = true;
  }
}

function persistKnowledgeSettings() {
  const next = {
    reviewDays: Math.max(7, Math.min(365, Number(els.kmReviewDays?.value) || 30)),
    enableReminder: Boolean(els.kmEnableReminder?.checked),
  };
  localStorage.setItem("knowledgeSettings", JSON.stringify(next));
}

function renderKmDocList(listEl, docs, stale = false) {
  if (!listEl) return;
  listEl.replaceChildren();
  if (!docs.length) {
    const empty = document.createElement("li");
    empty.className = "km-doc-empty";
    empty.textContent = "暂无待处理文档";
    listEl.append(empty);
    return;
  }
  for (const doc of docs) {
    const item = document.createElement("li");
    item.className = "km-doc-item";
    item.dataset.path = doc.path;
    const main = document.createElement("button");
    main.type = "button";
    main.className = "km-doc-open";
    const title = document.createElement("span");
    title.className = "km-doc-title";
    title.textContent = doc.title || doc.path;
    main.append(title);
    const meta = document.createElement("span");
    meta.className = "km-doc-meta";
    if (doc.workspace) meta.textContent += doc.workspace;
    if (stale) {
      const label = doc.daysSince < 0 ? "从未浏览" : `${doc.daysSince} 天未浏览`;
      meta.textContent += (meta.textContent ? " · " : "") + label;
    }
    if (meta.textContent) main.append(meta);
    main.addEventListener("click", () => {
      els.settingsModal?.classList.add("hidden");
      openDoc(doc.path);
    });
    item.append(main);
    listEl.append(item);
  }
}

async function loadKnowledgeHealth() {
  loadKnowledgeSettings();
  if (els.kmStats) els.kmStats.textContent = "正在分析知识脉络…";
  if (els.kmStatus) els.kmStatus.textContent = "正在分析知识脉络…";
  const days = Math.max(7, Math.min(365, Number(els.kmReviewDays?.value) || 30));
  try {
    const result = await api.get(`/api/knowledge/health?days=${days}`);
    const stats = result.stats || {};
    const reminderOn = els.kmEnableReminder?.checked !== false;
    if (els.kmStats) {
      els.kmStats.innerHTML = [
        `<div><span>文档总数</span><strong>${stats.documents || 0}</strong></div>`,
        `<div><span>缺标签</span><strong>${stats.missingTags || 0}</strong></div>`,
        `<div><span>缺链接</span><strong>${stats.missingLinks || 0}</strong></div>`,
        `<div><span>待温习</span><strong>${stats.staleDocs || 0}</strong></div>`,
      ].join("");
    }
    renderKnowledgeHealthScore(stats);
    if (els.kmMissingTagsCount) els.kmMissingTagsCount.textContent = String(stats.missingTags || 0);
    if (els.kmMissingLinksCount) els.kmMissingLinksCount.textContent = String(stats.missingLinks || 0);
    if (els.kmStaleCount) els.kmStaleCount.textContent = String(stats.staleDocs || 0);
    renderKmDocList(els.kmMissingTagsList, result.missingTags || []);
    renderKmDocList(els.kmMissingLinksList, result.missingLinks || []);
    renderKmDocList(els.kmStaleList, reminderOn ? (result.staleDocs || []) : [], true);
    if (els.kmStatus) {
      const tip = reminderOn
        ? `已分析 ${stats.documents || 0} 篇文档：${stats.missingTags || 0} 篇缺标签、${stats.missingLinks || 0} 篇缺链接、${stats.staleDocs || 0} 篇建议温习。`
        : `温习提醒已关闭。已分析 ${stats.documents || 0} 篇文档。`;
      els.kmStatus.textContent = tip;
    }
  } catch (error) {
    if (els.kmStats) els.kmStats.textContent = "";
    renderKnowledgeHealthScore(null);
    if (els.kmStatus) els.kmStatus.textContent = error.message || "分析失败";
  }
}

function renderKnowledgeHealthScore(stats) {
  const root = els.kmHealthScore;
  if (!root) return;
  if (!stats) {
    root.innerHTML = '<p class="muted">暂未分析</p>';
    return;
  }
  const score = Math.max(0, Math.min(100, Number(stats.healthScore) || 0));
  const breakdown = stats.scoreBreakdown || {};
  const level = score >= 85 ? { label: "优秀", cls: "km-score-excellent" }
    : score >= 70 ? { label: "良好", cls: "km-score-good" }
    : score >= 50 ? { label: "一般", cls: "km-score-fair" }
    : { label: "待改进", cls: "km-score-poor" };
  const items = ["link", "tag", "fresh", "concept"].map((key) => {
    const item = breakdown[key] || { score: 0, max: 0, label: "" };
    const pct = item.max > 0 ? Math.round((item.score / item.max) * 100) : 0;
    return `<div class="km-score-item">
      <div class="km-score-item-head"><span>${escapeHtml(item.label)}</span><strong>${item.score}/${item.max}</strong></div>
      <div class="km-score-bar"><span style="width:${pct}%"></span></div>
    </div>`;
  }).join("");
  root.innerHTML = `
    <div class="km-score-overview">
      <div class="km-score-ring ${level.cls}">
        <div class="km-score-ring-value">${score}</div>
        <div class="km-score-ring-label">${level.label}</div>
      </div>
      <div class="km-score-breakdown">${items}</div>
    </div>
    <p class="muted km-score-tip">满分 100 分：链接密度（40 分）反映文档双向链接建立程度；标签覆盖（30 分）反映知识脉络梳理程度；知识活跃（20 分）反映近期温习覆盖；概念关联（10 分）反映语义概念关联覆盖。</p>
  `;
}

if (els.kmRefreshBtn) {
  els.kmRefreshBtn.addEventListener("click", () => loadKnowledgeHealth());
}
if (els.kmReviewDays) {
  els.kmReviewDays.addEventListener("change", () => {
    persistKnowledgeSettings();
    loadKnowledgeHealth();
  });
}
if (els.kmEnableReminder) {
  els.kmEnableReminder.addEventListener("change", () => {
    persistKnowledgeSettings();
    loadKnowledgeHealth();
  });
}

els.closeSettingsBtn.addEventListener("click", () => {
  if (startupLicensePending) return;
  els.settingsModal.classList.add("hidden");
});
els.settingsModal.addEventListener("click", (event) => {
  if (startupLicensePending) return;
  if (event.target === els.settingsModal) els.settingsModal.classList.add("hidden");
});

document.querySelectorAll(".settings-nav-item").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.settingsTab;
    document.querySelectorAll(".settings-nav-item").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".settings-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.settingsPanel === target);
    });
    if (target === "about") {
      loadAboutInfo();
    }
    if (target === "knowledge") {
      loadKnowledgeHealth();
    }
  });
});

const resetEditorLayoutBtn = document.querySelector("#resetEditorLayoutBtn");
if (resetEditorLayoutBtn) {
  resetEditorLayoutBtn.addEventListener("click", () => {
    localStorage.removeItem("editorPaneLayout");
    if (typeof applyEditorSplitterLayout === "function") applyEditorSplitterLayout();
    showToast("编辑器布局已重置");
  });
}
const showSpellcheckToggle = document.querySelector("#showSpellcheckToggle");
if (showSpellcheckToggle) {
  showSpellcheckToggle.checked = !!state.showSpellcheck;
  showSpellcheckToggle.addEventListener("change", () => {
    state.showSpellcheck = showSpellcheckToggle.checked;
    localStorage.setItem('mt_showSpellcheck', JSON.stringify(state.showSpellcheck));
    showToast(state.showSpellcheck ? "拼写纠错已开启" : "拼写纠错已关闭");
    schedulePreviewUpdate();
    if (typeof renderReaderContent === "function" && state.mode === "view") renderReaderContent(state.currentContent);
  });
}

// 关于内容已内联到设置「关于」面板，切换至该 Tab 时由 settings-nav-item 处理器自动加载。
els.checkUpdateBtn?.addEventListener("click", async () => {
  showToast("正在检查更新...");
  try {
    await api.post("/api/update/check", {});
    await api.get("/api/version?refresh=1");
    await loadAboutInfo();
    showToast("已请求桌面启动器强制检查升级，稍后将显示升级提示");
  } catch (error) {
    showToast(error.message || "检查更新失败");
  }
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
      customAlert("复制失败，请手动复制");
    });
  });
});
els.themeChoices.addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme]");
  if (!button) return;
  localStorage.setItem("docTheme", button.dataset.theme);
  applySettings();
});
els.screenshotSaveChoices?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-save]");
  if (!button) return;
  localStorage.setItem("screenshotSaveLocation", button.dataset.save);
  renderScreenshotSaveChoices();
  showToast(button.dataset.save === "workspace" ? "截图将保存到文档所属工作区" : "截图将保存到默认工作路径");
});

function initPdfExportSettings() {
  const saved = JSON.parse(localStorage.getItem("pdfExportSettings") || "{}");
  els.pdfShowDate.checked = saved.showDate !== false;
  els.pdfShowAuthor.checked = saved.showAuthor !== false;
  els.pdfShowFooter.checked = saved.showFooter !== false;
  if (els.pdfAuthorText) els.pdfAuthorText.value = saved.authorText || "郑堃逢";
  if (els.pdfFooterText) els.pdfFooterText.value = saved.footerText || "MyTemple Knowledge · 本地 Markdown 知识库";
  if (els.pdfWatermarkText) els.pdfWatermarkText.value = saved.watermarkText || "MyTemple Knowledge";
  const persist = () => {
    const next = {
      showDate: els.pdfShowDate.checked,
      showAuthor: els.pdfShowAuthor.checked,
      authorText: (els.pdfAuthorText?.value || "").trim() || "郑堃逢",
      showFooter: els.pdfShowFooter.checked,
      footerText: (els.pdfFooterText?.value || "").trim() || "MyTemple Knowledge · 本地 Markdown 知识库",
      watermarkText: (els.pdfWatermarkText?.value || "").trim() || "MyTemple Knowledge",
    };
    localStorage.setItem("pdfExportSettings", JSON.stringify(next));
    if (els.pdfSettingsStatus) {
      els.pdfSettingsStatus.textContent = "已保存 · 下次导出生效";
      setTimeout(() => { if (els.pdfSettingsStatus) els.pdfSettingsStatus.textContent = ""; }, 2000);
    }
  };
  els.pdfShowDate.addEventListener("change", persist);
  els.pdfShowAuthor.addEventListener("change", persist);
  els.pdfShowFooter.addEventListener("change", persist);
  els.pdfAuthorText?.addEventListener("change", persist);
  els.pdfFooterText?.addEventListener("change", persist);
  els.pdfWatermarkText?.addEventListener("change", persist);
}

function readPdfExportSettings() {
  const saved = JSON.parse(localStorage.getItem("pdfExportSettings") || "{}");
  return {
    showDate: saved.showDate !== false,
    showAuthor: saved.showAuthor !== false,
    authorText: saved.authorText || "郑堃逢",
    showFooter: saved.showFooter !== false,
    footerText: saved.footerText || "MyTemple Knowledge · 本地 Markdown 知识库",
    watermarkText: saved.watermarkText || "MyTemple Knowledge",
  };
}

// 强制水印层：PDF/幻灯片导出叠加轻度斜向水印，保护软件推广，不可关闭。
function buildExportWatermark(text) {
  const label = escapeHtml(String(text || "MyTemple Knowledge")).slice(0, 40);
  // 用重复的固定定位层在每页铺满，透明度极低，不遮挡正文。
  const layer = `<div class="print-watermark" aria-hidden="true">${label}</div>`;
  return layer;
}

initPdfExportSettings();
initAiEditHintSettings();

function initEditorSplitters() {
  if (!els.editorBody) return;

  const MIN_OUTLINE = 140;
  const MAX_OUTLINE = 400;
  const MIN_EDITOR = 280;
  const MIN_PREVIEW = 220;

  function loadLayout() {
    try {
      const saved = JSON.parse(localStorage.getItem("editorPaneLayout") || "{}");
      return {
        outlineWidth: saved.outlineWidth || 224,
        editorRatio: saved.editorRatio || 0.5,
      };
    } catch (_) {
      return { outlineWidth: 224, editorRatio: 0.5 };
    }
  }

  function saveLayout(layout) {
    localStorage.setItem("editorPaneLayout", JSON.stringify(layout));
  }

  function applyLayout() {
    const layout = loadLayout();
    const outlineVisible = !els.editorBody.classList.contains("outline-hidden");
    const previewVisible = !els.editorBody.classList.contains("preview-hidden");
    const r = Math.max(0.15, Math.min(0.85, layout.editorRatio || 0.5));

    if (outlineVisible) {
      const w = Math.max(MIN_OUTLINE, Math.min(MAX_OUTLINE, layout.outlineWidth));
      if (previewVisible) {
        els.editorBody.style.gridTemplateColumns = `${w}px 3px minmax(0, ${r}fr) 3px minmax(0, ${1 - r}fr)`;
      } else {
        els.editorBody.style.gridTemplateColumns = `${w}px 3px minmax(0, 1fr) 0 0`;
      }
    } else {
      if (previewVisible) {
        els.editorBody.style.gridTemplateColumns = `0 0 minmax(0, ${r}fr) 3px minmax(0, ${1 - r}fr)`;
      } else {
        els.editorBody.style.gridTemplateColumns = `0 0 minmax(0, 1fr) 0 0`;
      }
    }
  }

  applyLayout();

  function startOutlineDrag(event) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const layout = loadLayout();
    const startOutlineWidth = layout.outlineWidth;
    els.outlineSplitter.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(e) {
      const delta = e.clientX - startX;
      const newWidth = Math.max(MIN_OUTLINE, Math.min(MAX_OUTLINE, startOutlineWidth + delta));
      const bodyWidth = els.editorBody.getBoundingClientRect().width;
      const rest = bodyWidth - newWidth - (els.editorBody.classList.contains("preview-hidden") ? 3 : 6);
      const minEditor = els.editorBody.classList.contains("preview-hidden") ? MIN_EDITOR : MIN_EDITOR + MIN_PREVIEW;
      if (rest < minEditor) return;
      layout.outlineWidth = newWidth;
      saveLayout(layout);
      applyLayout();
    }

    function onUp() {
      els.outlineSplitter.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function startPreviewDrag(event) {
    event.preventDefault();
    event.stopPropagation();
    const bodyWidth = els.editorBody.getBoundingClientRect().width;
    const startX = event.clientX;
    const layout = loadLayout();
    const isOutlineVisible = !els.editorBody.classList.contains("outline-hidden");
    const outlineWidth = isOutlineVisible ? layout.outlineWidth : 0;
    const splitterCount = isOutlineVisible ? 2 : 1;
    const available = bodyWidth - outlineWidth - splitterCount * 3;
    const startEditorWidth = Math.floor(available * layout.editorRatio);
    els.previewSplitter.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(e) {
      const delta = e.clientX - startX;
      let newEditorWidth = startEditorWidth + delta;
      const maxEditorWidth = available - MIN_PREVIEW;
      newEditorWidth = Math.max(MIN_EDITOR, Math.min(maxEditorWidth, newEditorWidth));
      layout.editorRatio = Math.max(0.15, Math.min(0.85, newEditorWidth / available));
      saveLayout(layout);
      applyLayout();
    }

    function onUp() {
      els.previewSplitter.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  els.outlineSplitter?.addEventListener("mousedown", startOutlineDrag);
  els.previewSplitter?.addEventListener("mousedown", startPreviewDrag);

  window.applyEditorSplitterLayout = applyLayout;
}

initEditorSplitters();
els.bgImageInput.addEventListener("change", async () => {
  const file = els.bgImageInput.files?.[0];
  if (!file) return;
  try {
  const bitmap = await createBoundedImageBitmap(file, 1920);
    const maxSide = 1920;
    const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const ctx = canvas.getContext("2d", { alpha: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
    canvas.width = 1;
    canvas.height = 1;
    const compressedFile = blob || file;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        localStorage.setItem("docBgImage", reader.result);
      } catch (e) {
        alert("图片过大，即使压缩后仍超出存储限制，请选择更小的图片。");
        return;
      }
      localStorage.setItem("docTheme", "image");
      applySettings();
    };
    reader.readAsDataURL(compressedFile);
  } catch (e) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        localStorage.setItem("docBgImage", reader.result);
      } catch (err) {
        alert("图片过大，超出本地存储限制，请选择更小的图片。");
        return;
      }
      localStorage.setItem("docTheme", "image");
      applySettings();
    };
    reader.readAsDataURL(file);
  }
});
// 图片主题文字明暗切换：浅色文字适配深色背景图，深色文字适配浅色背景图。
els.imageTextMode?.addEventListener("change", () => {
  localStorage.setItem("imageTextMode", els.imageTextMode.value);
  applySettings();
});
// 柔光主题强调色自定义：实时应用并持久化，重置按钮恢复默认值。
els.glowAccentColor?.addEventListener("input", (event) => {
  const accent = event.target.value;
  document.documentElement.style.setProperty("--accent", accent);
  document.documentElement.style.setProperty("--accent-strong", accent);
  localStorage.setItem("glowAccentColor", accent);
});
els.resetGlowAccentBtn?.addEventListener("click", () => {
  document.documentElement.style.removeProperty("--accent");
  document.documentElement.style.removeProperty("--accent-strong");
  localStorage.removeItem("glowAccentColor");
  if (els.glowAccentColor) els.glowAccentColor.value = "#88a956";"#88a956";
  applySettings();
  showToast("柔光强调色已恢复默认");
});
// 从背景图取色：采样图片主色调并应用为强调色，让界面配色与图片协调。
els.pickImageColorBtn?.addEventListener("click", async () => {
  const bg = localStorage.getItem("docBgImage");
  if (!bg) return showToast("请先上传背景图片");
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = bg;
    await img.decode();
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { alpha: true });
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 32) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; count += 1;
    }
    if (!count) return showToast("无法从图片取色");
    r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
    // 提升饱和度形成强调色，避免取到灰调。
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let accent = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    if (max - min < 30) accent = lum < 96 ? "#e15048" : "#c9302c";
    document.documentElement.style.setProperty("--accent", accent);
    localStorage.setItem("imageAccentColor", accent);
    showToast(`已取色：${accent}（已应用为强调色）`);
  } catch (e) {
    showToast("取色失败，请重试");
  }
});
els.globalFontSize.addEventListener("input", () => {
  localStorage.setItem("docFontSize", els.globalFontSize.value);
  applySettings();
});
els.docFontSize.addEventListener("input", () => {
  localStorage.setItem("docContentFontSize", els.docFontSize.value);
  applySettings();
});
if (els.windowZoom) {
  els.windowZoom.addEventListener("input", () => {
    const z = Number(els.windowZoom.value);
    localStorage.setItem("windowZoom", String(z));
    applyWindowZoom(z);
  });
}
els.globalFontFamily.addEventListener("change", () => {
  localStorage.setItem("docFontFamily", els.globalFontFamily.value);
  applySettings();
});
const markdownColorInputs = [
  ["heading", els.mdColorHeading],
  ["link", els.mdColorLink],
  ["code", els.mdColorCode],
  ["quote", els.mdColorQuote],
  ["table", els.mdColorTable],
  ["tag", els.mdColorTag],
];
markdownColorInputs.forEach(([key, input]) => {
  input?.addEventListener("input", () => {
    const settings = loadSettings();
    settings.markdownColors = { ...(settings.markdownColors || {}), [key]: input.value };
    localStorage.setItem("markdownColors", JSON.stringify(settings.markdownColors));
    applySettings(settings);
  });
});
els.aiPptBtn?.addEventListener("click", () => exportCurrentDocToPpt());
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
// 下拉面板迁移到 body 下：.editor-toolbar 设有 backdrop-filter（非 none），
// 根据规范会成为其后代 position:fixed 元素的包含块，配合 overflow-y:hidden
// 会让面板被裁剪而不可见。移到 body 后 fixed 相对视口定位，彻底脱离裁剪。
document.querySelectorAll(".toolbar-dropdown-panel").forEach((panel) => {
  document.body.appendChild(panel);
});
// document 级 mousedown：覆盖工具栏按钮与面板内按钮，preventDefault 防止
// 编辑器失焦导致选区塌缩（格式化仅对最后一行生效的根因）。
document.addEventListener("mousedown", (event) => {
  if (event.target.closest("[data-format]") || event.target.closest(".color-preset")) {
    event.preventDefault();
  }
});
els.editorToolbar.addEventListener("wheel", (event) => {
  const toolbar = els.editorToolbar;
  if (toolbar.scrollWidth <= toolbar.clientWidth) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  toolbar.scrollLeft += delta;
  event.preventDefault();
}, { passive: false });
document.addEventListener("click", (event) => {
  // 工具栏内直接格式化按钮（code/link/table 等）。面板已迁移到 body，
  // 故 #editorToolbar 内的 [data-format] 仅匹配工具栏直接按钮，不会误命中面板按钮。
  const toolbarFmt = event.target.closest("#editorToolbar [data-format]");
  if (toolbarFmt) {
    applyFormat(toolbarFmt.dataset.format);
    return;
  }
  // 下拉触发按钮
  const dropdownBtn = event.target.closest("[data-toolbar-dropdown]");
  if (dropdownBtn) {
    event.stopPropagation();
    const target = dropdownBtn.dataset.toolbarDropdown;
    const panel = document.querySelector(`.toolbar-dropdown-panel[data-panel="${target}"]`);
    if (!panel) return;
    const wasHidden = panel.classList.contains("hidden");
    document.querySelectorAll(".toolbar-dropdown-panel").forEach(p => p.classList.add("hidden"));
    if (wasHidden) {
      panel.classList.remove("hidden");
      const rect = dropdownBtn.getBoundingClientRect();
      const pw = panel.getBoundingClientRect().width;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8));
      panel.style.left = left + "px";
      panel.style.top = (rect.bottom + 4) + "px";
    }
    return;
  }
  // 面板内格式化按钮（quote/ul/ol/task/hr/bold/italic 等）
  const panelFmt = event.target.closest(".toolbar-dropdown-panel [data-format]");
  if (panelFmt) {
    applyFormat(panelFmt.dataset.format);
    document.querySelectorAll(".toolbar-dropdown-panel").forEach(p => p.classList.add("hidden"));
    return;
  }
  // 面板内颜色预设
  const preset = event.target.closest(".toolbar-dropdown-panel .color-preset");
  if (preset) {
    event.stopPropagation();
    const color = preset.dataset.color;
    const grid = preset.closest(".color-preset-grid");
    const colorType = grid?.dataset.colorType;
    if (colorType === "textColor" && els.textColor) {
      els.textColor.value = color;
      const preview = document.getElementById("textColorPreview");
      if (preview) preview.style.background = color;
      applyFormat("color");
    } else if (colorType === "bgColor" && els.bgColor) {
      els.bgColor.value = color;
      const preview = document.getElementById("bgColorPreview");
      if (preview) preview.style.background = color;
      applyFormat("bg");
    }
    return;
  }
  // 外部点击关闭所有面板
  const inPanel = event.target.closest(".toolbar-dropdown-panel");
  if (!inPanel && !dropdownBtn) {
    document.querySelectorAll(".toolbar-dropdown-panel").forEach(p => p.classList.add("hidden"));
  }
});
// 面板采用 fixed 定位，滚动或窗口缩放时位置会失真，直接关闭避免错位。
["scroll", "resize"].forEach((evt) =>
  window.addEventListener(evt, () => {
    document.querySelectorAll(".toolbar-dropdown-panel:not(.hidden)").forEach(p => p.classList.add("hidden"));
  }, { passive: true, capture: true })
);
els.textColor?.addEventListener("change", (e) => {
  const preview = document.getElementById("textColorPreview");
  if (preview) preview.style.background = e.target.value;
  applyFormat("color");
});
els.bgColor?.addEventListener("change", (e) => {
  const preview = document.getElementById("bgColorPreview");
  if (preview) preview.style.background = e.target.value;
  applyFormat("bg");
});
const fontSizeSelectEl = document.getElementById("fontSizeSelect");
fontSizeSelectEl?.addEventListener("change", () => applyFormat("size"));
els.headingSelect?.addEventListener("change", (event) => {
  const val = event.target.value;
  if (val) {
    applyFormat(val);
    event.target.selectedIndex = 0;
  }
});
els.editorHideBtn?.addEventListener("click", () => {
  setEditorVisible(state.editorHidden);
});
els.newFolderBtn?.addEventListener("click", () => openCreateModal("folder"));
els.newDocBtn?.addEventListener("click", () => openCreateModal("doc"));
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
els.modeToggleBtn.addEventListener("click", async () => {
  if (state.mode === "view") {
    if (state.currentPath) setMode("edit");
  } else if (state.mode === "edit") {
    if (state.currentPath) {
      await saveCurrentDoc({ keepEditorState: false });
    }
    setMode("view");
  } else if (state.mode === "graph") {
    if (state.currentPath) setMode("view");
    else setMode("edit");
  }
});
els.graphBtn.addEventListener("click", () => setMode("graph"));
els.focusModeBtn.addEventListener("click", () => setImmersiveEditing(!state.immersive));
els.lowGpuToggle?.addEventListener("change", () => setLowGpuMode(els.lowGpuToggle.checked));
els.previewToggleBtn.addEventListener("click", () => setPreviewVisible(!state.previewVisible));
els.outlineToggleBtn?.addEventListener("click", () => setEditorOutlineVisible(!state.editorOutlineVisible));
els.editorOutline?.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-editor-outline-toggle]");
  if (toggle) {
    const groupId = toggle.dataset.editorOutlineToggle;
    const group = groupId && document.getElementById(groupId);
    if (group) {
      const collapsed = group.classList.toggle("is-collapsed");
      toggle.setAttribute("aria-expanded", String(!collapsed));
    }
    return;
  }
  const button = event.target.closest("[data-heading-text]");
  if (!button) return;
  const lineAttr = parseInt(button.dataset.headingLine, 10);
  const occurrence = parseInt(button.dataset.headingOccurrence, 10) || 0;
  // 隐藏编辑器后点击大纲标题：预览栏直接跳转到标题对应位置，
  // 不再依赖隐藏编辑器的滚动（编辑器不可见时滚动无法反映到预览）。
  if (state.editorHidden && state.previewVisible && state.mode === "edit") {
    scrollPreviewToHeading(button.dataset.headingText, occurrence);
    return;
  }
  if (Number.isFinite(lineAttr) && lineAttr >= 0) {
    const doc = els.editor.view?.state?.doc;
    if (doc && lineAttr < doc.lines) {
      const line = doc.line(lineAttr + 1);
      const text = line.text;
      const heading = text.match(/^(\s*)(#{1,6})\s+(.+)$/);
      const autoHeading = text.match(/^(\s*)([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
      const target = plainText(button.dataset.headingText).toLowerCase();
      if ((heading && plainText(heading[3]).toLowerCase() === target) ||
          (autoHeading && plainText(autoHeading[2]).toLowerCase() === target)) {
        els.editor.scrollToLine?.(lineAttr + 1);
        els.editor.focus?.();
        return;
      }
    }
    scrollEditorToHeading(button.dataset.headingText, occurrence);
    return;
  }
  scrollEditorToHeading(button.dataset.headingText, occurrence);
});
els.deleteBtn.addEventListener("click", deleteSelected);
els.exportPdfBtn?.addEventListener("click", exportCurrentDocToPdf);
els.copyWechatBtn?.addEventListener("click", copyCurrentDocAsWechat);
els.saveBtn.addEventListener("click", async () => {
  try {
    await saveCurrentDoc({ refreshTree: true });
  } catch (error) {
    setSaveStatus("\u4fdd\u5b58\u5931\u8d25", true);
    customAlert(error.message || "保存失败");
  }
});
els.formatBtn.addEventListener("click", (e) => {
  if (e.shiftKey) {
    state.showSpellcheck = !state.showSpellcheck;
    localStorage.setItem('mt_showSpellcheck', JSON.stringify(state.showSpellcheck));
    showToast(state.showSpellcheck ? "拼写纠错已开启" : "拼写纠错已关闭");
    schedulePreviewUpdate();
    return;
  }
  if (!state.currentPath) return;
  const result = formatDocument(els.editor.value);
  // 先通过 CodeMirror 原生事务同步，再回退到 value setter，确保长文档不丢失
  const oldLength = (els.editor.value || "").length;
  try {
    const view = els.editor.view;
    if (view && view.dispatch) {
      view.dispatch({
        changes: { from: 0, to: oldLength, insert: result.content },
        selection: { anchor: 0, head: 0 },
        scrollIntoView: true,
      });
      els.editor.value = result.content; // 二次同步，确保 bridge 的 getter 返回新内容
    } else {
      els.editor.value = result.content;
    }
  } catch (_) {
    els.editor.value = result.content;
  }
  state.currentContent = result.content;
  updateLargeDocumentState(result.content);
  recordUndo(result.content);
  schedulePreviewUpdate({ immediate: true });
  const msg = `已规范 ${result.formatFixed} 处格式${
    state.showSpellcheck
      ? `，发现 ${result.spellErrors} 处疑似错字${result.spellErrors ? '，可在预览中查看红色波浪线' : ''}`
      : ''
  }${
    result.headingChaotic && result.headingLevelCorrected > 0
      ? `（已智能优化 ${result.headingLevelCorrected} 处跳级标题层级）`
      : result.headingChaotic
        ? ''
        : '（标题层级完整规范，未做结构改动）'
  }`;
  showToast(msg);
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
    // 系统标记为 reduce 但用户显式开启动态时，记录覆盖意图，让图谱恢复运动。
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      localStorage.setItem("graphDynamicOverride", "1");
      showToast("已强制启用动态图谱（覆盖系统减少动画设置）");
    }
    startGraphSimulation();
  } else {
    localStorage.removeItem("graphDynamicOverride");
    stopGraphSimulation();
    scheduleGraphDraw();
  }
});
// 图谱物理参数调节：实时应用并持久化，重置按钮恢复默认值。
const graphPhysicsDefaults = { repulsion: 1.25, attraction: 1.0, breathing: 1.0, restore: 1.0 };
function syncGraphPhysicsControls() {
  const p = state.graphView.physics;
  if (els.graphRepulsion) els.graphRepulsion.value = p.repulsion;
  if (els.graphRepulsionValue) els.graphRepulsionValue.textContent = p.repulsion.toFixed(2);
  if (els.graphAttraction) els.graphAttraction.value = p.attraction;
  if (els.graphAttractionValue) els.graphAttractionValue.textContent = p.attraction.toFixed(2);
  if (els.graphBreathing) els.graphBreathing.value = p.breathing;
  if (els.graphBreathingValue) els.graphBreathingValue.textContent = p.breathing.toFixed(2);
  if (els.graphRestore) els.graphRestore.value = p.restore;
  if (els.graphRestoreValue) els.graphRestoreValue.textContent = p.restore.toFixed(2);
}
els.graphRepulsion?.addEventListener("input", (e) => {
  state.graphView.physics.repulsion = parseFloat(e.target.value);
  els.graphRepulsionValue.textContent = state.graphView.physics.repulsion.toFixed(2);
  localStorage.setItem("graphRepulsion", String(state.graphView.physics.repulsion));
});
els.graphAttraction?.addEventListener("input", (e) => {
  state.graphView.physics.attraction = parseFloat(e.target.value);
  els.graphAttractionValue.textContent = state.graphView.physics.attraction.toFixed(2);
  localStorage.setItem("graphAttraction", String(state.graphView.physics.attraction));
});
els.graphBreathing?.addEventListener("input", (e) => {
  state.graphView.physics.breathing = parseFloat(e.target.value);
  els.graphBreathingValue.textContent = state.graphView.physics.breathing.toFixed(2);
  localStorage.setItem("graphBreathing", String(state.graphView.physics.breathing));
});
els.graphRestore?.addEventListener("input", (e) => {
  state.graphView.physics.restore = parseFloat(e.target.value);
  els.graphRestoreValue.textContent = state.graphView.physics.restore.toFixed(2);
  localStorage.setItem("graphRestore", String(state.graphView.physics.restore));
});
els.resetGraphPhysicsBtn?.addEventListener("click", () => {
  Object.assign(state.graphView.physics, graphPhysicsDefaults);
  localStorage.removeItem("graphRepulsion");
  localStorage.removeItem("graphAttraction");
  localStorage.removeItem("graphBreathing");
  localStorage.removeItem("graphRestore");
  syncGraphPhysicsControls();
  showToast("图谱物理参数已恢复默认");
});
syncGraphPhysicsControls();
document.addEventListener("visibilitychange", () => {
  state.graphView.pageActive = !document.hidden;
  if (document.hidden) {
    stopGraphSimulation();
    _stopSystemTimeInterval();
  } else {
    startGraphSimulation();
    _startSystemTimeInterval();
  }
  // 页面隐藏时立即保存草稿
  if (document.hidden) saveDraft();
  // 状态缓存失效
  _invalidateStatusCache();
});
window.addEventListener("pagehide", () => {
  // 页面关闭前同步保存草稿
  if (state.currentPath && state.mode === "edit" && els.editor.value !== state.lastSavedContent) {
    try { localStorage.setItem("draft:" + state.currentPath, els.editor.value); }
    catch (e) {
      // 页面即将关闭，toast 可能来不及显示，至少记录到 console
      console.error("[文档异常] stage=页面关闭草稿保存 path=" + state.currentPath, e);
    }
  }
});
window.addEventListener("blur", () => {
  state.graphView.pageActive = false;
  stopGraphSimulation();
});
window.addEventListener("focus", () => {
  state.graphView.pageActive = true;
  startGraphSimulation();
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
  state.graphView.lastInteraction = performance.now();
});
els.canvas.addEventListener("pointermove", (event) => {
  if (!state.graphDrag) {
    scheduleGraphHover(event.clientX, event.clientY);
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
    state.graphView.hoveredId = "";
    els.graphTooltip.classList.add("hidden");
    startGraphRebound();
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

// 统一的 resize 去抖处理
let _resizeTimer = null;
window.addEventListener("resize", () => {
  if (_resizeTimer) return;
  _resizeTimer = setTimeout(() => {
    _resizeTimer = null;
    // 触发所有 resize 相关操作
    if (state.aiInline.visible) positionAiInlineDialog();
    const ph = document.getElementById("editorPlaceholder");
    if (ph && ph.classList.contains("visible") && state.mode === "edit" && state.currentPath) {
      _showPlaceholder();
    }
    closeAllMenus();
    updateMultiCursorDisplay();
    requestAnimationFrame(applyLayout);
    restoreSidebarWidth();
    if (state.mode === "graph") {
      resizeCanvas();
      fitGraphView();
    }
  }, 100);
});

if (els.recentDocs) {
  els.recentDocs.addEventListener("wheel", (event) => {
    if (event.deltaX === 0) {
      event.preventDefault();
      els.recentDocs.scrollLeft += event.deltaY;
    }
  }, { passive: false });
}

async function bootstrap(refresh = false) {
  try {
    const data = await api.get(`/api/tree${refresh ? "?refresh=1" : ""}`);
    state.tree = data.tree;
    state.flatFiles = flatten(state.tree, []);
    if (data.workspaces && data.workspaces.length) state.workspaces = data.workspaces;
    if (data.defaultWorkspaceId) state.defaultWorkspaceId = data.defaultWorkspaceId;
    els.docCount.textContent = `${data.count || 0} ${text.docsUnit} / ${state.workspaces.filter((ws) => ws.visible).length} 个工作路径`;
    if (typeof updateSidebarDocCount === "function") updateSidebarDocCount();
    renderWorkspaceSummary();
    renderTree(state.tree);
    // 恢复上次打开的文档，保留用户工作上下文。
    if (!refresh) {
      try {
        const lastDoc = localStorage.getItem("lastOpenedDoc");
        if (lastDoc && state.flatFiles.some((file) => file.path === lastDoc)) {
          openDoc(lastDoc).then(() => {
            // 恢复上次的编辑模式
            try {
              const lastMode = localStorage.getItem("lastMode");
              if (lastMode && ["view", "edit", "graph"].includes(lastMode)) {
                setMode(lastMode);
              }
            } catch (_) {}
          }).catch((e) => console.warn("restore last doc failed:", e));
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error("Bootstrap failed:", err);
    els.docCount.textContent = "加载失败";
    if (typeof updateSidebarDocCount === "function") updateSidebarDocCount();
  }
}

// 启动初始化——显示开机图片 logo.png，在图片展示期间并行加载服务，加载完成后直接进入应用
let startupLicensePending = true;
document.body.classList.add("license-locked");
const appSplash = document.querySelector("#appSplash");
const splashProgressFill = document.querySelector("#splashProgressFill");
const splashProgressPct = document.querySelector("#splashProgressPct");
const splashProgressText = document.querySelector("#splashProgressText");

let _splashProgress = 0;
let _licenseGateCheckPromise = null;

function showLicenseGate(message = "软件未授权，请完成授权后继续使用") {
  startupLicensePending = true;
  document.body.classList.add("license-locked");
  els.settingsModal?.classList.add("hidden");
  if (els.licenseStatus && message) {
    els.licenseStatus.textContent = message;
    els.licenseStatus.className = "license-status error";
  }
  els.licenseModal?.classList.remove("hidden");
  els.licenseModal?.classList.add("startup-block");
}

function clearLicenseGate() {
  startupLicensePending = false;
  document.body.classList.remove("license-locked");
  els.licenseModal?.classList.remove("startup-block");
  els.licenseModal?.classList.add("hidden");
}

window.addEventListener("license-required", async (event) => {
  // 快速路径：30秒内已验证授权有效，直接清除弹窗（瞬态错误）
  const recentlyValid = state.licenseValidatedAt > 0 && (Date.now() - state.licenseValidatedAt) < 30000;
  if (recentlyValid) {
    console.warn("License validated recently (<30s), treating 403 as transient error");
    clearLicenseGate();
    return;
  }

  // 去重：如果已有正在进行的验证请求，直接复用结果
  if (_licenseGateCheckPromise) return _licenseGateCheckPromise;

  _licenseGateCheckPromise = (async () => {
    try {
      // 重新验证授权状态，排除瞬态错误（如文件读取失败、机器码计算异常等）
      const result = await checkLicenseStatus();
      if (result && result.activated) {
        // 授权仍然有效，只是之前的API请求出现了瞬态错误
        console.warn("License is still valid but API returned 403 LICENSE_REQUIRED — cleared gate");
        clearLicenseGate();
        return;
      }
      // 授权确实无效，显示授权弹窗
      showLicenseGate(event.detail?.error || "授权已失效，请重新授权");
    } catch (verifyErr) {
      console.error("License verification after 403 failed:", verifyErr);
      showLicenseGate(event.detail?.error || "授权状态验证失败，请重新授权");
    } finally {
      _licenseGateCheckPromise = null;
    }
  })();
  return _licenseGateCheckPromise;
});

function setSplashProgress(pct, text) {
  _splashProgress = pct;
  if (splashProgressFill) splashProgressFill.style.width = pct + "%";
  if (splashProgressPct) splashProgressPct.textContent = pct + "%";
  if (text && splashProgressText) splashProgressText.textContent = text;
}

try { applySettings(); } catch (e) { console.error("applySettings failed:", e); }
try { if (state.lowGpuMode) { document.body.classList.add("low-gpu-mode"); if (els.lowGpuToggle) els.lowGpuToggle.checked = true; } } catch (e) { console.error("lowGpuMode restore failed:", e); }
try { restoreWindowZoom(); } catch (e) { console.error("restoreWindowZoom failed:", e); }
try { restoreSidebarWidth(); } catch (e) { console.error("restoreSidebarWidth failed:", e); }
try { restoreSidebarCollapsed(); } catch (e) { console.error("restoreSidebarCollapsed failed:", e); }

const _deferIdle = window.requestIdleCallback || ((fn) => setTimeout(fn, 50));
_deferIdle(() => {
  try { loadAiHistory(); } catch (e) { console.error("loadAiHistory failed:", e); }
  try { renderAiMessages(); } catch (e) { console.error("renderAiMessages failed:", e); }
  try { loadRecentDocs(); } catch (e) { console.error("loadRecentDocs failed:", e); }
  try { renderRecentDocs(); } catch (e) { console.error("renderRecentDocs failed:", e); }
});

// 启动流程：开机图片 logo.png 立即显示，后台并行加载服务，加载完成后直接进入应用。
async function beginLoading() {
  // 直接启动授权与文档库加载，与开机图片并行进行。
  await startupLicenseCheck();
}

function hideSplash() {
  // 标记应用启动完成：此后运行时错误不再触发自动刷新，避免打断编辑心流。
  if (typeof window.__markAppStarted === "function") window.__markAppStarted();
  if (appSplash && !appSplash.classList.contains("hidden")) {
    setSplashProgress(100, "加载完成");
    // 立即移除启动图层，避免窗口缩放时 WebView 重新合成出旧的背景图。
    appSplash.classList.add("hidden");
    appSplash.remove();
    showWelcomeIfNeeded();
  } else {
    showWelcomeIfNeeded();
  }
}

function showWelcomeIfNeeded() {
  const dontShow = localStorage.getItem("welcomeDontShow");
  if (dontShow === "1") return;
  const overlay = document.getElementById("welcomeOverlay");
  if (!overlay) return;
  const startBtn = document.getElementById("welcomeStartBtn");
  const dontShowCb = document.getElementById("welcomeDontShow");
  const tabs = overlay.querySelectorAll(".welcome-tab");
  const panels = overlay.querySelectorAll(".welcome-panel");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const idx = tab.dataset.welcomeTab;
      tabs.forEach(t => t.classList.toggle("active", t === tab));
      panels.forEach(p => p.classList.toggle("active", p.dataset.welcomePanel === idx));
    });
  });

  if (startBtn) {
    startBtn.addEventListener("click", () => {
      if (dontShowCb && dontShowCb.checked) {
        localStorage.setItem("welcomeDontShow", "1");
      }
      overlay.classList.add("hidden");
      setTimeout(() => overlay.remove(), 400);
    });
  }

  overlay.classList.remove("hidden");
}

async function startupLicenseCheck() {
  setSplashProgress(15, "正在初始化…");

  const licensePromise = checkLicenseStatus();
  const result = await licensePromise;
  setSplashProgress(55, result.activated ? "正在加载文档库…" : "等待授权…");

  if (result.activated) {
    await bootstrap();
    clearLicenseGate();
    setSplashProgress(85, "正在完成初始化…");
    await Promise.resolve();
    setSplashProgress(100, "加载完成");
    // 加载完成后直接隐藏开机图片，进入应用。
    hideSplash();
    // 启动后台定时授权检查（每5分钟一次，检测授权是否在使用期间失效）
    startPeriodicLicenseCheck();
  } else {
    state.tree = [];
    state.flatFiles = [];
    renderTree([]);
    showLicenseGate();
    hideSplash();
    await new Promise((resolve) => {
      const check = setInterval(async () => {
        const r = await checkLicenseStatus();
        if (r.activated) {
          clearInterval(check);
          clearLicenseGate();
          resolve();
        }
      }, 1500);
    });
    await bootstrap();
  }
}

function startPeriodicLicenseCheck() {
  const INTERVAL_MS = 5 * 60 * 1000; // 每5分钟
  setInterval(async () => {
    try {
      const result = await checkLicenseStatus();
      if (!result.activated && state.licenseValidatedAt > 0) {
        // 授权在使用期间失效（如过期、被解绑等），触发授权弹窗
        state.licenseValidatedAt = 0;
        showLicenseGate(result.error || "授权已失效，请重新授权");
      }
    } catch (_) {
      // 静默忽略检查错误，不打扰用户
    }
  }, INTERVAL_MS);
}

// —— 图片预览系统 ——
const imagePreviewState = { scale: 1, rotation: 0, src: "", alt: "" };

function openImagePreview(src, alt) {
  const modal = document.getElementById("imagePreviewModal");
  const img = document.getElementById("imagePreviewImg");
  const download = document.getElementById("imagePreviewDownload");
  if (!modal || !img) return;
  imagePreviewState.scale = 1;
  imagePreviewState.rotation = 0;
  imagePreviewState.src = src;
  imagePreviewState.alt = alt || "";
  img.src = src;
  img.alt = alt || "";
  img.style.transform = "";
  img.style.cursor = "zoom-in";
  if (download) {
    try {
      const url = new URL(src, location.href);
      const filename = src.split("/").pop() || "image";
      download.href = src;
      download.download = filename;
      download.style.display = url.protocol === "blob:" || url.protocol === "data:" ? "none" : "inline-flex";
    } catch {
      download.style.display = "none";
    }
  }
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeImagePreview() {
  const modal = document.getElementById("imagePreviewModal");
  if (!modal) return;
  modal.classList.add("hidden");
  document.body.style.overflow = "";
  imagePreviewState.scale = 1;
  imagePreviewState.rotation = 0;
  const img = document.getElementById("imagePreviewImg");
  if (img) { img.style.transform = ""; img.style.cursor = "zoom-in"; }
}

function applyImagePreviewTransform() {
  const img = document.getElementById("imagePreviewImg");
  if (!img) return;
  const { scale, rotation } = imagePreviewState;
  img.style.transform = `scale(${scale}) rotate(${rotation}deg)`;
  img.style.cursor = scale > 1 ? "zoom-out" : "zoom-in";
}

document.addEventListener("keydown", (event) => {
  const modal = document.getElementById("imagePreviewModal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeImagePreview();
  } else if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    imagePreviewState.scale = Math.min(imagePreviewState.scale + 0.25, 5);
    applyImagePreviewTransform();
  } else if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    imagePreviewState.scale = Math.max(imagePreviewState.scale - 0.25, 0.25);
    applyImagePreviewTransform();
  } else if (event.key === "0") {
    event.preventDefault();
    imagePreviewState.scale = 1;
    imagePreviewState.rotation = 0;
    applyImagePreviewTransform();
  }
});

const ipModal = document.getElementById("imagePreviewModal");
const ipImg = document.getElementById("imagePreviewImg");
const ipClose = ipModal?.querySelector(".image-preview-close");
const ipBackdrop = ipModal?.querySelector(".image-preview-backdrop");
const ipToolbar = ipModal?.querySelector(".image-preview-toolbar");

ipClose?.addEventListener("click", closeImagePreview);
ipBackdrop?.addEventListener("click", closeImagePreview);

ipImg?.addEventListener("click", () => {
  if (imagePreviewState.scale > 1) {
    imagePreviewState.scale = 1;
    imagePreviewState.rotation = 0;
  } else {
    imagePreviewState.scale = 2;
  }
  applyImagePreviewTransform();
});

ipImg?.addEventListener("wheel", (event) => {
  event.preventDefault();
  const delta = event.deltaY > 0 ? -0.1 : 0.1;
  imagePreviewState.scale = Math.max(0.25, Math.min(5, imagePreviewState.scale + delta));
  applyImagePreviewTransform();
}, { passive: false });

ipToolbar?.addEventListener("click", (event) => {
  const btn = event.target.closest(".image-preview-btn");
  if (!btn) return;
  const action = btn.dataset.action;
  if (!action) return;
  event.preventDefault();
  switch (action) {
    case "zoom-in":
      imagePreviewState.scale = Math.min(imagePreviewState.scale + 0.25, 5);
      break;
    case "zoom-out":
      imagePreviewState.scale = Math.max(imagePreviewState.scale - 0.25, 0.25);
      break;
    case "zoom-reset":
      imagePreviewState.scale = 1;
      imagePreviewState.rotation = 0;
      break;
    case "rotate-left":
      imagePreviewState.rotation -= 90;
      break;
    case "rotate-right":
      imagePreviewState.rotation += 90;
      break;
  }
  applyImagePreviewTransform();
});

// 启动入口：开机图片已在 HTML 中直接渲染显示，立即并行加载后台服务。
beginLoading();
