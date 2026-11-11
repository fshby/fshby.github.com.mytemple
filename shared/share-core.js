// shared/share-core.js — 临时分享的**唯一实现源**
//
// 为什么要有这个文件：桌面端（public/modules/share-cloud.js）与云端工作台
// （cloud/app.js、cloud/share.js）各写过一份「引用 → 资产键」的解析逻辑，
// 靠人工对齐。2026-11-06 一天内因此炸了三次线上事故：
//   ① `ws_` 段被当成 source/ 下的子文件夹 → 全部 404，图片全丢；
//   ② 取到了图但写库键与读侧候选不同构 → 访客侧匹配不上，仍然白框；
//   ③ 工作区重建换 id 后精确通道 404，没有兜底 → 老文档图片再次丢失。
// 现在三端都 import 这一份（`npm run build:share` 生成同名产物到
// public/modules/ 与 cloud/），tests/share-core-sync.test.js 锁住「生成物
// 必须与源文件同步」，任何人只改生成物都会被测试拦下。
//
// 约束：纯函数、不碰 DOM / 网络 / localStorage —— 这样 Node 单测能直接跑。

/** 有效期档位（天）。0 = 永久。 */
export const SHARE_TTL_CHOICES = [1, 7, 30, 0];
export const SHARE_TTL_DEFAULT = 7;

/** 单篇最多带走的图片数。 */
export const SHARE_ASSET_MAX = 20;
/** 小图原样带走（截图小字不会被转糊）。 */
export const SHARE_ASSET_KEEP_BYTES = 260 * 1024;
/** 压缩后仍超限则放弃（页面显示占位，不静默丢）。 */
export const SHARE_ASSET_MAX_BYTES = 420 * 1024;
export const SHARE_MAX_WIDTH = 1080;
export const SHARE_QUALITY = 0.72;

/**
 * 正文字节上限。超了直接拒绝并给明确原因，而不是让平台 WAF / 网关
 * 在传输中途截断、前端再把它误报成「网络不畅」。
 */
export const SHARE_CONTENT_MAX_BYTES = 1_500_000;
/** 单篇分享图片总字节上限（base64 后的体积约为原字节 1.34 倍）。 */
export const SHARE_ASSETS_TOTAL_MAX_BYTES = 6_000_000;

export const SHARE_VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;
export const IMG_EXT = /\.(png|jpe?g|jfif|gif|webp|avif|bmp|svg)$/i;
export const HTML_DOC_EXT = /\.(html?|xhtml)$/i;

/**
 * 引用路径归一化：统一分隔符、去掉 `.` 段、`..` 回退一级、去掉首尾斜杠。
 * 注意这是「访客侧匹配键」的归一规则，不能把 `..` 直接删掉（那会把
 * `a/../b` 变成 `a/b`，与真实文件对不上）——这里用栈回退。
 */
export function normalizeSharePath(p) {
  const out = [];
  String(p || "").replace(/\\/g, "/").split("/").forEach((seg) => {
    if (!seg || seg === ".") return;
    if (seg === "..") { out.pop(); return; }
    out.push(seg);
  });
  return out.join("/");
}

/**
 * 正文里可能指向「随分享带走的资源」的引用候选键（读侧用）。
 *
 * 顺序即优先级，必须与写侧 `refToAsset().relPath` 落在同一套键上：
 *   1. `ws-asset/<ws>/x.png` 这种旧写法先换算成 `source/x.png`；
 *   2. 引用原样归一；
 *   3. 再试「文档所在目录 + 引用」（相对引用的常见写法）。
 */
export function assetCandidates(ref, docRel) {
  const raw = String(ref || "").trim();
  if (!raw || /^(https?:|data:|blob:|mailto:|javascript:)/i.test(raw)) return [];
  let p = raw.split("#")[0].split("?")[0];
  try { p = decodeURIComponent(p); } catch (_) { /* 保留原样 */ }
  p = normalizeSharePath(p);
  if (!p || p.split("/").some((s) => s === "..")) return [];

  const out = [];
  const wsAsset = p.match(/^ws-asset\/[^/]+\/(.+)$/);
  if (wsAsset) out.push(normalizeSharePath("source/" + wsAsset[1]));
  out.push(p);

  const dir = normalizeSharePath(docRel || "").split("/").slice(0, -1).join("/");
  if (dir) out.push(normalizeSharePath(dir + "/" + p));

  return [...new Set(out.filter((x) => x && !x.split("/").some((s) => s === ".." || s === ".")))];
}

/**
 * 引用 → 资产定位（写侧用）。
 * 返回 { wsId, fetchRel, relPath }：
 *  - relPath：写进 shared_assets 的键，必须与 `assetCandidates` 的首个候选同构；
 *  - wsId + fetchRel：本机取字节用。`/source/ws_xxx/f.webp` 的 ws_ 段是
 *    **工作区 id**（桌面后端 serve_source 同一解析），不是 source/ 下的子文件夹。
 * 解析失败返回 null。
 */
export function refToAsset(ref, fallbackWsId) {
  const clean = String(ref || "").split("#")[0].split("?")[0].trim();
  // 含 `..` 一律拒绝：写侧宁可不带走，也不猜路径（读侧另有按目录的候选兜底）；
  // 外链 / data: / blob: 不是本机文件，同样不解析（与读侧 assetCandidates 同口径）
  if (!clean || clean.includes("..") || /^(https?:|data:|blob:|mailto:|javascript:)/i.test(clean)) return null;
  const p = normalizeSharePath(clean);
  if (!p) return null;
  let wsId = fallbackWsId;
  let fetchRel = p;
  const m = p.match(/^(?:source\/)?(ws_[A-Za-z0-9]+)\/(.+)$/);
  if (m) {
    wsId = m[1];
    fetchRel = m[2];
  } else if (p.startsWith("source/")) {
    fetchRel = p.slice("source/".length);
  }
  return { wsId, fetchRel, relPath: p };
}

/** 从正文取资源引用（`![]()`、`<img|video|source src>` 四种写法）。 */
export function extractAssetRefs(text) {
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

/** 扩展名 → MIME（分享里只带图片，其余按二进制兜底）。 */
export function mimeOfRef(rel) {
  const ext = String(rel || "").split(".").pop().toLowerCase();
  const map = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg",
    gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  return map[ext] || "application/octet-stream";
}

/**
 * localStorage 里的有效期读数。
 * `Number(null) === 0` 会被当成「永久有效」——必须先判空串/null，
 * 这个坑在桌面端与云端各踩过一次（隐私风险：以为设了 7 天，其实永不过期）。
 */
export function parseShareTtl(raw, choices = SHARE_TTL_CHOICES, fallback = SHARE_TTL_DEFAULT) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  return choices.includes(v) ? v : fallback;
}

/** 到期时间（ISO）或 null（永久）。 */
export function expiresAtFromTtl(ttlDays, now = Date.now()) {
  return ttlDays ? new Date(now + ttlDays * 864e5).toISOString() : null;
}

/** 文本的 UTF-8 字节数（用于体积上限判定）。 */
export function utf8Bytes(text) {
  const s = String(text == null ? "" : text);
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  // 老 WebView 兜底：手算 UTF-8 长度
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
