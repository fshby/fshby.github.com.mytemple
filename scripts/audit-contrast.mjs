#!/usr/bin/env node
// 强调底可访问性审计（WCAG 2.x 对比度实测）。
//
// 用法：node scripts/audit-contrast.mjs
// 退出码：0 = 全部达标；1 = 有不达标项。
//
// 为什么需要它：颜色回归是最难被肉眼发现的缺陷 —— 深色主题下把强调底调亮 20%，
// 用户看到的是「按钮上的字有点糊」，而不是一个报错。CI 里跑不了浏览器，所以这里
// 在提交前手动跑一次（与 scripts/verify-baseline.mjs 同一套思路）。
//
// 判据：正文/图标文字 ≥ 4.5:1（WCAG AA），图形元素 ≥ 3.0:1。
// 关键实现细节（都是踩过的坑）：
//   · var()/color-mix() 的计算值可能输出 color(srgb r g b [/ a])，必须单独解析
//   · 半透明底色要先按 alpha 沿祖先链向上合成，否则对比度会算错
//   · 主题切换带过渡动画（--dur-1/--dur-2），等待不足会取到过渡中间值
//     （曾把 dark 的 button.primary 误报成 1.86:1，真实值 9.01:1）
//   · 渐变背景要取所有色标中最差的那一档
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 Edge（Chromium）。本脚本需要真实浏览器，跳过。");
  process.exit(0);
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(readFileSync(join(ROOT, "tests", "fixtures", "contrast-probe.html")));
    return;
  }
  const f = join(ROOT, "public", normalize(p));
  if (!existsSync(f)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const puppeteer = (await import("puppeteer-core")).default;
const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });

/** 支持 rgb()/rgba()/oklab 之外的两种实际会出现的计算值格式。 */
function parseColor(s) {
  const str = String(s).trim();
  let m = str.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  m = str.match(/^color\(srgb\s+([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
    return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}
const composite = (fg, bg) =>
  fg.a >= 1
    ? fg
    : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
const lum = (c) => {
  const f = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

async function readEl(sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const cs = getComputedStyle(el);
    // 祖先链背景逐层合成：从父节点向上，遇到不透明层即停止
    const chain = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      chain.push(c);
      const p = c.match(/^rgba?\(([^)]+)\)$/);
      if (p) {
        const v = p[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        if ((v.length > 3 ? v[3] : 1) >= 0.999) break;
      }
      if (/^color\(srgb\s+[^/)]+\)$/.test(c)) break;
    }
    return { bgc: cs.backgroundColor, bgi: cs.backgroundImage, color: cs.color, chain };
  }, sel);
}

function baseOf(chain) {
  let base = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const c = parseColor(chain[i]);
    if (c) base = composite(c, base);
  }
  return base;
}

const THEMES = ["light", "dark", "eye", "glow"];
// 文字目标（≥4.5:1）：覆盖全部「实心/半透明强调底 + 其上的文字」
const TEXT_TARGETS = [
  ["主按钮 button.primary", "#primary"],
  ["模式切换 active", "#vms"],
  ["图谱按钮 active", "#graphBtn"],
  ["全宽主按钮", "#primaryFull"],
  ["最近文档 active", "#recent"],
  ["关于面板头", "#aboutHeader"],
  ["打赏面板头", "#donationHeader"],
  ["更新面板头", "#updateHeader"],
  ["品牌角标", "#brandMark"],
  ["代码复制按钮", "#codeCopy"],
  ["工作区默认徽标", "#wsChip"],
  ["模板选择 active", "#cwc"],
  ["分段控件 active", "#seg"],
  ["浏览器搜索提示", "#bsh"],
  ["浏览器底部主按钮", "#bfp"],
  ["AI 行内提交", "#ais"],
  ["工作区开关", "#wst"],
  ["md 标签", "#mdTag"],
];
// 图形目标（≥3.0:1）
const GRAPHIC_TARGETS = [["进度条填充（图形 ≥3）", "#prog"]];

let fail = 0;
console.log("=== 强调底可访问性实测（正文 ≥4.5:1 / 图形 ≥3.0:1）===\n");
for (const theme of THEMES) {
  await page.evaluate((d) => {
    document.body.dataset.theme = d;
  }, theme);
  // 主题切换会触发 color/background 过渡（--dur-1/--dur-2 = 120/200ms）。
  await new Promise((r) => setTimeout(r, 450));
  const onAccent = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--on-accent").trim());
  console.log(`\n【${theme}】 --on-accent=${onAccent}`);

  for (const [label, sel] of TEXT_TARGETS) {
    const r = await readEl(sel);
    if (!r) {
      console.log(`  ${label.padEnd(20)} 元素缺失（夹具需同步真实标记）`);
      fail += 1;
      continue;
    }
    const base = baseOf(r.chain);
    const stops = [...String(r.bgi).matchAll(/(?:rgba?\([^)]*\)|color\(srgb[^)]*\))/g)].map((m) => m[0]);
    const shots = stops.length >= 2 ? stops : [r.bgc];
    let worst = Infinity;
    let detail = "";
    for (const s of shots) {
      const c = parseColor(s);
      if (!c || c.a < 0.02) continue;
      const bg = composite(c, base);
      const fg = composite(parseColor(r.color) || { r: 0, g: 0, b: 0, a: 1 }, bg);
      const cr = contrast(fg, bg);
      if (cr < worst) {
        worst = cr;
        detail = s.slice(0, 34);
      }
    }
    if (!isFinite(worst)) {
      console.log(`  ${label.padEnd(20)} 无法取值（底色透明）`);
      continue;
    }
    const ok = worst >= 4.5;
    if (!ok) fail += 1;
    console.log(`  ${label.padEnd(20)} ${worst.toFixed(2)}:1 ${ok ? "✓" : "✗ 不达标"}   [${detail.trim()}]`);
  }

  for (const [label, sel] of GRAPHIC_TARGETS) {
    const r = await readEl(sel);
    if (!r) continue;
    const base = baseOf(r.chain);
    const c = parseColor(r.bgc);
    if (!c || c.a < 0.02) {
      console.log(`  ${label.padEnd(20)} 透明`);
      continue;
    }
    const cr = contrast(composite(c, base), base);
    const ok = cr >= 3.0;
    if (!ok) fail += 1;
    console.log(`  ${label.padEnd(20)} ${cr.toFixed(2)}:1 ${ok ? "✓" : "✗ 不达标"}  (相对其底色)`);
  }
}

console.log(`\n>>> 不达标项：${fail}`);
await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
