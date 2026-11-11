#!/usr/bin/env node
/**
 * 静态资源缓存戳自动生成（取代人工「记得 +1」）。
 *
 * 为什么需要：缓存戳靠人手递增，改完 public/ 忘了改戳 → 老用户继续用缓存里的旧
 * app.js / styles.css，表现为「新功能没生效」「新旧文件混用报错」。2026-11 一个月里
 * 因此出过两次线上事故。
 *
 * 做法：把「参与打包的前端资源」内容拼起来算 sha256，取前 8 位，配合日期前缀写成
 * `YYYYMMDD-<hash8>`（形如 `20261111-3f9a2c1b`），只改 index.html 与 app.js 里的
 * `?v=` 值。内容没变 → 戳不变 → 无谓 diff 也没有。
 *
 * 用法：npm run stamp    （改完 public/ 资源后跑一次）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUB = path.join(ROOT, "public");

/** 参与指纹的文件（顺序固定，保证可复现）。 */
function assetFiles() {
  const files = [
    "app.js",
    "styles.css",
    "editor-core.js",
    "markdown-worker.js",
    "graph-worker.js",
    // 局域网访客页三件套（guest.html 引用 editor-core.js/styles.css 带同一戳，
    // 必须一起参与指纹，否则主资源更新后访客页拿旧 editor-core）
    "guest.js",
    "guest.css",
  ];
  const modules = fs
    .readdirSync(path.join(PUB, "modules"))
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => path.join("modules", f));
  return files.concat(modules);
}

const h = crypto.createHash("sha256");
for (const rel of assetFiles()) {
  const p = path.join(PUB, rel);
  if (!fs.existsSync(p)) continue;
  h.update(rel).update("\0").update(fs.readFileSync(p)).update("\0");
}
const digest = h.digest("hex").slice(0, 8);
const d = new Date();
const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
const next = `${ymd}-${digest}`;

/** 把文件里所有 `?v=<旧戳>` 换成新戳。 */
function restamp(file) {
  const p = path.join(ROOT, file);
  let s = fs.readFileSync(p, "utf8");
  const before = s;
  const olds = new Set([...s.matchAll(/\?v=([0-9a-zA-Z._-]+)/g)].map((m) => m[1]));
  // 云端资源自带 cloud-N 戳，不参与桌面端指纹
  const desktop = [...olds].filter((v) => !v.startsWith("cloud-"));
  for (const old of desktop) {
    if (old === next) continue;
    s = s.split(`?v=${old}`).join(`?v=${next}`);
  }
  if (s !== before) {
    fs.writeFileSync(p, s);
    console.log(`  restamped ${file} (${desktop.join(", ") || "无"} → ${next})`);
    return true;
  }
  return false;
}

let changed = false;
for (const f of ["public/index.html", "public/app.js", "public/guest.html", "public/guest.js"]) changed = restamp(f) || changed;
console.log(changed ? `缓存戳已更新为 ${next}` : `缓存戳无需变更（${next}）`);
