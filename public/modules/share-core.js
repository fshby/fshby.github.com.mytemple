// ⚠️ 自动生成，请勿直接编辑 —— 源文件 shared/share-core.js
// source-sha256: 9171239722a0dc5d74122f9c51171f3ce8ba3d7b00bf9223aced81a17ff7dbb6
// 改逻辑 → 改源文件 → npm run build:share；tests/share-core-sync.test.js 会校验水印。

// shared/share-core.js
var SHARE_TTL_CHOICES = [1, 7, 30, 0];
var SHARE_TTL_DEFAULT = 7;
var SHARE_ASSET_MAX = 20;
var SHARE_ASSET_KEEP_BYTES = 260 * 1024;
var SHARE_ASSET_MAX_BYTES = 420 * 1024;
var SHARE_MAX_WIDTH = 1080;
var SHARE_QUALITY = 0.72;
var SHARE_CONTENT_MAX_BYTES = 15e5;
var SHARE_ASSETS_TOTAL_MAX_BYTES = 6e6;
var SHARE_VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;
var IMG_EXT = /\.(png|jpe?g|jfif|gif|webp|avif|bmp|svg)$/i;
var HTML_DOC_EXT = /\.(html?|xhtml)$/i;
function normalizeSharePath(p) {
  const out = [];
  String(p || "").replace(/\\/g, "/").split("/").forEach((seg) => {
    if (!seg || seg === ".") return;
    if (seg === "..") {
      out.pop();
      return;
    }
    out.push(seg);
  });
  return out.join("/");
}
function assetCandidates(ref, docRel) {
  const raw = String(ref || "").trim();
  if (!raw || /^(https?:|data:|blob:|mailto:|javascript:)/i.test(raw)) return [];
  let p = raw.split("#")[0].split("?")[0];
  try {
    p = decodeURIComponent(p);
  } catch (_) {
  }
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
function refToAsset(ref, fallbackWsId) {
  const clean = String(ref || "").split("#")[0].split("?")[0].trim();
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
function mimeOfRef(rel) {
  const ext = String(rel || "").split(".").pop().toLowerCase();
  const map = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    jfif: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml"
  };
  return map[ext] || "application/octet-stream";
}
function parseShareTtl(raw, choices = SHARE_TTL_CHOICES, fallback = SHARE_TTL_DEFAULT) {
  if (raw === null || raw === void 0 || raw === "") return fallback;
  const v = Number(raw);
  return choices.includes(v) ? v : fallback;
}
function expiresAtFromTtl(ttlDays, now = Date.now()) {
  return ttlDays ? new Date(now + ttlDays * 864e5).toISOString() : null;
}
function utf8Bytes(text) {
  const s = String(text == null ? "" : text);
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) n += 1;
    else if (c < 2048) n += 2;
    else if (c >= 55296 && c <= 56319) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
export {
  HTML_DOC_EXT,
  IMG_EXT,
  SHARE_ASSETS_TOTAL_MAX_BYTES,
  SHARE_ASSET_KEEP_BYTES,
  SHARE_ASSET_MAX,
  SHARE_ASSET_MAX_BYTES,
  SHARE_CONTENT_MAX_BYTES,
  SHARE_MAX_WIDTH,
  SHARE_QUALITY,
  SHARE_TTL_CHOICES,
  SHARE_TTL_DEFAULT,
  SHARE_VIDEO_EXT,
  assetCandidates,
  expiresAtFromTtl,
  extractAssetRefs,
  mimeOfRef,
  normalizeSharePath,
  parseShareTtl,
  refToAsset,
  utf8Bytes
};
