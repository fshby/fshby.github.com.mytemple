#!/usr/bin/env node
// 把 frontend/styles/ 的 5 个层源文件按文件名字典序合并为 public/styles.css。
//
// 为什么按「文件名顺序」而不是显式列表：CSS 级联顺序 = 规则出现顺序，
// 层与层之间的覆盖关系依赖这个顺序（例如 05 层的 PR-4 规则覆盖 02 层的基座规则）。
// 改动样式请改层源文件，然后运行 `npm run build:css`；直接改 public/styles.css
// 会在下次合并时被覆盖 —— tests/css-architecture.test.js 会拦住这种改动。
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "frontend", "styles");
const OUT = join(ROOT, "public", "styles.css");
const EXPECTED_LAYERS = 5;

const files = readdirSync(SRC).filter((f) => f.endsWith(".css")).sort();
if (files.length !== EXPECTED_LAYERS) {
  throw new Error(`frontend/styles/ 应有 ${EXPECTED_LAYERS} 个层文件，实际 ${files.length}：${files.join(", ")}`);
}

const parts = files.map((f) => readFileSync(join(SRC, f), "utf8"));
// 直接拼接：除最后一层外，每个层文件都自带行尾换行（迁移时从原文件按行切出），
// 再额外插分隔符会产生多余的空行，并破坏「去层头 == 原文件」的逐字节性质。
const merged = parts.join("");

// 合并结果必须括号/注释平衡 —— 防止某层被截断后悄悄产出一个坏产物
let depth = 0, inComment = false;
for (let i = 0; i < merged.length; i++) {
  const ch = merged[i];
  if (inComment) { if (ch === "*" && merged[i + 1] === "/") { inComment = false; i++; } continue; }
  if (ch === "/" && merged[i + 1] === "*") { inComment = true; i++; continue; }
  if (ch === "{") depth++;
  else if (ch === "}") depth--;
  if (depth < 0) throw new Error(`合并结果出现多余的 }（offset ${i}）`);
}
if (depth !== 0 || inComment) throw new Error("合并结果括号/注释不平衡");

writeFileSync(OUT, merged);
console.log(`build-css: ${files.join(" + ")} → public/styles.css (${Buffer.byteLength(merged)} bytes)`);
