#!/usr/bin/env node
/**
 * 把 shared/share-core.js 生成成两份同名产物：
 *   public/modules/share-core.js  （桌面端 ESM，import 使用）
 *   cloud/share-core.js           （云端站点 ESM，import 使用）
 *
 * 生成物带源文件 sha256 水印，tests/share-core-sync.test.js 会比对
 * 「水印 == 当前源文件哈希」且「两份生成物逐字节相同」，
 * 因此只改生成物、或改了源忘了重新生成，测试都会失败。
 *
 * 用法：npm run build:share
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "shared", "share-core.js");
const OUTS = [
  path.join(ROOT, "public", "modules", "share-core.js"),
  path.join(ROOT, "cloud", "share-core.js"),
];

const source = fs.readFileSync(SRC);
const hash = crypto.createHash("sha256").update(source).digest("hex");
const banner = [
  "// ⚠️ 自动生成，请勿直接编辑 —— 源文件 shared/share-core.js",
  `// source-sha256: ${hash}`,
  "// 改逻辑 → 改源文件 → npm run build:share；tests/share-core-sync.test.js 会校验水印。",
].join("\n");

for (const out of OUTS) {
  await build({
    entryPoints: [SRC],
    outfile: out,
    bundle: true,
    format: "esm",
    target: "es2020",
    legalComments: "none",
    banner: { js: banner },
    logLevel: "warning",
  });
  const size = fs.statSync(out).size;
  console.log(`generated ${path.relative(ROOT, out)} (${size} bytes)`);
}
console.log(`source-sha256 ${hash}`);
