// highlight.js 语言覆盖测试
// 目的：app.js 的 HLJS_SUPPORTED 白名单声称支持的语言，必须在浏览器里真正可解析。
// 历史上白名单写了 bat/tex/scala 等语言，但 langs/ 下没有对应语言包，
// 导致控制台出现 "Could not find the language 'bat'" 并退化为无高亮。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const vendor = path.join(root, "public", "vendor", "highlight");

function loadHljs() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(vendor, "highlight.min.js"), "utf8"), sandbox, {
    filename: "highlight.min.js",
  });
  const langDir = path.join(vendor, "langs");
  for (const f of fs.readdirSync(langDir)) {
    vm.runInContext(fs.readFileSync(path.join(langDir, f), "utf8"), sandbox, { filename: f });
  }
  assert.ok(sandbox.hljs && typeof sandbox.hljs.getLanguage === "function", "highlight.js 未能初始化");
  return sandbox.hljs;
}

function declaredLanguages() {
  const src = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const m = src.match(/const HLJS_SUPPORTED = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, "未在 app.js 中找到 HLJS_SUPPORTED 白名单");
  return [...new Set((m[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, "")))];
}

test("HLJS_SUPPORTED 白名单中的每个语言都已加载", () => {
  const hljs = loadHljs();
  const missing = declaredLanguages().filter((l) => !hljs.getLanguage(l));
  assert.deepEqual(missing, [], `以下语言在白名单中但缺少语言包：${missing.join(", ")}`);
});

test("index.html 引用的扩展语言包文件都存在", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const refs = [...html.matchAll(/src="\/vendor\/highlight\/(langs\/[^"?]+)/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, "index.html 未引用任何扩展语言包");
  const missing = refs.filter((r) => !fs.existsSync(path.join(root, "public", "vendor", "highlight", r)));
  assert.deepEqual(missing, [], `index.html 引用了不存在的语言包：${missing.join(", ")}`);
});

test("exportDocImages 不再引用未声明的 urlSet（历史 bug 回归防护）", () => {
  const src = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const start = src.indexOf("async function exportDocImages()");
  assert.ok(start > -1, "未找到 exportDocImages");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.ok(body.includes("const imgUrlSet = new Set()"), "exportDocImages 应声明 imgUrlSet");
  // 该函数曾写成 [...urlSet]，urlSet 从未声明 → 每次导出图片都抛 ReferenceError
  assert.ok(!/(?<![.\w$])urlSet\b/.test(body), "exportDocImages 引用了未声明的 urlSet");
  const filterLine = body.split("\n").find((l) => l.includes(".filter((url)"));
  assert.ok(filterLine && filterLine.includes("imgUrlSet"), "过滤本地资源时应使用 imgUrlSet");
});
