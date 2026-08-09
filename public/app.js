import { createMarkdownEditor } from "/editor-core.js?v=20260807-v1";

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
const MARKDOWN_WORKER_URL = "/markdown-worker.js?v=20260809-worker-4";
const AI_HISTORY_KEY = "mytemple.ai.history.v1";
const AI_TRANSFORM_LABELS = { summary: "摘要", keypoints: "要点", terms: "术语解释", polish: "润色", continue: "续写", rewrite: "代写", translate: "翻译", hint: "编辑提示" };

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
  previewVisible: true,
  previewBeforeImmersive: true,
  previewTimer: 0,
  previewLastContent: "",
  previewRenderSeq: 0,
  previewPending: null,
  previewAnchors: [],
  editorOutlineVisible: localStorage.getItem("editorOutlineVisible") !== "0",
  editorOutlineTimer: 0,
  editorOutlineSeq: 0,
  currentContentBytes: 0,
  largeDocument: false,
  previewAutoHidden: false,
  markdownWorker: null,
  markdownWorkerSeq: 0,
  markdownWorkerPending: new Map(),
  markdownWorkerFailed: false,
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
};

els.editor = createMarkdownEditor(els.editor);

if (els.graphDynamic) els.graphDynamic.checked = state.graphView.dynamic;

const api = {
  async get(path) {
    const response = await fetch(path);
    if (!response.ok) {
      const body = await response.text();
      try { throw new Error(JSON.parse(body).error || body); } catch (error) { if (error instanceof SyntaxError) throw new Error(body); throw error; }
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
      try { throw new Error(JSON.parse(body).error || body); } catch (error) { if (error instanceof SyntaxError) throw new Error(body); throw error; }
    }
    return response.json();
  },
};

// === 周期性 Perlin 噪声：确保纹理无缝平铺 ===
// gridSize: 网格单元数（2 的幂次），tileSize: 瓦片像素尺寸
function createPeriodicPerlin(gridSize, tileSize, seed) {
  const N = gridSize;
  const hashLen = N * N;
  const perm = new Int32Array(hashLen * 2);
  const gradX = new Float32Array(hashLen);
  const gradY = new Float32Array(hashLen);
  let s = seed | 0;
  function lcg() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  }
  for (let i = 0; i < hashLen; i += 1) {
    perm[i] = i;
  }
  for (let i = hashLen - 1; i > 0; i -= 1) {
    const j = Math.floor(lcg() * (i + 1));
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  for (let i = 0; i < hashLen; i += 1) {
    const angle = lcg() * Math.PI * 2;
    gradX[i] = Math.cos(angle);
    gradY[i] = Math.sin(angle);
  }
  const t = 1 / tileSize;
  function fade(x) { return x * x * x * (x * (x * 6 - 15) + 10); }
  function lerp(a, b, t2) { return a + (b - a) * t2; }
  function noise(px, py) {
    const fx = px * t * N;
    const fy = py * t * N;
    const x0 = ((fx | 0) % N + N) % N;
    const y0 = ((fy | 0) % N + N) % N;
    const x1 = (x0 + 1) % N;
    const y1 = (y0 + 1) % N;
    const u = fade(fx - (fx | 0));
    const v = fade(fy - (fy | 0));
    const dx = fx - (fx | 0);
    const dy = fy - (fy | 0);
    const i00 = perm[y0 * N + x0];
    const i10 = perm[y0 * N + x1];
    const i01 = perm[y1 * N + x0];
    const i11 = perm[y1 * N + x1];
    const n00 = gradX[i00] * dx + gradY[i00] * dy;
    const n10 = gradX[i10] * (dx - 1) + gradY[i10] * dy;
    const n01 = gradX[i01] * dx + gradY[i01] * (dy - 1);
    const n11 = gradX[i11] * (dx - 1) + gradY[i11] * (dy - 1);
    const nx0 = lerp(n00, n10, u);
    const nx1 = lerp(n01, n11, u);
    return lerp(nx0, nx1, v);
  }
  // 多八度分形布朗运动 (fBm)
  function fbm(px, py, octaves) {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;
    for (let i = 0; i < octaves; i += 1) {
      value += noise(px * frequency, py * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }
    return value / maxValue;
  }
  return { noise, fbm };
}

// === 生成无缝平铺纸张纹理 ===
function generateSeamlessPaperTextureDataUrl(size, seed) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const { fbm, noise } = createPeriodicPerlin(12, size, seed);

  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  const baseR = 238, baseG = 226, baseB = 200;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      const n1 = fbm(x * 0.8, y * 0.8, 4);
      const n2 = fbm(x * 2.5, y * 2.5, 3);
      const n3 = fbm(x * 5.0, y * 5.0, 2);

      const fiber = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
      const intensity = (fiber + 1) * 0.5;

      const shade = 0.88 + intensity * 0.18;
      const tintR = 1.0;
      const tintG = 0.96 + intensity * 0.03;
      const tintB = 0.86 + intensity * 0.05;

      let r = baseR * shade * tintR;
      let g = baseG * shade * tintG;
      let b = baseB * shade * tintB;

      const ghash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const grain = (ghash - Math.floor(ghash)) - 0.5;
      const grainN = grain * 1.8;
      r += grainN;
      g += grainN * 0.5;
      b += grainN * 0.10;

      data[idx] = Math.max(0, Math.min(255, r));
      data[idx + 1] = Math.max(0, Math.min(255, g));
      data[idx + 2] = Math.max(0, Math.min(255, b));
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

function _mkValueNoise2D(seed) {
  const SIZE = 256;
  const grid = new Float32Array(SIZE * SIZE);
  let s = seed | 0;
  function lcg() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  }
  for (let i = 0; i < grid.length; i++) {
    grid[i] = lcg() * 2 - 1;
  }
  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function noise(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const xf = x - x0;
    const yf = y - y0;
    const x0m = ((x0 % SIZE) + SIZE) % SIZE;
    const x1m = ((x0 + 1) % SIZE + SIZE) % SIZE;
    const y0m = ((y0 % SIZE) + SIZE) % SIZE;
    const y1m = ((y0 + 1) % SIZE + SIZE) % SIZE;
    const v00 = grid[y0m * SIZE + x0m];
    const v10 = grid[y0m * SIZE + x1m];
    const v01 = grid[y1m * SIZE + x0m];
    const v11 = grid[y1m * SIZE + x1m];
    const u = smoothstep(xf);
    const v = smoothstep(yf);
    const nx0 = v00 + (v10 - v00) * u;
    const nx1 = v01 + (v11 - v01) * u;
    return nx0 + (nx1 - nx0) * v;
  }
  function fbm(x, y, octaves) {
    let val = 0, amp = 1, freq = 1, maxV = 0;
    for (let i = 0; i < octaves; i++) {
      val += noise(x * freq, y * freq) * amp;
      maxV += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return val / maxV;
  }
  return { noise, fbm };
}

function generateLargePaperTextureDataUrl(w, h, seed) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const baseR = 238, baseG = 226, baseB = 200;

  const n1 = _mkValueNoise2D(seed);
  const n2 = _mkValueNoise2D(seed + 101);
  const n3 = _mkValueNoise2D(seed + 203);
  const n4 = _mkValueNoise2D(seed + 307);

  const imgData = ctx.createImageData(w, h);
  const data = imgData.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;

      const nx = x * 0.0025;
      const ny = y * 0.0025;
      const coarse = n1.fbm(nx, ny, 4);
      const medium = n2.fbm(x * 0.007, y * 0.007, 3);
      const fine = n3.fbm(x * 0.020, y * 0.020, 3);
      const micro = n4.fbm(x * 0.050, y * 0.050, 2);

      const combined = coarse * 0.48 + medium * 0.28 + fine * 0.16 + micro * 0.08;
      const intensity = (combined + 1) * 0.5;

      const shade = 0.88 + intensity * 0.20;
      const tintR = 1.0;
      const tintG = 0.96 + intensity * 0.03;
      const tintB = 0.86 + intensity * 0.05;

      let r = baseR * shade * tintR;
      let g = baseG * shade * tintG;
      let b = baseB * shade * tintB;

      const ghash = ((x * 374761393) ^ (y * 668265263)) & 0xff;
      const grainN = (ghash / 255 - 0.5) * 1.8;

      data[idx] = Math.max(0, Math.min(255, r + grainN));
      data[idx + 1] = Math.max(0, Math.min(255, g + grainN * 0.5));
      data[idx + 2] = Math.max(0, Math.min(255, b + grainN * 0.10));
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

let _paperBgCache = "";
let _paperBgCacheKey = "";
function getPaperBackgroundUrl() {
  const vw = window.innerWidth || 1920;
  const vh = window.innerHeight || 1080;
  const w = Math.min(vw, 2400);
  const h = Math.min(vh + 200, 2400);
  const key = `${w}x${h}`;
  if (_paperBgCacheKey === key && _paperBgCache) return _paperBgCache;
  try {
    _paperBgCache = generateLargePaperTextureDataUrl(w, h, 54321);
    _paperBgCacheKey = key;
    return _paperBgCache;
  } catch (_) {
    return "";
  }
}

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
      background-color: #e8dcc6;
      background-image:
        var(--paper-bg),
        radial-gradient(ellipse 60% 40% at 50% 50%, rgba(245, 235, 215, 0.12), transparent 70%);
      background-size: 100% 100%, cover;
      background-repeat: no-repeat, no-repeat;
      background-attachment: fixed, fixed;
    }
    body[data-theme="eye"]::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 9999;
      background:
        radial-gradient(ellipse 80% 60% at 50% 50%, transparent 65%, rgba(50, 35, 12, 0.05) 100%);
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
      background: rgba(110, 88, 55, 0.20);
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
    theme: localStorage.getItem("docTheme") || "dark",
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
  const themeColorMap = { dark: "#1e1e1e", eye: "#efe3cc", image: "#1a1a2e", bagua: "#14110d" };
  const themeBgMap = { dark: "#1e1e1e", eye: "#efe3cc", image: "#1a1a2e", bagua: "#14110d" };
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
  } else {
    document.documentElement.style.removeProperty("--accent");
  }
  const currentScale = parseFloat(document.documentElement.style.getPropertyValue("--app-scale")) || 1;
  document.documentElement.style.setProperty("--app-font-size", `${Math.round(settings.fontSize * currentScale)}px`);
  document.documentElement.style.setProperty("--doc-font-size", `${Math.round(settings.contentFontSize * currentScale)}px`);
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
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
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
      outline.push({ id: headingId(heading[3], index), title: plainText(heading[3]), level, line: lineNo });
      continue;
    }
    const autoHeading = line.match(/^(\s*)([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (autoHeading) {
      const level = 2;
      outline.push({ id: headingId(autoHeading[2], `auto-${h2Index++}`), title: plainText(autoHeading[2]), level, line: lineNo });
      h3Index = 0;
      h4Index = 0;
      continue;
    }
    const dottedHeading = line.match(/^(\s*)(\d+(?:\.\d+)+)[、.．]\s*([^-*].+)$/);
    if (dottedHeading) {
      const level = 3;
      outline.push({ id: headingId(dottedHeading[3], `num-h3-${h3Index++}`), title: plainText(dottedHeading[3]), level, line: lineNo });
      h4Index = 0;
      continue;
    }

    const numHeading = line.match(/^(\s*)(\((?:\d{1,3})\)|(\d{1,3})([、.．)]))\s*([^-*].+)$/);
    if (numHeading && !/^\s*\d+[.)]\s+\[[ xX]\](?:\s|$)/.test(line)) {
      const level = 4;
      outline.push({ id: headingId(numHeading[5], `num-h4-${h4Index++}`), title: plainText(numHeading[5]), level, line: lineNo });
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
  const wait = value.length > 100000 ? 600 : value.length > 20000 ? 260 : 120;
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
  const itemButton = (item) => {
    const indent = Math.max(0, item.level - 1) * 14;
    return `<button class="editor-outline-item level-${item.level}" data-heading-text="${escapeHtml(item.title)}" data-heading-line="${Number.isFinite(item.line) ? item.line : -1}" style="margin-left:${indent}px" title="${escapeHtml(item.title)}">${escapeHtml(compactName(item.title, 15))}</button>`;
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

function setEditorOutlineVisible(visible) {
  state.editorOutlineVisible = Boolean(visible);
  localStorage.setItem("editorOutlineVisible", state.editorOutlineVisible ? "1" : "0");
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
    if (typeof applyEditorSplitterLayout === "function") applyEditorSplitterLayout();
    if (state.mode === "edit") {
      els.editor.view?.requestMeasure?.();
      syncPreviewToEditor();
    }
  });
}

function findHeadingLineInEditor(headingText) {
  const value = els.editor.value;
  if (!headingText) return -1;
  const lines = value.split("\n");
  const target = plainText(headingText).toLowerCase();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (match && plainText(match[3]).toLowerCase() === target) return index;
    const autoMatch = lines[index].match(/^(\s*)([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (autoMatch && plainText(autoMatch[2]).toLowerCase() === target) return index;
  }
  return -1;
}

function scrollEditorToHeading(headingText) {
  const lineIndex = findHeadingLineInEditor(headingText);
  if (lineIndex < 0) return;
  els.editor.scrollToLine?.(lineIndex + 1);
}

function stripFrontmatter(markdown) {
  const source = String(markdown || "");
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return source;
  const before = source.slice(0, match.index).trimEnd();
  const after = source.slice(match.index + match[0].length).trimStart();
  return (before ? before + "\n\n" : "") + after;
}

function normalizeAssetUrlsToRelative(html) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  wrapper.querySelectorAll("[src], [href]").forEach((el) => {
    const attr = el.hasAttribute("src") ? "src" : "href";
    const value = el.getAttribute(attr) || "";
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i.test(value)) {
      try {
        const url = new URL(value, window.location.origin);
        if (url.pathname) el.setAttribute(attr, url.pathname + url.search + url.hash);
      } catch (_) { /* keep original */ }
    }
  });
  return wrapper.innerHTML;
}

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
  const exportNote = showAuthor ? `<p class="print-author">由 MyTemple Knowledge 导出 · ${authorLabel}</p>` : "";
  const footerLabel = escapeHtml(pdfSettings.footerText || "MyTemple Knowledge · 本地 Markdown 知识库");
  const footer = showFooter ? `<footer class="print-footer"><span>${footerLabel}</span></footer>` : "";
  const watermark = buildExportWatermark(pdfSettings.watermarkText);
  return `<article class="print-article">
    ${watermark}
    <header class="print-header">
      <h1 class="print-title">${escapeHtml(title)}</h1>
      ${dateLabel ? `<p class="print-meta">${escapeHtml(dateLabel)}</p>` : ""}
      ${exportNote}
    </header>
    <div class="print-body">${body}</div>
    ${footer}
  </article>`;
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
    const done = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector(".custom-dialog-cancel").addEventListener("click", () => done(false));
    overlay.querySelector(".custom-dialog-confirm").addEventListener("click", () => done(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(false); });
    const onKey = (e) => {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); done(false); }
      else if (e.key === "Enter") { document.removeEventListener("keydown", onKey); done(true); }
    };
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
    const done = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector(".custom-dialog-cancel").addEventListener("click", () => done(null));
    overlay.querySelector(".custom-dialog-confirm").addEventListener("click", () => done(inputEl?.value ?? ""));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(null); });
    const onKey = (e) => {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); done(null); }
      else if (e.key === "Enter") { document.removeEventListener("keydown", onKey); done(inputEl?.value ?? ""); }
    };
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
    const done = () => { overlay.remove(); resolve(true); };
    overlay.querySelector(".custom-dialog-confirm").addEventListener("click", done);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(); });
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") { document.removeEventListener("keydown", onKey); done(); }
    };
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => overlay.querySelector(".custom-dialog-confirm")?.focus());
  });
}

// 打印样式：注入到打印 iframe，使导出的 PDF 不依赖主页面样式，
// 同时 iframe 来源为 about:blank，浏览器页眉页脚不会显示本机地址与端口。
const PRINT_STYLES = `html,body{margin:0;padding:0;background:#fff;}
.print-article{background:#ffffff;color:#1f2937;font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;font-size:14px;line-height:1.75;padding:48px 56px;max-width:820px;margin:0 auto;}
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
.print-body pre{background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;padding:14px 16px;overflow-x:auto;font-family:"Cascadia Code",Consolas,monospace;font-size:13px;line-height:1.6;page-break-inside:avoid;}
.print-body code{font-family:"Cascadia Code",Consolas,monospace;font-size:0.92em;background:rgba(15,23,42,0.06);padding:1px 5px;border-radius:3px;}
.print-body pre code{background:transparent;padding:0;border-radius:0;font-size:13px;}
.print-body table{width:100%;border-collapse:collapse;margin:1em 0;font-size:13px;page-break-inside:avoid;}
.print-body th,.print-body td{border:1px solid #d1d5db;padding:8px 12px;text-align:left;}
.print-body th{background:#f1f5f9;font-weight:600;}
.print-body ul,.print-body ol{margin:0.7em 0;padding-left:1.8em;}
.print-body li{margin:0.3em 0;}
.print-body hr{border:0;border-top:1px solid #e5e7eb;margin:1.8em 0;}
.print-footer{margin-top:36px;padding-top:14px;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af;}
.print-watermark{position:fixed;top:0;left:0;width:100%;height:100%;display:flex;justify-content:center;align-items:center;font-size:52px;color:rgba(15,23,42,0.05);pointer-events:none;transform:rotate(-30deg);z-index:9999;letter-spacing:6px;white-space:nowrap;font-weight:700;}
@page{margin:18mm 16mm;}`;

async function exportCurrentDocToPdf() {
  if (!state.currentPath && !state.currentContent) {
    showToast("请先打开一个文档");
    return;
  }
  showToast("正在准备 PDF 导出...");
  let html = buildDocumentPrintHtml();
  html = await inlinePrintImages(html);
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
    iframe.remove();
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
        setTimeout(resolve, 3000);
      })));
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 120));
    iframe.contentWindow.focus();
    showToast("提示：若不需要页眉页脚，请在打印对话框中取消勾选「页眉与页脚」");
    iframe.contentWindow.addEventListener("afterprint", cleanup);
    iframe.contentWindow.print();
  } catch (error) {
    console.error(error);
    showToast("无法调起打印对话框，请检查浏览器设置");
    cleanup();
  }
  setTimeout(cleanup, 60000);
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
function splitMarkdownIntoSlides(markdown) {
  const source = stripFrontmatter(String(markdown || "")).trim();
  if (!source) return [];
  // 优先按独立成行的 --- 分页（水平分隔线作为幻灯片断点）
  const byRule = source.split(/(?:\r?\n|\r)\s*-{3,}\s*(?:\r?\n|\r)/).map((s) => s.trim()).filter(Boolean);
  if (byRule.length > 1) return byRule;
  // 无分隔线时按二级标题拆分，标题前内容作为封面
  const chunks = [];
  const headingRe = /^##\s+/m;
  if (!headingRe.test(source)) return [source];
  const lines = source.split(/\r?\n/);
  let buffer = [];
  for (const line of lines) {
    if (/^##\s+/.test(line) && buffer.length) {
      chunks.push(buffer.join("\n").trim());
      buffer = [];
    }
    buffer.push(line);
  }
  if (buffer.length) chunks.push(buffer.join("\n").trim());
  return chunks.filter(Boolean);
}

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
.slide{width:min(960px,92vw);height:min(600px,80vh);background:#fff;border-radius:12px;padding:48px 56px;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);display:none;position:relative;}
.slide.active{display:block;}
.slide h1{font-size:36px;font-weight:700;color:#1a1a2e;margin-bottom:24px;line-height:1.35;border-bottom:3px solid #6366f1;padding-bottom:12px;}
.slide h2{font-size:30px;font-weight:600;color:#312e81;margin:20px 0 14px;}
.slide h3{font-size:24px;font-weight:600;color:#4338ca;margin:16px 0 10px;}
.slide p{font-size:20px;line-height:1.8;color:#374151;margin:12px 0;}
.slide ul,.slide ol{margin:12px 0;padding-left:32px;font-size:20px;line-height:1.8;color:#374151;}
.slide li{margin:6px 0;}
.slide blockquote{border-left:4px solid #6366f1;background:#f5f3ff;padding:12px 20px;margin:16px 0;border-radius:0 8px 8px 0;color:#4b5563;font-size:19px;}
.slide pre{background:#1e293b;color:#e2e8f0;border-radius:8px;padding:16px 20px;overflow-x:auto;font-family:"Cascadia Code",Consolas,monospace;font-size:16px;line-height:1.6;margin:14px 0;}
.slide code{font-family:"Cascadia Code",Consolas,monospace;background:rgba(99,102,241,0.1);padding:2px 6px;border-radius:4px;font-size:0.9em;color:#4338ca;}
.slide pre code{background:transparent;padding:0;color:inherit;}
.slide table{width:100%;border-collapse:collapse;margin:16px 0;font-size:18px;}
.slide th,.slide td{border:1px solid #d1d5db;padding:8px 14px;text-align:left;}
.slide th{background:#eef2ff;font-weight:600;color:#312e81;}
.slide img{max-width:100%;height:auto;border-radius:8px;margin:14px auto;display:block;}
.slide a{color:#4338ca;text-decoration:underline;}
.slide hr{border:0;border-top:2px solid #e5e7eb;margin:20px 0;}
.deck-watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:48px;color:rgba(99,102,241,0.06);pointer-events:none;z-index:9999;font-weight:700;letter-spacing:6px;white-space:nowrap;}
.nav{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:16px;background:rgba(255,255,255,0.1);backdrop-filter:blur(8px);padding:8px 20px;border-radius:999px;z-index:10000;}
.nav button{background:rgba(255,255,255,0.15);border:0;color:#fff;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:18px;transition:background 0.2s;}
.nav button:hover{background:rgba(255,255,255,0.3);}
.nav .counter{color:rgba(255,255,255,0.8);font-size:14px;min-width:60px;text-align:center;}
.progress{position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#6366f1,#8b5cf6);transition:width 0.3s ease;z-index:10000;}
.hint{position:fixed;top:16px;right:20px;color:rgba(255,255,255,0.4);font-size:12px;z-index:10000;}
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
<div class="hint">← → 翻页 · F 全屏 · 点击右侧前进</div>
<script>
(function(){
  var slides = ${slidesJson};
  var deck = document.getElementById("deck");
  var current = 0;
  slides.forEach(function(html, i){
    var div = document.createElement("div");
    div.className = "slide" + (i === 0 ? " active" : "");
    div.innerHTML = html;
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
  });
  show(0);
})();
</script>
</body>
</html>`;
  const blob = new Blob([presentationHtml], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const safeName = String(title).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "幻灯片";
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName}_幻灯片.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast(`已导出 ${slides.length} 页幻灯片，双击 HTML 文件即可演示`);
}

function ensureMarkdownWorker() {
  if (state.markdownWorker || state.markdownWorkerFailed) return state.markdownWorker;
  try {
    state.markdownWorker = new Worker(MARKDOWN_WORKER_URL);
    state.markdownWorker.addEventListener("message", (event) => {
      const { seq, html, outline } = event.data || {};
      const pending = state.markdownWorkerPending.get(seq);
      if (!pending) return;
      state.markdownWorkerPending.delete(seq);
      pending.resolve({ html, outline });
    });
    state.markdownWorker.addEventListener("error", (event) => {
      state.markdownWorkerFailed = true;
      const error = event?.error || new Error("Markdown worker failed");
      for (const pending of state.markdownWorkerPending.values()) pending.reject(error);
      state.markdownWorkerPending.clear();
      if (state.markdownWorker) state.markdownWorker.terminate();
      state.markdownWorker = null;
    });
  } catch (error) {
    state.markdownWorkerFailed = true;
    console.error(error);
  }
  return state.markdownWorker;
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
  return new Promise((resolve, reject) => {
    state.markdownWorkerPending.set(seq, { resolve, reject });
    worker.postMessage({ seq, source, searchTerm, includeHtml, includeOutline });
  });
}

async function renderReaderContent(source, options = {}) {
  const content = String(source || "");
  const searchTerm = options.searchTerm || "";
  try {
    const { html, outline } = await requestMarkdownRender({
      source: content,
      searchTerm,
      includeHtml: true,
      includeOutline: true,
    });
    if (state.currentContent !== content && !searchTerm) return;
    els.markdownView.innerHTML = html ?? cachedRenderMarkdown(content, { searchTerm });
    renderOutlineItems(outline || extractOutline(content));
  } catch (error) {
    console.error(error);
    els.markdownView.innerHTML = cachedRenderMarkdown(content, { searchTerm });
    renderOutline(content);
  }
}

function inlineMarkdown(value, searchTerm = "") {
  let html = escapeHtml(value)
    .replace(/%%[\s\S]*?%%/g, "")
    .replace(/\$\$([\s\S]+?)\$\$/g, "<code class=\"math\">$1</code>")
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
    .replace(/\[\^([\w-]+)\]/g, '<sup class="footnote-ref"><a href="#fn-$1">[^$1]</a></sup>')
    .replace(/(^|[\s>])#([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]{1,30})(?![\w\u4e00-\u9fa5-])/g, '$1<span class="md-tag">#$2</span>')
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

const CODE_KEYWORDS = {
  javascript: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|delete|void|yield|async|await|try|catch|finally|throw|import|export|from|default|as|static|get|set|null|undefined|true|false|NaN|Infinity)\b/g,
  typescript: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|delete|void|yield|async|await|try|catch|finally|throw|import|export|from|default|as|static|get|set|null|undefined|true|false|NaN|Infinity|interface|type|enum|namespace|declare|abstract|readonly|public|private|protected|implements|keyof|infer|is)\b/g,
  python: /\b(?:def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|try|except|finally|raise|with|lambda|yield|global|nonlocal|assert|del|in|not|and|or|is|None|True|False|self|cls|async|await)\b/g,
  go: /\b(?:func|return|if|else|for|range|switch|case|default|break|continue|var|const|type|struct|interface|map|chan|package|import|defer|go|select|fallthrough|goto|nil|true|false)\b/g,
  rust: /\b(?:fn|let|mut|const|static|struct|enum|trait|impl|pub|use|mod|return|if|else|match|for|while|loop|break|continue|as|in|ref|move|async|await|unsafe|extern|crate|self|Self|super|type|where|dyn|union)\b/g,
  java: /\b(?:public|private|protected|static|final|void|class|interface|extends|implements|return|if|else|for|while|do|switch|case|break|continue|new|this|super|try|catch|finally|throw|throws|import|package|instanceof|synchronized|abstract|enum|null|true|false|int|long|double|float|boolean|char|byte|short|String)\b/g,
  c: /\b(?:int|long|short|char|float|double|void|unsigned|signed|const|static|extern|register|volatile|auto|struct|union|enum|typedef|return|if|else|for|while|do|switch|case|break|continue|default|goto|sizeof|NULL|true|false|include|define|ifdef|ifndef|endif)\b/g,
  cpp: /\b(?:int|long|short|char|float|double|void|unsigned|signed|const|static|extern|register|volatile|auto|struct|union|enum|class|namespace|template|typename|public|private|protected|virtual|override|return|if|else|for|while|do|switch|case|break|continue|default|goto|sizeof|new|delete|this|nullptr|true|false|include|define|ifdef|ifndef|endif|using|operator)\b/g,
  csharp: /\b(?:public|private|protected|static|readonly|const|void|class|interface|struct|enum|extends|implements|return|if|else|for|while|do|switch|case|break|continue|new|this|base|try|catch|finally|throw|using|namespace|var|dynamic|async|await|get|set|value|null|true|false|int|long|double|float|bool|char|string|byte|object|override|virtual|abstract|sealed)\b/g,
  ruby: /\b(?:def|end|class|module|return|if|elsif|else|unless|case|when|while|until|for|break|next|redo|retry|yield|begin|rescue|ensure|raise|require|require_relative|include|extend|attr_accessor|attr_reader|attr_writer|self|super|nil|true|false|lambda|do|then)\b/g,
  bash: /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|break|continue|exit|local|export|unset|read|echo|printf|source|alias|unalias|trap|set|unset|shift|cd|pwd|ls|cat|grep|sed|awk|find|chmod|chown|mkdir|rmdir|rm|cp|mv|touch|head|tail|wc|sort|uniq|cut|tr|tee|xargs)\b/g,
  powershell: /\b(?:param|function|return|if|else|elseif|switch|for|foreach|while|do|break|continue|try|catch|finally|throw|using|namespace|class|enum|var|Write-Output|Write-Host|Write-Error|Get-ChildItem|Set-Location|Get-Content|New-Item|Remove-Item|Copy-Item|Move-Item|Select-Object|Where-Object|ForEach-Object|Sort-Object|Format-Table|Out-String|Invoke-WebRequest)\b/g,
  sql: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|ON|GROUP|BY|HAVING|ORDER|ASC|DESC|LIMIT|OFFSET|UNION|ALL|DISTINCT|AS|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|IS|NULL|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|CONSTRAINT|UNIQUE|CHECK|CASCADE|TRIGGER|PROCEDURE|FUNCTION|RETURNS|DECLARE|BEGIN|COMMIT|ROLLBACK|TRANSACTION)\b/gi,
  json: /\b(?:true|false|null)\b/g,
  yaml: /\b(?:true|false|null|yes|no|on|off)\b/g,
  html: /\b(?:html|head|body|div|span|p|a|img|ul|ol|li|table|tr|td|th|thead|tbody|form|input|button|label|select|option|textarea|h1|h2|h3|h4|h5|h6|br|hr|meta|link|script|style|title|nav|header|footer|main|section|article|aside|figure|figcaption|code|pre|blockquote)\b/gi,
};

const BUILTIN_TYPES = /\b(?:string|number|boolean|object|array|Promise|Date|RegExp|Error|Map|Set|Symbol|BigInt|Uint8Array|ArrayBuffer|JSON|Math|console|window|document|process|Buffer|require|module|exports|global|window|setTimeout|setInterval|clearTimeout|clearInterval|fetch|console)\b/g;

function highlightCode(raw, language) {
  let code = escapeHtml(raw);
  const lang = String(language || "text").toLowerCase();

  // 1. Comments (highest priority - protect from further matching)
  const commentSpans = [];
  code = code.replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)/g, (match) => {
    const idx = commentSpans.length;
    commentSpans.push(`<span class="tok-comment">${match}</span>`);
    return `\x00C${idx}\x00`;
  });

  // 2. Strings
  const stringSpans = [];
  code = code.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, (match) => {
    const idx = stringSpans.length;
    stringSpans.push(`<span class="tok-string">${match}</span>`);
    return `\x00S${idx}\x00`;
  });

  // 3. Numbers
  code = code.replace(/\b(\d+\.?\d*(?:e[+-]?\d+)?|0x[0-9a-fA-F]+|0b[01]+)\b/g, '<span class="tok-number">$1</span>');

  // 4. Keywords
  const kwPattern = CODE_KEYWORDS[lang] || CODE_KEYWORDS.javascript;
  code = code.replace(kwPattern, (match) => `<span class="tok-keyword">${match}</span>`);

  // 5. Built-in types & globals (only for JS/TS family)
  if (["javascript", "typescript", "json"].includes(lang)) {
    code = code.replace(BUILTIN_TYPES, (match) => `<span class="tok-builtin">${match}</span>`);
  }

  // 6. Function calls: word followed by (
  code = code.replace(/\b([a-zA-Z_$][\w$]*)(\s*\()/g, (match, name, paren) => {
    if (match.includes("span class=")) return match;
    return `<span class="tok-function">${name}</span>${paren}`;
  });

  // 7. HTML/XML tags (for html, xml, markdown)
  if (["html", "xml", "markdown"].includes(lang)) {
    code = code.replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="tok-tag">$2</span>');
    code = code.replace(/\s([\w-]+)(=)/g, ' <span class="tok-attr">$1</span>$2');
  }

  // Restore strings
  code = code.replace(/\x00S(\d+)\x00/g, (_, idx) => stringSpans[Number(idx)] || "");
  // Restore comments
  code = code.replace(/\x00C(\d+)\x00/g, (_, idx) => commentSpans[Number(idx)] || "");

  return code;
}

function renderMarkdown(source, options = {}) {
  const searchTerm = options.searchTerm || "";
  const editTools = options.editTools === true;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
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
  const footnoteDefs = [];

  const flushList = () => {
    if (!list) return;
    const hasTasks = list.items.some((item) => item.task);
    const listClass = hasTasks ? ' class="contains-task-list"' : "";
    const items = list.items.map((item) => `<li${item.task ? ' class="task-list-item"' : ""}>${item.html}</li>`).join("");
    html.push(`<${list.type}${listClass}>${items}</${list.type}>`);
    list = null;
  };
  const flushBlockquote = () => {
    if (!blockquote.length) return;
    const first = blockquote[0];
    const calloutMatch = first.match(/^\[!(note|info|tip|warning|danger|quote|success|question|bug|example|failure|abstract|todo|important|caution)\]\s*(.*)$/i);
    if (calloutMatch) {
      const type = calloutMatch[1].toLowerCase();
      const title = calloutMatch[2].trim();
      const body = blockquote.slice(1);
      const titleHtml = `<strong class="callout-title">${inlineMarkdown(title || type, searchTerm)}</strong>`;
      const bodyHtml = body.map((l) => inlineMarkdown(l, searchTerm)).filter(Boolean).join("<br />");
      html.push(`<div class="callout callout-${type}">${titleHtml}${bodyHtml ? `<div class="callout-body">${bodyHtml}</div>` : ""}</div>`);
    } else {
      const content = blockquote.map((l) => inlineMarkdown(l, searchTerm)).join("<br />");
      html.push(`<blockquote>${content}</blockquote>`);
    }
    blockquote = [];
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
        html.push(`<div class="markdown-table-wrap">${tools}${tableHtml}</div>`);
      } else {
        html.push(`<div class="markdown-table-wrap">${tableHtml}</div>`);
      }
    }
    table = [];
    tableStartLine = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushList();
      flushTable();
      flushBlockquote();
      if (inCode) {
        const raw = code.join("\n");
        html.push(`<div class="code-block" data-language="${codeLanguage}"><span class="code-language">${escapeHtml(codeLanguage)}</span><button class="code-copy" type="button">\u590d\u5236</button><pre><code class="language-${codeLanguage}">${highlightCode(raw, codeLanguage)}</code></pre></div>`);
        code = [];
        codeLanguage = "text";
      } else {
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
      html.push("<hr />");
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
      flushBlockquote();
      html.push("");
      continue;
    }
    flushList();
    html.push(`<p>${inlineMarkdown(line, searchTerm)}</p>`);
  }
  flushList();
  flushTable();
  flushBlockquote();
  if (inCode) {
    const raw = code.join("\n");
    html.push(`<div class="code-block" data-language="${codeLanguage}"><span class="code-language">${escapeHtml(codeLanguage)}</span><button class="code-copy" type="button">\u590d\u5236</button><pre><code class="language-${codeLanguage}">${highlightCode(raw, codeLanguage)}</code></pre></div>`);
  }
  // 脚注定义统一渲染到文末。
  if (footnoteDefs.length) {
    const items = footnoteDefs.map((fn) => `<li id="fn-${escapeHtml(fn.id)}">${inlineMarkdown(fn.text || "", searchTerm)}</li>`).join("");
    html.push(`<section class="footnotes"><ol>${items}</ol></section>`);
  }
  return html.join("\n");
}

function markdownCacheKey(source, options = {}) {
  const text = String(source || "");
  const mode = options.editTools ? "edit" : "read";
  const searchTerm = options.searchTerm || "";
  return `${mode}\n${searchTerm}\n${text.length}\n${text}`;
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
    requestAnimationFrame(() => {
      const editorMax = Math.max(1, els.editor.scrollHeight - els.editor.clientHeight);
      els.editor.scrollTop = Math.round(editorMax * (state.readerScrollRatio || 0));
      if (typeof applyEditorSplitterLayout === "function") applyEditorSplitterLayout();
    });
    if (state.previewVisible && !state.largeDocument) {
      requestAnimationFrame(() => schedulePreviewUpdate({ immediate: true, forceContent: state.currentContent }));
    }
  }
  if (mode === "view") {
    void renderReaderContent(state.currentContent);
  }
  if (mode !== "graph") stopGraphSimulation();
  if (mode === "graph") requestAnimationFrame(() => initGraph());
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
  const doc = await api.get(`/api/doc?path=${encodeURIComponent(docPath)}`);
  if (seq !== state.openSeq) return;

  const item = state.flatFiles.find((file) => file.path === doc.path) || doc;
  state.activeWorkspaceId = item.workspaceId || doc.path.split(":", 1)[0] || state.activeWorkspaceId;
  state.currentPath = doc.path;
  state.currentContent = doc.content;
  state.currentVersion = doc.contentSha256 || "";
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
  await renderReaderContent(doc.content, { searchTerm: options.searchTerm || "" });
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
  lastInputValue = doc.content;
  setSaveStatus("\u4fdd\u5b58", false);
  syncTreeSelectionState();
  if (state.mode === "graph") scheduleGraphDraw();
  if (options.searchTerm) {
    requestAnimationFrame(() => scrollReaderToElement(els.markdownView.querySelector(".search-hit"), "auto"));
  }
  addRecentDoc(doc.path);
  try { localStorage.setItem("lastOpenedDoc", doc.path); } catch (_) {}
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
      if (els.aiDeepseekApiKey) els.aiDeepseekApiKey.value = status.deepseekApiKey || "";
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

async function submitAiQuestion(event) {
  event?.preventDefault();
  const question = els.aiQuestion?.value.trim();
  if (!question || els.aiSendBtn?.disabled) return;
  state.ai.messages.push({ role: "user", content: question });
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
    els.aiSelectionMenu.style.top = "72px";
    els.aiSelectionMenu.style.transform = "translateX(-50%)";
  } else {
    const range = window.getSelection().getRangeAt(0);
    const rect = range.getBoundingClientRect();
    els.aiSelectionMenu.style.left = `${Math.max(12, Math.min(window.innerWidth - 300, rect.left + rect.width / 2 - 120))}px`;
    els.aiSelectionMenu.style.top = `${Math.max(12, rect.top - 52)}px`;
    els.aiSelectionMenu.style.transform = "";
  }
}

function closeAiTransformModal() {
  els.aiTransformModal?.classList.add("hidden");
  state.ai.transform = null;
}

async function runAiTransform(mode) {
  const selection = state.ai.selection || getAiSelection();
  const isRewrite = mode === "rewrite";
  // 代写模式允许无选区（基于写作要求生成新文档），其余模式需选中文本。
  if (!isRewrite && !selection?.text) return showToast("请先选中一段文本");
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
  if (els.aiTransformInstruction) els.aiTransformInstruction.value = "";
  const sourceText = selection?.text || "";
  els.aiTransformSource.textContent = sourceText
    ? `${selection.source === "editor" ? "编辑器选区" : "阅读器选区"} · ${sourceText.length} 字`
    : "代写模式：根据写作要求生成新文档";
  els.aiTransformResult.value = isRewrite ? "正在根据要求生成文档…" : "正在处理选中文本…";
  els.aiTransformResult.disabled = true;
  els.aiTransformInsertBtn.disabled = isRewrite || selection?.source !== "editor";
  els.aiTransformCreateBtn.disabled = true;
  const instruction = isRewrite ? (els.aiTransformInstruction?.value || "").trim() : "";
  if (isRewrite && !instruction) {
    els.aiTransformResult.value = "";
    els.aiTransformResult.disabled = false;
    return showToast("请在「写作要求」中填写需求");
  }
  try {
    const payload = { text: sourceText, mode };
    if (instruction) payload.instruction = instruction;
    const result = await api.post("/api/ai/transform", payload);
    els.aiTransformResult.value = result.content || "";
    state.ai.transform = { ...(selection || {}), mode, result: result.content || "" };
    els.aiTransformCreateBtn.disabled = !result.content;
    if (result.warning) showToast(result.warning);
  } catch (error) {
    els.aiTransformResult.value = "";
    showToast(error.message || "文本处理失败");
    closeAiTransformModal();
  } finally {
    els.aiTransformResult.disabled = false;
  }
}

async function insertAiTransform() {
  const transform = state.ai.transform;
  const content = els.aiTransformResult.value.trim();
  if (!transform || transform.source !== "editor" || !content) return;
  els.editor.focus();
  els.editor.setRangeText(content, transform.start, transform.end, "end");
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
  closeAiTransformModal();
  showToast("AI 结果已插入当前位置");
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
  return localStorage.getItem("aiEditHint") === "1" && state.mode === "edit" && document.activeElement === els.editor;
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
  // 编辑器失焦时清除提示定时器，光标不在编辑栏时不启动智能编辑提示。
  els.editor?.addEventListener("blur", () => { clearAiEditHintTimer(); hideAiEditHintPopover(); });
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
  const key = `${para.start}:${para.text.slice(0, 32)}`;
  // 同一段落 5 分钟内不重复提示。
  if (key === aiHintState.lastKey && Date.now() - aiHintState.lastShownAt < 300000) return;
  aiHintState.lastKey = key;
  aiHintState.lastShownAt = Date.now();
  aiHintState.inflight = true;
  try {
    const result = await api.post("/api/ai/transform", { text: para.text, mode: "hint" });
    if (!result || !result.content) return;
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
    showAiEditHintPopover({ hint, suggestion, para, warning: result.warning });
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
  popover.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-hint-action]");
    if (!btn) return;
    const action = btn.dataset.hintAction;
    hideAiEditHintPopover();
    state.ai.selection = { source: "editor", text: para.text, start: para.start, end: para.end };
    if (action === "rewrite") runAiTransform("polish");
    else if (action === "insert") insertAiHintComment(suggestion);
    else if (action === "translate") runAiTransform("translate");
  });
  if (warning) showToast(warning);
}

function insertAiHintComment(suggestion) {
  if (!suggestion) return;
  const comment = `\n> ${String(suggestion).split("\n").join("\n> ")}\n`;
  insertAtCursor(comment);
  showToast("已插入注释");
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

function syncPreviewToEditor() {
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
    const currentLine = clamp(els.editor.hasFocus ? cursorLine : scrollLine, 0, Math.max(0, totalLines - 1));
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
    if (!src || src.startsWith("data:") || !src.includes("/source/")) return;
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

function renderCurrentPreview() {
  return renderCurrentPreviewAsync();
}

// 降低全量替换 innerHTML 造成的视觉抖动：先微降不透明度，rAF 写回内容后恢复，
// 用淡入掩盖 DOM 重建瞬间，避免心流编辑被打断。
// 保留滚动位置：innerHTML 重建会重置 scrollTop，导致表格操作等增量编辑后预览跳至文档尾部。
let _previewSwapScheduled = false;
function swapPreviewHtml(html) {
  const preview = els.preview;
  if (!preview) return;
  const savedScroll = preview.scrollTop;
  // 仅做极轻微的透明度过渡（0.75），降低插入样式时的闪烁抖动，不打断心流。
  preview.style.opacity = "0.75";
  preview.innerHTML = html;
  preview.scrollTop = savedScroll;
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
  state.previewVisible = Boolean(visible);
  if (!automatic) state.previewAutoHidden = false;
  else state.previewAutoHidden = !state.previewVisible;
  els.editorBody.classList.toggle("preview-hidden", !state.previewVisible);
  els.editorPanel.classList.toggle("preview-hidden", !state.previewVisible);
  els.previewToggleBtn.textContent = state.previewVisible
    ? "\u9690\u85cf\u9884\u89c8"
    : state.largeDocument ? "\u663e\u793a\u9884\u89c8\uff08\u5927\u6587\u6863\uff09" : "\u663e\u793a\u9884\u89c8";
  els.previewToggleBtn.setAttribute("aria-pressed", String(state.previewVisible));
  if (state.previewVisible) {
    if (state.largeDocument) schedulePreviewUpdate();
    else requestAnimationFrame(() => schedulePreviewUpdate({ immediate: true }));
  } else {
    clearTimeout(state.previewTimer);
    els.preview.classList.remove("preview-pending");
  }
  // 切换预览可见性后重算 grid 列宽，避免编辑栏未占满或右侧留白。
  requestAnimationFrame(() => {
    if (typeof applyEditorSplitterLayout === "function") applyEditorSplitterLayout();
  });
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
    state.currentVersion = result.contentSha256 || state.currentVersion;
  } catch (e) {
    const errorMessage = e?.response?.data?.error || e?.message || "保存失败";
    setSaveStatus("保存失败", false);
    showToast(errorMessage);
    return false;
  }
  if (seq !== state.saveSeq) return true;
  const editorUnchanged = els.editor.value === content;
  const latestContent = els.editor.value;
  state.currentContent = editorUnchanged ? content : latestContent;
  updateLargeDocumentState(state.currentContent);
  state.lastSavedContent = content;
  if (renderAfterSave && editorUnchanged && state.mode === "read") {
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
      snippet.textContent = item.snippet || item.path;
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

function deleteTreeItem(path) {
  if (!path) return;
  state.deleteTarget = path;
  els.deleteTarget.textContent = path;
  els.deleteModal.classList.remove("hidden");
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
      openDoc(response.newPath);
    }
    showToast("重命名成功");
  } catch (error) {
    showToast(error.message || "重命名失败");
  }
}

function displayNameFromPath(path) {
  const parts = (path || "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
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
    let offset = 0;
    for (let i = 0; i < headerLineIdx; i++) offset += newLines[i].length + 1;
    offset += Math.min(start - lineStart, newLines[headerLineIdx].length);
    els.editor.value = newValue;
    els.editor.selectionStart = offset;
    els.editor.selectionEnd = offset;
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
  const color = els.textColor.value;
  const bg = els.bgColor.value;
  const size = els.fontSize.value;
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
    const targetWorkspaceId = resolveScreenshotWorkspaceId();
    const uploaded = await api.post("/api/asset", {
      dataUrl,
      name: `screenshot-${Date.now()}.webp`,
      workspaceId: targetWorkspaceId || undefined,
    });
    insertAtCursor(`\n${uploaded.markdown}\n`);
    if (!state.previewVisible) setPreviewVisible(true, { automatic: true });
    schedulePreviewUpdate({ immediate: true });
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
  if (mode === "default") {
    return state.defaultWorkspaceId && state.defaultWorkspaceId !== "default"
      ? state.defaultWorkspaceId
      : "";
  }
  const fromPath = state.currentPath ? splitWorkspaceRef(state.currentPath).id : "";
  if (fromPath && /^ws_[a-f0-9]{10}$/i.test(fromPath)) return fromPath;
  if (state.activeWorkspaceId && /^ws_[a-f0-9]{10}$/i.test(state.activeWorkspaceId)) return state.activeWorkspaceId;
  if (state.defaultWorkspaceId && /^ws_[a-f0-9]{10}$/i.test(state.defaultWorkspaceId)) return state.defaultWorkspaceId;
  return "";
}

els.searchInput.addEventListener("input", debounce(runSearch, 160));
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
    return;
  }
  try {
    const { results } = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
    if (seq !== gsSeq) return;
    gsCurrentItems = results.slice(0, 50);
    gsSelectedIndex = gsCurrentItems.length ? 0 : -1;
    gsCount.textContent = `${results.length} 个结果`;
    if (!gsCurrentItems.length) {
      gsResults.innerHTML = `<div style="text-align:center;padding:32px 0;color:var(--muted,#999);font-size:13px;">未找到匹配内容</div>`;
      return;
    }
    // 按文件分组
    const groups = {};
    const order = [];
    for (const item of gsCurrentItems) {
      const file = state.flatFiles.find((f) => f.path === item.path) || item;
      const folder = (item.path || "").split("/").slice(0, -1).join("/") || "根目录";
      if (!groups[folder]) { groups[folder] = []; order.push(folder); }
      groups[folder].push({ item, file });
    }
    let html = "";
    let idx = 0;
    for (const folder of order) {
      html += `<div class="global-search-group">${escapeHtmlGs(folder)}</div>`;
      for (const { item, file } of groups[folder]) {
        const selectedCls = idx === gsSelectedIndex ? " selected" : "";
        html += `<button class="global-search-item${selectedCls}" data-idx="${idx}" data-path="${escapeHtmlGs(item.path)}" data-query="${escapeHtmlGs(query)}">
          <span class="global-search-item-title">${escapeHtmlGs(displayName(file))}</span>
          <span class="global-search-item-path">${escapeHtmlGs(item.path)}</span>
          <span class="global-search-item-snippet">${highlightSnippet(item.snippet || item.content || "", query)}</span>
        </button>`;
        idx++;
      }
    }
    gsResults.innerHTML = html;
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
    if (gsCurrentItems.length === 0) return;
    gsSelectedIndex = Math.min(gsSelectedIndex + 1, gsCurrentItems.length - 1);
    updateGsSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (gsCurrentItems.length === 0) return;
    gsSelectedIndex = Math.max(gsSelectedIndex - 1, 0);
    updateGsSelection();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (gsSelectedIndex >= 0 && gsSelectedIndex < gsCurrentItems.length) {
      openGsResult(gsCurrentItems[gsSelectedIndex], gsInput.value.trim());
    }
  }
});

function updateGsSelection() {
  gsResults.querySelectorAll(".global-search-item").forEach((el) => {
    el.classList.toggle("selected", Number(el.dataset.idx) === gsSelectedIndex);
  });
  const sel = gsResults.querySelector(".global-search-item.selected");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

gsResults?.addEventListener("click", (e) => {
  const btn = e.target.closest(".global-search-item");
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  if (idx >= 0 && idx < gsCurrentItems.length) {
    openGsResult(gsCurrentItems[idx], gsInput.value.trim());
  }
});

function openGsResult(item, query) {
  closeGlobalSearch();
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
    dropdown.style.left = Math.round(itemRect.left) + "px";
    dropdown.style.top = Math.round(itemRect.bottom + 4) + "px";
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

  const actions = {
    "new-doc": () => openCreateModal("doc"),
    "new-folder": () => openCreateModal("folder"),
    save: () => saveCurrentDoc(),
    workspace: () => openWorkspaceModal(),
    "export-pdf": () => exportCurrentDocToPdf(),
    "export-ppt": () => exportCurrentDocToPpt(),
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
    find: () => els.searchInput?.focus(),
    replace: () => els.searchInput?.focus(),
    "go-doc": () => els.searchInput?.focus(),
    "go-symbol": () => showToast("进入知识库标题导航模式"),
    "go-back": () => history.back(),
    "go-forward": () => history.forward(),
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
els.editor.addEventListener("scroll", () => { hideAiEditHintPopover(); syncPreviewToEditor(); }, { passive: true });
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
  const handled = (() => {
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
      const format = {
        b: "bold",
        i: "italic",
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

els.editor.addEventListener("scroll", updateMultiCursorDisplay);
window.addEventListener("resize", updateMultiCursorDisplay);
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
      els.licenseUnactivated.classList.add("hidden");
      els.licenseActivated.classList.remove("hidden");
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
      els.licenseUnactivated.classList.remove("hidden");
      els.licenseActivated.classList.add("hidden");
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
        setTimeout(() => checkLicenseStatus(), 800);
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
    try {
      // 通过删除 .license 文件解除授权（通过 API）
      await api.post("/api/license/activate", { licenseKey: "" });
    } catch (_) { /* ignore */ }
    checkLicenseStatus();
  });
}

[els.aiBaseUrl, els.aiEmbeddingModel, els.aiChatModel].filter(Boolean).forEach((input) => {
  input.addEventListener("input", () => {
    state.ai.configDirty = true;
  });
});

function aiCurrentProvider() {
  return state.ai.chatProvider === "deepseek" ? "deepseek" : "ollama";
}

function aiConfigPayload(embeddingModel) {
  return {
    baseUrl: els.aiBaseUrl.value.trim(),
    embeddingModel: embeddingModel ?? els.aiEmbeddingModel.value.trim(),
    chatModel: els.aiChatModel.value.trim(),
    chatProvider: aiCurrentProvider(),
    deepseekApiKey: els.aiDeepseekApiKey?.value.trim() || "",
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
    if (result.releaseNotes) {
      els.aboutReleaseNotes.textContent = result.releaseNotes;
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

els.closeSettingsBtn.addEventListener("click", () => els.settingsModal.classList.add("hidden"));
els.settingsModal.addEventListener("click", (event) => {
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

// 关于内容已内联到设置「关于」面板，切换至该 Tab 时由 settings-nav-item 处理器自动加载。
els.checkUpdateBtn?.addEventListener("click", async () => {
  showToast("正在检查更新...");
  try {
    await api.get("/api/version?refresh=1");
    await loadAboutInfo();
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
  window.addEventListener("resize", () => requestAnimationFrame(applyLayout));

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
    const bitmap = await createImageBitmap(file);
    const maxSide = 1920;
    const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const ctx = canvas.getContext("2d", { alpha: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
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
els.editorToolbar.addEventListener("mousedown", (event) => {
  if (event.target.closest("[data-format]")) event.preventDefault();
});
els.editorToolbar.addEventListener("wheel", (event) => {
  const toolbar = els.editorToolbar;
  if (toolbar.scrollWidth <= toolbar.clientWidth) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  toolbar.scrollLeft += delta;
  event.preventDefault();
}, { passive: false });
els.editorToolbar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-format]");
  if (button) applyFormat(button.dataset.format);
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
  if (Number.isFinite(lineAttr) && lineAttr >= 0) {
    els.editor.scrollToLine?.(lineAttr + 1);
    return;
  }
  scrollEditorToHeading(button.dataset.headingText);
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
}, 200));

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
    renderWorkspaceSummary();
    renderTree(state.tree);
    // 恢复上次打开的文档，保留用户工作上下文。
    if (!refresh) {
      try {
        const lastDoc = localStorage.getItem("lastOpenedDoc");
        if (lastDoc && state.flatFiles.some((file) => file.path === lastDoc)) {
          openDoc(lastDoc).catch((e) => console.warn("restore last doc failed:", e));
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error("Bootstrap failed:", err);
    els.docCount.textContent = "加载失败";
  }
}

// 启动初始化——显示开机图片 logo.png，在图片展示期间并行加载服务，加载完成后直接进入应用
let startupLicensePending = false;
const appSplash = document.querySelector("#appSplash");
const splashProgressFill = document.querySelector("#splashProgressFill");
const splashProgressPct = document.querySelector("#splashProgressPct");
const splashProgressText = document.querySelector("#splashProgressText");

let _splashProgress = 0;
function setSplashProgress(pct, text) {
  _splashProgress = pct;
  if (splashProgressFill) splashProgressFill.style.width = pct + "%";
  if (splashProgressPct) splashProgressPct.textContent = pct + "%";
  if (text && splashProgressText) splashProgressText.textContent = text;
}

try { applySettings(); } catch (e) { console.error("applySettings failed:", e); }
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
    setTimeout(() => {
      appSplash.classList.add("hidden");
      setTimeout(() => appSplash.remove(), 400);
      showWelcomeIfNeeded();
    }, 300);
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
  const bootstrapPromise = bootstrap();

  const result = await licensePromise;
  setSplashProgress(55, result.activated ? "正在加载文档库…" : "等待授权…");

  if (result.activated) {
    await bootstrapPromise;
    setSplashProgress(85, "正在完成初始化…");
    await Promise.resolve();
    setSplashProgress(100, "加载完成");
    // 加载完成后直接隐藏开机图片，进入应用。
    hideSplash();
  } else {
    await bootstrapPromise;
    state.tree = [];
    state.flatFiles = [];
    renderTree([]);
    startupLicensePending = true;
    els.licenseModal.classList.remove("hidden");
    els.licenseModal.classList.add("startup-block");
    hideSplash();
    await new Promise((resolve) => {
      const check = setInterval(async () => {
        const r = await checkLicenseStatus();
        if (r.activated) {
          clearInterval(check);
          startupLicensePending = false;
          els.licenseModal.classList.remove("startup-block");
          els.licenseModal.classList.add("hidden");
          resolve();
        }
      }, 1500);
    });
    await bootstrap();
  }
}

// 启动入口：开机图片已在 HTML 中直接渲染显示，立即并行加载后台服务。
beginLoading();
