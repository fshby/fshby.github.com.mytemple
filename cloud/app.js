/* ============================================================================
 * 知识库云端 · 工作台
 *
 * 目标：让用户在手机上快速、美观地查看与检索自己同步到云端的知识库。
 * 数据隔离完全由数据库 RLS 强制（owner_id = auth.uid()），前端**从不**传 owner_id，
 * 也不做「这行是不是我的」这类安全判断 —— 那只是显示逻辑，不是边界。
 *
 * 上传由用户显式发起：选文件夹 / 选文件 / 拖拽 / 拖入 zip 包。
 * 云端按「分区 + 相对路径」为键、以内容 SHA-256 做增量比对，内容未变的不重传。
 * ==========================================================================*/

const CFG = window.__MT_CLOUD__ || {};
const SDK = window.WorkBuddyCloud;
/* 文档类白名单（**两端逐字同源**：public/modules/cloud-client.js 顶部有一份完全相同的
 * 拷贝，tests/three-way-sync.test.js 逐字比对，防两端算出不同的可同步集合）。
 *
 * 独立 HTML 文档（.html/.htm/.xhtml）在云端**不走 markdown 渲染**，而是包进沙箱 iframe
 * 按网页原样加载（见 renderHtmlDocRow）；桌面端本就把它们当一等公民（沙箱预览 + 去标签
 * 检索），放开同步是为了消除「本机能看、云端永远没有」的割裂感（2026-10-13 用户决策）。
 *
 * json / csv 仍**刻意排除**：工作区里的 .json 常是含 token / 密钥的配置文件，自动上云
 * 等于开一条泄漏通道；csv 也没有阅读端渲染分支。 */
const TEXT_EXT = /\.(md|markdown|mdown|mkd|txt|html?|xhtml)$/i;
/** 独立 HTML 文档：渲染方式与 Markdown 不同（沙箱 iframe）。 */
const HTML_DOC_EXT = /\.(html?|xhtml)$/i;
/** 沙箱令牌与桌面端 app.js 的 HTML_DOC_SANDBOX 逐字一致：只保留脚本执行、表单与
 *  模态框。**绝不含 allow-same-origin** —— 与 allow-scripts 同给等于没沙箱
 *  （帧内可读 parent / localStorage / 应用桥）。 */
const HTML_DOC_SANDBOX = "allow-scripts allow-forms allow-modals";
/** 注入到 srcdoc 最前面的高度上报脚本（与桌面端 app.js 逐字同源）：沙箱帧是 opaque
 *  origin，父页量不到内容高度，只能由帧内自己把 scrollHeight postMessage 出来。 */
const HTML_FRAME_RESIZE_SCRIPT = '<script>(function(){function p(){var d=document.documentElement,b=document.body;var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);try{parent.postMessage({type:"mt-html-frame-height",h:Math.ceil(h)},"*")}catch(_){}}function s(){p();if(window.ResizeObserver){try{new ResizeObserver(p).observe(document.documentElement)}catch(_){}}else{setInterval(p,500)}}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",s)}else{s()}})();</script>';
/** 帧高上限：原先写死 20000px，长网页会被**截断**（2026-10-13 实测：一篇 542KB 的
 *  文档内容高 443608px → iframe 只给到 20000px，剩 4.5%，用户还得在帧内再滚一次，
 *  「外层滚 + 帧内滚」两层滚动正是「大 HTML 不流畅」的来源之一）。
 *  放宽到 200000px：常见长文一屏到底、与外层滚动条合成一条；真正超限的极端文档
 *  由每块右上角的「放大」全屏视图兜底（见 decorateHtmlBlocks）。
 *  注意这同时是**安全阀**：帧内可上报任意 h，不 clamp 会被构造出天文数字高度。 */
const HTML_FRAME_MAX_HEIGHT = 200000;
const ASSET_EXT = /\.(png|jpe?g|jfif|gif|webp|avif|bmp|ico|svg|mp4|m4v|webm|mov|ogv)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;
const SKIP_DIR = /(^|\/)(__MACOSX|\.git|node_modules|\.obsidian|\.trash)(\/|$)/i;
/** 单个资源上限：超过就跳过并计数，避免把手机流量和存储配额一次打满。 */
const ASSET_MAX_BYTES = 12 * 1024 * 1024;
/** 存储布局：users/<uid>/assets/<分区>/<工作区相对路径>，与文档的 rel_path 同构，
 *  这样文档里写 `source/x.webp` 就能直接对上，不需要额外的映射表。 */
const ASSET_ROOT = "assets";
/** 签名 URL 默认 600s；这里取 SDK 上限 1h，够看完一篇长文，且不把 URL 长期留在内存。 */
const SIGN_TTL = 3600;
/** 批量签名失败后逐个兜底签的数量上限（多见于文档引用了没上传的图）。 */
const SIGN_FALLBACK_MAX = 30;
/** 资源上传的并发数与单批字节上限。 */
const ASSET_CONCURRENCY = 4;
const ASSET_BATCH_BYTES = 16 * 1024 * 1024;
/** 资源清单（本地记住已上传过的「路径:体积」）存这里，用来做增量。 */
const ASSET_MANIFEST_KEY = "mtCloudAssets.v1";
const UPSERT_BATCH_MAX_DOCS = 20;
const UPSERT_BATCH_MAX_BYTES = 1_200_000;

/* 静态资源版本戳：改动 cloud/ 下被页面引用的任何文件时，与 index.html 的三件套一起递增。 */
const ASSET_V = "cloud-18";

/* 第三方库一律同源自托管，见 scripts/vendor-cloud.mjs。
 * 绝不改回第三方 CDN —— 见该脚本头部注释：cdn.jsdelivr.net 在部分网络下 TLS 会被重置，
 * 登录 SDK 曾因此加载失败，导致所有登录方式同时不可用。 */
const VENDOR = "/vendor";
const MERMAID_SRC = `${VENDOR}/mermaid/mermaid.min.js?v=${ASSET_V}`;
const KATEX_CSS = `${VENDOR}/katex/katex.min.css?v=${ASSET_V}`;
const KATEX_SRC = `${VENDOR}/katex/katex.min.js?v=${ASSET_V}`;

/* ── 客户端初始化（全局唯一实例）────────────────────────────── */
let cloud = null;
function initClient() {
  if (cloud) return cloud;
  if (!SDK || typeof SDK.createWorkBuddyCloud !== "function") {
    throw new Error("云服务 SDK 未加载，请检查网络后刷新");
  }
  if (!CFG.endpoint || !CFG.publishableKey) {
    throw new Error("云端配置缺失（cloud-config.js）");
  }
  cloud = SDK.createWorkBuddyCloud({
    endpoint: CFG.endpoint,
    oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
    publishableKey: CFG.publishableKey,
  });
  return cloud;
}

/* ── DOM ───────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const el = {
  views: { boot: $("viewBoot"), login: $("viewLogin"), list: $("viewList"), doc: $("viewDoc") },
  backBtn: $("backBtn"), whoami: $("whoami"), logoutBtn: $("logoutBtn"),
  authLogin: $("authLogin"), authRegister: $("authRegister"),
  authTitle: $("authTitle"), authSub: $("authSub"),
  tabEmail: $("tabEmail"), tabPhone: $("tabPhone"),
  emailForm: $("emailForm"), email: $("email"), emailFieldError: $("emailFieldError"),
  emailWaySeg: $("emailWaySeg"), wayOtp: $("wayOtp"), wayPassword: $("wayPassword"),
  emailCodeField: $("emailCodeField"),
  emailCode: $("emailCode"), sendEmailCodeBtn: $("sendEmailCodeBtn"),
  emailPasswordField: $("emailPasswordField"), emailPasswordLabel: $("emailPasswordLabel"),
  emailPassword: $("emailPassword"), emailPasswordHint: $("emailPasswordHint"), emailSubmit: $("emailSubmit"),
  intentSwitch: $("intentSwitch"), intentSwitchPhone: $("intentSwitchPhone"),
  forgotBtn: $("forgotBtn"),
  resetHint: $("resetHint"), emailError: $("emailError"),
  phoneForm: $("phoneForm"), phone: $("phone"), phoneError: $("phoneError"),
  code: $("code"), sendCodeBtn: $("sendCodeBtn"), passwordField: $("passwordField"),
  signupPassword: $("signupPassword"), loginSubmit: $("loginSubmit"), loginError: $("loginError"),
  wechatBtn: $("wechatBtn"),
  q: $("q"), clearQ: $("clearQ"), uploadBtn: $("uploadBtn"), refreshBtn: $("refreshBtn"),
  manageBtn: $("manageBtn"), stats: $("stats"), tree: $("tree"), searchResults: $("searchResults"),
  cards: $("cards"), viewSwitch: $("viewSwitch"), wsChips: $("wsChips"),
  emptyState: $("emptyState"),
  docTitle: $("docTitle"), docPath: $("docPath"), docBody: $("docBody"), docDeleteBtn: $("docDeleteBtn"),
  uploadSheet: $("uploadSheet"), dropZone: $("dropZone"), pickFolderBtn: $("pickFolderBtn"),
  pickFilesBtn: $("pickFilesBtn"), folderInput: $("folderInput"), filesInput: $("filesInput"),
  localImport: $("localImport"), localImportBtn: $("localImportBtn"),
  localImportNote: $("localImportNote"), localWsName: $("localWsName"),
  wsName: $("wsName"), uploadProgress: $("uploadProgress"), progressFill: $("progressFill"),
  progressLabel: $("progressLabel"), cancelUploadBtn: $("cancelUploadBtn"), uploadResult: $("uploadResult"),
  manageSheet: $("manageSheet"), wsList: $("wsList"), clearAllBtn: $("clearAllBtn"),
  confirmSheet: $("confirmSheet"), confirmText: $("confirmText"), confirmCancel: $("confirmCancel"),
  confirmOk: $("confirmOk"),
  toast: $("toast"),
  nativeActions: $("nativeActions"), offlineBar: $("offlineBar"),
  shareSheet: $("shareSheet"), shareList: $("shareList"),
};

const state = {
  session: null,
  docs: [],           // 元数据：id / workspace / rel_path / title / bytes / updated_at / content_sha
  loaded: false,
  currentId: null,
  worker: null,
  pendingOtp: null,      // 手机验证码挑战
  pendingEmailOtp: null, // 邮箱验证码挑战
  resetStarted: null,    // 忘记密码：resetPasswordForEmail 的返回值（携带 updateUser）
  emailFlow: "login",    // "login" | "reset"（找回密码流程，优先级高于 emailMode）
  emailMode: "otp",      // "otp"（验证码，主路径）| "password"（密码登录）
  authIntent: "login",   // "login" | "register"（主意图，邮箱/手机共用）
  loginTab: "email",
  upload: null,       // { cancelled, done, total }
  searchToken: 0,
  docSource: "",      // 当前打开的文档原文（原生端分享/导出要用）
  docCache: new Map(),// id -> 正文（打开过或搜过的文档，用于秒开与出命中片段）
  /* id -> { digest, srcdoc, exp }：独立 HTML 文档「改写 + 签名」后的成品 srcdoc。
   * srcdoc 没有 URL，浏览器 HTTP 缓存完全用不上；而准备阶段对几百 KB 的文档同样是
   * 可观开销（正则扫全篇找引用 → 批量签名往返 → 字符串级改写）。重开同一篇直接复用
   * 成品，只做一次 iframe 装载。签名 URL 有 SIGN_TTL 有效期，所以缓存跟着过期。 */
  htmlFrameCache: new Map(),
  view: "tree",       // 列表视图："tree"（目录）| "recent"（最近）| "all"（全部）
  wsFilter: null,     // 分区筛选，null = 不筛
  signedAssets: new Map(), // 存储对象路径 -> { url, exp } 已签名的图片地址（随会话失效）
  assetManifest: new Map(),// "分区/相对路径" -> 字节数，本地记住已上传过的资源，用于增量跳过
};

/* ── 小工具 ────────────────────────────────────────────────── */
function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function maskIdentity(user) {
  if (!user) return "已登录";
  const phone = user.phone || user.phone_number;
  if (phone) {
    const d = String(phone).replace(/\D/g, "");
    if (d.length >= 7) return d.slice(0, 3) + "****" + d.slice(-4);
    return "已登录";
  }
  return "已登录";
}
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  return (v / 1048576).toFixed(2) + " MB";
}
function fmtTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
let toastTimer = null;
function toast(msg, kind) {
  el.toast.textContent = msg;
  el.toast.className = "toast" + (kind ? " toast-" + kind : "");
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}
function show(id) {
  for (const [k, node] of Object.entries(el.views)) node.hidden = k !== id;
  el.backBtn.hidden = id !== "doc";
  const signedIn = id === "list" || id === "doc";
  el.logoutBtn.hidden = !signedIn;
  el.whoami.hidden = !signedIn;
  document.body.dataset.view = id;
  // 原生端：首个视图真正渲染出来后才收起系统启动屏（见 NATIVE 段的说明）
  if (window.__mtRevealSplash) window.__mtRevealSplash();
}
function askConfirm(text) {
  return new Promise((resolve) => {
    el.confirmText.textContent = text;
    el.confirmSheet.hidden = false;
    const done = (val) => {
      el.confirmSheet.hidden = true;
      el.confirmOk.removeEventListener("click", onOk);
      el.confirmCancel.removeEventListener("click", onNo);
      resolve(val);
    };
    const onOk = () => done(true);
    const onNo = () => done(false);
    el.confirmOk.addEventListener("click", onOk);
    el.confirmCancel.addEventListener("click", onNo);
  });
}
function openSheet(node) { node.hidden = false; }
function closeSheet(node) { node.hidden = true; }
for (const sheet of [el.uploadSheet, el.manageSheet, el.confirmSheet]) {
  sheet.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-sheet]")) closeSheet(sheet);
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSheet(el.uploadSheet); closeSheet(el.manageSheet); closeSheet(el.confirmSheet);
    // 列表页里 Esc 退出搜索态（回到当前视图），并交出焦点
    if (el.q.value || document.activeElement === el.q) { el.q.blur(); applyView(); }
  }
});

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  if (window.crypto && crypto.subtle) {
    const d = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // 极老的 WebView 兜底：FNV-1a 变体，仅用于增量比对，不用于安全
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i += 1) { h ^= buf[i]; h = (h * 0x01000193) >>> 0; }
  return "fnv" + h.toString(16);
}
function titleFrom(text, relPath) {
  const m = /^\s*#{1,6}\s+(.+?)\s*$/m.exec(text || "");
  if (m) return m[1].replace(/[*_`~[\]]/g, "").slice(0, 120);
  const base = String(relPath).split("/").pop() || relPath;
  return base.replace(/\.[^.]+$/, "");
}
function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/* ══ 图片 / 视频资源（文档里的 source/… 引用）══════════════════════
 *
 * 背景：文档正文里的截图写成 `![](source/x.webp)`（工作区根相对），桌面端由
 * Rust 的 /source/* 路由直接读磁盘，所以本机一直正常；云端没有这个路由，
 * 相对路径按云域解析必然 404 —— 这就是「手机端截图不显示」的根因。
 *
 * 做法：图片**不进 documents.content**（否则一篇 20 图的笔记会把正文撑到几十兆，
 * 列表和检索都会被拖死），而是按「分区 + 工作区相对路径」原样存进云存储：
 *     users/<uid>/assets/<分区>/source/x.webp
 * 键与文档的 rel_path 同构，所以文档里写什么路径就能直接对上，不需要映射表。
 * 读取时按需签发短期 URL（存储桶不暴露公开地址），签不出来的就是「云端没有这张图」。
 * ----------------------------------------------------------------- */

/** 分区名要进对象路径，得先过 SDK 的路径校验：去掉分隔符、空段与首尾空白。 */
function assetWsSegment(ws) {
  return String(ws || "默认工作区").replace(/[\\/]+/g, "_").replace(/^\.+$/, "_").trim() || "默认工作区";
}
function assetPrefix(uid, ws) {
  return `users/${uid}/${ASSET_ROOT}/${assetWsSegment(ws)}`;
}
/** 拼完整对象路径；路径非法（含 .. 等）时 SDK 会抛错，这里直接返回空串让调用方跳过。 */
function assetObjectPath(uid, ws, rel) {
  try { return cloud.storage.userPath(uid, `${ASSET_ROOT}/${assetWsSegment(ws)}/${rel}`); }
  catch (_) { return ""; }
}
function assetManifestKey(ws, rel) { return assetWsSegment(ws) + "/" + rel; }

/** 清单只在本地做「同一路径、体积没变就跳过上传」的增量判断，读不到就当空。 */
function loadAssetManifest() {
  try {
    const raw = window.localStorage.getItem(ASSET_MANIFEST_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    state.assetManifest = new Map(obj && typeof obj === "object" ? Object.entries(obj) : []);
  } catch (_) { state.assetManifest = new Map(); }
}
function saveAssetManifest() {
  try {
    window.localStorage.setItem(ASSET_MANIFEST_KEY, JSON.stringify(Object.fromEntries(state.assetManifest)));
  } catch (_) { /* 隐私模式下写不进去：只影响下次增量，不影响功能 */ }
}
/** 作废某个分区的上传清单（删除分区 / 清空之后调用）。 */
function forgetAssetManifest(ws) {
  const prefix = assetWsSegment(ws) + "/";
  for (const k of [...state.assetManifest.keys()]) {
    if (k.startsWith(prefix)) state.assetManifest.delete(k);
  }
  saveAssetManifest();
}

function mimeOf(rel) {
  const e = String(rel).toLowerCase().split(".").pop();
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg",
    gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
    ico: "image/x-icon", svg: "image/svg+xml",
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
  })[e] || "application/octet-stream";
}

/**
 * 把文档里的一条引用解析成**候选的存储相对路径**（按优先级排列）。
 * 依次尝试：① 工作区根相对（桌面端语义）② 文档同目录相对。
 * 外部链接（http/data/blob）不是本地资源，返回空数组。
 */
function assetRelCandidates(ref, docRel) {
  const raw = String(ref || "").trim();
  if (!raw || /^(https?:|data:|blob:|mailto:|javascript:)/i.test(raw)) return [];
  let p = raw.split("#")[0].split("?")[0];
  try { p = decodeURIComponent(p); } catch (_) { /* 保留原样 */ }
  p = normPath(p);
  if (!p) return [];

  const out = [];
  // 新版写法 `ws-asset/<ws_id>/source/x.png` 指向工作区 source/ 下的文件
  const wsAsset = p.match(/^ws-asset\/[^/]+\/(.+)$/);
  if (wsAsset) out.push(normPath(`source/${wsAsset[1]}`));
  out.push(p);

  const dir = normPath(docRel || "").split("/").slice(0, -1).join("/");
  if (dir) out.push(normPath(`${dir}/${p}`));

  return [...new Set(out.filter((x) => x && !x.split("/").some((s) => s === ".." || s === ".")))];
}

/**
 * 从 Markdown 原文里取出所有「本机资源引用」（图片 / 视频）。
 * 覆盖 `![alt](url)`、`<img src>`、`<video src>`、`<source src>` 四种写法；
 * 外链在下一步会被一起过滤掉（assetRelCandidates 对外链返回空）。
 */
function extractAssetRefs(md) {
  const src = String(md || "");
  const out = [];
  const re = /!\[[^\]]*\]\(\s*<?([^)>\s]+)[^)]*\)|<(?:img|video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const u = m[1] || m[2];
    if (u) out.push(u);
  }
  return out;
}

/** 本机资源 URL：与桌面端同语义 —— 笔记里写 `source/x.webp`，本机就是 `/<root>/source/x.webp`。 */
function localAssetUrl(rel) {
  return LOCAL_ORIGIN + "/" + String(rel).split("/").map(encodeURIComponent).join("/");
}

/** HTML 文档里的资源属性（与 extractAssetRefs 的标签集合必须一致：**上传什么就改写什么**，
 *  否则会出现「图传到云了，页面里还是相对路径」或反过来）。 */
const HTML_ASSET_SRC_RE = /(<\s*(?:img|video|source)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;

/**
 * 把 HTML 文档正文里的相对资源引用换成可直接加载的绝对地址。
 *
 * 为什么必须**字符串级**改写、不能像 markdown 那样渲染后再改 DOM：
 * 独立 HTML 文档渲染在沙箱 iframe（opaque origin）里，父页 `querySelector` 摸不到
 * 帧内节点（这正是沙箱的意义），所以只能在塞进 srcdoc 之前先改。
 * 没有命中的引用原样保留 —— 相对路径在云端必然 404，但至少不掩盖原始内容。
 *
 * @param {string} html 原始 HTML 源码
 * @param {(ref:string)=>string} lookup 引用 → 绝对地址；返回空串表示放弃改写
 */
function rewriteHtmlAssetSrc(html, lookup) {
  return String(html || "").replace(HTML_ASSET_SRC_RE, (all, pre, q, val) => {
    let url = "";
    try { url = lookup(val) || ""; } catch (_) { url = ""; }
    return url ? pre + q + url + q : all;
  });
}

/**
 * 从本机读取笔记引用的图片 / 视频，供「一键推送」一并上云。
 *
 * 为什么必须**逐篇**扫引用：文档内容没变 ≠ 它引用的截图已经在云端。
 * 「图片同步」上线之前推送过的笔记全都正文一致、图片全缺，只按内容指纹判断
 * 就永远修不回来。所以这里读遍所有本机文档的正文（本机读取，代价可忽略）。
 *
 * 取字节：先发 HEAD 拿体积，体积与上传清单一致就不下载（省掉整张图的传输）；
 * 体积变了或清单里没有才真正 GET。返回的条目直接喂给 uploadAssets。
 */
async function collectLocalAssets(docs, ws, setNote) {
  const refs = [];
  for (const d of docs) {
    for (const ref of extractAssetRefs(d.text)) {
      const cands = assetRelCandidates(ref, d.rel).filter((p) => ASSET_EXT.test(p));
      if (cands.length) refs.push(cands);
    }
  }
  if (!refs.length) return [];

  const assets = [];
  const seen = new Set();
  for (let i = 0; i < refs.length; i += 1) {
    if (i % 5 === 0 || i === refs.length - 1) setNote(`核对引用的图片…（${i + 1}/${refs.length}）`);
    // 候选按优先级排列：第一个能读到的就是它（与桌面端渲染时同一套解析顺序）
    for (const rel of refs[i]) {
      if (seen.has(rel)) break;
      seen.add(rel);
      let head;
      try { head = await fetch(localAssetUrl(rel), { method: "HEAD", cache: "no-store" }); }
      catch (_) { break; }
      if (!head || !head.ok) continue;
      const size = Number(head.headers.get("content-length") || 0);
      if (size > ASSET_MAX_BYTES) break;
      if (size > 0 && state.assetManifest.get(assetManifestKey(ws, rel)) === size) {
        assets.push({ relPath: rel, size, skipFetch: true });
        break;
      }
      try {
        const got = await fetch(localAssetUrl(rel), { cache: "no-store" });
        if (!got || !got.ok) break;
        const bytes = new Uint8Array(await got.arrayBuffer());
        assets.push({ relPath: rel, bytes, size: bytes.byteLength });
      } catch (_) { /* 单张读不到就跳过，不影响其它图片与文档 */ }
      break;
    }
  }
  return assets;
}

/* ══ 认证 ═══════════════════════════════════════════════════ */
function loginError(msg) {
  el.loginError.textContent = msg || "";
  el.loginError.hidden = !msg;
}
function emailError(msg) {
  el.emailError.textContent = msg || "";
  el.emailError.hidden = !msg;
}
function setPhoneError(msg) {
  el.phoneError.textContent = msg || "";
  el.phoneError.hidden = !msg;
}
function setEmailFieldError(msg) {
  el.emailFieldError.textContent = msg || "";
  el.emailFieldError.hidden = !msg;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 发送倒计时：两个发码按钮各用各的计时器，互不干扰。 */
const countdownTimers = new WeakMap();
function startCountdown(btn, seconds = 60) {
  let left = seconds;
  clearInterval(countdownTimers.get(btn));
  btn.disabled = true;
  btn.textContent = `${left}s`;
  countdownTimers.set(btn, setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(countdownTimers.get(btn));
      btn.disabled = false;
      btn.textContent = "获取验证码";
      return;
    }
    btn.textContent = `${left}s`;
  }, 1000));
}

function setLoginTab(tab) {
  state.loginTab = tab;
  const isEmail = tab === "email";
  el.tabEmail.classList.toggle("is-active", isEmail);
  el.tabPhone.classList.toggle("is-active", !isEmail);
  el.tabEmail.setAttribute("aria-selected", String(isEmail));
  el.tabPhone.setAttribute("aria-selected", String(!isEmail));
  el.emailForm.hidden = !isEmail;
  el.phoneForm.hidden = isEmail;
  loginError("");
  emailError("");
  setPhoneError("");
  setEmailFieldError("");
  // 切回邮箱页时按当前形态重排（发过验证码的新邮箱仍要露出「设置密码」）
  if (isEmail) applyEmailMode();
  applyPhoneMode();
}
el.tabEmail.addEventListener("click", () => setLoginTab("email"));
el.tabPhone.addEventListener("click", () => setLoginTab("phone"));
el.authLogin.addEventListener("click", () => setAuthIntent("login"));
el.authRegister.addEventListener("click", () => setAuthIntent("register"));
setLoginTab(state.loginTab);
setAuthIntent(state.authIntent);

/* ── 主意图（登录 / 注册）────────────────────────────────────
 * 「登录」和「注册」是两件事，必须让用户先选；注册不再是隐式行为
 * （旧版只有填了新邮箱发码后密码框才冒出来，新用户找不到注册入口）。 */
function setAuthIntent(intent) {
  state.authIntent = intent;
  const reg = intent === "register";
  el.authLogin.classList.toggle("is-active", !reg);
  el.authRegister.classList.toggle("is-active", reg);
  el.authLogin.setAttribute("aria-selected", String(!reg));
  el.authRegister.setAttribute("aria-selected", String(reg));
  el.authTitle.textContent = reg ? "创建账号" : "登录";
  el.authSub.textContent = reg
    ? "注册后，这个邮箱或手机号就是你的私人知识库账号。"
    : "登录后，只有你自己能看到上传到云端的内容。";
  emailError("");
  loginError("");
  setEmailFieldError("");
  setPhoneError("");
  applyEmailMode();
  applyPhoneMode();
}

/* ── 邮箱：登录（验证码主路径 / 密码）/ 注册 / 找回密码 ───────── */

function emailLoginContext() {
  return {
    email: el.email.value.trim(),
    code: el.emailCode.value.trim(),
    password: el.emailPassword.value,
  };
}

/**
 * 邮箱表单按「主意图 × 登录方式 × 找回流程」三维互斥排布：
 *   登录 + 验证码 —— 主路径：只露「邮箱 + 验证码」，提交按钮「登录」。
 *                     发码后确认是新邮箱 → 密码框补出来兜底（SDK 契约：
 *                     新用户注册必须设密码），同时主分段已自动切到注册。
 *   登录 + 密码   —— 验证码整行隐藏，「忘记密码？」只在这时出现
 *                     （验证码登录没有密码可忘）。
 *   注册          —— 验证码 + 设置密码都直接摊开，提交按钮「注册」。
 *   找回密码      —— 验证码 + 新密码，提交按钮「确认重置密码」，
 *                     方式分段与次级链接都收起，防误入其它流程。
 */
function applyEmailMode() {
  const reset = state.emailFlow === "reset";
  const reg = !reset && state.authIntent === "register";
  const mode = state.emailMode;
  el.emailWaySeg.hidden = reset || reg;
  el.wayOtp.classList.toggle("is-active", mode === "otp");
  el.wayOtp.setAttribute("aria-selected", String(mode === "otp"));
  el.wayPassword.classList.toggle("is-active", mode === "password");
  el.wayPassword.setAttribute("aria-selected", String(mode === "password"));

  // 注册只走验证码（方式分段此时已隐藏），emailMode 的残留只在登录态生效
  el.emailCodeField.hidden = !reset && !reg && mode === "password";
  const newUserPending = !!(state.pendingEmailOtp && !state.pendingEmailOtp.isExistingUser);
  const pwdVisible = reg || reset || mode === "password" || newUserPending;
  el.emailPasswordField.hidden = !pwdVisible;
  el.emailPasswordLabel.textContent = reset ? "新密码" : (reg ? "设置密码" : "密码");
  el.emailPasswordHint.hidden = !(reg || newUserPending);
  if (!el.emailPasswordHint.hidden) {
    el.emailPasswordHint.textContent = reg
      ? "密码至少 8 位。设置后，以后可在新设备上用密码登录。"
      : "首次注册，设置密码（至少 8 位）后，以后可在新设备上用密码登录。";
  }
  el.emailPassword.autocomplete = !reg && mode === "password" ? "current-password" : "new-password";
  el.emailSubmit.textContent = reset ? "确认重置密码" : (reg ? "注册" : "登录");
  el.intentSwitch.textContent = reg ? "已有账号？去登录" : "没有账号？去注册";
  el.forgotBtn.hidden = reset || reg || mode !== "password";
  el.resetHint.hidden = !reset;
}

/** 手机表单按主意图排布（手机没有密码登录态：验证码是唯一方式）。 */
function applyPhoneMode() {
  const reg = state.authIntent === "register";
  const newUserPending = !!(state.pendingOtp && !state.pendingOtp.isExistingUser);
  el.passwordField.hidden = !(reg || newUserPending);
  el.loginSubmit.textContent = reg ? "注册" : "登录";
  el.intentSwitchPhone.textContent = reg ? "已有账号？去登录" : "没有账号？去注册";
}

/** 发码回调共用：按「SDK 说的注册状态」校正主分段，别让用户输完码才发现走错门。 */
function reconcileIntent(sentIsExisting, pendingField) {
  if (state.authIntent === "login" && !sentIsExisting) {
    setAuthIntent("register");
    toast("这个账号还没注册，已切换到注册：设置密码后即完成注册");
  } else if (state.authIntent === "register" && sentIsExisting) {
    setAuthIntent("login");
    (pendingField === "phone" ? loginError : emailError)("该账号已注册，验证码可直接登录");
  }
}

el.email.addEventListener("input", () => { setEmailFieldError(""); resetEmailFlow(); });

el.sendEmailCodeBtn.addEventListener("click", async () => {
  const { email } = emailLoginContext();
  if (!EMAIL_RE.test(email)) {
    setEmailFieldError("请输入正确的邮箱地址");
    return;
  }
  setEmailFieldError("");
  emailError("");
  resetEmailFlow();
  el.sendEmailCodeBtn.disabled = true;
  try {
    const sent = await cloud.auth.sendOtp({ email });
    if (sent.error) {
      emailError(sent.error.message || "验证码发送失败");
      el.sendEmailCodeBtn.disabled = false;
      return;
    }
    state.pendingEmailOtp = {
      email,
      verificationId: sent.data.verificationId,
      isExistingUser: sent.data.isExistingUser,
    };
    startCountdown(el.sendEmailCodeBtn);
    // 主意图与 SDK 说的注册状态不一致时自动校正（内含说明与提示），一致时只报发码成功
    const consistent = (state.authIntent === "login") === sent.data.isExistingUser;
    if (consistent) toast("验证码已发送到邮箱");
    reconcileIntent(sent.data.isExistingUser, "email");
    applyEmailMode();
  } catch (err) {
    emailError(String(err && err.message || err));
    el.sendEmailCodeBtn.disabled = false;
  }
});

/** 退出「忘记密码」流程，回到当前登录形态。 */
function resetEmailFlow() {
  if (state.emailFlow !== "reset") return;
  state.emailFlow = "login";
  state.resetStarted = null;
  el.resetHint.hidden = true;
  applyEmailMode();
}

el.forgotBtn.addEventListener("click", async () => {
  const { email } = emailLoginContext();
  emailError("");
  if (!EMAIL_RE.test(email)) {
    setEmailFieldError("先填写要找回的邮箱地址");
    return;
  }
  setEmailFieldError("");
  el.forgotBtn.disabled = true;
  try {
    const started = await cloud.auth.resetPasswordForEmail(email);
    if (started.error) { emailError(started.error.message || "重置邮件发送失败"); return; }
    state.emailFlow = "reset";
    state.resetStarted = started;
    el.resetHint.textContent = "重置邮件已发送。把邮件里的重置码填到上面的「验证码」，新密码填到「新密码」，然后点「确认重置密码」。";
    applyEmailMode();
  } catch (err) {
    emailError(String(err && err.message || err));
  } finally {
    el.forgotBtn.disabled = false;
  }
});

async function submitEmailReset() {
  const { code, password } = emailLoginContext();
  if (!code) { emailError("请填写邮件里的重置码"); return; }
  if (!password || password.length < 8) { emailError("新密码至少 8 位"); return; }
  const completed = await state.resetStarted.data.updateUser({ nonce: code, password });
  if (completed.error) { emailError(completed.error.message || "重置失败"); return; }
  resetEmailFlow();
  toast("密码已重置，正在进入");
  await enterApp();
}

async function submitEmailOtp() {
  const { email, code, password } = emailLoginContext();
  const pending = state.pendingEmailOtp;
  if (!pending || pending.email !== email) { emailError("请先为当前邮箱获取验证码"); return; }
  if (!code) { emailError("请输入验证码"); return; }
  if (!pending.isExistingUser && (!password || password.length < 8)) {
    emailError(state.authIntent === "register" ? "请设置密码（至少 8 位）" : "首次注册需要设置密码（至少 8 位）");
    return;
  }
  const res = await cloud.auth.verifyOtp({
    email: pending.email,
    verificationId: pending.verificationId,
    isExistingUser: pending.isExistingUser,
    token: code,
    // 已有用户传 undefined（SDK 契约：密码只在注册时必需）
    password: pending.isExistingUser ? undefined : password,
  });
  if (res.error) { emailError(res.error.message || "登录失败"); return; }
  state.pendingEmailOtp = null;
  el.emailCode.value = "";
  await enterApp();
}

/** 密码登录（次路径）。失败提示不暴露账号是否存在。 */
async function submitEmailPassword() {
  const { email, password } = emailLoginContext();
  if (!EMAIL_RE.test(email)) { setEmailFieldError("请输入正确的邮箱地址"); return; }
  if (!password) { emailError("请输入密码"); return; }
  setEmailFieldError("");
  const res = await cloud.auth.signInWithPassword({ email, password });
  if (res.error) {
    // 不暴露账号是否存在，统一提示
    emailError("邮箱或密码不正确");
    return;
  }
  await enterApp();
}

/* 登录方式分段（验证码 ↔ 密码）与主意图互换按钮，只负责重排；真正的提交统一走表单按钮 */
el.wayOtp.addEventListener("click", () => {
  if (state.emailMode === "otp") return;
  state.emailMode = "otp";
  emailError("");
  setEmailFieldError("");
  applyEmailMode();
});
el.wayPassword.addEventListener("click", () => {
  if (state.emailMode === "password") return;
  state.emailMode = "password";
  emailError("");
  setEmailFieldError("");
  applyEmailMode();
});
el.intentSwitch.addEventListener("click", () => {
  resetEmailFlow();
  setAuthIntent(state.authIntent === "register" ? "login" : "register");
});
el.intentSwitchPhone.addEventListener("click", () => {
  setAuthIntent(state.authIntent === "register" ? "login" : "register");
});

el.emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  emailError("");
  el.emailSubmit.disabled = true;
  try {
    if (state.emailFlow === "reset") await submitEmailReset();
    else if (state.authIntent === "register") await submitEmailOtp();
    else if (state.emailMode === "password") await submitEmailPassword();
    else await submitEmailOtp();
  } catch (err) {
    emailError(String(err && err.message || err));
  } finally {
    el.emailSubmit.disabled = false;
  }
});

el.phone.addEventListener("input", () => setPhoneError(""));

el.sendCodeBtn.addEventListener("click", async () => {
  const phone = el.phone.value.trim();
  if (!/^1\d{10}$/.test(phone)) {
    setPhoneError("请输入正确的 11 位手机号");
    return;
  }
  setPhoneError("");
  loginError("");
  el.sendCodeBtn.disabled = true;
  try {
    const sent = await cloud.auth.sendOtp({ phone });
    if (sent.error) {
      loginError(sent.error.message || "验证码发送失败");
      el.sendCodeBtn.disabled = false;
      return;
    }
    state.pendingOtp = {
      phone,
      verificationId: sent.data.verificationId,
      isExistingUser: sent.data.isExistingUser,
    };
    startCountdown(el.sendCodeBtn);
    // 主意图与 SDK 说的注册状态不一致时自动校正（内含说明与提示），一致时只报发码成功
    const consistent = (state.authIntent === "login") === sent.data.isExistingUser;
    if (consistent) toast("验证码已发送");
    reconcileIntent(sent.data.isExistingUser, "phone");
    applyPhoneMode();
  } catch (err) {
    loginError(String(err && err.message || err));
    el.sendCodeBtn.disabled = false;
  }
});

el.phoneForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = el.phone.value.trim();
  const token = el.code.value.trim();
  const pending = state.pendingOtp;
  loginError("");
  if (!pending || pending.phone !== phone) {
    loginError("请先为当前手机号获取验证码");
    return;
  }
  if (!token) { loginError("请输入验证码"); return; }
  if (!pending.isExistingUser && !el.signupPassword.value) {
    loginError(state.authIntent === "register" ? "请设置密码（至少 8 位）" : "首次注册需要设置密码（至少 8 位）");
    return;
  }
  el.loginSubmit.disabled = true;
  try {
    const res = await cloud.auth.verifyOtp({
      phone: pending.phone,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token,
      password: pending.isExistingUser ? undefined : el.signupPassword.value,
    });
    if (res.error) { loginError(res.error.message || "登录失败"); return; }
    state.pendingOtp = null;
    el.code.value = "";
    await enterApp();
  } catch (err) {
    loginError(String(err && err.message || err));
  } finally {
    el.loginSubmit.disabled = false;
  }
});

el.wechatBtn.addEventListener("click", async () => {
  loginError("");
  try {
    const r = await cloud.auth.signInWithOAuth({ provider: "wechat", redirectTo: location.origin });
    if (r.error) { loginError(r.error.message || "微信登录不可用"); return; }
    if (r.data && r.data.url) location.assign(r.data.url);
  } catch (err) {
    loginError(String(err && err.message || err));
  }
});

el.logoutBtn.addEventListener("click", async () => {
  const ok = await askConfirm("退出登录？云端内容仍保留在你的账号下。");
  if (!ok) return;
  try { await cloud.auth.signOut(); } catch (_) {}
  state.session = null; state.docs = []; state.loaded = false;
  state.pendingOtp = null; state.pendingEmailOtp = null;
  state.docCache.clear(); state.wsFilter = null; state.view = "tree";
  // 成品 srcdoc 里内嵌着上一个账号的签名 URL，绝不能跨账号复用
  state.htmlFrameCache.clear();
  // 换账号必须清掉资源缓存与上传清单：签名 URL 属于上一个账号，
  // 清单更是「这个分区已经传过哪些图」的账本，留着会让新账号的图被误判为已传。
  state.signedAssets.clear();
  state.assetManifest = new Map();
  saveAssetManifest();
  resetEmailFlow();
  el.tree.innerHTML = ""; el.searchResults.innerHTML = ""; el.cards.innerHTML = "";
  el.wsChips.hidden = true; el.wsChips.innerHTML = "";
  el.q.value = ""; el.clearQ.hidden = true;
  show("login");
});

/* ══ 数据加载 ═══════════════════════════════════════════════ */
async function loadDocs() {
  // PostgREST 单次响应有行数上限，按 range 分页拉全，避免静默截断
  const PAGE = 1000;
  const MAX = 20000;
  const all = [];
  for (let from = 0; from < MAX; from += PAGE) {
    const { data, error } = await cloud.database
      .from("documents")
      .select("id, workspace, rel_path, title, bytes, updated_at, content_sha, doc_mtime")
      .is("deleted_at", null)
      .order("rel_path", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      toast(error.code === "42501" ? "没有权限读取云端内容" : (error.message || "加载失败"), "error");
      return;
    }
    const rows = Array.isArray(data) ? data : [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  state.docs = all;
  state.loaded = true;
  /* 列表已经是最新状态 —— 之前缓存的正文与成品 srcdoc（内含签名 URL）都可能过期：
   * 一键推送 / 上传会改写云端正文。这一处清掉，覆盖「刷新按钮 / 上传与推送完成 /
   * 启动」三条路径，避免用户打开一篇看到旧内容。 */
  state.docCache.clear();
  state.htmlFrameCache.clear();
  renderList();
}

function renderStats() {
  const wsCount = new Set(state.docs.map((d) => d.workspace)).size;
  const bytes = state.docs.reduce((s, d) => s + (Number(d.bytes) || 0), 0);
  el.stats.textContent = state.docs.length
    ? `${state.docs.length} 篇 · ${wsCount} 个分区 · ${fmtBytes(bytes)}`
    : "云端暂无内容";
  el.emptyState.hidden = state.docs.length > 0;
}

function groupByWorkspace(docs) {
  const map = new Map();
  for (const d of docs) {
    if (!map.has(d.workspace)) map.set(d.workspace, []);
    map.get(d.workspace).push(d);
  }
  return map;
}

/** 文档名：rel_path 的尾段（比 title 更稳定，title 可能为空）。 */
function docName(d) {
  return String(d.rel_path || "").split("/").pop() || d.title || "未命名";
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
function fmtRelative(v) {
  if (!v) return "";
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 0) return fmtTime(v).slice(0, 10);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return min + " 分钟前";
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + " 小时前";
  const day = Math.floor(hour / 24);
  if (day < 30) return day + " 天前";
  return fmtTime(v).slice(0, 10);
}

/** 把已转义文本里的命中词包成 <mark>（关键词也先转义，用户输入永远不当 HTML）。 */
function markHits(escapedText, q) {
  if (!q) return escapedText;
  const needle = escapeHtml(q);
  if (!needle) return escapedText;
  const safe = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escapedText.replace(new RegExp(safe, "gi"), (m) => `<mark>${m}</mark>`);
}

/**
 * 文档卡片：「最近」「全部」「搜索结果」三处共用同一个组件，
 * 只靠 opts 调时间显示方式与是否带命中片段。列表里**不取正文**，
 * 避免为了看一眼目录把整库内容拉下来。
 */
function docCard(d, opts) {
  const o = opts || {};
  const q = o.q || "";
  const name = docName(d);
  const parts = [];
  if (d.workspace) parts.push(`<span class="dc-badge">${escapeHtml(d.workspace)}</span>`);
  const dir = String(d.rel_path || "").split("/").slice(0, -1).join("/");
  if (dir) parts.push(`<span class="dc-path">${escapeHtml(dir)}</span>`);
  parts.push(`<span>${fmtBytes(d.bytes)}</span>`);
  const when = o.relative ? fmtRelative(d.updated_at) : fmtTime(d.updated_at);
  if (when) parts.push(`<span>${escapeHtml(when)}</span>`);
  const snippet = o.snippet ? `<span class="sr-snippet">${o.snippet}</span>` : "";
  return `<button class="doc-card" type="button" data-id="${d.id}">
    <span class="dc-title">${markHits(escapeHtml(d.title || name), q)}</span>
    <span class="dc-sub">${parts.join('<span class="dc-sep">·</span>')}</span>
    ${snippet}
  </button>`;
}

function docLeaf(d) {
  const name = docName(d);
  return `<li class="doc-item"><button class="doc-link" type="button" data-id="${d.id}">
    <span class="doc-name">${escapeHtml(d.title || name)}</span>
    <span class="doc-sub">${escapeHtml(name)} · ${fmtBytes(d.bytes)}</span>
  </button></li>`;
}

function buildTreeHtml(docs) {
  // 树只表达结构（分区 → 目录 → 文档）；时效性交给「最近」视图，不再在这里重复一遍。
  const groups = groupByWorkspace(docs);
  const out = [];
  for (const ws of [...groups.keys()].sort((a, b) => a.localeCompare(b, "zh"))) {
    const rows = groups.get(ws);
    const dirs = new Map();
    for (const d of rows) {
      const parts = String(d.rel_path).split("/");
      const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir).push(d);
    }
    const dirHtml = [...dirs.keys()].sort((a, b) => a.localeCompare(b, "zh")).map((dir) => {
      const list = `<ul class="doc-list">${dirs.get(dir).map(docLeaf).join("")}</ul>`;
      if (!dir) return list;
      return `<details class="dir" open><summary class="dir-summary"><span class="dir-name">${escapeHtml(dir)}</span><span class="ws-count">${dirs.get(dir).length}</span></summary>${list}</details>`;
    }).join("");
    out.push(`<details class="ws" open><summary class="ws-summary"><span class="ws-name">${escapeHtml(ws)}</span><span class="ws-count">${rows.length}</span></summary>${dirHtml}</details>`);
  }
  return out.join("");
}

function renderTree() {
  el.tree.innerHTML = buildTreeHtml(visibleDocs());
}

/* ══ 三种视图（目录 / 最近 / 全部）══════════════════════════
 * 一个分段控件换三种「整体看全整库」的方式：
 *   目录 = 分区 → 目录 → 文档（结构）
 *   最近 = 按更新时间倒序的卡片流（时效）
 *   全部 = 按标题排序的卡片网格（找一篇已知名字的）
 * 三者共用同一种卡片/叶子样式，所以视觉噪音不随视图数增长。 */

/** 当前分区筛选下可见的文档。 */
function visibleDocs() {
  if (!state.wsFilter) return state.docs;
  return state.docs.filter((d) => d.workspace === state.wsFilter);
}

function renderCards() {
  if (!state.docs.length) { el.cards.innerHTML = ""; return; }
  const rows = visibleDocs();
  const list = state.view === "recent"
    ? [...rows].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    : [...rows].sort((a, b) => String(a.title || a.rel_path || "")
        .localeCompare(String(b.title || b.rel_path || ""), "zh"));
  el.cards.innerHTML = list.length
    ? list.map((d) => docCard(d, { relative: state.view === "recent" })).join("")
    : `<p class="empty-inline muted">这个分区还没有内容。</p>`;
}

/** 分区筛选条：只有多于一个分区时才出现（单分区下纯属噪音）。 */
function renderWsChips() {
  const counts = new Map();
  for (const d of state.docs) counts.set(d.workspace, (counts.get(d.workspace) || 0) + 1);
  if (counts.size < 2) { el.wsChips.hidden = true; el.wsChips.innerHTML = ""; return; }
  const chip = (ws, label, n) =>
    `<button class="chip${(state.wsFilter || "") === ws ? " is-active" : ""}" type="button" data-ws="${escapeHtml(ws)}">`
    + `${escapeHtml(label)}<span class="chip-count">${n}</span></button>`;
  el.wsChips.innerHTML = chip("", "全部", state.docs.length)
    + [...counts.keys()].sort((a, b) => a.localeCompare(b, "zh"))
        .map((ws) => chip(ws, ws, counts.get(ws))).join("");
  el.wsChips.hidden = false;
}

/** 视图切换：同时负责清空搜索态，避免「搜索中切视图」留下半截结果。 */
function applyView() {
  const isTree = state.view === "tree";
  clearTimeout(searchTimer);          // 清空输入后别再让挂起的检索把结果刷回来
  el.tree.hidden = !isTree;
  el.cards.hidden = isTree;
  el.searchResults.hidden = true;
  el.searchResults.innerHTML = "";
  el.q.value = "";
  el.clearQ.hidden = true;
  for (const btn of el.viewSwitch.querySelectorAll(".vs-btn")) {
    const on = btn.dataset.view === state.view;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  renderTree();
  renderCards();
}

/** 列表页统一重绘入口（加载 / 刷新 / 删除后调用）。 */
function renderList() {
  renderStats();
  renderWsChips();
  renderTree();
  renderCards();
}

el.viewSwitch.addEventListener("click", (e) => {
  const btn = e.target.closest(".vs-btn");
  if (!btn || btn.dataset.view === state.view) return;
  state.view = btn.dataset.view;
  applyView();
});

el.wsChips.addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  state.wsFilter = c.dataset.ws || null;
  renderWsChips();
  renderTree();
  renderCards();
});

/* ══ 检索 ═══════════════════════════════════════════════════
 * 三层递进，兼顾「快」与「准」：
 *   1) 本地标题 / 路径即时筛 —— 不联网，输入即命中；
 *   2) 本地正文缓存命中 —— 打开过或搜过的文档能立即出片段；
 *   3) 云端正文 ilike —— 只取元数据列（不带 content），避免为了搜索把整库正文拉下来；
 *   4) 给排名靠前、还没有片段的结果按 id 批量补拉正文，生成命中上下文。
 * 第 4 步的条数有硬上限（SNIPPET_DOCS），所以手机端的流量是可预期的。 */
const SNIPPET_DOCS = 8;
const DOC_CACHE_MAX = 60;

/** 记录正文到内存缓存（打开文档时写入；搜索出片段时也写入）。 */
function rememberDoc(id, content) {
  if (typeof content !== "string") return;
  const key = String(id);
  state.docCache.delete(key);
  state.docCache.set(key, content);
  while (state.docCache.size > DOC_CACHE_MAX) {
    state.docCache.delete(state.docCache.keys().next().value);
  }
}

/** 独立 HTML 文档取检索片段前先剥掉标签与脚本样式（与桌面端 app.rs strip_html 同意图）：
 *  否则片段里全是 `<div class=…>` 噪声，看不出命中在哪句话上。 */
function stripTagsForSearch(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ");
}

/** 取正文里第一处命中的上下文，命中词用 <mark> 标出；markdown 标记先抹平。 */
function buildSnippet(content, q, isHtml) {
  const flat = (isHtml ? stripTagsForSearch(content) : String(content || "")).replace(/\r\n?/g, "\n");
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return "";
  const WIN_BEFORE = 34, WIN_AFTER = 62;
  const clean = (s) => s.replace(/[#>*`_[\]]/g, " ").replace(/\s+/g, " ");
  const head = flat.slice(Math.max(0, at - WIN_BEFORE), at);
  const hit = flat.slice(at, at + q.length);
  const tail = flat.slice(at + q.length, at + q.length + WIN_AFTER);
  return (at > WIN_BEFORE ? "…" : "")
    + escapeHtml(clean(head)) + "<mark>" + escapeHtml(hit) + "</mark>" + escapeHtml(clean(tail))
    + (at + q.length + WIN_AFTER < flat.length ? "…" : "");
}

/** 相关度：标题命中 > 路径命中 > 仅正文命中。 */
function scoreDoc(d, lc, hasSnippet) {
  let s = 0;
  if (String(d.title || "").toLowerCase().includes(lc)) s += 100;
  if (String(d.rel_path || "").toLowerCase().includes(lc)) s += 40;
  if (hasSnippet) s += 20;
  return s;
}

/* 检索触发：这一层必须在**真机输入法**下工作，不能只靠 input 事件。
 * Android WebView 实测差异（2026-10-13 真浏览器复现）：
 *   1) 中文输入法拼字过程中 input 会带 isComposing=true —— 此时值是拼音串（如 "kaoyan"），
 *      拿它去检索只会得到「没有匹配 kaoyan」；而部分 WebView 在选字上屏后**不再补发 input**，
 *      画面就永久停在那个「没有匹配」上 —— 用户看到的现象正是「检索不生效」。
 *   2) type="search" 的原生清除按钮 / 软键盘「搜索」键走的可能是 search / change 事件，
 *      而软键盘通常**不派发 keyup**。
 * 所以：拼字中跳过；compositionend / change / search / Enter 各兜一遍；最后再有一层
 * 「聚焦期间比对值变化」的轮询兜底，覆盖任何不按规范派发事件的输入法。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
/** 云端正文检索的最短长度：中文一个字就是一个词，门槛必须比拉丁文低。 */
function remoteMinLen(q) { return CJK_RE.test(q) ? 1 : 2; }

let searchTimer = null;
const SEARCH_DEBOUNCE = 280;
/** 输入法拼字中：此间 el.q.value 是拼音串（"kaoyan"），搜了只会得到「没有匹配 kaoyan」。
 *  用 compositionstart/end 显式跟踪，而不只依赖 input.isComposing —— 事件派发顺序在
 *  各 WebView 上并不一致，且轮询兜底不看 isComposing。5s 超时防止 compositionend 丢失后卡死。 */
let composingQuery = false;
let composingTimer = null;
function scheduleSearch(delay) {
  if (composingQuery) return;
  const v = el.q.value.trim();
  el.clearQ.hidden = !v;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(v), typeof delay === "number" ? delay : SEARCH_DEBOUNCE);
}

let polledValue = "";
let qPoll = null;
function startQueryPoll() {
  if (qPoll) return;
  polledValue = el.q.value;
  qPoll = setInterval(() => {
    if (composingQuery) return;                     // 拼字中不打扰
    if (el.q.value !== polledValue) { polledValue = el.q.value; scheduleSearch(120); }
  }, 320);
}
function stopQueryPoll() { if (qPoll) { clearInterval(qPoll); qPoll = null; } }

el.q.addEventListener("compositionstart", () => {
  composingQuery = true;
  clearTimeout(composingTimer);
  composingTimer = setTimeout(() => { composingQuery = false; scheduleSearch(0); }, 5000);
});
el.q.addEventListener("compositionend", () => {
  composingQuery = false;
  clearTimeout(composingTimer);
  scheduleSearch(60);
});
el.q.addEventListener("input", (e) => {
  if ((e && e.isComposing) || composingQuery) return;
  scheduleSearch();
});
el.q.addEventListener("change", () => scheduleSearch(0));
el.q.addEventListener("search", () => scheduleSearch(0));
el.q.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  clearTimeout(searchTimer);
  runSearch(el.q.value.trim());
  el.q.blur();
});
el.q.addEventListener("focus", startQueryPoll);
el.q.addEventListener("blur", () => {
  composingQuery = false;
  clearTimeout(composingTimer);
  setTimeout(stopQueryPoll, 800);
});
el.clearQ.addEventListener("click", () => { clearTimeout(searchTimer); applyView(); });

/** 长列表滚到下方后再检索时，结果区可能整个落在视口之外（手机小屏尤其明显），
 *  看起来就像「点了没反应」。只在完全不可见时滚到最近边缘，避免输入过程中抖动。 */
function revealResults() {
  try {
    const r = el.searchResults.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) el.searchResults.scrollIntoView({ block: "nearest" });
  } catch (_) { /* 取不到布局就算了，不影响检索本身 */ }
}

async function runSearch(q) {
  if (!q) { applyView(); return; }
  const token = ++state.searchToken;
  const lc = q.toLowerCase();
  const snippets = new Map();   // id -> 片段 HTML

  // 1) 本地：标题 / 路径
  const local = state.docs.filter((d) =>
    String(d.title || "").toLowerCase().includes(lc)
    || String(d.rel_path || "").toLowerCase().includes(lc));

  // 2) 本地正文缓存（打开过 / 上次搜过）
  for (const d of state.docs) {
    const cached = state.docCache.get(String(d.id));
    if (cached && cached.toLowerCase().includes(lc)) {
      snippets.set(String(d.id), buildSnippet(cached, q, HTML_DOC_EXT.test(d.rel_path || "")));
    }
  }

  // 3) 云端正文检索：只选元数据列，正文不随响应回来
  //    失败必须**可见** —— 否则用户看到「没有匹配」会以为内容没同步上去，而不是网络/权限出错。
  let remote = [];
  let remoteError = "";
  if (q.length >= remoteMinLen(q)) {
    try {
      const { data, error } = await cloud.database
        .from("documents")
        .select("id, workspace, rel_path, title, bytes, updated_at")
        .is("deleted_at", null)
        .ilike("content", `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`)
        .order("updated_at", { ascending: false })
        .limit(60);
      if (error) remoteError = error.message || "云端检索失败";
      else if (Array.isArray(data)) remote = data;
    } catch (err) { remoteError = String((err && err.message) || err); }
  }
  if (token !== state.searchToken) return;

  const seen = new Set();
  const merged = [];
  for (const d of [...local, ...remote]) {
    const id = String(d.id);
    if (seen.has(id)) continue;
    seen.add(id); merged.push(d);
  }

  // 4) 给排名靠前、还没有片段的结果补拉正文（一次批量请求 + 条数上限）
  const need = merged.filter((d) => !snippets.has(String(d.id))).slice(0, SNIPPET_DOCS);
  if (need.length) {
    try {
      const { data } = await cloud.database
        .from("documents").select("id, content")
        .in("id", need.map((d) => d.id));
      if (token !== state.searchToken) return;
      const got = new Map((Array.isArray(data) ? data : []).map((r) => [String(r.id), r.content]));
      for (const d of need) {
        const id = String(d.id);
        const content = got.get(id);
        if (typeof content !== "string") continue;
        rememberDoc(id, content);
        if (content.toLowerCase().includes(lc)) {
          snippets.set(id, buildSnippet(content, q, HTML_DOC_EXT.test(d.rel_path || "")));
        }
      }
    } catch (_) { /* 补拉失败就只显示标题，不阻断搜索 */ }
  }
  if (token !== state.searchToken) return;

  merged.sort((a, b) => {
    const diff = scoreDoc(b, lc, snippets.has(String(b.id))) - scoreDoc(a, lc, snippets.has(String(a.id)));
    return diff !== 0 ? diff : String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  });

  el.tree.hidden = true;
  el.cards.hidden = true;
  el.searchResults.hidden = false;
  // 云端检索失败时明确说出来：用户看到「没有匹配」会以为内容没同步上去，
  // 而不是网络 / 权限出问题 —— 这正是「检索不生效」最常见的误判来源。
  const warn = remoteError
    ? `<p class="sr-warn">云端正文检索未完成：${escapeHtml(remoteError)}<br>结果可能不完整，网络恢复后重试一次即可。</p>`
    : "";
  if (!merged.length) {
    // 带上「当前账号下有多少篇参与检索」：一句话就能区分「确实没有这篇」和
    // 「登录的不是同一个账号 / 内容还没同步上去」——这两种困惑以前长得一模一样。
    const scope = state.docs.length
      ? `当前账号下 ${state.docs.length} 篇已参与检索（标题 / 路径 / 正文）。`
      : "当前账号下还没有同步的内容。";
    el.searchResults.innerHTML = warn
      + `<p class="empty-inline muted">没有匹配「${escapeHtml(q)}」的内容。<br>${scope}<br>试试更短的关键词，或确认这篇是否已上传到云端。</p>`;
    revealResults();
    return;
  }
  const bodyHits = [...snippets.keys()].filter((id) => merged.some((d) => String(d.id) === id)).length;
  el.searchResults.innerHTML = warn
    + `<p class="sr-head"><strong>${merged.length}</strong> 篇命中`
    + (bodyHits ? ` · <strong>${bodyHits}</strong> 篇含正文匹配` : "")
    + `</p>`
    + merged.map((d) => docCard(d, { q, snippet: snippets.get(String(d.id)) })).join("");
  revealResults();
}

/* ══ 阅读 ═══════════════════════════════════════════════════ */
function ensureWorker() {
  if (state.worker) return state.worker;
  // assets=/vendor/ 让 worker 从同源自托管目录取图表库，而不是第三方 CDN。
  // 桌面端不传这个参数（行为与以前一致），所以同一份 worker 能服务两端。
  const w = new Worker(`/markdown-worker.js?v=${ASSET_V}&assets=/vendor/`);
  state.worker = w;
  return w;
}
function renderMarkdownInWorker(source) {
  return new Promise((resolve, reject) => {
    const w = ensureWorker();
    const seq = Math.random().toString(36).slice(2);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      w.removeEventListener("message", onMsg);
      reject(new Error("渲染超时"));
    }, 15000);
    const onMsg = async (e) => {
      const d = e.data || {};
      if (d.seq !== seq || settled) return;
      settled = true;
      clearTimeout(timer);
      w.removeEventListener("message", onMsg);
      try {
        const html = d.useBlob && d.htmlBlob ? await d.htmlBlob.text() : (d.html || "");
        resolve(html);
      } catch (err) { reject(err); }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ seq, source, searchTerm: "", includeHtml: true, includeOutline: false });
  });
}

/* 沙箱帧高度自适应：worker 渲染的 html / chart 围栏 iframe、以及独立 HTML 文档预览
 * （.html-doc-frame）都会在 srcdoc 最前置一段上报脚本，帧内把 scrollHeight postMessage
 * 出来，这里把对应 iframe 撑到内容高度。
 * 必须校验 event.source === frame.contentWindow，只认自家帧；高度 clamp 防异常值。 */
(function installHtmlFrameAutoHeight() {
  if (window.__mtHtmlFrameAutoHeightInstalled) return;
  window.__mtHtmlFrameAutoHeightInstalled = true;
  window.addEventListener("message", (event) => {
    const d = event.data;
    if (!d || d.type !== "mt-html-frame-height") return;
    const h = Number(d.h);
    if (!Number.isFinite(h) || h <= 0) return;
    document.querySelectorAll("iframe.html-inline-frame, iframe.html-doc-frame").forEach((frame) => {
      if (!frame.isConnected || frame.contentWindow !== event.source) return;
      const clamped = Math.min(Math.max(Math.ceil(h) + 12, 240), HTML_FRAME_MAX_HEIGHT);
      frame.style.height = clamped + "px";
    });
  });
})();

/** 阅读区宽度没被利用完，是「APK 里打开 HTML 变窄」的第一层成因（实测 iframe 356px /
 *  屏幕 390px ＝ 91.3%，少的 34px 是正文区左右 padding 与卡片边框）。
 *  全屏视图把这层外壳全部让出去：iframe 直接铺满视口 → 可用宽度回到 100%，
 *  帧内 100vh 也从「被撑开的内容高度」变回真实视口高度。 */
function openHtmlFrameFullscreen(iframe) {
  if (!iframe) return;
  const overlay = document.createElement("div");
  overlay.className = "html-frame-fullscreen-overlay";
  const closeBtn = document.createElement("button");
  closeBtn.className = "html-frame-fullscreen-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "退出全屏");
  closeBtn.textContent = "×";
  const full = document.createElement("iframe");
  // 沿用同一份 srcdoc 与 sandbox：借「放大」绕过限制是不允许的。
  // 注意 sandbox="" 必须原样保留（那是最严格档），不能因「空值」回退到放宽策略。
  full.srcdoc = iframe.srcdoc || iframe.getAttribute("srcdoc") || "";
  const inherited = iframe.getAttribute("sandbox");
  full.setAttribute("sandbox", inherited === null ? HTML_DOC_SANDBOX : inherited);
  full.setAttribute("referrerpolicy", "no-referrer");
  full.setAttribute("title", "HTML 全屏预览");
  overlay.append(full, closeBtn);

  const prevOverflow = document.body.style.overflow;
  const cleanup = () => {
    overlay.remove();
    document.body.style.overflow = prevOverflow;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (ev) => { if (ev.key === "Escape") cleanup(); };
  closeBtn.addEventListener("click", cleanup);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) cleanup(); });
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
}

/** 给内嵌网页 iframe 挂「放大」按钮（Markdown 里的 html 围栏块 .html-inline-block 与
 *  独立 HTML 文档 .html-doc-block 共用，桌面端 app.js 的同名实现为参照）。
 *
 *  与桌面端的一处**有意差异**：按钮**常显**而不是 hover 才显 —— 这里主要服务手机
 *  （APK / 微信），触屏没有 hover，hover 才显等于永远点不到。
 *
 *  全屏帧**不挂** html-inline-frame / html-doc-frame 类名：那两个类是高度上报的
 *  命中目标，带上就会被撑到内容高度，全屏就白开了。 */
function decorateHtmlBlocks(container) {
  if (!container || typeof container.querySelectorAll !== "function") return;
  container.querySelectorAll(".html-doc-block, .html-inline-block").forEach((block) => {
    if (block.querySelector(".html-frame-fullscreen-btn")) return;
    const iframe = block.querySelector("iframe.html-doc-frame, iframe.html-inline-frame");
    if (!iframe) return;
    const btn = document.createElement("button");
    btn.className = "html-frame-fullscreen-btn";
    btn.type = "button";
    btn.textContent = "放大";
    btn.title = "全屏查看这个网页";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openHtmlFrameFullscreen(iframe);
    });
    // 说明栏存在就并进栏里（不遮挡提示文字），否则绝对定位到块右上角
    const bar = block.querySelector(":scope > .html-doc-bar");
    if (bar) bar.appendChild(btn);
    else block.appendChild(btn);
  });
}

let katexPromise = null;
function loadKatex() {
  if (katexPromise) return katexPromise;
  katexPromise = new Promise((resolve) => {
    if (window.katex) return resolve(window.katex);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = KATEX_CSS;
    document.head.appendChild(link);
    const s = document.createElement("script");
    s.src = KATEX_SRC;
    s.onload = () => resolve(window.katex || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return katexPromise;
}

let mermaidPromise = null;
function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise((resolve) => {
    if (window.mermaid) return resolve(window.mermaid);
    const s = document.createElement("script");
    s.src = MERMAID_SRC;
    s.onload = () => resolve(window.mermaid || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return mermaidPromise;
}

function isDark() { return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches; }

async function decorateContent(root) {
  // 1) KaTeX
  const mathNodes = root.querySelectorAll(".math-block[data-math], .math-inline[data-math]");
  if (mathNodes.length) {
    const katex = await loadKatex();
    if (katex) {
      mathNodes.forEach((node) => {
        const src = node.getAttribute("data-math") || "";
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

  // 2) Mermaid —— 串行渲染：mermaid.render 不是并发安全的
  const blocks = root.querySelectorAll(".chart-block.mermaid-block .mermaid-container");
  if (blocks.length) {
    const mermaid = await loadMermaid();
    if (mermaid) {
      try {
        mermaid.initialize({ startOnLoad: false, theme: isDark() ? "dark" : "default", securityLevel: "loose" });
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
      } catch (_) {}
      let uid = 0;
      for (const box of blocks) {
        const src = box.parentElement.querySelector(".mermaid-source");
        if (!src) continue;
        const def = src.textContent || "";
        try {
          const { svg } = await mermaid.render(`mtc-mmd-${Date.now()}-${++uid}`, def);
          box.innerHTML = svg;
          const svgEl = box.querySelector("svg");
          if (svgEl) {
            const vb = (svgEl.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
            svgEl.removeAttribute("width");
            svgEl.removeAttribute("height");
            svgEl.style.width = "100%";
            svgEl.style.height = "auto";
            svgEl.style.display = "block";
            // 自然尺寸作上限：不把小图画布拉满整屏
            if (vb.length === 4 && vb[2] > 0) svgEl.style.maxWidth = Math.round(vb[2]) + "px";
            svgEl.style.margin = "0 auto";
          }
          src.hidden = true;
        } catch (err) {
          box.innerHTML = `<div class="chart-error">图表渲染失败：${escapeHtml(String(err && err.message || err))}</div>`;
        }
      }
    }
  }

  // 3) 代码块复制
  root.querySelectorAll(".code-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pre = btn.parentElement && btn.parentElement.querySelector("pre");
      if (!pre) return;
      try { await navigator.clipboard.writeText(pre.innerText); toast("已复制"); }
      catch (_) { toast("复制失败", "error"); }
    });
  });

  // 4) 内嵌网页（Markdown 的 html / chart 围栏）挂「放大」
  decorateHtmlBlocks(root);
}

async function openDoc(id) {
  state.currentId = id;
  const meta = state.docs.find((d) => String(d.id) === String(id));
  el.docTitle.textContent = meta ? (meta.title || meta.rel_path) : "加载中…";
  el.docPath.textContent = meta ? `${meta.workspace} / ${meta.rel_path}` : "";
  show("doc");
  window.scrollTo(0, 0);

  /* 打开过的文档走内存缓存秒开，不再打一次网络 —— 列表页与「按 id 补拉片段」都会把
   * 正文写进 docCache，手机上省掉一次 30–300ms 的往返。只有缓存未命中、或列表元信息
   * 缺失时才回云端取正文。
   * 失效点（正文可能已经不是这一份了）：刷新列表 loadDocs、一键推送 runLocalImport、
   * 上传、删除、退出登录 —— 各自都会清 docCache，见对应实现。 */
  const cachedText = state.docCache.get(String(id));
  let data = null;
  if (cachedText != null && meta) {
    data = {
      id,
      title: meta.title, rel_path: meta.rel_path, workspace: meta.workspace,
      content: cachedText, bytes: meta.bytes, updated_at: meta.updated_at,
    };
  } else {
    el.docBody.innerHTML = `<div class="doc-loading"><div class="spinner"></div></div>`;
    const { data: row, error } = await cloud.database
      .from("documents").select("id, title, rel_path, workspace, content, bytes, updated_at")
      .eq("id", id).is("deleted_at", null).maybeSingle();
    if (error || !row) {
      state.docSource = "";
      el.docBody.innerHTML = `<p class="muted">读取失败：${escapeHtml(error ? (error.message || "未知错误") : "文档不存在")}</p>`;
      return;
    }
    data = row;
  }
  el.docTitle.textContent = data.title || data.rel_path;
  el.docPath.textContent = `${data.workspace} / ${data.rel_path} · ${fmtTime(data.updated_at)}`;
  state.docSource = data.content || "";
  rememberDoc(id, state.docSource);
  // 按扩展名分派渲染：独立 HTML 文档不能走 markdown 渲染（整页标签会被当正文
  // 渲染成一段乱码文本），改用沙箱 iframe 按网页原样加载（与桌面端同款沙箱）。
  if (HTML_DOC_EXT.test(data.rel_path || "")) {
    try {
      await renderHtmlDocRow(data);
      return;
    } catch (err) {
      el.docBody.innerHTML = `<pre class="fallback-pre">${escapeHtml(data.content || "")}</pre>`;
      toast("网页预览失败，已降级为源码：" + String(err && err.message || err), "error");
      return;
    }
  }
  try {
    const html = await renderMarkdownInWorker(data.content || "");
    el.docBody.innerHTML = html;
    await decorateContent(el.docBody);
    // 图片单独一步：正文先出来，再把本机相对引用的截图换成云存储的签名地址。
    await resolveDocAssets(el.docBody, data);
  } catch (err) {
    el.docBody.innerHTML = `<pre class="fallback-pre">${escapeHtml(data.content || "")}</pre>`;
    toast("渲染降级为纯文本：" + String(err && err.message || err), "error");
  }
}

/** 内容指纹（与桌面端 app.js 的 htmlDocDigest 逐字同源）：内容没变就不重建 iframe。 */
function htmlDocDigest(text) {
  const s = String(text || "");
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

/**
 * 渲染独立 HTML 文档：沙箱 iframe + 说明栏。
 *
 * 三条不可省的约束：
 *   1) srcdoc 前置高度上报脚本，父页把帧撑到内容高度（否则整页网页挤在固定小窗里）；
 *   2) 资源引用必须先做**字符串级**改写再塞进去 —— 沙箱帧是 opaque origin，父页
 *      摸不到帧内 DOM，做不到「渲染后再替换 src」（markdown 那条路可以，这条不行）；
 *   3) 「找引用 → 批量签名 → 改写」这套准备动作的成品按内容指纹缓存（htmlFrameCache）：
 *      对几百 KB 的文档，重扫全篇 + 一次签名往返本身就是可观开销，而 srcdoc 没有 URL，
 *      浏览器 HTTP 缓存一点忙都帮不上。
 */
async function renderHtmlDocRow(row) {
  const uid = state.session && state.session.user && state.session.user.id;
  const docRel = row.rel_path || "";
  const source = row.content || "";
  const docKey = String(row.id || "");
  const digest = htmlDocDigest(source);

  // 成品缓存命中：跳过准备阶段，直接装载（签名 URL 有 SIGN_TTL，缓存跟着过期）
  const hit = state.htmlFrameCache.get(docKey);
  if (hit && hit.digest === digest && hit.exp > Date.now()) {
    mountHtmlDocBlock(hit.srcdoc, hit.hasAsset);
    return;
  }

  // 先把引用逐个解析成云存储对象路径，再一次性批量签名（逐个签名会打爆请求数）。
  const plan = new Map();
  const allPaths = new Set();
  for (const ref of extractAssetRefs(source)) {
    if (plan.has(ref)) continue;
    const paths = assetRelCandidates(ref, docRel)
      .filter((p) => ASSET_EXT.test(p))
      .map((rel) => ({ rel, obj: assetObjectPath(uid, row.workspace, rel) }))
      .filter((x) => x.obj);
    if (!paths.length) continue;
    paths.forEach((x) => allPaths.add(x.obj));
    plan.set(ref, paths);
  }
  let signed = new Map();
  if (uid && allPaths.size) {
    try { signed = await signAssets([...allPaths]); } catch (_) { signed = new Map(); }
  }
  const content = rewriteHtmlAssetSrc(source, (ref) => {
    const paths = plan.get(ref);
    if (!paths) return "";
    const hitPath = paths.find((x) => signed.has(x.obj));
    return hitPath ? signed.get(hitPath.obj) : "";
  });

  const hasAsset = plan.size > 0;
  const srcdoc = HTML_FRAME_RESIZE_SCRIPT + content;
  state.htmlFrameCache.set(docKey, {
    digest, srcdoc, hasAsset, exp: Date.now() + SIGN_TTL * 1000,
  });
  mountHtmlDocBlock(srcdoc, hasAsset);
}

/** 把成品 srcdoc 装成一个 HTML 文档块（说明栏 + 沙箱 iframe + 「放大」入口）。 */
function mountHtmlDocBlock(srcdoc, hasAsset) {
  const block = document.createElement("div");
  block.className = "html-doc-block";
  const bar = document.createElement("div");
  bar.className = "html-doc-bar";
  const label = document.createElement("span");
  label.className = "html-doc-label";
  label.textContent = "网页预览";
  const hint = document.createElement("span");
  hint.className = "html-doc-hint";
  hint.textContent = hasAsset
    ? "按网页原样加载（脚本在沙箱内运行）；已随云同步的图片可正常显示"
    : "按网页原样加载（脚本在沙箱内运行）；相对路径资源不可用";
  bar.append(label, hint);

  const frame = document.createElement("iframe");
  frame.className = "html-doc-frame";
  frame.setAttribute("sandbox", HTML_DOC_SANDBOX);
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", "HTML 文档预览");
  frame.srcdoc = srcdoc;

  block.append(bar, frame);
  el.docBody.replaceChildren(block);
  // 手机端「放大」入口：全屏后 iframe 铺满视口，宽度利用率回到 100%
  decorateHtmlBlocks(el.docBody);
}

document.addEventListener("click", (e) => {
  const link = e.target.closest(".doc-link, .doc-card");
  if (link) { openDoc(link.getAttribute("data-id")); return; }
  const a = e.target.closest("a[href]");
  if (a && !a.getAttribute("href").startsWith("#")) {
    // 外部链接交给系统浏览器
    e.preventDefault();
    const href = a.getAttribute("href");
    if (/^https?:/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
  }
});

/** 从文档页回到列表（顶栏返回键与 Android 物理返回键共用）。 */
function backToList() {
  state.currentId = null;
  state.docSource = "";
  el.docBody.innerHTML = "";
  show("list");
}

el.backBtn.addEventListener("click", backToList);

el.docDeleteBtn.addEventListener("click", async () => {
  if (!state.currentId) return;
  const ok = await askConfirm("从云端删除这一篇？本地原始文件不受影响。");
  if (!ok) return;
  const { data, error } = await cloud.database.from("documents").delete().eq("id", state.currentId).select("id");
  if (error || !Array.isArray(data) || data.length === 0) {
    toast("未删除成功（可能已不存在或不属于你）", "error");
    return;
  }
  state.docs = state.docs.filter((d) => String(d.id) !== String(state.currentId));
  state.currentId = null;
  state.docSource = "";
  toast("已从云端删除");
  renderList(); show("list");
});

el.refreshBtn.addEventListener("click", async () => {
  el.refreshBtn.disabled = true;
  await loadDocs();
  el.refreshBtn.disabled = false;
  toast("已刷新");
});

/* ══ 从本机导入（一键推送）═══════════════════════════════════
 *
 * 定位：**备用路径**。桌面端自己已经能直连云服务（见 public/modules/cloud-client.js），
 * 不需要经过浏览器；这条路保留给「不想让桌面端直连」或「没装桌面端」的场景。
 *
 * 历史背景：早期以为云服务强制「请求来源 == 应用发布域名」（精确 Origin 校验），
 * 桌面 WebView 的源 http://127.0.0.1:<port> 不在白名单内，因此只能由本页代劳。
 * 该前提在 2026-10-12 被实测推翻 —— 跨源预检对 127.0.0.1 放行，鉴权只看
 * X-Wb-Webapp-Access-Key + JWT + RLS，与 Origin 无关。
 *
 * 用法：桌面端「云端同步」面板带着 ?local=http://127.0.0.1:<port> 打开本页，
 * 本页去读本机那三个只读端点，再把内容传上云。
 *
 * 安全边界：本机 axum 只对本站域名开放 /api/workspaces、/api/files、/api/files/*path
 * 三个 GET 端点（见 handlers.rs::cloud_read_cors），写端点完全不开放 —— 这里读得到、改不了。
 */
const LOCAL_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})$/;

function localOrigin() {
  try {
    const raw = (new URLSearchParams(location.search).get("local") || "").replace(/\/+$/, "");
    if (!LOCAL_ORIGIN_RE.test(raw)) return null;
    const port = Number(RegExp.$1);
    return port >= 1 && port <= 65535 ? raw : null;
  } catch (_) {
    return null;
  }
}

const LOCAL_ORIGIN = localOrigin();

async function localGet(origin, path) {
  const res = await fetch(origin + path, { cache: "no-store" });
  if (!res.ok) throw new Error("本机接口 " + path + " 返回 HTTP " + res.status);
  return res.json();
}

/**
 * FileEntry 的字段是 **camelCase**（Rust 侧 `#[serde(rename_all = "camelCase")]`）：
 * `/api/files` 回的是 `workspaceId` / `contentSha256`。
 * 这里两种拼写都认 —— 写死 snake_case 会让过滤恒为空（「一键推送」直接早退报
 * 「本机工作区里没有 Markdown / 文本文件」），与桌面端 cloud-client.js 的 fWs/fSha 同一契约。
 */
function fWs(f) {
  return (f && (f.workspaceId ?? f.workspace_id)) || null;
}
function fSha(f) {
  return (f && (f.contentSha256 ?? f.content_sha256)) || null;
}

/** FileEntry.path 形如 "<workspace_id>/<相对路径>"，云端存的是相对路径。 */
function relFromRef(ref, wsId) {
  const p = normPath(ref);
  return p.startsWith(wsId + "/") ? p.slice(wsId.length + 1) : p;
}

/** 读取本机工作区与文件清单（不含正文）。 */
async function readLocalIndex(origin) {
  const wsRes = await localGet(origin, "/api/workspaces");
  const list = Array.isArray(wsRes && wsRes.workspaces) ? wsRes.workspaces : [];
  const def = list.find((w) => w.id === wsRes.defaultWorkspaceId) || list[0];
  if (!def) throw new Error("本机没有已加载的知识库工作区");
  const filesRes = await localGet(origin, "/api/files");
  const arr = Array.isArray(filesRes && filesRes.data)
    ? filesRes.data
    : (Array.isArray(filesRes) ? filesRes : []);
  // ⚠️ 必须用 fWs() 读工作区 id：写成 f.workspace_id 会恒为 undefined，
  // 过滤结果永远是空数组，「一键推送」就地早退。
  const md = arr.filter((f) => f && TEXT_EXT.test(String(f.path || "")) && fWs(f) === def.id);
  return { ws: def, files: md };
}

async function runLocalImport() {
  if (!LOCAL_ORIGIN) return;
  const btn = el.localImportBtn;
  const note = el.localImportNote;
  const setNote = (t) => { note.textContent = t; };
  btn.disabled = true;
  try {
    setNote("正在读取本机知识库索引…");
    const { ws, files } = await readLocalIndex(LOCAL_ORIGIN);
    el.localWsName.textContent = ws.name || "本机知识库";
    if (!files.length) {
      setNote("本机工作区里没有可同步的文档（.md / .txt / .html）。");
      return;
    }

    const cloudWs = el.wsName.value.trim() || ws.name || "我的知识库";
    el.wsName.value = cloudWs;
    setNote(`本机 ${files.length} 篇，正在与云端比对…`);

    // 先拿云端指纹：内容一致的连正文都不用读
    const { data: existing, error: exErr } = await cloud.database
      .from("documents").select("rel_path, content_sha").eq("workspace", cloudWs);
    if (exErr) {
      setNote("读取云端索引失败：" + (exErr.message || "未知错误"));
      return;
    }
    const have = new Map((existing || []).map((r) => [r.rel_path, r.content_sha]));

    const candidates = [];
    const scanned = [];        // 全部本机文档（含未变的）：图片引用必须逐篇扫
    let unchanged = 0;
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const rel = relFromRef(f.path, ws.id);
      if (!rel) continue;
      const enc = rel.split("/").map(encodeURIComponent).join("/");
      const res = await localGet(LOCAL_ORIGIN, "/api/files/" + enc);
      const entry = res && res.data ? res.data : res;
      const text = typeof entry.content === "string" ? entry.content : "";
      scanned.push({ rel, text });
      // 指纹同样走 fSha()：content_sha256 是 undefined，比对永远不命中 →
      // 每篇正文都会被重读、重传一遍。
      if (have.get(rel) && have.get(rel) === fSha(f)) { unchanged += 1; continue; }
      candidates.push({ relPath: rel, text, mtime: entry.modified || null });
      setNote(`读取本机内容…（${i + 1}/${files.length}，待上传 ${candidates.length} 篇）`);
    }

    // 图片要按「引用」读，而不是按文档是否变化 —— 见 collectLocalAssets 的说明
    setNote(`本机 ${files.length} 篇；正在核对引用的图片 / 视频…`);
    const assets = await collectLocalAssets(scanned, cloudWs, setNote);

    if (!candidates.length && !assets.length) {
      setNote(`已是最新：${files.length} 篇内容均与云端一致，引用的图片也已同步。`);
      return;
    }
    setNote(`待同步 ${candidates.length} 篇（内容未变 ${unchanged} 篇已跳过）、图片 / 视频 ${assets.length} 个，开始…`);
    closeSheet(win);
    await runUpload(candidates, assets, 0);
  } catch (err) {
    const msg = String((err && err.message) || err);
    setNote("读取本机失败：" + msg +
      "。请确认桌面端正在运行，并且本页面是在同一台电脑上打开的。");
  } finally {
    btn.disabled = false;
  }
}

if (LOCAL_ORIGIN) {
  el.localImport.hidden = false;
  el.localImportBtn.addEventListener("click", runLocalImport);
}

/* ══ 上传 ═══════════════════════════════════════════════════ */
const win = el.uploadSheet;
el.uploadBtn.addEventListener("click", () => {
  el.uploadResult.hidden = true;
  el.uploadProgress.hidden = true;
  el.wsName.value = el.wsName.value || commonWorkspaceDefault();
  openSheet(win);
});
el.pickFolderBtn.addEventListener("click", () => el.folderInput.click());
el.pickFilesBtn.addEventListener("click", () => el.filesInput.click());
el.folderInput.addEventListener("change", () => collectFromFileList(el.folderInput.files));
el.filesInput.addEventListener("change", () => collectFromFileList(el.filesInput.files));

["dragenter", "dragover"].forEach((ev) => el.dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); el.dropZone.classList.add("dragover");
}));
["dragleave", "drop"].forEach((ev) => el.dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); el.dropZone.classList.remove("dragover");
}));
el.dropZone.addEventListener("drop", async (e) => {
  const dt = e.dataTransfer;
  if (!dt) return;
  const entries = [];
  const items = dt.items ? [...dt.items] : [];
  const roots = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (roots.length) {
    for (const root of roots) await walkEntry(root, "", entries);
  } else {
    for (const f of dt.files) entries.push({ relPath: normPath(f.name), file: f });
  }
  handleEntries(entries);
});

function commonWorkspaceDefault() {
  if (state.docs.length) {
    const names = [...new Set(state.docs.map((d) => d.workspace))];
    if (names.length === 1) return names[0];
  }
  return "";
}

async function walkEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    const file = await new Promise((res) => entry.file(res, () => res(null)));
    if (file) out.push({ relPath: normPath(prefix + entry.name), file });
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries 每次最多返回 100 条，必须循环读到空
    for (;;) {
      const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      if (!batch || !batch.length) break;
      for (const child of batch) await walkEntry(child, prefix + entry.name + "/", out);
    }
  }
}

async function collectFromFileList(list) {
  const files = list ? [...list] : [];
  if (!files.length) return;
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    const unzipped = await readZip(files[0]);
    handleEntries(unzipped);
    return;
  }
  const entries = files.map((f) => {
    let rel = f.webkitRelativePath || f.name;
    rel = normPath(rel);
    // 选择文件夹时去掉最外层目录名，避免多一层无意义前缀
    const seg = rel.split("/");
    if (seg.length > 1) rel = seg.slice(1).join("/");
    return { relPath: rel, file: f };
  });
  handleEntries(entries);
}

async function readZip(file) {
  if (!window.fflate || !window.fflate.unzipSync) {
    toast("压缩包支持未加载（fflate 不可用）", "error");
    return [];
  }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const out = window.fflate.unzipSync(buf);
    const entries = [];
    for (const [rawName, bytes] of Object.entries(out)) {
      if (rawName.endsWith("/")) continue;
      if (SKIP_DIR.test(rawName)) continue;
      // 文本与图片/视频都要：压缩包是「把整个知识库连带 source/ 一起搬到手机」最省事的路径
      const isText = TEXT_EXT.test(rawName);
      if (!isText && !ASSET_EXT.test(rawName)) continue;
      let rel = normPath(rawName);
      const seg = rel.split("/");
      if (seg.length > 1) rel = seg.slice(1).join("/");
      // 文本直接解码；二进制保留字节，上传时包成 Blob
      entries.push(isText
        ? { relPath: rel, text: new TextDecoder().decode(bytes) }
        : { relPath: rel, bytes, size: bytes.byteLength });
    }
    return entries;
  } catch (err) {
    toast("压缩包解析失败：" + String(err && err.message || err), "error");
    return [];
  }
}

/** 把杂七杂八的条目分成「文本文档」与「图片/视频资源」两堆，顺带报出被忽略的数量。 */
function splitEntries(entries) {
  const docs = [];
  const assets = [];
  let ignored = 0;
  for (const e of entries || []) {
    const p = e && e.relPath ? e.relPath : "";
    if (!p || SKIP_DIR.test(p)) continue;
    if (TEXT_EXT.test(p)) docs.push(e);
    else if (ASSET_EXT.test(p)) assets.push(e);
    else ignored += 1;
  }
  return { docs, assets, ignored };
}

async function handleEntries(entries) {
  const { docs, assets, ignored } = splitEntries(entries);
  if (!docs.length && !assets.length) {
    el.uploadResult.textContent = ignored
      ? `选中的 ${ignored} 个文件都不是可同步的类型（支持 .md / .txt / .html 与常见图片、视频）`
      : "没有找到可同步的文件";
    el.uploadResult.hidden = false;
    return;
  }
  if (!el.wsName.value.trim()) {
    const first = (docs[0] || assets[0]).relPath.split("/")[0];
    const multi = docs.concat(assets).some((c) => c.relPath.includes("/"));
    el.wsName.value = first && multi ? first : "我的知识库";
    toast("已自动填写分区名：" + el.wsName.value);
  }
  await runUpload(docs, assets, ignored);
}

el.cancelUploadBtn.addEventListener("click", () => {
  if (state.upload) state.upload.cancelled = true;
  el.progressLabel.textContent = "正在取消…";
});

/**
 * 把图片 / 视频送进云存储。
 *
 * 增量判据用本地清单的「分区/相对路径 → 体积」：体积没变就跳过。
 * 文档有 content_sha 可以精确比对，存储端没有同样便宜的指纹接口，体积是成本最低的可用信号；
 * 代价是「同体积但内容变了」会漏传，对截图来说极少见，且用户重选一次文件夹即会重传。
 */
async function uploadAssets(job, ws, assets, setProgress) {
  const uid = state.session && state.session.user && state.session.user.id;
  if (!uid) { job.assetFailed += assets.length; return; }

  const todo = [];
  for (const a of assets) {
    if (job.cancelled) break;
    const rel = normPath(a.relPath);
    const size = Number(a.size != null ? a.size : (a.file ? a.file.size : 0));
    const obj = rel ? assetObjectPath(uid, ws, rel) : "";
    if (!obj) { job.assetFailed += 1; continue; }
    if (size > ASSET_MAX_BYTES) { job.assetTooBig += 1; continue; }
    if (state.assetManifest.get(assetManifestKey(ws, rel)) === size) {
      // 本地清单只记「传过没」，**云端才是事实源**：历史上传失败、换账号登录、
      // 对象被清掉，都会留下「清单说有、云端没有」的死记录 —— 只按清单跳过，
      // 这些图永远修不回来（手机 / 网页一直显示「未同步」）。这里补一次 HEAD 探针。
      let present = false;
      try { const r = await cloud.storage.exists(obj); present = !!(r && r.data); } catch (_) { /* 探针失败按缺失处理 */ }
      if (present) { job.assetSkipped += 1; continue; }
      // 确缺：清单命中时 collectLocalAssets 不会取字节，这里补取再上传
      if (!a.file && !a.bytes && a.relPath) {
        try {
          const got = await fetch(localAssetUrl(a.relPath), { cache: "no-store" });
          if (got && got.ok) {
            a.bytes = new Uint8Array(await got.arrayBuffer());
            a.size = a.bytes.byteLength;
          }
        } catch (_) { /* 下面按失败计 */ }
      }
      if (!a.file && !a.bytes) { job.assetFailed += 1; continue; }
    }
    todo.push({ entry: a, rel, size, obj });
  }
  if (!todo.length) return;

  let sent = 0;
  let batch = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const slice = batch.slice();
    batch = []; batchBytes = 0;
    // 每次 4 个并发：串行在手机上太慢，全量并发又容易被限流
    const results = await Promise.all(slice.map(async (t) => {
      try {
        const body = t.entry.file || new Blob([t.entry.bytes], { type: mimeOf(t.rel) });
        const { error } = await cloud.storage.upload(t.obj, body, {
          contentType: mimeOf(t.rel),
          upsert: true,
          cacheControl: "31536000",
        });
        return { t, ok: !error };
      } catch (_) { return { t, ok: false }; }
    }));
    for (const r of results) {
      sent += 1;
      if (r.ok) {
        job.assetSent += 1;
        state.assetManifest.set(assetManifestKey(ws, r.t.rel), r.t.size);
      } else {
        job.assetFailed += 1;
      }
    }
    setProgress(`同步图片 / 视频…（${sent}/${todo.length}）`, (sent / todo.length) * 35);
  };
  for (const t of todo) {
    if (job.cancelled) break;
    batch.push(t);
    batchBytes += Number(t.size) || 0;
    if (batch.length >= ASSET_CONCURRENCY || batchBytes >= ASSET_BATCH_BYTES) await flush();
  }
  if (!job.cancelled) await flush();
  if (job.assetSent) saveAssetManifest();
}

/**
 * 批量签发资源访问 URL。
 * 存储桶不对外暴露公开地址，读也必须带短期签名；签不出来的就是「云端没有这张对象」。
 * 结果按对象路径缓存到会话内存里，同一篇文档反复打开不会重复签。
 */
async function signAssets(paths) {
  const out = new Map();
  const now = Date.now();
  const need = [];
  for (const p of paths) {
    const hit = state.signedAssets.get(p);
    if (hit && hit.exp > now + 60_000) out.set(p, hit.url);
    else need.push(p);
  }
  if (!need.length) return out;

  const keep = (entries, fallback) => {
    (entries || []).forEach((e, i) => {
      const url = e && (e.signedUrl || e.signedURL);
      const p = (e && e.path) || fallback[i];
      if (url && p && !(e && e.error)) {
        out.set(p, url);
        state.signedAssets.set(p, { url, exp: now + SIGN_TTL * 1000 });
      }
    });
  };

  try {
    const { data, error } = await cloud.storage.createSignedUrls(need, SIGN_TTL);
    if (!error && Array.isArray(data)) { keep(data, need); return out; }
  } catch (_) { /* 落到逐个兜底 */ }

  for (const p of need.slice(0, SIGN_FALLBACK_MAX)) {
    try {
      const { data, error } = await cloud.storage.createSignedUrl(p, SIGN_TTL);
      if (!error) keep([data], [p]);
    } catch (_) { /* 该对象不存在 */ }
  }
  return out;
}

/** 图片确实不在云端时给一条可读的占位，而不是让用户对着一张裂图猜原因。 */
function markAssetMissing(node) {
  const holder = document.createElement("span");
  holder.className = "asset-missing";
  const label = node.getAttribute("alt") || String(node.getAttribute("src") || "").split("/").pop() || "媒体";
  const tag = document.createElement("span");
  tag.className = "asset-missing-tag";
  tag.textContent = "未同步";
  const name = document.createElement("span");
  name.className = "asset-missing-name";
  name.textContent = label;
  const path = document.createElement("span");
  path.className = "asset-missing-path";
  path.textContent = node.getAttribute("src") || "";
  holder.append(tag, name, path);
  node.replaceWith(holder);
}

/**
 * 文档渲染后，把 `source/x.webp` 这类本机相对引用换成云存储的签名地址。
 * 外链（http/data/blob）不属于本地资源，原样留给浏览器。
 */
async function resolveDocAssets(root, doc) {
  const nodes = [...root.querySelectorAll("img[src], video[src]")];
  if (!nodes.length) return;
  const uid = state.session && state.session.user && state.session.user.id;
  if (!uid) return;

  const ws = doc.workspace;
  const docRel = doc.rel_path || "";
  const items = [];
  const allPaths = new Set();
  for (const node of nodes) {
    const cands = assetRelCandidates(node.getAttribute("src") || "", docRel);
    if (!cands.length) continue;
    const paths = cands
      .map((rel) => ({ rel, obj: assetObjectPath(uid, ws, rel) }))
      .filter((x) => x.obj);
    if (!paths.length) continue;
    paths.forEach((x) => allPaths.add(x.obj));
    items.push({ node, paths });
  }
  if (!items.length) return;

  const signed = await signAssets([...allPaths]);
  for (const it of items) {
    const hit = it.paths.find((x) => signed.has(x.obj));
    if (!hit) { markAssetMissing(it.node); continue; }
    const url = signed.get(hit.obj);
    if (it.node.getAttribute("src") !== url) it.node.setAttribute("src", url);
    it.node.setAttribute("data-cloud-asset", hit.rel);
    // 签名地址是短期的，不要让浏览器把它写进磁盘缓存
    it.node.setAttribute("referrerpolicy", "no-referrer");
  }
}

async function runUpload(candidates, assets, ignoredCount) {
  const ws = el.wsName.value.trim() || "我的知识库";
  assets = assets || [];
  el.uploadResult.hidden = true;
  el.uploadProgress.hidden = false;
  el.progressFill.style.width = "0%";

  const job = {
    cancelled: false, done: 0, total: candidates.length, added: 0, updated: 0, skipped: 0, failed: 0,
    assetTotal: assets.length, assetSent: 0, assetSkipped: 0, assetFailed: 0, assetTooBig: 0, ignored: ignoredCount || 0,
  };
  state.upload = job;
  const setProgress = (label, pct) => {
    el.progressLabel.textContent = label;
    el.progressFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
  };
  setProgress(assets.length ? `准备文档与 ${assets.length} 个图片 / 视频…` : "读取文件…（0/0）", 0);

  try {
    // 0) 文档与资源是两条独立的链：先把图片送进云存储，文档正文随后。
    //    顺序不能反 —— 文档先入库的话，用户点开时图片还没到，会先看到一排「未同步」。
    if (assets.length) await uploadAssets(job, ws, assets, setProgress);
    if (job.cancelled) return finishUpload(job, "已取消（未写入任何内容）");

    // 1) 读取内容 + 内容指纹
    //    进度基准：图片已经在 0~35% 走完，文档再占 35~100%；没图片时文档从 0 开始。
    const base = assets.length ? 35 : 0;
    const prepared = [];
    for (let i = 0; i < candidates.length; i += 1) {
      if (job.cancelled) break;
      const c = candidates[i];
      const text = typeof c.text === "string" ? c.text : await c.file.text();
      const sha = await sha256Hex(text);
      prepared.push({
        rel_path: c.relPath,
        title: titleFrom(text, c.relPath),
        content: text,
        content_sha: sha,
        bytes: new TextEncoder().encode(text).length,
        doc_mtime: c.file ? (c.file.lastModified || null) : (c.mtime || null),
      });
      if (i % 10 === 0 || i === candidates.length - 1) {
        if (!job.total) break;
        setProgress(`读取文档…（${i + 1}/${job.total}）`, base + ((i + 1) / job.total) * 20);
      }
    }
    if (job.cancelled) return finishUpload(job, "已取消（未写入任何内容）");

    // 2) 拉取云端已有指纹，算出真正需要传的（只选图片时不查文档表）
    let todo = [];
    if (prepared.length) {
      const { data: existing, error: exErr } = await cloud.database
        .from("documents").select("rel_path, content_sha").eq("workspace", ws);
      if (exErr) return finishUpload(job, "读取云端索引失败：" + (exErr.message || ""), true);
      const have = new Map((existing || []).map((r) => [r.rel_path, r.content_sha]));

      todo = prepared.filter((p) => have.get(p.rel_path) !== p.content_sha);
      job.updated = prepared.filter((p) => have.has(p.rel_path) && have.get(p.rel_path) !== p.content_sha).length;
      job.added = prepared.length - job.updated;
      job.skipped = prepared.length - todo.length;
    }
    if (!todo.length && !job.assetSent) return finishUpload(job, null);

    // 3) 分批 upsert
    const nowIso = new Date().toISOString();
    let sent = 0;
    let batch = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const payload = batch.map((p) => ({
        workspace: ws,
        rel_path: p.rel_path,
        title: p.title,
        content: p.content,
        content_sha: p.content_sha,
        bytes: p.bytes,
        doc_mtime: p.doc_mtime,
        deleted_at: null,
        updated_at: nowIso,
      }));
      const { error } = await cloud.database
        .from("documents")
        .upsert(payload, { onConflict: "owner_id,workspace,rel_path" })
        .select("id");
      if (error) {
        job.failed += batch.length;
        console.warn("upload batch failed", error.code || "", error.message || "");
      }
      sent += batch.length;
      batch = []; batchBytes = 0;
      setProgress(`上传文档…（${sent}/${todo.length}）`, base + 20 + (sent / todo.length) * 40);
    };
    for (const p of todo) {
      if (job.cancelled) break;
      batch.push(p);
      batchBytes += p.bytes;
      if (batch.length >= UPSERT_BATCH_MAX_DOCS || batchBytes >= UPSERT_BATCH_MAX_BYTES) await flush();
    }
    if (!job.cancelled) await flush();

    // 4) 写同步摘要（best-effort，失败不影响正文同步；同样以 .select() 读回判定是否真的写入）
    try {
      const { data: meta, error: metaErr } = await cloud.database.from("kb_meta").upsert({
        display_name: null,
        last_sync_at: nowIso,
        doc_count: state.docs.length + todo.length,
        client_ver: "cloud-1",
      }, { onConflict: "owner_id" }).select("last_sync_at");
      if (metaErr || !Array.isArray(meta) || meta.length === 0) {
        console.warn("kb_meta 摘要未写入（不影响正文同步）");
      }
    } catch (_) { /* 同上 */ }

    finishUpload(job, job.cancelled ? "已取消" : null);
  } catch (err) {
    finishUpload(job, String(err && err.message || err), true);
  }
}

function finishUpload(job, note, isError) {
  state.upload = null;
  const parts = [];
  if (job.added) parts.push(`新增 ${job.added} 篇`);
  if (job.updated) parts.push(`更新 ${job.updated} 篇`);
  if (job.skipped) parts.push(`跳过未变 ${job.skipped} 篇`);
  if (job.assetSent) parts.push(`图片 / 视频 ${job.assetSent} 个`);
  if (job.assetSkipped) parts.push(`图片未变 ${job.assetSkipped} 个`);
  if (job.failed) parts.push(`失败 ${job.failed} 篇`);
  if (job.assetFailed) parts.push(`图片失败 ${job.assetFailed} 个`);
  if (job.assetTooBig) parts.push(`超大跳过 ${job.assetTooBig} 个`);
  const summary = parts.length ? parts.join("，") : "没有需要传输的内容";

  // 被忽略的文件类型要单独说一句：静默丢弃会让人以为「传成功了」
  const warns = [];
  if (job.assetTooBig) warns.push(`有 ${job.assetTooBig} 个文件超过 ${Math.round(ASSET_MAX_BYTES / 1024 / 1024)}MB 未上传`);
  if (job.assetFailed) warns.push(`有 ${job.assetFailed} 个图片 / 视频上传失败，可重试`);
  if (job.failed) warns.push(`有 ${job.failed} 篇文档未成功，可稍后重试`);
  if (job.ignored) warns.push(`忽略了 ${job.ignored} 个不支持的文件`);

  el.progressFill.style.width = "100%";
  el.progressLabel.textContent = note || summary;
  const detail = note || warns.length ? [note ? note + "。" : "", warns.join("；"), warns.length ? "。" : ""].join("") : "";
  if (detail) {
    el.uploadResult.textContent = detail;
    el.uploadResult.hidden = false;
  }
  toast(note || summary, isError ? "error" : undefined);
  if (!job.cancelled) setTimeout(() => { el.uploadProgress.hidden = true; }, 1500);
  loadDocs();
}

/* ══ 管理 ═══════════════════════════════════════════════════ */
el.manageBtn.addEventListener("click", () => {
  renderWsList();
  openSheet(el.manageSheet);
});

function renderWsList() {
  const groups = groupByWorkspace(state.docs);
  if (!groups.size) {
    el.wsList.innerHTML = `<p class="muted">云端暂无内容。</p>`;
    return;
  }
  el.wsList.innerHTML = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh")).map(([ws, rows]) => {
    const bytes = rows.reduce((s, d) => s + (Number(d.bytes) || 0), 0);
    return `<div class="ws-row">
      <div class="ws-row-main"><span class="ws-row-name">${escapeHtml(ws)}</span>
      <span class="muted">${rows.length} 篇 · ${fmtBytes(bytes)}</span></div>
      <button class="ghost-btn" type="button" data-del-ws="${escapeHtml(ws)}">删除分区</button>
    </div>`;
  }).join("");
}

el.wsList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del-ws]");
  if (!btn) return;
  const ws = btn.getAttribute("data-del-ws");
  const n = state.docs.filter((d) => d.workspace === ws).length;
  const ok = await askConfirm(`删除分区「${ws}」的 ${n} 篇云端副本？本地原始文件不受影响。`);
  if (!ok) return;
  const { data, error } = await cloud.database.from("documents").delete().eq("workspace", ws).select("id");
  if (error || !Array.isArray(data) || data.length === 0) { toast("删除失败或没有权限", "error"); return; }
  state.docs = state.docs.filter((d) => d.workspace !== ws);
  // 分区里的图片也被一并删掉了吗？没有 —— 这里删的只是文档行。
  // 但用户的心智是「这个分区清空了」，所以把该分区的上传清单一起作废，下次重传一遍最稳妥。
  forgetAssetManifest(ws);
  toast(`已删除 ${data.length} 篇云端副本`);
  renderWsList(); renderTree(); renderStats();
});

el.clearAllBtn.addEventListener("click", async () => {
  const n = state.docs.length;
  const ok = await askConfirm(`清空你的全部云端副本（${n} 篇）？此操作不可撤销，但不会影响本地文件。`);
  if (!ok) return;
  const { data, error } = await cloud.database.from("documents").delete().not("id", "is", null).select("id");
  if (error || !Array.isArray(data)) { toast("清空失败：" + (error ? error.message : "未知错误"), "error"); return; }
  state.docs = [];
  state.assetManifest = new Map(); saveAssetManifest();
  toast(`已清空 ${data.length} 篇云端副本`);
  closeSheet(el.manageSheet);
  renderWsList(); renderTree(); renderStats();
});

/* ══ 分享链接（只读快照 + 匿名可读）═══════════════════════════
 * 过去分享是把正文纯文本丢进系统面板：微信里是一大段没有格式、没有出处、
 * 图片全丢的文字。现在改成生成一条**只读快照**并分享链接 —— 访客点开就是
 * 渲染好的移动端页面，带三处官网品牌水印。
 *
 * 为什么必须做快照、而不是让访客直接读原表：
 *   1) `documents` 是 owner-only RLS，微信访客没有账号，一行都读不到；
 *   2) 云存储也不对匿名开放 —— 官方明确「Storage is for signed-in users.
 *      Public Bucket/public URL access is not exposed.」，实测各路由无凭据
 *      返回 MISSING_CREDENTIALS。所以图片字节只能**随快照一起**落在匿名可读的
 *      `shared_assets` 里（base64），不能存地址。
 * 实测：匿名读 shared_docs / shared_assets 均 HTTP 200；把 revoked 置 true 后
 * 两张表立刻都返回空 —— 这正是「永久有效 + 可随时撤销」依赖的机制。
 * ------------------------------------------------------------------------- */
const SHARE_PATH = "share.html";
/** 单篇最多带走的图片数。再多就该直接给原文了，硬塞只会拖慢首屏。 */
const SHARE_ASSET_MAX = 20;
/** 原图小于此值就原样带上：不做二次转码，截图上的小字才不会被转糊。 */
const SHARE_ASSET_KEEP_BYTES = 260 * 1024;
/** 压缩后仍大于此值的图放弃带走（页面显示占位，不静默丢）。 */
const SHARE_ASSET_MAX_BYTES = 420 * 1024;
/** 压缩目标：移动端阅读分辨率，再宽是浪费流量。 */
const SHARE_MAX_WIDTH = 1080;
const SHARE_QUALITY = 0.72;
/** 分享页不带视频：体积不可控，微信里多半也是跳转播放。 */
const SHARE_VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;

function newShareId() {
  const b = new Uint8Array(9);
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    window.crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("");
}

/** 分享链接用当前站点域名：分享页就部署在同一个源下，不引外部域名。 */
function shareLink(id) {
  const base = (location.origin || CFG.endpoint || "").replace(/\/+$/, "");
  return `${base}/${SHARE_PATH}?d=${id}`;
}

function bytesToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let out = "";
  const CHUNK = 0x8000; // 分块，避免 apply 参数过多爆栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/**
 * 把一张图处理成可内联的 base64。
 * 小图**原样保留**（不重编码）—— 既保清晰度，也省掉 canvas 往返。
 * 大图等比缩到 SHARE_MAX_WIDTH 并转 WebP；仍超限返回 null，交给调用方放弃。
 */
async function shrinkImageForShare(blob, fallbackMime) {
  const mime = blob.type || fallbackMime || "image/png";
  if (!/^image\//i.test(mime)) return null;
  if (blob.size <= SHARE_ASSET_KEEP_BYTES) {
    return { mime, b64: bytesToBase64(await blob.arrayBuffer()) };
  }
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, SHARE_MAX_WIDTH / (bmp.width || 1));
    const w = Math.max(1, Math.round((bmp.width || 1) * scale));
    const h = Math.max(1, Math.round((bmp.height || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const out = await new Promise((r) => canvas.toBlob(r, "image/webp", SHARE_QUALITY));
    if (!out || out.size > SHARE_ASSET_MAX_BYTES) return null;
    return { mime: "image/webp", b64: bytesToBase64(await out.arrayBuffer()) };
  } catch (_) {
    return null;
  }
}

/**
 * 收集这篇笔记引用的图片并压好。
 * 与上传侧同一套引用解析（extractAssetRefs + assetRelCandidates），
 * 「笔记里写了什么」与「分享时带走什么」不会出现两套判据。
 */
async function collectShareAssets(doc) {
  const uid = state.session && state.session.user && state.session.user.id;
  const result = { assets: [], missing: 0, tooBig: 0 };
  const groups = [];
  const allPaths = new Set();
  for (const ref of extractAssetRefs(doc.content || "")) {
    if (groups.length >= SHARE_ASSET_MAX) break;
    const metas = assetRelCandidates(ref, doc.rel_path || "")
      .filter((p) => ASSET_EXT.test(p) && !SHARE_VIDEO_EXT.test(p))
      .map((rel) => ({ rel, obj: assetObjectPath(uid, doc.workspace, rel) }))
      .filter((x) => x.obj);
    if (!metas.length) continue;
    metas.forEach((m) => allPaths.add(m.obj));
    groups.push(metas);
  }
  if (!groups.length) return result;

  const signed = await signAssets([...allPaths]);
  for (const metas of groups) {
    const hit = metas.find((m) => signed.has(m.obj));
    if (!hit) { result.missing += 1; continue; }
    let blob = null;
    try {
      const res = await fetch(signed.get(hit.obj), { cache: "no-store", referrerPolicy: "no-referrer" });
      if (res.ok) blob = await res.blob();
    } catch (_) { /* 下面统一按 missing 计 */ }
    if (!blob) { result.missing += 1; continue; }
    const shrunk = await shrinkImageForShare(blob, mimeOf(hit.rel));
    if (!shrunk) { result.tooBig += 1; continue; }
    result.assets.push({ rel_path: hit.rel, mime: shrunk.mime, bytes_b64: shrunk.b64 });
  }
  return result;
}

/** 写一条分享快照。同一篇已有未撤销的分享就**复用并刷新**，避免点一次多一条链接。 */
async function writeShare(doc, content, assets) {
  const db = cloud.database;
  const rel = doc.rel_path || "";
  const row = {
    workspace: doc.workspace,
    rel_path: rel,
    title: doc.title || rel.split("/").pop() || "笔记",
    content,
    asset_count: assets.length,
    owner_name: (state.session && state.session.user && state.session.user.name) || null,
  };

  let id = null;
  try {
    const found = await db.from("shared_docs").select("id")
      .eq("workspace", doc.workspace).eq("rel_path", rel).eq("revoked", false).limit(1);
    if (!found.error && found.data && found.data.length) id = found.data[0].id;
  } catch (_) { /* 查不到就新建 */ }

  if (id) {
    const up = await db.from("shared_docs").update(row).eq("id", id).select();
    if (up.error) throw up.error;
    // 覆盖式刷新：先清旧图再插新的，否则刚删掉的图会一直留在分享里
    await db.from("shared_assets").delete().eq("share_id", id).select("rel_path");
  } else {
    id = newShareId();
    const ins = await db.from("shared_docs").insert(Object.assign({ id }, row)).select();
    if (ins.error) throw ins.error;
    // 写操作必须读回：返回空数组说明被 RLS 拦了，不能当成功（历史踩过的坑）
    if (!ins.data || !ins.data.length) throw new Error("分享没有写进云端（可能被权限拦下）");
  }

  if (assets.length) {
    const ins2 = await db.from("shared_assets")
      .insert(assets.map((a) => Object.assign({ share_id: id }, a))).select("share_id");
    if (ins2.error) throw ins2.error;
  }
  return id;
}

async function readMyShares() {
  const res = await cloud.database.from("shared_docs")
    .select("id,title,workspace,rel_path,created_at,asset_count")
    .eq("revoked", false).order("created_at", { ascending: false }).limit(50);
  if (res.error) throw res.error;
  return res.data || [];
}

async function revokeShare(id) {
  const res = await cloud.database.from("shared_docs")
    .update({ revoked: true }).eq("id", id).select("id");
  if (res.error) throw res.error;
  // 读回为空 = 没撤成（被 RLS 拦下或不是自己的），不能报成功
  if (!res.data || !res.data.length) throw new Error("撤销没有生效");
}

function shareErrMsg(err) {
  return String((err && (err.message || err.error_description)) || err || "未知错误");
}

/** 「我的分享」抽屉：列出未撤销的分享，可复制链接 / 撤销 */
async function openShareSheet() {
  el.shareSheet.hidden = false;
  el.shareList.innerHTML = '<p class="muted">正在读取…</p>';
  try {
    const rows = await readMyShares();
    if (!rows.length) {
      el.shareList.innerHTML = '<p class="muted">还没有分享出去的笔记。在阅读页点「分享链接」即可生成。</p>';
      return;
    }
    el.shareList.innerHTML = rows.map((r) => {
      const where = [r.workspace, r.rel_path].filter(Boolean).join(" / ");
      const imgs = r.asset_count ? ` · ${r.asset_count} 张图` : "";
      return `<div class="share-item" data-share="${escapeHtml(r.id)}">
        <div class="share-item-main">
          <strong class="share-item-title">${escapeHtml(r.title || "（无标题）")}</strong>
          <span class="share-item-meta">${escapeHtml(where)} · ${escapeHtml(fmtTime(r.created_at))}${imgs}</span>
        </div>
        <div class="share-item-actions">
          <button class="link-btn" type="button" data-share-act="copy">复制链接</button>
          <button class="link-btn danger-link" type="button" data-share-act="revoke">撤销</button>
        </div>
      </div>`;
    }).join("");
  } catch (err) {
    el.shareList.innerHTML = `<p class="muted">读取失败：${escapeHtml(shareErrMsg(err))}</p>`;
  }
}

if (el.shareSheet) {
  el.shareSheet.addEventListener("click", async (e) => {
    if (e.target.closest("[data-close-sheet]")) { el.shareSheet.hidden = true; return; }
    const btn = e.target.closest("[data-share-act]");
    if (!btn) return;
    const item = btn.closest("[data-share]");
    const id = item && item.dataset.share;
    if (!id) return;
    if (btn.dataset.shareAct === "copy") {
      const url = shareLink(id);
      try {
        if (CAP.Clipboard) await CAP.Clipboard.write({ string: url });
        else if (navigator.clipboard) await navigator.clipboard.writeText(url);
        else { toast("当前环境不支持复制，链接：" + url); return; }
        toast("链接已复制");
      } catch (_) { toast("复制失败，链接：" + url, "error"); }
      return;
    }
    if (btn.dataset.shareAct === "revoke") {
      const ok = await askConfirm("撤销这条分享？访客会立刻打不开，链接里的图片也一并不可读。");
      if (!ok) return;
      btn.disabled = true;
      try {
        await revokeShare(id);
        item.remove();
        toast("已撤销");
      } catch (err) {
        btn.disabled = false;
        toast("撤销失败：" + shareErrMsg(err), "error");
      }
    }
  });
}

/* ══ 原生能力（Android App）═══════════════════════════════════
 *
 * 本页同时服务浏览器与 APK 的 WebView（APK 用 server.url 远程加载本页），
 * 所以原生能力一律做成**渐进增强**：只有 Capacitor 判定为原生时才挂行为，
 * 浏览器里一个字节都不变 —— 这就是「APK 功能完善 + 网页版界面不变」的做法，
 * 也避免了维护第二套 UI。
 *
 * 判定用 isNativePlatform()（Capacitor 官方语义），不解析 UA：UA 可被伪造。
 * ------------------------------------------------------------------------- */
const NATIVE = !!(window.Capacitor
  && typeof window.Capacitor.isNativePlatform === "function"
  && window.Capacitor.isNativePlatform());
const CAP = (NATIVE && window.Capacitor.Plugins) || {};

/**
 * 关掉最上层的弹层；确认框要走它自己的取消按钮，否则 askConfirm 的 Promise
 * 永远不 resolve（返回键处理里很容易踩到）。
 */
function closeTopSheet() {
  if (el.confirmSheet && !el.confirmSheet.hidden) { el.confirmCancel.click(); return true; }
  for (const sheet of [el.uploadSheet, el.manageSheet]) {
    if (sheet && !sheet.hidden) { closeSheet(sheet); return true; }
  }
  return false;
}

/** 文件名里去掉路径分隔符等在手机上非法的字符。 */
function safeFileName(name) {
  return String(name || "note").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "note";
}

if (NATIVE) {
  if (el.nativeActions) el.nativeActions.hidden = false;

  // ── 启动屏 ────────────────────────────────────────────────
  // apk/capacitor.config.json：SplashScreen.launchAutoHide = true +
  // launchShowDuration = 5000。系统启动屏（纯色底 + 居中品牌方牌）会一直盖着，
  // 直到**首个视图真正渲染出来**（show() 首次调用）才收起 —— 首帧内容是从网络
  // 加载的远程页，样式未到就被系统收屏，会留下「系统图标 + 未套样式首帧」叠在
  // 一起的错乱第一屏（2026-10-13 实机截图）。
  // 这里 5000ms 与原生 launchShowDuration 对齐，是**双保险**；之所以不去用
  // launchAutoHide = false（那样更纯粹），是因为一旦远程页完全加载失败（无网络
  // 时连 offline.html 都进不来），没人能再调 hide()，App 会永久卡在启动屏只能强杀 ——
  // 宁可多显示一会儿启动屏，也不能出现「打不开」。
  let splashHidden = false;
  window.__mtRevealSplash = () => {
    if (splashHidden) return;
    splashHidden = true;
    if (CAP.SplashScreen && typeof CAP.SplashScreen.hide === "function") {
      Promise.resolve(CAP.SplashScreen.hide()).catch(() => { /* 插件未就绪时忽略 */ });
    }
  };
  setTimeout(() => { if (window.__mtRevealSplash) window.__mtRevealSplash(); }, 5000);

  // 0) 微信登录在 APK 里不可用：OAuth 网页扫码流程要求「用另一台设备的微信
  //    扫当前屏幕上的二维码」，手机上就是自己扫自己，走不通。隐藏入口与
  //    分隔线，避免给出死路（邮箱 / 手机验证码在 APK 里完全可用）。
  if (el.wechatBtn) el.wechatBtn.hidden = true;
  const wechatDivider = el.wechatBtn && el.wechatBtn.previousElementSibling;
  if (wechatDivider && wechatDivider.classList.contains("or")) wechatDivider.hidden = true;

  // 1) 状态栏配色跟随页面主题（浅色主题深色字，深色主题浅色字）
  if (CAP.StatusBar) {
    const applyStatusBar = () => {
      const dark = isDark();
      Promise.resolve(CAP.StatusBar.setBackgroundColor({ color: dark ? "#12100e" : "#f6f4ef" })).catch(() => {});
      Promise.resolve(CAP.StatusBar.setStyle({ style: dark ? "DARK" : "LIGHT" })).catch(() => {});
    };
    applyStatusBar();
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyStatusBar);
    } catch (_) { /* 老 WebView 没有 addEventListener on MediaQueryList */ }
  }

  // 2) Android 物理返回键：先关弹层，再退出文档，最后才允许退出应用
  if (CAP.App && typeof CAP.App.addListener === "function") {
    CAP.App.addListener("backButton", () => {
      if (closeTopSheet()) return;
      if (el.views && !el.views.doc.hidden) { backToList(); return; }
      CAP.App.exitApp();
    });
  }

  // 3) 网络状态：断网时顶部提示条（不阻塞阅读 —— 已打开的正文就在内存里）
  if (CAP.Network && typeof CAP.Network.addListener === "function") {
    const setOffline = (offline) => { if (el.offlineBar) el.offlineBar.hidden = !offline; };
    Promise.resolve(CAP.Network.getStatus()).then((s) => setOffline(!(s && s.connected))).catch(() => {});
    CAP.Network.addListener("networkStatusChange", (s) => setOffline(!(s && s.connected)));
  }

  // 4) 文档动作条：分享 / 复制 / 导出 .md
  if (el.nativeActions) {
    el.nativeActions.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-native]");
      if (!btn) return;
      const act = btn.dataset.native;
      const title = el.docTitle.textContent || "笔记";
      const text = state.docSource || "";
      if (!text) { toast("这篇还没有内容可操作", "error"); return; }

      if (act === "share") {
        // 分享的是**链接**，不是正文纯文本：访客点开即渲染好（带官网水印）。
        const doc = state.docs.find((d) => String(d.id) === String(state.currentId));
        if (!doc) { toast("没找到这篇的元信息，请重新打开一次", "error"); return; }
        if (!state.session) { toast("请先登录后再分享", "error"); return; }
        btn.disabled = true;
        try {
          const picked = await collectShareAssets(Object.assign({}, doc, { content: text }));
          const id = await writeShare(doc, text, picked.assets);
          const url = shareLink(id);
          const parts = [];
          if (picked.assets.length) parts.push(`${picked.assets.length} 张图`);
          if (picked.missing) parts.push(`${picked.missing} 张未同步`);
          if (picked.tooBig) parts.push(`${picked.tooBig} 张过大未带走`);
          const tail = parts.length ? `（${parts.join("，")}）` : "";
          if (CAP.Share) {
            await CAP.Share.share({
              title: `${doc.title || "笔记"} · MyTemple 知识库`,
              text: `用 MyTemple 知识库分享的笔记：${doc.title || ""}`,
              url,
              dialogTitle: "分享到",
            });
            toast("分享链接已生成" + tail);
          } else if (CAP.Clipboard) {
            await CAP.Clipboard.write({ string: url });
            toast("分享链接已复制" + tail);
          } else {
            toast("链接：" + url);
          }
        } catch (err) {
          toast("生成分享链接失败：" + shareErrMsg(err), "error");
        } finally {
          btn.disabled = false;
        }
        return;
      }

      if (act === "shares") {
        openShareSheet();
        return;
      }

      if (act === "copy") {
        if (!CAP.Clipboard) { toast("当前环境不支持复制", "error"); return; }
        try {
          await CAP.Clipboard.write({ string: text });
          toast("正文已复制");
        } catch (_) { toast("复制失败", "error"); }
        return;
      }

      if (act === "export") {
        if (!CAP.Filesystem) { toast("当前环境不支持导出", "error"); return; }
        try {
          // 独立 HTML 文档按 .html 导出（沿用原文后缀），Markdown 笔记仍按 .md ——
          // 否则导出的 .md 里装着一整页 HTML，任何编辑器都打不开。
          const cur = state.docs.find((d) => String(d.id) === String(state.currentId));
          const ext = HTML_DOC_EXT.test((cur && cur.rel_path) || "") ? ".html" : ".md";
          const name = safeFileName(title) + ext;
          // Directory.Documents 在 Android 上落在应用专属目录（无需存储权限）
          await CAP.Filesystem.writeFile({
            path: name, data: text, directory: "DOCUMENTS", encoding: "utf8", recursive: true,
          });
          toast("已导出到「文档」：" + name);
        } catch (err) {
          toast("导出失败：" + String((err && err.message) || err), "error");
        }
        return;
      }
    });
  }
}

/* ══ 启动 ═══════════════════════════════════════════════════ */
async function enterApp() {
  const { data: session, error } = await cloud.auth.getSession();
  if (error || !session) { show("login"); return; }
  state.session = session;
  el.whoami.textContent = maskIdentity(session.user);
  show("list");
  await loadDocs();
}

async function boot() {
  show("boot");
  loadAssetManifest();
  try {
    initClient();
  } catch (err) {
    show("login");
    loginError(String(err && err.message || err));
    return;
  }

  // 微信回调必须在任何路由守卫之前、无条件执行（code 是一次性的）
  try {
    if (typeof cloud.auth.handleWechatWebCallback === "function") {
      const r = await cloud.auth.handleWechatWebCallback();
      if (r && r.error) loginError(r.error.message || "微信登录失败");
      else if (r && r.data) history.replaceState(null, "", location.pathname);
    }
  } catch (_) { /* 无 code 时视为普通访问 */ }

  try {
    const { data: session } = await cloud.auth.getSession();
    if (session) { await enterApp(); return; }
  } catch (_) {}
  show("login");

  try {
    cloud.auth.onAuthStateChange((evt, session) => {
      if (evt === "SIGNED_OUT") {
        state.session = null; state.docs = [];
        state.signedAssets.clear(); state.assetManifest = new Map(); saveAssetManifest();
        show("login");
      } else if (session && !state.session) {
        enterApp();
      }
    });
  } catch (_) {}
}

boot();
