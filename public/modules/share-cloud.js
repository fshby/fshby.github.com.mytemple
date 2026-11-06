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
import { cloudClient, cloudReady, stripCloudUnsafeHtml, CLOUD_WORKBENCH_URL, cloudEndpoint } from "./cloud-client.js";

/** 与云端工作台同名同值：有效期记忆存在 localStorage，两端心智一致。 */
const SHARE_TTL_KEY = "shareTtlDays";
export const SHARE_TTL_CHOICES = [1, 7, 30, 0];
const SHARE_TTL_DEFAULT = 7;

const SHARE_PATH = "share.html";
/** 单篇最多带走的图片数（与云端页一致：再多就该直接给原文）。 */
const SHARE_ASSET_MAX = 20;
/** 小图原样带走，不重编码（截图小字不会被转糊）。 */
const SHARE_ASSET_KEEP_BYTES = 260 * 1024;
/** 压缩后仍超限则放弃（页面显示占位，不静默丢）。 */
const SHARE_ASSET_MAX_BYTES = 420 * 1024;
const SHARE_MAX_WIDTH = 1080;
const SHARE_QUALITY = 0.72;
const SHARE_VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;
const IMG_EXT = /\.(png|jpe?g|jfif|gif|webp|avif|bmp|svg)$/i;
const HTML_DOC_EXT = /\.html?$/i;

export function shareTtlDays() {
  // 注意 Number(null) === 0：未设置过时不能当成「永久」，必须先判空串/null
  const raw = localStorage.getItem(SHARE_TTL_KEY);
  if (raw === null || raw === "") return SHARE_TTL_DEFAULT;
  const v = Number(raw);
  return SHARE_TTL_CHOICES.includes(v) ? v : SHARE_TTL_DEFAULT;
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

/** 分享页部署在云端工作台同源下（桌面端不带自己的域名）。 */
export function shareLink(id) {
  const base = String(CLOUD_WORKBENCH_URL || "").replace(/\/+$/, "");
  return `${base}/${SHARE_PATH}?d=${id}`;
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

function mimeOfRef(rel) {
  const ext = String(rel || "").split(".").pop().toLowerCase();
  const map = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml" };
  return map[ext] || "application/octet-stream";
}

/** 从正文取图片引用（`![]()`、`<img|video|source src>` 四种写法，与云端同一条正则）。 */
function extractAssetRefs(text) {
  const src = String(text || "");
  const out = [];
  const re = /!\[[^\]]*\]\(\s*<?([^)>\s]+)[^)]*\)|<(?:img|video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const u = m[1] || m[2];
    if (u && !/^(https?:|data:|blob:)/i.test(u)) out.push(u);
  }
  return out;
}

/** 引用 → source/ 下的相对路径（文档里写 `source/x.png` 或 `./img/x.png` 都能落到同一处）。 */
function sourceRelative(ref) {
  const clean = String(ref || "").split("#")[0].split("?")[0].trim();
  if (!clean || clean.startsWith("..")) return "";
  const noDot = clean.replace(/^\.\//, "").replace(/^\/+/, "");
  if (noDot.startsWith("source/")) return noDot.slice("source/".length);
  return noDot;
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
export async function collectShareAssets(wsId, content) {
  const result = { assets: [], missing: 0, tooBig: 0 };
  const seen = new Set();
  for (const ref of extractAssetRefs(content)) {
    if (result.assets.length >= SHARE_ASSET_MAX) break;
    if (SHARE_VIDEO_EXT.test(ref) || !IMG_EXT.test(ref)) continue;
    const rel = sourceRelative(ref);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    let blob = null;
    try {
      const res = await fetch(wsAssetUrl(wsId, rel), { cache: "no-store" });
      if (res.ok) blob = await res.blob();
    } catch (_) { /* 下面按 missing 计 */ }
    if (!blob) { result.missing += 1; continue; }
    const shrunk = await shrinkImageForShare(blob, mimeOfRef(rel));
    if (!shrunk) { result.tooBig += 1; continue; }
    result.assets.push({ rel_path: rel, mime: shrunk.mime, bytes_b64: shrunk.b64 });
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
  const headers = await shareHeaders(body ? { "content-type": "application/json", prefer: "return=representation" } : {});
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
  const expiresAt = ttl ? new Date(Date.now() + ttl * 864e5).toISOString() : null;
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
export async function revokeShare(id) {
  const rows = await restRequest("shared_docs", {
    method: "PATCH",
    query: `?id=${encEq(id)}`,
    body: { revoked: true },
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error("撤销没有生效");
}

export { shareErrMsg, findLiveShare };
