/* 回归锁：桌面端第三方库必须全部同源自托管，不得再直连 cdn.jsdelivr.net。
 *
 * 背景（2026-11-12 真机反馈）：预览里所有 Mermaid 图表显示
 * 「Mermaid 库加载失败（需外网连接 CDN）」。实测
 *   curl https://cdn.jsdelivr.net/npm/mermaid@11.12.2/dist/mermaid.min.js
 *   -> (35) schannel: failed to receive handshake，HTTP 000 / 0 B / 0.34s
 * 是主机名级 TLS 阻断，不是断网（同一时间 unpkg.com 能返回 200）。
 * 云端早已由 scripts/vendor-cloud.mjs 把库下载进仓库同源提供，桌面端却只镜像了登录 SDK。
 * 本轮把同一批文件镜像到 public/vendor/，并让所有加载点指向它。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT));
const readText = (p) => read(p).toString("utf8");
const size = (p) => statSync(new URL(p, ROOT)).size;

const appSrc = readText("public/app.js");

const LIBS = [
  "mermaid/mermaid.min.js",
  "katex/katex.min.js",
  "katex/katex.min.css",
  "chartjs/chart.umd.js",
  "echarts/echarts.min.js",
];

test("桌面端 app.js 不再引用任何第三方 CDN 地址", () => {
  // 只禁「真实可加载的 URL」，注释里对主机名的说明不参与判断。
  assert.doesNotMatch(appSrc, /https:\/\/cdn\.jsdelivr\.net\/npm\//,
    "改回 CDN 会让国内线路整片图表与公式失效");
  assert.doesNotMatch(appSrc, /https:\/\/unpkg\.com\//, "不得改走其它第三方 CDN");
  assert.doesNotMatch(appSrc, /https:\/\/cdnjs\.cloudflare\.com\//, "不得改走其它第三方 CDN");
  assert.doesNotMatch(appSrc, /需外网连接 CDN/, "降级提示不应再把用户指向外网");
});

test("app.js 引用的每个 /vendor/ 资产都真实存在且非空", () => {
  // 只收集「文件」引用：注释里的 `public/vendor/katex/`、worker 的 `?assets=/vendor/`
  // 都是目录路径，statSync 在 Windows 上返回 0，不能当成资产做体积断言。
  const refs = [...new Set(
    [...appSrc.matchAll(/\/vendor\/[A-Za-z0-9_./-]+\.(?:js|css|woff2|json|map)/g)]
      .map((m) => m[0].slice("/vendor/".length))
  )];
  assert.ok(refs.length >= 5, `应至少引用 5 个 vendor 资产，实测 ${refs.length}`);
  // 5 个库是硬要求，不能因为源码里恰好没写全引用就跳过。
  for (const rel of [...new Set([...refs, ...LIBS])]) {
    const p = "public/vendor/" + rel;
    assert.ok(existsSync(new URL(p, ROOT)), `缺少 ${p}：跑 npm run vendor:cloud`);
    assert.ok(size(p) > 1000, `${p} 体积异常（可能下载到了错误页）`);
  }
});

test("桌面端与云端使用逐字节相同的库文件", () => {
  for (const rel of LIBS) {
    const a = read("public/vendor/" + rel);
    const b = read("cloud/vendor/" + rel);
    assert.ok(a.equals(b), `${rel} 两端不一致：跑 npm run vendor:cloud`);
  }
  // 必须是可直接用 <script src> 加载的 UMD/IIFE 构建，不能误换成 ESM 文件。
  const mmd = readText("public/vendor/mermaid/mermaid.min.js");
  assert.match(mmd.slice(-600), /globalThis\["mermaid"\]/, "本地 mermaid 必须是全局构建");
});

test("KaTeX 字体齐备（CSS 用相对路径引用 fonts/）", () => {
  const css = readText("public/vendor/katex/katex.min.css");
  const names = [...new Set([...css.matchAll(/fonts\/[A-Za-z0-9_.-]+\.woff2/g)].map((m) => m[0]))];
  assert.ok(names.length >= 10, `CSS 应引用多份 woff2，实测 ${names.length}`);
  for (const n of names) {
    const p = "public/vendor/katex/" + n;
    assert.ok(existsSync(new URL(p, ROOT)), `缺少字体 ${p}：跑 npm run vendor:cloud`);
    assert.ok(size(p) > 1000, `${p} 体积异常`);
  }
});

test("Mermaid / KaTeX / 图表模板都指向 /vendor/，且 worker 带 assets 参数", () => {
  assert.match(appSrc, /script\.src = "\/vendor\/mermaid\/mermaid\.min\.js\?v=/, "Mermaid 必须走本地");
  assert.match(appSrc, /script\.src = "\/vendor\/katex\/katex\.min\.js\?v=/, "KaTeX 必须走本地");
  assert.match(appSrc, /link\.href = "\/vendor\/katex\/katex\.min\.css\?v=/, "KaTeX 样式必须走本地");
  assert.match(appSrc, /<script src="\/vendor\/chartjs\/chart\.umd\.js"><\/script>/, "Chart.js 自包含页必须走本地");
  assert.match(appSrc, /<script src="\/vendor\/echarts\/echarts\.min\.js"><\/script>/, "ECharts 自包含页必须走本地");
  assert.match(appSrc, /MARKDOWN_WORKER_URL = "\/markdown-worker\.js\?v=[^"&]+&assets=\/vendor\/"/,
    "worker 必须带 assets=/vendor/，否则图表库回退到被墙的 CDN");
});

test("自包含图表页的库地址是根相对路径（不写死端口/域名）", () => {
  // 桌面端端口会在 7321..7420 之间回滚；写死 origin 的 URL 会被持久化进文档后失效。
  // 真浏览器实测：sandbox 的 srcdoc iframe 里根相对 URL 按父文档 base 解析，可正常加载。
  for (const m of appSrc.matchAll(/<script src="([^"]*(?:chartjs|echarts)[^"]*)"><\/script>/g)) {
    assert.ok(m[1].startsWith("/vendor/"), `图表模板库地址必须根相对：${m[1]}`);
  }
});

test("public/vendor 总体积在预算内", () => {
  let total = 0;
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      const p = dir + e.name;
      if (e.isDirectory()) walk(p + "/");
      else total += size(p);
    }
  };
  walk("public/vendor/");
  assert.ok(total < 12 * 1024 * 1024, `public/vendor 总体积 ${total} B 超出 12MB 预算`);
  assert.ok(total > 4 * 1024 * 1024, `public/vendor 总体积 ${total} B 偏小，可能漏了库`);
});
