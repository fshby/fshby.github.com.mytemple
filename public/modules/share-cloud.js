// 桌面端「临时分享链接」：把当前文档做成一条只读快照写进云端，
// 访客（含微信内）打开 `share.html?d=<id>` 即见渲染好的页面，无需登录。
//
// 与云端工作台**同一套契约**（cloud/app.js 的 writeShare / collectShareAssets）：
//   · 表：shared_docs（正文 + 过期时间）/ shared_assets（图片 base64）
//   · 匿名可读由 RLS 保证：`revoked = false AND (expires_at IS NULL OR expires_at > now())`
//   · 图片不落云存储（匿名不可读），随快照内联；压缩口径逐个常量对齐，避免两端观感不同
//
// 两处桌面特有的坑，这里都已经吃掉了：
//   1) **WAF**：桌面文档在本地是原文，正文含 `<script>` / `on*=` 直写云端会被平台拦成 403
//      （响应不带 CORS 头，浏览器只会报「缺少跨域头」，很容易误判成配置问题）。
//      所以独立 HTML 文档写之前先走与同步同一份 `stripCloudUnsafeHtml`。
//   2) **写操作必须读回**：`.select()` 返回空数组 = 被 RLS 拦下，不能当成功（历史踩过的坑）。
//
// 分享快照是独立副本：之后再改文档不会自动更新，再点一次分享即刷新。
import { cloudClient, cloudReady, stripCloudUnsafeHtml, CLOUD_WORKBENCH_URL, withShareCode, cloudEndpoint } from "./cloud-client.js";
// 引用解析 / 候选键 / 各类上限**全部来自单一实现源**（shared/share-core.js → 本目录同名产物）。
// 这几条规则以前桌面与云端各写一份、靠人工对齐，一天内炸了三次线上事故，见源文件注释。
import {
  SHARE_TTL_CHOICES,
  SHARE_TTL_DEFAULT,
  SHARE_ASSET_MAX,
  SHARE_ASSET_KEEP_BYTES,
  SHARE_ASSET_MAX_BYTES,
  SHARE_MAX_WIDTH,
  SHARE_QUALITY,
  SHARE_VIDEO_EXT,
  IMG_EXT,
  HTML_DOC_EXT,
  SHARE_CONTENT_MAX_BYTES,
  SHARE_ASSETS_TOTAL_MAX_BYTES,
  refToAsset,
  mimeOfRef,
  extractAssetRefs,
  parseShareTtl,
  expiresAtFromTtl,
  utf8Bytes,
} from "./share-core.js";

export { SHARE_TTL_CHOICES };
// 共享核心的实现原样再导出，既有调用方与单测的导入路径保持不变
export { refToAsset };

const SHARE_PATH = "share.html";
/** 与云端工作台同名同值：有效期记忆存在 localStorage，两端心智一致。 */
const SHARE_TTL_KEY = "shareTtlDays";

export function shareTtlDays() {
  // 注意 Number(null) === 0：未设置过时不能当成「永久」，判定逻辑在共享核心里
  return parseShareTtl(localStorage.getItem(SHARE_TTL_KEY), SHARE_TTL_CHOICES, SHARE_TTL_DEFAULT);
}

export function setShareTtlDays(value) {
  const v = Number(value);
  const safe = SHARE_TTL_CHOICES.includes(v) ? v : SHARE_TTL_DEFAULT;
  localStorage.setItem(SHARE_TTL_KEY, String(safe));
  return safe;
}

/** 列表展示用：永久有效 / 剩 N 天 / 剩 N 小时 / 已过期 */
export function shareExpiryText(expiresAt) {
  if (!expiresAt) return "永久有效";
  const left = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(left)) return "永久有效";
  if (left <= 0) return "已过期";
  const hours = Math.ceil(left / 36e5);
  if (hours <= 48) return `剩 ${hours} 小时`;
  return `剩 ${Math.ceil(hours / 24)} 天`;
}

/** 9 字节随机 → 短 id（与云端 newShareId 同一算法，长度一致）。 */
export function newShareId() {
  const b = new Uint8Array(9);
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    window.crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("");
}

/** 分享页部署在云端工作台同源下（桌面端不带自己的域名）。
 *  必须带 sharecode：平台升级后裸路径 403「链接不完整」，访客没有站点 cookie。 */
export function shareLink(id) {
  const base = String(CLOUD_WORKBENCH_URL || "").replace(/\/+$/, "");
  return withShareCode(`${base}/${SHARE_PATH}?d=${id}`);
}

export function shareReady() {
  return cloudReady();
}

/* ── 图片：从本机工作区直接取字节 ─────────────────────────────
 * 文档里的图片来自 `<ws_root>/source/…`（截图统一保存到这里），桌面同源，
 * 走只读路由 `/ws-asset/{wsId}/{相对 source 的路径}` 即可，不需要签名 URL。
 */
function bytesToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function wsAssetUrl(wsId, rel) {
  const encRel = String(rel || "").split("/").map((s) => encodeURIComponent(s)).join("/");
  return `/ws-asset/${encodeURIComponent(wsId)}/${encRel}`;
}

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
 * 收集并压好正文引用的图片。
 * @returns {{assets: {rel_path:string,mime:string,bytes_b64:string}[], missing:number, tooBig:number}}
 */
/** 取图兜底链：预览能看到，分享就带得走。
 *  ① /ws-asset/{引用里的wsId}/{文件} —— 精确（v2.3.1 语义：ws_ 段是工作区 id）；
 *  ② /source/{引用路径} —— 编辑器预览用的同一端点，自带兜底：ws id 失效
 *     （工作区重建换 id 等）时按文件名扫描所有工作区的 source/ 目录。
 *     此前只有①，工作区重建后老文档里的旧 ws id 查无此工作区 → 全部 404
 *     且静默计「未找到」，出现「预览有图、分享丢图」的分叉。 */
export function fetchCandidates(target) {
  const urls = [wsAssetUrl(target.wsId, target.fetchRel)];
  const viaSource = String(target.relPath || "").replace(/^source\//, "");
  if (viaSource) urls.push("/source/" + viaSource.split("/").map((s) => encodeURIComponent(s)).join("/"));
  return urls;
}

export async function collectShareAssets(wsId, content) {
  const result = { assets: [], missing: 0, tooBig: 0, truncated: 0 };
  const seen = new Set();
  for (const ref of extractAssetRefs(content)) {
    if (SHARE_VIDEO_EXT.test(ref) || !IMG_EXT.test(ref)) continue;
    const target = refToAsset(ref, wsId);
    if (!target || !target.fetchRel || seen.has(target.relPath)) continue;
    seen.add(target.relPath);
    // 超出上限如实计数，不静默截断（否则访客看到占位图，分享者以为全带上了）
    if (result.assets.length >= SHARE_ASSET_MAX) { result.truncated += 1; continue; }
    let blob = null;
    for (const url of fetchCandidates(target)) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) { blob = await res.blob(); break; }
      } catch (_) { /* 尝试下一跳 */ }
    }
    if (!blob) { result.missing += 1; continue; }
    const shrunk = await shrinkImageForShare(blob, mimeOfRef(target.fetchRel));
    if (!shrunk) { result.tooBig += 1; continue; }
    result.assets.push({ rel_path: target.relPath, mime: shrunk.mime, bytes_b64: shrunk.b64 });
  }
  return result;
}

/* ── 快照读写 ─────────────────────────────────────────────────
 * 直连数据库 REST（不走 SDK 的 query builder）：桌面端未登录时 SDK 会在
 * 「等 token」上无限挂起（真机上表现为点分享一直转圈），这里显式取 token、
 * 取不到就立刻报「请先登录」，失败可见。
 * 请求头只用平台 CORS 白名单内的项（Authorization / X-Wb-Webapp-Access-Key /
 * Content-Type / Prefer）——apikey 不在白名单，跨源预检会被拦。
 */
const REST_BASE = `${String(cloudEndpoint() || "").replace(/\/+$/, "")}/.cloud/database/rest/v1`;

function publishableKey() {
  return (window.__MT_CLOUD__ && window.__MT_CLOUD__.publishableKey) || "";
}

async function shareHeaders(extra = {}) {
  let token = null;
  try {
    token = await cloudClient().auth.getAccessToken();
  } catch (_) {
    token = null;
  }
  if (!token) throw new Error("请先登录云账号再分享（登录后重试）");
  return Object.assign(
    {
      authorization: `Bearer ${token}`,
      "x-wb-webapp-access-key": publishableKey(),
      accept: "application/json",
    },
    extra,
  );
}

function encEq(value) {
  return `eq.${encodeURIComponent(String(value))}`;
}

async function restRequest(table, { method = "GET", query = "", body = null } = {}) {
  // Prefer 一律带上：写/删操作必须**读回**受影响的行才能判断是否真的生效
  // （被 RLS 拦下时 PostgREST 返回成功状态码 + 空数组，不读回就会误报成功）；
  // 对 GET 无副作用，省得按方法分叉。
  const extra = { prefer: "return=representation" };
  if (body) extra["content-type"] = "application/json";
  const headers = await shareHeaders(extra);
  const res = await fetch(`${REST_BASE}/${table}${query}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error_description || data.error)) || `HTTP ${res.status}`;
    throw new Error(String(msg).slice(0, 200));
  }
  return data;
}

function shareErrMsg(err) {
  return String((err && (err.message || err.error_description)) || err || "未知错误");
}

/** 找到这篇文档「未撤销」的分享（有则复用刷新，避免点一次多一条链接）。 */
async function findLiveShare(workspace, relPath) {
  const rows = await restRequest("shared_docs", {
    query: `?select=id,expires_at&workspace=${encEq(workspace)}&rel_path=${encEq(relPath)}&revoked=eq.false&limit=1`,
  });
  return (Array.isArray(rows) && rows[0]) || null;
}

/**
 * 写一条分享快照（含自动过期）。
 * @returns {Promise<{id:string, expiresAt:string|null}>}
 */
export async function writeShare({ workspace, relPath, title, content, assets = [] }) {
  const ttl = shareTtlDays();
  const isHtml = HTML_DOC_EXT.test(relPath || "");
  // HTML 文档先剥离成 WAF 安全形态（与云同步同一份函数）；注意它返回
  // { text, changed, removed } 而不是字符串。Markdown 原样即可。
  const safeContent = isHtml
    ? stripCloudUnsafeHtml(String(content || "")).text
    : String(content || "");
  const expiresAt = expiresAtFromTtl(ttl);
  // 体积上限：放过去只会在网关/WAF 处被截断，前端再误报成「网络不畅」
  const contentBytes = utf8Bytes(safeContent);
  if (contentBytes > SHARE_CONTENT_MAX_BYTES) {
    throw new Error(
      `正文约 ${(contentBytes / 1048576).toFixed(1)}MB，超过单篇分享上限 ` +
      `${(SHARE_CONTENT_MAX_BYTES / 1048576).toFixed(1)}MB，请拆分后再分享`
    );
  }
  const assetBytes = assets.reduce((n, a) => n + String(a.bytes_b64 || "").length, 0);
  if (assetBytes > SHARE_ASSETS_TOTAL_MAX_BYTES) {
    throw new Error(
      `本次要带走的图片合计约 ${(assetBytes / 1048576).toFixed(1)}MB，超过 ` +
      `${(SHARE_ASSETS_TOTAL_MAX_BYTES / 1048576).toFixed(0)}MB 上限，请精简图片后再分享`
    );
  }
  const row = {
    workspace,
    rel_path: relPath,
    title: title || String(relPath || "").split("/").pop() || "笔记",
    content: safeContent,
    asset_count: assets.length,
    expires_at: expiresAt,
  };

  const existing = await findLiveShare(workspace, relPath);
  let id = existing ? existing.id : null;

  if (id) {
    const updated = await restRequest("shared_docs", {
      method: "PATCH",
      query: `?id=${encEq(id)}`,
      body: row,
    });
    // 写操作必须读回：返回空 = 被 RLS 拦下，不能当成功
    if (!Array.isArray(updated) || !updated.length) throw new Error("分享刷新没有生效（可能被权限拦下）");
    // 覆盖式刷新：先清旧图，否则刚删掉的图会一直留在分享里
    await restRequest("shared_assets", { method: "DELETE", query: `?share_id=${encEq(id)}` });
  } else {
    id = newShareId();
    const inserted = await restRequest("shared_docs", {
      method: "POST",
      body: Object.assign({ id }, row),
    });
    if (!Array.isArray(inserted) || !inserted.length) throw new Error("分享没有写进云端（可能被权限拦下）");
  }

  if (assets.length) {
    const inserted2 = await restRequest("shared_assets", {
      method: "POST",
      body: assets.map((a) => Object.assign({ share_id: id }, a)),
    });
    if (!Array.isArray(inserted2) || !inserted2.length) throw new Error("分享图片没有写进云端");
  }
  return { id, expiresAt };
}

/** 我的分享（未撤销，含已过期但尚未清理的） */
export async function readMyShares() {
  const rows = await restRequest("shared_docs", {
    query: "?select=id,title,workspace,rel_path,created_at,asset_count,expires_at&revoked=eq.false&order=created_at.desc&limit=50",
  });
  return Array.isArray(rows) ? rows : [];
}

/** 撤销即失效：RLS 立刻停止下发正文与图片 */
/**
 * 撤销 = **删除数据**，不是打标记。只置 revoked 的话正文与图片仍留在云端
 * （只是 RLS 不让匿名读），属于「以为删了、其实还在」。
 * 顺序必须是「先删资产、再删主表」：资产表没有 FK 级联，反了会留孤儿行。
 */
export async function revokeShare(id) {
  await restRequest("shared_assets", {
    method: "DELETE",
    query: `?share_id=${encEq(id)}`,
  });
  const rows = await restRequest("shared_docs", {
    method: "DELETE",
    query: `?id=${encEq(id)}`,
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error("删除没有生效");
}

export { shareErrMsg, findLiveShare };
