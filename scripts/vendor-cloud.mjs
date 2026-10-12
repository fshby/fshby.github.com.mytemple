/**
 * 把云端工作台依赖的第三方库自托管到 cloud/vendor/。
 *
 * ── 为什么必须自托管 ─────────────────────────────────────────────
 * 原先这些库全部挂在 cdn.jsdelivr.net 上。该主机名在部分网络（国内常见线路）
 * 下 TLS 连接会被直接重置，实测：
 *     curl https://cdn.jsdelivr.net/...   -> (35) Recv failure: Connection was reset
 *     curl https://unpkg.com/...          -> 200
 *     curl https://registry.npmjs.org/... -> 200
 * 即 DNS 能解析（151.101.x.x）但握手被打断 —— 是主机名级阻断，不是断网。
 *
 * 后果不是「图表不显示」这种降级，而是**登录整体不可用**：
 * 登录 SDK 也挂在这个主机上，脚本加载失败 → window.WorkBuddyCloud 为 undefined
 * → initClient() 抛错 → 验证码 / 微信 / 密码三条路全部失效。
 *
 * 因此改为下载进仓库、由站点同源提供。katex 的 CSS 与字体保持相对路径关系
 * （vendor/katex/katex.min.css 同目录下的 fonts/），换域名也不会失效。
 *
 * 版本全部固定，且与改动前线上实际加载的版本一致，避免顺带升级引入行为变化。
 *
 * 用法：
 *     npm run vendor:cloud            # 缺什么补什么（幂等）
 *     npm run vendor:cloud -- --force # 全部重下
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname || ".", "..");
const vendorDir = path.join(root, "cloud", "vendor");
const force = process.argv.includes("--force");

/** 下载源，按顺序回退。cdn.jsdelivr.net 被故意排除（见文件头注释）。 */
const MIRRORS = [
  (p) => `https://unpkg.com/${p}`,
  (p) => `https://fastly.jsdelivr.net/npm/${p}`,
];

/** 体积下限，用来识别「拿到的是错误页而不是真文件」。 */
const ASSETS = [
  {
    to: "sdk/workbuddy-cloud-sdk.global.js",
    pkg: "@tencent-ai/workbuddy-cloud-sdk@0.1.3-dev.c090db7.202610050023/lib/index.global.js",
    min: 50_000,
    why: "登录 SDK：验证码 / 微信 / 密码登录全靠它",
  },
  {
    to: "fflate/fflate.min.js",
    pkg: "fflate@0.8.2/umd/index.js",
    min: 20_000,
    why: "浏览器内解压 zip（拖入压缩包上传）",
  },
  {
    to: "mermaid/mermaid.min.js",
    pkg: "mermaid@11.12.2/dist/mermaid.min.js",
    min: 1_000_000,
    why: "笔记里的 Mermaid 图表",
  },
  {
    to: "katex/katex.min.js",
    pkg: "katex@0.16.9/dist/katex.min.js",
    min: 100_000,
    why: "笔记里的数学公式（脚本）",
  },
  {
    to: "katex/katex.min.css",
    pkg: "katex@0.16.9/dist/katex.min.css",
    min: 10_000,
    why: "笔记里的数学公式（样式 + 字体相对路径）",
  },
  {
    // 注意：chart.js v4 的 dist 里没有 chart.umd.min.js（那是 jsDelivr 自动生成的），
    // 压缩好的 UMD 构建就叫 chart.umd.js，用这个才是包里的原始文件。
    to: "chartjs/chart.umd.js",
    pkg: "chart.js@4.4.7/dist/chart.umd.js",
    min: 150_000,
    why: "笔记里的 Chart.js 图表（由 markdown-worker 在 iframe 内加载）",
  },
  {
    to: "echarts/echarts.min.js",
    pkg: "echarts@5.5.1/dist/echarts.min.js",
    min: 800_000,
    why: "笔记里的 ECharts 图表（由 markdown-worker 在 iframe 内加载）",
  },
];

/**
 * 需要同时镜像到桌面端 `public/vendor/` 的资产。
 *
 * 为什么：桌面端现在**直连**云服务数据面（实测 CORS 预检对 http://127.0.0.1:<port>
 * 完全放行，含 Authorization / Prefer / X-Wb-Webapp-Access-Key），因此 exe 也需要这份
 * SDK 来做登录。两端用**同一份文件**，避免出现两份实现各自漂移。
 */
const PUBLIC_MIRRORS = [
  { from: "sdk/workbuddy-cloud-sdk.global.js", what: "桌面端登录 SDK（与云端同源同版本）" },
];

/** 桌面端要读的公开配置：由 cloud/cloud-config.js 生成，保证两端键值完全一致。 */
const CONFIG_SRC = "cloud/cloud-config.js";
const CONFIG_DST = "public/cloud-config.js";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 把 cloud/ 下的文件按字节镜像到 public/；内容一致则跳过（幂等）。 */
function mirrorToPublic(relFrom) {
  const src = path.join(vendorDir, relFrom.split("/").join(path.sep));
  if (!existsSync(src)) throw new Error(`镜像源不存在：cloud/vendor/${relFrom}`);
  const dst = path.join(root, "public", "vendor", relFrom.split("/").join(path.sep));
  const buf = readFileSync(src);
  if (existsSync(dst) && sha256(readFileSync(dst)) === sha256(buf)) {
    console.log(`  镜像  public/vendor/${relFrom}  (${buf.length} B, 已一致)`);
    return { relTo: `public/vendor/${relFrom}`, size: buf.length, skipped: true };
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, buf);
  console.log(`  镜像  public/vendor/${relFrom}  (${buf.length} B, sha256:${sha256(buf).slice(0, 12)})`);
  return { relTo: `public/vendor/${relFrom}`, size: buf.length, skipped: false };
}

/**
 * 生成 public/cloud-config.js。
 *
 * 内容取自 cloud/cloud-config.js —— 单一事实源，两端键值必须一致（测试会比对）。
 * 只加一段「本文件由脚本生成、勿手改」的头注，其余逐字节照搬。
 */
function syncCloudConfig() {
  const src = readFileSync(path.join(root, CONFIG_SRC), "utf8").replace(/^\uFEFF/, "");
  const banner =
    "/* 本文件由 scripts/vendor-cloud.mjs 生成，请勿手改。\n" +
    " * 事实源：cloud/cloud-config.js（改那一个，再跑 npm run vendor:cloud）。\n" +
    " * 桌面端直连云服务数据面，因此需要与云端页完全相同的 endpoint / publishableKey。\n" +
    " */\n";
  const out = banner + src;
  const dst = path.join(root, CONFIG_DST);
  const before = existsSync(dst) ? readFileSync(dst, "utf8") : null;
  if (before === out) {
    console.log(`  生成  ${CONFIG_DST}  (${Buffer.byteLength(out)} B, 已一致)`);
    return { relTo: CONFIG_DST, size: Buffer.byteLength(out), skipped: true };
  }
  writeFileSync(dst, out);
  console.log(`  生成  ${CONFIG_DST}  (${Buffer.byteLength(out)} B)`);
  return { relTo: CONFIG_DST, size: Buffer.byteLength(out), skipped: false };
}

/** 依次尝试各镜像；任一成功即返回。全部失败才抛错。 */
async function download(pkgPath) {
  const errors = [];
  for (const mirror of MIRRORS) {
    const url = mirror(pkgPath);
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        errors.push(`${url} -> HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const head = buf.subarray(0, 200).toString("utf8").trimStart().toLowerCase();
      // 镜像返回错误页时通常是 HTML，这里挡掉
      if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
        errors.push(`${url} -> 返回 HTML 错误页`);
        continue;
      }
      return { buf, url };
    } catch (err) {
      errors.push(`${url} -> ${err && err.message ? err.message : err}`);
    }
  }
  throw new Error(`全部镜像均失败：\n      ${errors.join("\n      ")}`);
}

async function ensure(relTo, pkgPath, min, label) {
  const dst = path.join(vendorDir, relTo.split("/").join(path.sep));
  if (!force && existsSync(dst) && statSync(dst).size >= min) {
    const buf = readFileSync(dst);
    console.log(`  跳过  ${relTo}  (${buf.length} B, 已存在)`);
    return { relTo, size: buf.length, sha: sha256(buf), skipped: true };
  }

  const { buf, url } = await download(pkgPath);
  if (buf.length < min) {
    throw new Error(`${relTo} 体积异常：${buf.length} B < 下限 ${min} B（来源 ${url}）`);
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, buf);
  const sha = sha256(buf);
  console.log(`  下载  ${relTo}  (${buf.length} B, sha256:${sha.slice(0, 12)})  <- ${new URL(url).host}`);
  void label;
  return { relTo, size: buf.length, sha, skipped: false };
}

/** katex CSS 用相对路径引字体；只取 woff2（现代浏览器一律优先 woff2），
 *  这样字体目录与 CSS 的相对关系成立，且不必把 ttf/woff 也搬进来。 */
async function ensureKatexFonts(cssRel) {
  const cssAbs = path.join(vendorDir, cssRel.split("/").join(path.sep));
  const css = readFileSync(cssAbs, "utf8");
  const names = [...new Set(css.match(/fonts\/[A-Za-z0-9_.-]+\.woff2/g) || [])].sort();
  if (!names.length) throw new Error("katex.min.css 里没找到 woff2 字体引用");
  const results = [];
  for (const name of names) {
    results.push(
      await ensure(`katex/${name}`, `katex@0.16.9/dist/${name}`, 1_000, "katex 字体")
    );
  }
  return results;
}

console.log(`[vendor:cloud] 目标目录 ${path.relative(root, vendorDir)}`);
let total = 0;
const rows = [];

for (const a of ASSETS) {
  const r = await ensure(a.to, a.pkg, a.min, a.why);
  rows.push(r);
  total += r.size;
}

// 字体依赖 CSS 已经落地，必须放在 CSS 之后
const fontRows = await ensureKatexFonts("katex/katex.min.css");
for (const r of fontRows) {
  rows.push(r);
  total += r.size;
}

// 桌面端需要的同一份 SDK（exe 直连云服务数据面）+ 公开配置
console.log("\n[vendor:cloud] 镜像到桌面端 public/");
for (const m of PUBLIC_MIRRORS) {
  const r = mirrorToPublic(m.from);
  rows.push(r);
  total += r.size;
}
rows.push(syncCloudConfig());

console.log(`\n[vendor:cloud] 完成：${rows.length} 个文件，合计 ${(total / 1048576).toFixed(2)} MB`);
const skipped = rows.filter((r) => r.skipped).length;
if (skipped) console.log(`[vendor:cloud] 其中 ${skipped} 个已存在被跳过（--force 可强制重下）`);
console.log("[vendor:cloud] 这些文件由站点同源提供，页面不再依赖任何第三方 CDN。");
