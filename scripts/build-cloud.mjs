/**
 * 把桌面端已验证的 Markdown 渲染器同步到云端工作台。
 *
 * 为什么要复制：云端工作台是独立发布的静态站点（发布目录 = cloud/），
 * 不能反向引用 public/ 下的文件；而渲染必须是同一份实现，否则两端排版会分叉。
 * 所以以 public/markdown-worker.js 为唯一事实源，构建时拷贝。
 *
 * 用法：npm run build:cloud
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname || ".", "..");
const src = path.join(root, "public", "markdown-worker.js");
const dst = path.join(root, "cloud", "markdown-worker.js");

if (!existsSync(src)) {
  console.error("[build:cloud] 找不到源文件：" + src);
  process.exit(1);
}

const buf = readFileSync(src);
writeFileSync(dst, buf);

const sha = createHash("sha256").update(buf).digest("hex").slice(0, 12);
console.log(`[build:cloud] markdown-worker.js 已同步 -> cloud/ (${buf.length} B, sha256:${sha})`);
