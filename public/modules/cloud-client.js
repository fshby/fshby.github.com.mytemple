/**
 * 桌面端云服务客户端 + 双向同步内核。
 *
 * ── 为什么桌面端可以直连云服务 ────────────────────────────────
 * 早先的实现假设「云服务强制请求来源 == 应用发布域名」，于是把链路做成
 * 「桌面端打开浏览器 → 云端页读本机只读接口 → 云端页上传」。实测（2026-10-12）
 * 这个前提**不成立**：
 *
 *   OPTIONS /.cloud/auth/v1/verification      Origin: http://127.0.0.1:7321
 *     -> 204  Access-Control-Allow-Origin: http://127.0.0.1:7321
 *             Access-Control-Allow-Headers: Authorization,X-Wb-Webapp-Access-Key,
 *                                           Content-Type,Accept,Prefer,…
 *   OPTIONS /.cloud/database/rest/v1/documents  同上
 *
 * 也就是说云服务的边界是 publishableKey + 用户 JWT + RLS，**与 Origin 无关**，
 * 且预检放行本机源。所以桌面端自己就能登录、读、写，不需要任何中转。
 *
 * ── 本模块的职责 ──────────────────────────────────────────────
 *  1. SDK 引导（复用与云端页同一份 /vendor/sdk/…，避免两份实现漂移）
 *  2. 登录 / 会话 / 登出（邮箱验证码、手机验证码、邮箱密码）
 *  3. 本机索引与正文读写（走 /api/files、/api/save —— **不新增任何 Rust 端点**）
 *  4. 云端索引与分批 upsert / 墓碑
 *  5. 三路判据同步内核（见下）
 *
 * ── 同步语义 ─────────────────────────────────────────────────
 * 用 localStorage 里的「上次同步快照」B 做三路判据，而不是单纯比时间：
 *
 *   L.sha == C.sha                        → 已一致，跳过（不读正文）
 *   B 未定义（首次接触两端都有）           → 比时间，差 < 60s 判冲突
 *   L.sha == B && C.sha != B              → 只有云端变了 → 拉取
 *   C.sha == B && L.sha != B              → 只有本机变了 → 推送
 *   两边都不等于 B                        → 冲突：本机原样保留，
 *                                          云端版本另存为 xxx.conflict-云-<时间>.md
 *
 * 底线：**任何情况下不静默覆盖本机**（拉取写入走 /api/save 的 baseHash 冲突检测）。
 * 云端 deleted_at 非空只提示「云端已删除」，**不反向删本机**；
 * 本机删除则给云端打墓碑（deleted_at），可恢复。
 */

const CFG = (typeof window !== "undefined" && window.__MT_CLOUD__) || {};

/** 云端工作台地址（与 cloud-config.js 的 endpoint 同源）。 */
export const CLOUD_WORKBENCH_URL = "https://mytemple-cloud.app.workbuddy.host/";

/* 文档类白名单（**两端逐字同源**：cloud/app.js 顶部有一份完全相同的拷贝，
 *  tests/three-way-sync.test.js 会逐字比对，防两端算出不同的可同步集合）。
 *
 * 为什么单列 html（2026-10-13 用户决策）：桌面端早就把独立 HTML 文档当一等公民
 * —— 沙箱 iframe 预览（app.js HTML_DOC_SANDBOX）、去标签检索（app.rs plain_text_for）、
 * 索引照常收录。只有这份白名单没跟上，于是「本机能看、云端永远没有」。
 * 云端已按扩展名分派渲染（markdown 走 worker，html 走沙箱 iframe），故放开。
 *
 * json / csv 仍**刻意排除**：工作区里的 .json 常是含 token / 密钥的配置文件，
 * 自动上云等于开一条泄漏通道（RLS 只按 owner 隔离，分享或失号即外泄）；
 * csv 没有阅读端渲染分支，放上去只是一堆逗号文本。
 */
const TEXT_EXT = /\.(md|markdown|mdown|mkd|txt|html?|xhtml)$/i;
/** 独立 HTML 文档：渲染方式与 Markdown 不同（沙箱 iframe，不是 markdown 渲染）。 */
const HTML_DOC_EXT = /\.(html?|xhtml)$/i;
/** 独立 HTML 文档的正文上限。整页 HTML 可能几十 MB，而 documents.content 是 text ——
 *  一篇就能把云端列表与检索拖死（本机索引对 >10MB 的文件本来也不收录，这里更严）。 */
const HTML_DOC_MAX_BYTES = 1_200_000;
const UPSERT_BATCH_MAX_DOCS = 20;
const UPSERT_BATCH_MAX_BYTES = 1_200_000;
const INDEX_PAGE = 1000;
const INDEX_MAX = 20_000;
const IN_CHUNK = 50;
/** 两端时间差小于这个窗口就不敢判先后，直接当冲突处理（保守）。 */
const CONFLICT_WINDOW_MS = 60_000;
/** 与云端页同款客户端标识，写入 kb_meta.client_ver。 */
const CLIENT_VER = "exe";

const STATE_KEY = "mtCloudSync.v1";
const DEVICE_KEY = "mtCloudDevice.v1";

/* ── 图片 / 视频资产 ─────────────────────────────────────────
 * 文档正文里的截图写成 `![](source/x.webp)`，字节存在云存储：
 *   users/<uid>/assets/<分区>/<工作区相对路径>
 * 「文档同步」只搬文本 —— 早期面板推送因此出现「有文档、没图片」，
 * 手机 / 网页打开就是一片「未同步」占位（2026-10-13 实机反馈）。
 * 这里按**引用**逐篇扫描本机文档，云端缺哪张才补哪张：
 *   · 不信本地清单：存在性以云端为准（storage.exists 是 HEAD 探针）。
 *     历史上传失败或换账号登录都会留下「清单说有、云端没有」的死记录，
 *     只按清单跳过会让图片永远修不回来。
 *   · 与云端页（cloud/app.js 的 extractAssetRefs / assetRelCandidates /
 *     assetObjectPath / assetWsSegment）必须同规则：同一篇笔记在两端解析出
 *     的对象路径必须一致，否则会「本机一条路径、云端另一条路径」地互相看不见。
 *     改动请同步两处，并跑 tests/three-way-sync.test.js 的同规则断言。
 */
const ASSET_EXT = /\.(png|jpe?g|jfif|gif|webp|avif|bmp|ico|svg|mp4|m4v|webm|mov|ogv)$/i;
const ASSET_MAX_BYTES = 12 * 1024 * 1024;
const ASSET_MAX_COUNT = 400;
const ASSET_CONCURRENCY = 4;

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  ico: "image/x-icon", svg: "image/svg+xml",
  mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
};

function mimeOf(rel) {
  const ext = String(rel || "").split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/** 工作区分段名：与云端页同规则（路径分隔符换成下划线，避免多层目录）。 */
function assetWsSegment(ws) {
  return String(ws || "默认工作区").replace(/[\\/]+/g, "_").replace(/^\.+$/, "_").trim() || "默认工作区";
}

/** 云存储对象路径；路径非法（含 .. 等）时 SDK 会抛错，这里返回空串让调用方跳过。 */
function assetObjectPath(uid, ws, rel) {
  try {
    return cloudClient().storage.userPath(uid, `assets/${assetWsSegment(ws)}/${rel}`);
  } catch (_) {
    return "";
  }
}

/** 本机资源 URL：笔记里写 `source/x.webp`，本机就是 `/source/x.webp`（本机只读路由）。 */
function assetLocalUrl(rel) {
  return "/source/" + String(rel || "").split("/").map(encodeURIComponent).join("/");
}

/** 从 Markdown 原文取出本机资源引用（`![]()`、`<img|video|source src>` 四种写法）。 */
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

/** 引用 → 候选相对路径（含 `ws-asset/<id>/...` 新写法与同目录相对引用）。 */
function assetRelCandidates(ref, docRel) {
  const raw = String(ref || "").trim();
  if (!raw || /^(https?:|data:|blob:|mailto:|javascript:)/i.test(raw)) return [];
  let p = raw.split("#")[0].split("?")[0];
  try { p = decodeURIComponent(p); } catch (_) { /* 保留原样 */ }
  p = normPath(p);
  if (!p) return [];

  const out = [];
  const wsAsset = p.match(/^ws-asset\/[^/]+\/(.+)$/);
  if (wsAsset) out.push(normPath(`source/${wsAsset[1]}`));
  out.push(p);

  const dir = normPath(docRel || "").split("/").slice(0, -1).join("/");
  if (dir) out.push(normPath(`${dir}/${p}`));

  return [...new Set(out.filter((x) => x && !x.split("/").some((s) => s === ".." || s === ".")))];
}

/** 本机是否存在该文件（HEAD 只看头，不下载整张图）。 */
async function localAssetSize(rel) {
  try {
    const res = await fetch(assetLocalUrl(rel), { method: "HEAD", cache: "no-store" });
    if (!res.ok) return -1;
    const n = Number(res.headers.get("content-length") || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return -1;
  }
}

/**
 * 把本机文档引用的图片 / 视频补到云存储。
 * 只处理「引用得到、本机读得到、云端又没有」的对象；已有对象只花一次 HEAD 探针。
 */
async function pushLocalAssets({ docs, ws, uid, onProgress }) {
  const report = (t) => { try { onProgress && onProgress(t); } catch (_) { /* UI 回调出错不影响同步 */ } };
  const out = { sent: 0, exists: 0, missing: 0, tooBig: 0, failed: 0 };

  // 1) 收集「每个引用一组候选路径」（去重，避免同一张图被多篇文档重复处理）
  const jobs = [];
  const seenRef = new Set();
  for (const entry of docs) {
    const rel = relFromRef(entry.path, ws.id);
    if (!rel) continue;
    for (const ref of extractAssetRefs(entry.content || "")) {
      const cands = assetRelCandidates(ref, rel).filter((p) => ASSET_EXT.test(p));
      if (!cands.length) continue;
      const key = cands.join("|");
      if (seenRef.has(key)) continue;
      seenRef.add(key);
      jobs.push(cands);
      if (jobs.length >= ASSET_MAX_COUNT) break;
    }
    if (jobs.length >= ASSET_MAX_COUNT) break;
  }
  if (!jobs.length) return out;

  report(`核对笔记引用的图片（0/${jobs.length}）…`);
  const client = cloudClient();
  const queue = [];
  const handled = new Set();   // 已解析成功的本机路径（多个引用可能指向同一张图）

  // 2) 逐个确认「本机有 + 云端没有」
  //    候选要**依次试**：笔记写 `![](x.webp)` 时既可能是工作区根下的 source/，
  //    也可能是文档同目录下的 —— 只看第一个候选会把后者误报成「本机找不到」。
  for (let i = 0; i < jobs.length; i += 1) {
    if (i % 5 === 0 || i === jobs.length - 1) report(`核对笔记引用的图片（${i + 1}/${jobs.length}）…`);
    let target = null;
    let tooBig = false;
    let dup = false;
    for (const cand of jobs[i]) {
      if (handled.has(cand)) { dup = true; break; }      // 同一张图已被别的引用处理
      const size = await localAssetSize(cand);
      if (size < 0) continue;                            // 这个候选本机没有 → 试下一个
      if (size > ASSET_MAX_BYTES) { tooBig = true; break; }
      target = { rel: cand, size };
      break;
    }
    if (tooBig) { out.tooBig += 1; continue; }
    if (dup) continue;
    if (!target) { out.missing += 1; continue; }         // 候选全都不在本机（引用失效）
    handled.add(target.rel);

    const obj = assetObjectPath(uid, ws.name, target.rel);
    if (!obj) { out.failed += 1; continue; }
    let present = false;
    try {
      const r = await client.storage.exists(obj);
      present = !!(r && r.data);
    } catch (_) { present = false; }
    if (present) { out.exists += 1; continue; }
    queue.push({ rel: target.rel, obj, size: target.size });
  }
  if (!queue.length) return out;

  // 3) 缺的才上传（4 并发，与云端页同一批量策略）
  let done = 0;
  for (let i = 0; i < queue.length; i += ASSET_CONCURRENCY) {
    const slice = queue.slice(i, i + ASSET_CONCURRENCY);
    const results = await Promise.all(slice.map(async (t) => {
      try {
        const res = await fetch(assetLocalUrl(t.rel), { cache: "no-store" });
        if (!res.ok) return { t, ok: false, why: "local" };
        const blob = await res.blob();
        const { error } = await client.storage.upload(t.obj, blob, {
          contentType: mimeOf(t.rel), upsert: true, cacheControl: "31536000",
        });
        return { t, ok: !error };
      } catch (_) {
        return { t, ok: false };
      }
    }));
    for (const r of results) {
      done += 1;
      if (r.ok) out.sent += 1;
      else if (r.why === "local") out.missing += 1;
      else out.failed += 1;
    }
    report(`上传图片 / 视频（${done}/${queue.length}）…`);
  }
  return out;
}


/* ── 客户端引导 ────────────────────────────────────────────── */

let _client = null;

/** 是否具备直连云端的条件（SDK 与配置都到位）。 */
export function cloudReady() {
  return !!(window.WorkBuddyCloud && typeof window.WorkBuddyCloud.createWorkBuddyCloud === "function"
    && CFG.endpoint && CFG.publishableKey);
}

export function cloudEndpoint() {
  return CFG.endpoint || "";
}

/**
 * 全局唯一的客户端实例。初始化参数与云端页**逐字段一致**（endpoint /
 * oauthRelayBaseUrl / publishableKey），三者都只来自 cloud-config.js。
 */
export function cloudClient() {
  if (_client) return _client;
  const sdk = window.WorkBuddyCloud;
  if (!sdk || typeof sdk.createWorkBuddyCloud !== "function") {
    throw new Error("云服务 SDK 未加载，请检查安装是否完整后重试");
  }
  if (!CFG.endpoint || !CFG.publishableKey) {
    throw new Error("云端配置缺失（cloud-config.js）");
  }
  _client = sdk.createWorkBuddyCloud({
    endpoint: CFG.endpoint,
    oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
    publishableKey: CFG.publishableKey,
  });
  return _client;
}

/** SDK 统一是 { data, error } 形状，这里把 error 转成异常。 */
function unwrap(res, fallback) {
  if (res && res.error) {
    const msg = res.error.message || res.error.error_description || fallback;
    throw new Error(msg);
  }
  return res ? res.data : null;
}

/* ── 认证 ──────────────────────────────────────────────────── */

/**
 * 读会话。**只有这里**允许吞异常：初始化阶段没会话是正常状态。
 * 注意：SDK 内部把会话存在 localStorage，而 localStorage 按
 * scheme+host+port 隔离 —— 本机端口从 7321 漂到 7322 会表现为「掉登录态」。
 * 面板里会显示当前端口以提示这一点。
 */
export async function getSession() {
  try {
    const r = await cloudClient().auth.getSession();
    return r && r.data ? r.data : null;
  } catch (_) {
    return null;
  }
}

/** 发验证码。传 email 或 phone，二选一。 */
export async function sendOtp({ email, phone }) {
  const payload = email ? { email } : { phone };
  const data = unwrap(await cloudClient().auth.sendOtp(payload), "验证码发送失败");
  return { verificationId: data && data.verificationId, isExistingUser: !!(data && data.isExistingUser) };
}

/** 校验验证码完成登录/注册。新用户必须带 password（SDK 契约）。 */
export async function verifyOtp({ email, phone, verificationId, isExistingUser, token, password }) {
  const payload = {
    verificationId,
    isExistingUser,
    token,
    // 已有用户传 undefined —— 密码只在注册时必需
    password: isExistingUser ? undefined : password,
  };
  if (email) payload.email = email;
  if (phone) payload.phone = phone;
  unwrap(await cloudClient().auth.verifyOtp(payload), "登录失败");
}

export async function signInWithPassword(email, password) {
  unwrap(await cloudClient().auth.signInWithPassword({ email, password }), "邮箱或密码不正确");
}

export async function signOut() {
  try {
    await cloudClient().auth.signOut();
  } catch (_) {
    /* 退出失败也要让本地状态归零，否则界面会卡在「已登录」 */
  }
}

/** 账号掩码：只露手机号前 3 后 4，邮箱只露首字符与域名。 */
export function maskIdentity(user) {
  if (!user) return "已登录";
  const phone = user.phone || user.phone_number;
  if (phone) {
    const d = String(phone).replace(/\D/g, "");
    if (d.length >= 7) return d.slice(0, 3) + "****" + d.slice(-4);
  }
  const email = user.email;
  if (email && String(email).includes("@")) {
    const [name, domain] = String(email).split("@");
    const head = name.slice(0, 1);
    return `${head}${"*".repeat(Math.max(1, Math.min(name.length - 1, 6)))}@${domain}`;
  }
  return "已登录";
}

/* ── 本机接口（只读 + 写，均为既有端点，不新增后端）───────────── */

async function localRequest(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = null;
  }
  if (!res.ok) {
    // 后端错误统一是 {ok:false,error:"…"} 或裸 {error:"…"}
    const msg = (body && (body.error || body.message)) || `${path} -> HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  // 注意：/api/save 的 baseHash 冲突**不是** HTTP 错误，而是 200 + {ok:false,conflict:true,…}
  // （见 ipc::save_doc）。只判 res.ok 会把「拒绝写入」误当成写入成功。
  if (body && body.ok === false) {
    const e = new Error(String(body.error || body.message || "写入被拒绝"));
    if (body.conflict) e.conflict = true;
    if (body.diskSha256) e.diskSha256 = body.diskSha256;
    throw e;
  }
  return body;
}

const localGet = (path) => localRequest(path);
const localPost = (path, payload) => localRequest(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

/** 把相对路径编码成 URL 路径段（保留 / 分隔）。 */
export function encodeRefPath(rel) {
  return String(rel || "").split("/").map(encodeURIComponent).join("/");
}

export function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** FileEntry.path 形如 "<workspace_id>/<相对路径>"，云端存的是相对路径。 */
export function relFromRef(ref, wsId) {
  const p = normPath(ref);
  return p.startsWith(wsId + "/") ? p.slice(wsId.length + 1) : p;
}

/**
 * ⚠️ FileEntry 的 JSON 序列化是 **camelCase**（Rust 端 `#[serde(rename_all="camelCase")]`，
 * 2026-10-12 实机确认：/api/files 返回的是 workspaceId / contentSha256，
 * **没有** workspace_id / content_sha256 字段）。按 snake_case 读会恒为 undefined，
 * 表现为「可同步内容：暂无 Markdown」「没有需要同步的内容」。
 * 这里统一收口，两种拼写都认，避免同类静默故障再次发生。
 */
function fWs(f) {
  return (f && (f.workspaceId ?? f.workspace_id)) || null;
}
function fSha(f) {
  return (f && (f.contentSha256 ?? f.content_sha256)) || null;
}

/**
 * 本机工作区 + 文件清单（不含正文）。
 * /api/workspaces 是**裸对象**，/api/files 走 success() 包装（{ok,data:[…]}）——
 * 两者形状不同，混用会得到「永远读不到文件」这种静默故障。
 *
 * @param {string} [wsId] 指定工作区 id；缺省用默认工作区
 * @returns {ws, workspaces, files, countsByWs}
 *   files 只含所选工作区的文本类条目；countsByWs 是全部工作区的文本篇数（面板选择器用）。
 */
export async function readLocalIndex(wsId) {
  const wsRes = await localGet("/api/workspaces");
  const list = Array.isArray(wsRes && wsRes.workspaces) ? wsRes.workspaces : [];
  if (!list.length) throw new Error("本机没有已加载的知识库工作区");
  const def = list.find((w) => w.id === wsRes.defaultWorkspaceId) || list[0];
  const ws = list.find((w) => w.id === wsId) || def;

  const filesRes = await localGet("/api/files");
  const arr = Array.isArray(filesRes && filesRes.data)
    ? filesRes.data
    : (Array.isArray(filesRes) ? filesRes : []);
  const counts = new Map();
  for (const f of arr) {
    if (!f || !TEXT_EXT.test(String(f.path || ""))) continue;
    const wid = fWs(f) || "?";
    counts.set(wid, (counts.get(wid) || 0) + 1);
  }
  const files = arr.filter((f) => f && TEXT_EXT.test(String(f.path || "")) && fWs(f) === ws.id);
  return { ws, workspaces: list, files, countsByWs: counts };
}

/** 读一篇本机正文（FileEntry.content 为懒加载字段，必须走单篇接口）。 */
async function readLocalContent(ref) {
  const res = await localGet("/api/files/" + encodeRefPath(ref));
  const entry = res && res.data ? res.data : res;
  return {
    content: typeof entry.content === "string" ? entry.content : "",
    sha: fSha(entry),
    mtime: entry.modified || null,
  };
}

/**
 * 写回本机。baseHash 交给后端做冲突检测（磁盘 hash 与 baseHash 不一致时
 * 后端返回 "__CONFLICT__:<diskHash>"，我们据此拒绝覆盖）。
 */
async function writeLocalDoc(ref, content, baseHash) {
  const payload = { path: ref, content };
  if (baseHash) payload.baseHash = baseHash;
  return localPost("/api/save", payload);
}

/* ── 云端数据面 ────────────────────────────────────────────── */

/**
 * 拉云端索引。刻意**不**过滤 deleted_at：墓碑参与同步判据，
 * 才能区分「云端从没有过」与「云端删过」。
 */
export async function fetchCloudIndex(workspace) {
  const all = [];
  for (let from = 0; from < INDEX_MAX; from += INDEX_PAGE) {
    const { data, error } = await cloudClient().database
      .from("documents")
      .select("rel_path, content_sha, doc_mtime, updated_at, deleted_at")
      .eq("workspace", workspace)
      .order("rel_path", { ascending: true })
      .range(from, from + INDEX_PAGE - 1);
    if (error) throw new Error(error.message || "读取云端索引失败");
    const rows = Array.isArray(data) ? data : [];
    all.push(...rows);
    if (rows.length < INDEX_PAGE) break;
  }
  return all;
}

/** 分批 upsert 正文。 */
async function upsertDocs(workspace, prepared, onSent) {
  const nowIso = new Date().toISOString();
  let sent = 0;
  let batch = [];
  let batchBytes = 0;
  let failed = 0;
  const flush = async () => {
    if (!batch.length) return;
    const payload = batch.map((p) => ({
      workspace,
      rel_path: p.rel_path,
      title: p.title,
      content: p.content,
      content_sha: p.content_sha,
      bytes: p.bytes,
      doc_mtime: p.doc_mtime,
      deleted_at: null,
      updated_at: nowIso,
    }));
    const { error } = await cloudClient().database
      .from("documents")
      .upsert(payload, { onConflict: "owner_id,workspace,rel_path" })
      .select("id");
    if (error) failed += batch.length;
    sent += batch.length;
    batch = [];
    batchBytes = 0;
    if (onSent) onSent(sent);
  };
  for (const p of prepared) {
    batch.push(p);
    batchBytes += p.bytes;
    if (batch.length >= UPSERT_BATCH_MAX_DOCS || batchBytes >= UPSERT_BATCH_MAX_BYTES) await flush();
  }
  await flush();
  return { sent, failed };
}

/** 给云端打墓碑（软删除，可恢复）。 */
async function markDeletedOnCloud(workspace, rels) {
  const nowIso = new Date().toISOString();
  let failed = 0;
  for (let i = 0; i < rels.length; i += IN_CHUNK) {
    const chunk = rels.slice(i, i + IN_CHUNK);
    const { error } = await cloudClient().database
      .from("documents")
      .update({ deleted_at: nowIso, updated_at: nowIso })
      .eq("workspace", workspace)
      .in("rel_path", chunk)
      .select("rel_path");
    if (error) failed += chunk.length;
  }
  return { ok: rels.length - failed, failed };
}

/** 按 rel_path 批量取正文（仅取需要拉取的那些，避免全量下载）。 */
async function fetchCloudContents(workspace, rels) {
  const out = new Map();
  for (let i = 0; i < rels.length; i += IN_CHUNK) {
    const chunk = rels.slice(i, i + IN_CHUNK);
    const { data, error } = await cloudClient().database
      .from("documents")
      .select("rel_path, content, content_sha, doc_mtime, updated_at")
      .eq("workspace", workspace)
      .in("rel_path", chunk);
    if (error) throw new Error(error.message || "读取云端正文失败");
    for (const row of (data || [])) out.set(row.rel_path, row);
  }
  return out;
}

/** 同步摘要（best-effort，失败不影响正文）。 */
async function writeMeta(docCount) {
  try {
    await cloudClient().database.from("kb_meta").upsert({
      display_name: null,
      last_sync_at: new Date().toISOString(),
      doc_count: docCount,
      client_ver: CLIENT_VER,
    }, { onConflict: "owner_id" }).select("last_sync_at");
  } catch (_) {
    /* 摘要写不进去不算同步失败 */
  }
}

/* ── 本地工具 ──────────────────────────────────────────────── */

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  if (window.crypto && crypto.subtle) {
    const d = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i += 1) { h ^= buf[i]; h = (h * 0x01000193) >>> 0; }
  return "fnv" + h.toString(16);
}

function titleFrom(text, relPath) {
  const src = String(text || "");
  // 独立 HTML 文档的标题在 <title> 里；正文里的 `# 一级标题` 多半是注释或示例代码，
  // 优先级必须低于 <title>（与桌面端 app.rs extract_title 同一分派原则）。
  if (HTML_DOC_EXT.test(relPath)) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
    if (t) {
      const name = t[1].replace(/\s+/g, " ").trim();
      if (name) return name.slice(0, 120);
    }
  }
  const m = /^\s*#{1,6}\s+(.+?)\s*$/m.exec(src);
  if (m) return m[1].replace(/[*_`~[\]]/g, "").slice(0, 120);
  const base = String(relPath).split("/").pop() || relPath;
  return base.replace(/\.[^.]+$/, "");
}

function fmtStamp(d = new Date()) {
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 本机设备短标识：冲突副本文件名里带上，便于区分是哪个端产生的。 */
function deviceTag() {
  try {
    let v = localStorage.getItem(DEVICE_KEY);
    if (v) return v;
    v = Math.random().toString(36).slice(2, 6);
    localStorage.setItem(DEVICE_KEY, v);
    return v;
  } catch (_) {
    return "dev";
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return { workspace: null, lastSyncAt: null, files: {}, assets: {} };
    const parsed = JSON.parse(raw);
    return {
      workspace: parsed && parsed.workspace ? parsed.workspace : null,
      lastSyncAt: parsed && parsed.lastSyncAt ? parsed.lastSyncAt : null,
      files: parsed && parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      // 图片核对戳：{rel_path: 该篇的本地内容 sha}，含义是「这个内容版本引用的图片
      // 已确认都在云端」。有它才不会每次同步都把整个库的正文与云端探针重跑一遍。
      // 内容一变（推 / 拉 / 本机编辑）sha 就对不上，自动重新核对。
      assets: parsed && parsed.assets && typeof parsed.assets === "object" ? parsed.assets : {},
    };
  } catch (_) {
    return { workspace: null, lastSyncAt: null, files: {}, assets: {} };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (_) {
    /* 配额满/隐私模式：同步本身不受影响，只是下次退化成「首次接触」判据 */
  }
}

/** 上次同步时间（面板显示用）。 */
export function lastSyncAt(workspace) {
  const st = loadState();
  if (workspace && st.workspace !== workspace) return null;
  return st.lastSyncAt;
}

/* ── 同步内核 ──────────────────────────────────────────────── */

/**
 * 双向同步。
 *
 * @param {"push"|"pull"|"both"} opts.mode  "push" 只上传、 "pull" 只拉取、 "both" 双向
 * @param {(text:string)=>void} opts.onProgress
 * @returns 摘要 { workspace, push, pull, conflict, tombstone, skipped, cloudDeleted, failed, notes[] }
 */
export async function syncCloud({ mode = "both", workspaceId, onProgress } = {}) {
  const report = (t) => { try { onProgress && onProgress(t); } catch (_) { /* UI 回调出错不影响同步 */ } };
  const wantPush = mode !== "pull";
  const wantPull = mode !== "push";

  report("读取本机知识库索引…");
  const { ws, files } = await readLocalIndex(workspaceId);
  const workspace = ws.name || ws.id || "我的知识库";

  report(`读取云端索引（分区「${workspace}」）…`);
  const cloudRows = await fetchCloudIndex(workspace);
  const cloudMap = new Map(cloudRows.map((r) => [r.rel_path, r]));

  const localMap = new Map();
  for (const f of files) {
    const rel = relFromRef(f.path, ws.id);
    if (rel) localMap.set(rel, f);
  }

  const st = loadState();
  const base = st.workspace === workspace ? (st.files || {}) : {};
  const baseAssets = st.workspace === workspace ? (st.assets || {}) : {};
  const next = { ...base };
  // 本次真正核对过的图片戳（rel → 内容 sha）；只有成功跑完一轮才写回
  const assetStamps = {};

  const summary = {
    workspace, mode, push: 0, pull: 0, conflict: 0, tombstone: 0,
    skipped: 0, cloudDeleted: 0, failed: 0, notes: [],
    // 超过上限被跳过的独立 HTML 文档数（Markdown 不受此限）。
    docTooBig: 0,
    // 图片 / 视频：即使这一轮没扫（核对戳命中）也是 0，而不是 undefined ——
    // 面板与 summarize 直接读这几个字段做判断，缺字段会变成「undefined 张」。
    assetPush: 0, assetExists: 0, assetMissing: 0, assetTooBig: 0, assetFailed: 0,
  };
  summary.localCount = localMap.size;
  summary.cloudCount = [...cloudMap.values()].filter((r) => r && !r.deleted_at).length;

  const toPush = [];
  const toPull = [];
  const toTombstone = [];
  const toConflict = [];

  const rels = new Set([...localMap.keys(), ...cloudMap.keys(), ...Object.keys(base)]);
  for (const rel of rels) {
    const L = localMap.get(rel);
    const C = cloudMap.get(rel);
    const B = base[rel];
    const cVisible = !!C && !C.deleted_at;

    // 1) 两端都有且内容一致：已同步
    if (L && cVisible && fSha(L) === C.content_sha) {
      next[rel] = fSha(L);
      summary.skipped += 1;
      continue;
    }

    // 2) 本机有、云端没有（或已被云端软删）
    if (L && !cVisible) {
      if (C && C.deleted_at && B !== undefined && fSha(L) === B) {
        // 本机没动过，云端删过 —— 尊重云端删除，但**不删本机**
        summary.cloudDeleted += 1;
        summary.notes.push(`云端已删除，本机保留：${rel}`);
        next[rel] = L.content_sha256;
      } else {
        // 云端从没有过，或本机在云端删除后又改过 → 上传（后者等于复活）
        toPush.push({ rel, entry: L, resurrect: !!(C && C.deleted_at) });
      }
      continue;
    }

    // 3) 云端有、本机没有
    if (!L && cVisible) {
      if (B === undefined || C.content_sha !== B) {
        toPull.push({ rel, cloud: C });
      } else {
        // 上次同步之后本机删了、云端没变 → 给云端打墓碑
        toTombstone.push(rel);
      }
      continue;
    }

    // 4) 云端已软删、本机也没有 → 两边一致地不存在
    if (!L && !C) {
      delete next[rel];
      continue;
    }
    if (!L && C && C.deleted_at) {
      delete next[rel];
      summary.skipped += 1;
      continue;
    }

    // 5) 两端都有但内容不同 → 判方向
    if (L && cVisible) {
      if (B === undefined) {
        // 首次接触：只能比时间
        const localMs = Number(L.modified) || 0;
        const cloudMs = Date.parse(C.updated_at) || 0;
        const latest = Math.max(localMs, Number(C.doc_mtime) || 0);
        if (latest > cloudMs + CONFLICT_WINDOW_MS) toPush.push({ rel, entry: L, resurrect: false });
        else if (cloudMs > latest + CONFLICT_WINDOW_MS) toPull.push({ rel, cloud: C });
        else toConflict.push({ rel, cloud: C, entry: L });
      } else if (fSha(L) === B) {
        toPull.push({ rel, cloud: C });
      } else if (C.content_sha === B) {
        toPush.push({ rel, entry: L, resurrect: false });
      } else {
        toConflict.push({ rel, cloud: C, entry: L });
      }
    }
  }

  const modeNote = (n, what) => {
    if (n) summary.notes.push(`${what} ${n} 篇：当前是单向同步，可再点另一个按钮`);
  };

  /* ── 推送 ── */
  let pushedCount = 0;
  if (wantPush && toPush.length) {
    report(`读取本机正文（0/${toPush.length}）…`);
    const prepared = [];
    let i = 0;
    for (const item of toPush) {
      i += 1;
      const ref = item.entry.path;
      let content = typeof item.entry.content === "string" ? item.entry.content : null;
      let sha = fSha(item.entry);
      let mtime = item.entry.modified || null;
      if (content === null) {
        const got = await readLocalContent(ref);
        content = got.content;
        sha = got.sha || sha;
        mtime = got.mtime || mtime;
      }
      if (!sha) sha = await sha256Hex(content);
      const bytes = new TextEncoder().encode(content).length;
      const cloud = cloudMap.get(item.rel);
      if (cloud && !item.resurrect && cloud.content_sha === sha && !cloud.deleted_at) {
        // 索引与正文之间被别处同步过，跳过
        next[item.rel] = sha;
        summary.skipped += 1;
        continue;
      }
      // 独立 HTML 文档的正文上限：整页 HTML 可能几十 MB，而我方 documents.content
      // 是 text —— 放上去会把云端列表与检索一起拖慢（Markdown 不设限，保持既有行为）。
      if (HTML_DOC_EXT.test(item.rel) && bytes > HTML_DOC_MAX_BYTES) {
        summary.docTooBig += 1;
        summary.notes.push(`HTML 文档超过 ${Math.round(HTML_DOC_MAX_BYTES / 1024)}KB 未上传：${item.rel}`);
        continue;
      }
      prepared.push({
        rel_path: item.rel, title: titleFrom(content, item.rel),
        content, content_sha: sha, bytes, doc_mtime: mtime,
      });
      if (i % 5 === 0 || i === toPush.length) report(`读取本机正文（${i}/${toPush.length}）…`);
    }
    if (prepared.length) {
      report(`上传中（0/${prepared.length}）…`);
      const { sent, failed } = await upsertDocs(workspace, prepared, (n) => report(`上传中（${n}/${prepared.length}）…`));
      summary.push = sent - failed;
      summary.failed += failed;
      pushedCount = summary.push;
      for (const p of prepared) next[p.rel_path] = p.content_sha;
    }
  } else if (!wantPush && toPush.length) {
    modeNote(toPush.length, "待上传");
  }

  /* ── 图片 / 视频（推送方向）───────────────────────────────────
   * 文档同步只搬文本，图片字节必须单独补：发布面板推送过的库因此「正文在、
   * 图片缺」，手机 / 网页打开就是「未同步」。按引用扫描本机文档，云端缺哪张补哪张。
   * 这一步失败不影响文档同步结果（正文同步成功就该报成功）。
   *
   * 只扫「内容版本没核对过」的文档（baseAssets 里存的是上次核对时的正文 sha）：
   * 否则每次同步都要读遍全库正文 + 给每张图打一次云端 HEAD 探针，库越大越慢。 */
  if (wantPush && localMap.size) {
    try {
      const session = await getSession();
      const uid = session && session.user && session.user.id;
      if (uid) {
        const entries = [...localMap.values()];
        const docs = [];
        for (const e of entries) {
          const rel = relFromRef(e.path, ws.id);
          if (!rel) continue;
          const stamp = fSha(e);
          if (stamp && baseAssets[rel] === stamp) continue;   // 这个内容版本已核对过
          if (typeof e.content === "string") { docs.push({ ...e, __rel: rel }); continue; }
          try {
            const r = await readLocalContent(e.path);
            docs.push({ ...e, content: r.content, __rel: rel });
          } catch (_) { /* 单篇读不到就跳过，不影响其它文档的图片 */ }
        }
        if (docs.length) {
          report(`核对笔记引用的图片（${docs.length} 篇）…`);
          const ar = await pushLocalAssets({ docs, ws, uid, onProgress: report });
          summary.assetPush = ar.sent;
          summary.assetExists = ar.exists;
          summary.assetMissing = ar.missing;
          summary.assetTooBig = ar.tooBig;
          summary.assetFailed = ar.failed;
          for (const d of docs) assetStamps[d.__rel] = fSha(d);
        }
      }
    } catch (_) { /* 图片环节出错不改变文档同步的结论，也不写戳（下次重试） */ }
  }

  /* ── 拉取 ── */
  if (wantPull && toPull.length) {
    report(`读取云端正文（0/${toPull.length}）…`);
    const contents = await fetchCloudContents(workspace, toPull.map((t) => t.rel));
    let done = 0;
    for (const item of toPull) {
      done += 1;
      report(`写入本机（${done}/${toPull.length}）…`);
      const row = contents.get(item.rel);
      if (!row || typeof row.content !== "string") {
        summary.failed += 1;
        summary.notes.push(`云端正文缺失，已跳过：${item.rel}`);
        continue;
      }
      const ref = `${ws.id}/${item.rel}`;
      const local = localMap.get(item.rel);
      try {
        // baseHash 用本机当前 sha —— camelCase 适配漏掉这里，冲突检测会整体失效
        await writeLocalDoc(ref, row.content, local ? fSha(local) : undefined);
        summary.pull += 1;
        next[item.rel] = row.content_sha;
      } catch (err) {
        const msg = String((err && err.message) || err);
        if ((err && err.conflict) || msg.startsWith("__CONFLICT__")) {
          // 本机在索引读取之后被改过 —— 绝不覆盖，先落一份冲突副本
          await saveConflictCopy(ref, row.content, summary);
          next[item.rel] = row.content_sha;
        } else {
          summary.failed += 1;
          summary.notes.push(`写入失败：${item.rel}（${msg}）`);
        }
      }
    }
  } else if (!wantPull && toPull.length) {
    modeNote(toPull.length, "待拉取");
  }

  /* ── 冲突：本机原样保留，云端版本另存副本，并把本机版本推上去收敛 ── */
  if (toConflict.length) {
    const conflicts = [];
    for (const item of toConflict) {
      const row = item.cloud;
      if (typeof row.content !== "string") {
        // 索引没带正文，单独取一次
        const got = await fetchCloudContents(workspace, [item.rel]);
        const full = got.get(item.rel);
        if (!full || typeof full.content !== "string") { summary.failed += 1; continue; }
        row.content = full.content;
      }
      const ref = `${ws.id}/${item.rel}`;
      await saveConflictCopy(ref, row.content, summary);
      conflicts.push({
        rel_path: item.rel,
        title: titleFrom(item.entry.content || "", item.rel),
        content: typeof item.entry.content === "string" ? item.entry.content : null,
        content_sha: fSha(item.entry),
        doc_mtime: item.entry.modified || null,
      });
      next[item.rel] = fSha(item.entry);
    }
    // 把本机版本推上云端，让两端收敛（内容不丢：另一版本已在副本里）
    const prepared = [];
    for (const c of conflicts) {
      let content = c.content;
      if (content === null) {
        try {
          const got = await readLocalContent(`${ws.id}/${c.rel_path}`);
          content = got.content;
        } catch (_) { continue; }
      }
      prepared.push({
        rel_path: c.rel_path, title: titleFrom(content, c.rel_path),
        content, content_sha: c.content_sha, bytes: new TextEncoder().encode(content).length,
        doc_mtime: c.doc_mtime,
      });
    }
    if (prepared.length) {
      const { sent, failed } = await upsertDocs(workspace, prepared);
      summary.push += sent - failed;
      summary.failed += failed;
      pushedCount += sent - failed;
    }
  }

  /* ── 墓碑 ── */
  if (toTombstone.length) {
    report(`标记云端删除（${toTombstone.length} 篇）…`);
    const { ok, failed } = await markDeletedOnCloud(workspace, toTombstone);
    summary.tombstone = ok;
    summary.failed += failed;
    for (const rel of toTombstone) delete next[rel];
  }

  // 图片核对戳只对「本机当前仍存在的文档」保留，避免删库后残留一堆死记录
  const nextAssets = {};
  for (const rel of localMap.keys()) {
    const v = assetStamps[rel] !== undefined ? assetStamps[rel] : baseAssets[rel];
    if (v) nextAssets[rel] = v;
  }

  saveState({ workspace, lastSyncAt: new Date().toISOString(), files: next, assets: nextAssets });
  if (pushedCount) await writeMeta(localMap.size);

  return summary;
}

/** 把一份「另一端的内容」落成本机的冲突副本，绝不覆盖原文件。 */
async function saveConflictCopy(ref, content, summary) {
  const rel = relFromRef(ref, ref.split("/")[0]);
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : ".md";
  const copyRel = `${dir}${stem}.conflict-云-${fmtStamp()}${ext}`;
  const copyRef = `${ref.split("/")[0]}/${copyRel}`;
  try {
    await writeLocalDoc(copyRef, content, undefined);
    summary.conflict += 1;
    summary.notes.push(`两端都改过，已保留本机版本，云端版本另存为：${copyRel}`);
  } catch (err) {
    summary.failed += 1;
    summary.notes.push(`冲突副本写入失败：${copyRel}（${String((err && err.message) || err)}）`);
  }
}

/** 把同步摘要渲染成一句人话（面板直接显示）。 */
export function summarize(summary) {
  const parts = [];
  if (summary.push) parts.push(`上传 ${summary.push}`);
  if (summary.pull) parts.push(`拉取 ${summary.pull}`);
  if (summary.conflict) parts.push(`冲突留副本 ${summary.conflict}`);
  if (summary.tombstone) parts.push(`标记删除 ${summary.tombstone}`);
  if (summary.cloudDeleted) parts.push(`云端已删、本机保留 ${summary.cloudDeleted}`);
  if (summary.assetPush) parts.push(`补传图片 ${summary.assetPush} 张`);
  if (summary.assetMissing) parts.push(`${summary.assetMissing} 张引用在本机找不到`);
  if (summary.assetTooBig) parts.push(`${summary.assetTooBig} 张超过 12MB 未上传`);
  if (summary.assetFailed) parts.push(`图片失败 ${summary.assetFailed} 张`);
  if (summary.docTooBig) parts.push(`${summary.docTooBig} 个 HTML 文档过大未上传`);
  if (summary.failed) parts.push(`失败 ${summary.failed}`);
  if (parts.length) {
    if (summary.skipped) parts.push(`未变 ${summary.skipped}`);
    return parts.join("，");
  }

  // 没有任何动作时，把「为什么没有」说清楚，而不是一句「没有需要同步的内容」
  const L = Number(summary.localCount) || 0;
  const C = Number(summary.cloudCount) || 0;
  if (!L && !C) return "这个工作区本机和云端都还没有内容";
  // 文档没动但核对过图片：把图片的结论也说出来，否则会以为「什么都没做」
  if (summary.assetExists) return `内容已一致，${summary.assetExists} 张引用图片也都在云端`;
  if (summary.mode === "pull") {
    return C
      ? `云端 ${C} 篇都已在本地，没有需要拉取的`
      : "云端此分区还没有内容：可先用「推送本机 → 云端」上传";
  }
  if (summary.mode === "push") {
    return L
      ? `没有需要上传的改动（本机 ${L} 篇，云端已有 ${C} 篇）`
      : (C
        ? `本机此工作区没有可同步的文档（云端已有 ${C} 篇，可用「拉取」取回）`
        : "本机此工作区没有可同步的文档，没有可上传的内容");
  }
  if (L && !C) return `云端此分区还是空的：用「推送本机 → 云端」可上传本机 ${L} 篇`;
  if (!L && C) return `本机此工作区是空的：用「拉取云端更新」可取回云端 ${C} 篇`;
  return `内容已一致（本机 ${L} 篇 = 云端 ${C} 篇）`;
}
