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
const TEXT_EXT = /\.(md|markdown|mdown|mkd|txt)$/i;
const UPSERT_BATCH_MAX_DOCS = 20;
const UPSERT_BATCH_MAX_BYTES = 1_200_000;

/* 静态资源版本戳：改动 cloud/ 下被页面引用的任何文件时，与 index.html 的三件套一起递增。 */
const ASSET_V = "cloud-6";

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
  tabEmail: $("tabEmail"), tabPhone: $("tabPhone"),
  emailForm: $("emailForm"), email: $("email"), emailFieldError: $("emailFieldError"),
  emailCodeField: $("emailCodeField"),
  emailCode: $("emailCode"), sendEmailCodeBtn: $("sendEmailCodeBtn"),
  emailPasswordField: $("emailPasswordField"), emailPasswordLabel: $("emailPasswordLabel"),
  emailPassword: $("emailPassword"), emailPasswordHint: $("emailPasswordHint"), emailSubmit: $("emailSubmit"),
  emailPasswordLogin: $("emailPasswordLogin"), forgotBtn: $("forgotBtn"),
  resetHint: $("resetHint"), emailError: $("emailError"),
  phoneForm: $("phoneForm"), phone: $("phone"), phoneError: $("phoneError"),
  code: $("code"), sendCodeBtn: $("sendCodeBtn"), passwordField: $("passwordField"),
  signupPassword: $("signupPassword"), loginSubmit: $("loginSubmit"), loginError: $("loginError"),
  wechatBtn: $("wechatBtn"),
  q: $("q"), clearQ: $("clearQ"), uploadBtn: $("uploadBtn"), refreshBtn: $("refreshBtn"),
  manageBtn: $("manageBtn"), stats: $("stats"), tree: $("tree"), searchResults: $("searchResults"),
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
  loginTab: "email",
  upload: null,       // { cancelled, done, total }
  searchToken: 0,
  docSource: "",      // 当前打开的文档原文（原生端分享/导出要用）
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
}
el.tabEmail.addEventListener("click", () => setLoginTab("email"));
el.tabPhone.addEventListener("click", () => setLoginTab("phone"));
setLoginTab(state.loginTab);

/* ── 邮箱：验证码（主路径）/ 密码登录 / 找回密码 ─────────────── */

function emailLoginContext() {
  return {
    email: el.email.value.trim(),
    code: el.emailCode.value.trim(),
    password: el.emailPassword.value,
  };
}

/**
 * 邮箱登录的三种界面形态（互斥呈现，解决「验证码 + 密码 + 找回」三套控件
 * 同时摊开、看不出哪条是主路径的问题）：
 *   otp      —— 主路径：只露「邮箱 + 验证码」；仅当发码后确认是新邮箱，
 *               才把「设置密码」补出来（注册必需）。
 *   password —— 密码登录：验证码整行隐藏，提交按钮变「登录」。
 *   reset    —— 找回密码：验证码 + 新密码，提交按钮变「确认重置密码」，
 *               两个次级链接都收起，防误入其它流程。
 */
function applyEmailMode() {
  const reset = state.emailFlow === "reset";
  const mode = reset ? "reset" : state.emailMode;
  const otp = mode === "otp";
  el.emailCodeField.hidden = mode === "password";
  const newUserPending = !!(state.pendingEmailOtp && !state.pendingEmailOtp.isExistingUser);
  const pwdVisible = !otp || mode === "password" || reset || newUserPending;
  el.emailPasswordField.hidden = !pwdVisible;
  el.emailPasswordLabel.textContent = reset ? "新密码" : (otp ? "设置密码" : "密码");
  el.emailPasswordHint.hidden = !(otp && newUserPending);
  if (!el.emailPasswordHint.hidden) {
    el.emailPasswordHint.textContent = "首次注册，设置密码（至少 8 位）后，以后可在新设备上用密码登录。";
  }
  el.emailPassword.autocomplete = mode === "password" ? "current-password" : "new-password";
  el.emailSubmit.textContent = reset ? "确认重置密码" : (mode === "password" ? "登录" : "登录 / 注册");
  el.emailPasswordLogin.textContent = mode === "password" ? "改用验证码登录" : "用密码登录";
  el.forgotBtn.hidden = reset;
  el.resetHint.hidden = !reset;
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
    toast(sent.data.isExistingUser ? "验证码已发送到邮箱" : "验证码已发送，新邮箱需设置密码");
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
    emailError("首次注册需要设置密码（至少 8 位）");
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

/* 次级链接只负责切换形态（password ↔ otp），真正的提交统一走表单按钮 */
el.emailPasswordLogin.addEventListener("click", () => {
  if (state.emailFlow === "reset") return;
  state.emailMode = state.emailMode === "password" ? "otp" : "password";
  emailError("");
  setEmailFieldError("");
  applyEmailMode();
});

el.emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  emailError("");
  el.emailSubmit.disabled = true;
  try {
    if (state.emailFlow === "reset") await submitEmailReset();
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
    // 新用户必须设置密码（SDK 契约），只在此时露出密码框
    el.passwordField.hidden = Boolean(sent.data.isExistingUser);
    startCountdown(el.sendCodeBtn);
    toast("验证码已发送");
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
    loginError("首次登录需要设置密码（至少 8 位）");
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
  resetEmailFlow();
  el.tree.innerHTML = ""; el.searchResults.innerHTML = "";
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
  renderTree();
  renderStats();
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

function docLeaf(d) {
  const name = String(d.rel_path).split("/").pop();
  return `<li class="doc-item"><button class="doc-link" type="button" data-id="${d.id}">
    <span class="doc-name">${escapeHtml(d.title || name)}</span>
    <span class="doc-sub">${escapeHtml(name)} · ${fmtBytes(d.bytes)}</span>
  </button></li>`;
}

function buildTreeHtml(docs) {
  const groups = groupByWorkspace(docs);
  const out = [];
  const recent = [...docs].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).slice(0, 8);
  if (recent.length > 1) {
    out.push(`<details class="ws" open><summary class="ws-summary"><span class="ws-name">最近更新</span><span class="ws-count">${recent.length}</span></summary>
      <ul class="doc-list">${recent.map(docLeaf).join("")}</ul></details>`);
  }
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
  el.tree.innerHTML = buildTreeHtml(state.docs);
}

/* ── 搜索：本地标题/路径即时筛 + 云端正文 ilike 补充 ────────── */
let searchTimer = null;
el.q.addEventListener("input", () => {
  const v = el.q.value.trim();
  el.clearQ.hidden = !v;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(v), 280);
});
el.clearQ.addEventListener("click", () => {
  el.q.value = ""; el.clearQ.hidden = true;
  el.searchResults.hidden = true; el.tree.hidden = false;
  el.searchResults.innerHTML = "";
});

async function runSearch(q) {
  if (!q) { el.searchResults.hidden = true; el.tree.hidden = false; return; }
  const token = ++state.searchToken;
  const lc = q.toLowerCase();
  const local = state.docs.filter((d) =>
    String(d.title || "").toLowerCase().includes(lc) || String(d.rel_path).toLowerCase().includes(lc));

  let remote = [];
  if (q.length >= 2) {
    try {
      const { data, error } = await cloud.database
        .from("documents")
        .select("id, workspace, rel_path, title, bytes, updated_at")
        .is("deleted_at", null)
        .ilike("content", `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`)
        .limit(80);
      if (!error && Array.isArray(data)) remote = data;
    } catch (_) { /* 正文检索失败时仍展示本地命中 */ }
  }
  if (token !== state.searchToken) return;

  const seen = new Set();
  const merged = [];
  for (const d of [...local, ...remote]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id); merged.push(d);
  }
  el.tree.hidden = true;
  el.searchResults.hidden = false;
  if (!merged.length) {
    el.searchResults.innerHTML = `<p class="empty-inline muted">没有匹配「${escapeHtml(q)}」的内容</p>`;
    return;
  }
  el.searchResults.innerHTML = `<p class="result-head muted">${merged.length} 条结果</p>`
    + `<ul class="doc-list">${merged.map(docLeaf).join("")}</ul>`;
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
}

async function openDoc(id) {
  state.currentId = id;
  const meta = state.docs.find((d) => String(d.id) === String(id));
  el.docTitle.textContent = meta ? (meta.title || meta.rel_path) : "加载中…";
  el.docPath.textContent = meta ? `${meta.workspace} / ${meta.rel_path}` : "";
  el.docBody.innerHTML = `<div class="doc-loading"><div class="spinner"></div></div>`;
  show("doc");
  window.scrollTo(0, 0);

  const { data, error } = await cloud.database
    .from("documents").select("id, title, rel_path, workspace, content, bytes, updated_at")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  if (error || !data) {
    state.docSource = "";
    el.docBody.innerHTML = `<p class="muted">读取失败：${escapeHtml(error ? (error.message || "未知错误") : "文档不存在")}</p>`;
    return;
  }
  el.docTitle.textContent = data.title || data.rel_path;
  el.docPath.textContent = `${data.workspace} / ${data.rel_path} · ${fmtTime(data.updated_at)}`;
  state.docSource = data.content || "";
  try {
    const html = await renderMarkdownInWorker(data.content || "");
    el.docBody.innerHTML = html;
    await decorateContent(el.docBody);
  } catch (err) {
    el.docBody.innerHTML = `<pre class="fallback-pre">${escapeHtml(data.content || "")}</pre>`;
    toast("渲染降级为纯文本：" + String(err && err.message || err), "error");
  }
}

document.addEventListener("click", (e) => {
  const link = e.target.closest(".doc-link");
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
  renderTree(); renderStats(); show("list");
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
  const md = arr.filter((f) => f && TEXT_EXT.test(String(f.path || "")) && f.workspace_id === def.id);
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
      setNote("本机工作区里没有 Markdown / 文本文件。");
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
    let unchanged = 0;
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const rel = relFromRef(f.path, ws.id);
      if (!rel) continue;
      if (have.get(rel) && have.get(rel) === f.content_sha256) { unchanged += 1; continue; }
      const enc = rel.split("/").map(encodeURIComponent).join("/");
      const res = await localGet(LOCAL_ORIGIN, "/api/files/" + enc);
      const entry = res && res.data ? res.data : res;
      const text = typeof entry.content === "string" ? entry.content : "";
      candidates.push({ relPath: rel, text, mtime: entry.modified || null });
      setNote(`读取本机内容…（${i + 1}/${files.length}，已取 ${candidates.length} 篇）`);
    }

    if (!candidates.length) {
      setNote(`已是最新：${files.length} 篇内容均与云端一致，无需上传。`);
      return;
    }
    setNote(`待上传 ${candidates.length} 篇（内容未变 ${unchanged} 篇已跳过），开始同步…`);
    closeSheet(win);
    await runUpload(candidates);
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
      if (!TEXT_EXT.test(rawName)) continue;
      if (/(^|\/)(__MACOSX|\.git|node_modules)(\/|$)/.test(rawName)) continue;
      let rel = normPath(rawName);
      const seg = rel.split("/");
      if (seg.length > 1) rel = seg.slice(1).join("/");
      entries.push({ relPath: rel, text: new TextDecoder().decode(bytes) });
    }
    return entries;
  } catch (err) {
    toast("压缩包解析失败：" + String(err && err.message || err), "error");
    return [];
  }
}

async function handleEntries(entries) {
  const candidates = (entries || []).filter((e) => {
    const p = e.relPath || "";
    if (!TEXT_EXT.test(p)) return false;
    if (/(^|\/)(__MACOSX|\.git|node_modules|\.obsidian|\.trash)(\/|$)/i.test(p)) return false;
    return true;
  });
  if (!candidates.length) {
    el.uploadResult.textContent = "没有找到可同步的 Markdown / 文本文件（.md / .markdown / .txt）";
    el.uploadResult.hidden = false;
    return;
  }
  if (!el.wsName.value.trim()) {
    const first = candidates[0].relPath.split("/")[0];
    el.wsName.value = first && candidates.some((c) => c.relPath.includes("/")) ? first : "我的知识库";
    toast("已自动填写分区名：" + el.wsName.value);
  }
  await runUpload(candidates);
}

el.cancelUploadBtn.addEventListener("click", () => {
  if (state.upload) state.upload.cancelled = true;
  el.progressLabel.textContent = "正在取消…";
});

async function runUpload(candidates) {
  const ws = el.wsName.value.trim() || "我的知识库";
  el.uploadResult.hidden = true;
  el.uploadProgress.hidden = false;
  el.progressFill.style.width = "0%";

  const job = { cancelled: false, done: 0, total: candidates.length, added: 0, updated: 0, skipped: 0, failed: 0 };
  state.upload = job;
  const setProgress = (label, pct) => {
    el.progressLabel.textContent = label;
    el.progressFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
  };
  setProgress(`读取文件…（0/${job.total}）`, 0);

  try {
    // 1) 读取内容 + 内容指纹
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
        setProgress(`读取文件…（${i + 1}/${job.total}）`, ((i + 1) / job.total) * 25);
      }
    }
    if (job.cancelled) return finishUpload(job, "已取消（未写入任何内容）");

    // 2) 拉取云端已有指纹，算出真正需要传的
    const { data: existing, error: exErr } = await cloud.database
      .from("documents").select("rel_path, content_sha").eq("workspace", ws);
    if (exErr) return finishUpload(job, "读取云端索引失败：" + (exErr.message || ""), true);
    const have = new Map((existing || []).map((r) => [r.rel_path, r.content_sha]));

    const todo = prepared.filter((p) => have.get(p.rel_path) !== p.content_sha);
    job.updated = prepared.filter((p) => have.has(p.rel_path) && have.get(p.rel_path) !== p.content_sha).length;
    job.added = prepared.length - job.updated;
    job.skipped = job.total - todo.length;
    if (!todo.length) return finishUpload(job, null);

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
      setProgress(`上传中…（${sent}/${todo.length}）`, 25 + (sent / todo.length) * 70);
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
  if (job.added) parts.push(`新增 ${job.added}`);
  if (job.updated) parts.push(`更新 ${job.updated}`);
  if (job.skipped) parts.push(`跳过未变 ${job.skipped}`);
  if (job.failed) parts.push(`失败 ${job.failed}`);
  const summary = parts.length ? parts.join("，") : "没有需要传输的内容";
  el.progressFill.style.width = "100%";
  el.progressLabel.textContent = note || summary;
  if (note || job.failed) {
    el.uploadResult.textContent = (note ? note + "。" : "") + (job.failed ? `有 ${job.failed} 篇未成功，可稍后重试。` : "");
    el.uploadResult.hidden = !el.uploadResult.textContent;
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
  toast(`已清空 ${data.length} 篇云端副本`);
  closeSheet(el.manageSheet);
  renderWsList(); renderTree(); renderStats();
});

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
        if (!CAP.Share) { toast("当前环境不支持分享", "error"); return; }
        try {
          await CAP.Share.share({ title, text, dialogTitle: "分享笔记" });
        } catch (err) {
          // 用户点取消不算错误
          if (!/cancel/i.test(String((err && err.message) || err))) toast("分享失败", "error");
        }
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
          const name = safeFileName(title) + ".md";
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
        show("login");
      } else if (session && !state.session) {
        enterApp();
      }
    });
  } catch (_) {}
}

boot();
