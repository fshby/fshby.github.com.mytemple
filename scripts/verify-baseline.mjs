#!/usr/bin/env node
// 12 组合（4 主题 × 3 视图）计算样式基线快照。
//
// 用法：
//   node scripts/verify-baseline.mjs            # 与基线比对（有差异即失败，退出码 1）
//   node scripts/verify-baseline.mjs --update   # 刷新基线（只在有意调整后运行）
//
// 为什么走真实浏览器而不是解析 CSS：
//   var() 在「声明所在元素」上完成替换，color-mix() 的计算值还取决于祖先底色链；
//   真正决定用户看到什么的，是浏览器的计算样式。静态解析（scripts/css-token-model.mjs）
//   负责守「声明值」，这里负责守「计算值」，两者互补。
//
// 为什么不在 npm test 里：CI/沙箱内没有可用的 Chromium/WebView2，且本脚本单次约 10s。
// 提交前自检与发布前各手动跑一次即可。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SNAPSHOT = join(ROOT, "tests", "baselines", "computed-styles.snapshot.json");
const UPDATE = process.argv.includes("--update");

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 Edge（Chromium）。本脚本需要真实浏览器，跳过。");
  process.exit(0);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

// ── 基线页 = 真实 public/index.html 的「运行时派生」 ────────────────────────
//   · 去掉 <script src="/app.js"> 与启动内联脚本，让宿主不要启动（否则会去连 Tauri IPC 而失败）
//   · 注入一段真实 editor-core，把示例文档挂进真实的 #editor 容器，并填满 #markdownView
// 这样外壳（顶栏/侧栏/状态栏/分隔条）与线上完全同源，同时沉浸渲染容器有真实内容可测。
// 磁盘上的 public/index.html 不做任何修改。
const SAMPLE_DOC = [
  "# 一级标题",
  "",
  "正文 **粗体** 与 *斜体* 与 `行内代码` 与 [外链](https://example.com) 与 ~~删除~~ 与 ==高亮==。",
  "",
  "## 二级标题",
  "",
  "> 引用块",
  "",
  "- 列表项一",
  "- 列表项二",
  "",
  "```js",
  "const a = 1;",
  "```",
  "",
  "行内公式 $a^2+b^2=c^2$ 与行间公式：",
  "",
  "$$",
  "\\int_0^1 x^2 dx",
  "$$",
  "",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| 1 | 2 |",
].join("\n");

const BASELINE_SCRIPT = [
  '<script type="module">',
  '  import { createMarkdownEditor } from "/editor-core.js";',
  "  const DOC = __DOC__;",
  '  const host = document.querySelector("#editor");',
  "  const ed = createMarkdownEditor(host);",
  "  const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');",
  "  const inline = (s) =>",
  "    esc(s)",
  "      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')",
  "      .replace(/~~([^~]+)~~/g, '<del>$1</del>')",
  "      .replace(/==([^=]+)==/g, '<mark>$1</mark>')",
  "      .replace(/`([^`]+)`/g, '<code>$1</code>')",
  "      .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a class=\"mt-md-inline-link\" data-href=\"$2\">$1</a>');",
  "  const render = (src) => {",
  '    const lines = String(src).split("\\n");',
  "    const out = [];",
  "    let i = 0;",
  "    while (i < lines.length) {",
  "      const line = lines[i];",
  "      if (/^```/.test(line)) {",
  "        const body = [];",
  "        i += 1;",
  "        while (i < lines.length && !/^```/.test(lines[i])) { body.push(esc(lines[i])); i += 1; }",
  "        i += 1;",
  '        out.push("<pre><code>" + body.join("\\n") + "</code></pre>");',
  "        continue;",
  "      }",
  "      if (/^\\$\\$$/.test(line.trim())) {",
  "        const body = [];",
  "        i += 1;",
  "        while (i < lines.length && !/^\\$\\$$/.test(lines[i].trim())) { body.push(lines[i]); i += 1; }",
  "        i += 1;",
  "        out.push('<div class=\"math-block\" data-math=\"' + esc(body.join(' ')) + '\"></div>');",
  "        continue;",
  "      }",
  "      const h = /^(#{1,3})\\s+(.*)$/.exec(line);",
  '      if (h) { out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); i += 1; continue; }',
  '      if (/^>\\s?/.test(line)) { out.push("<blockquote><p>" + inline(line.replace(/^>\\s?/, "")) + "</p></blockquote>"); i += 1; continue; }',
  "      if (/^[-*]\\s+/.test(line)) {",
  "        const items = [];",
  '        while (i < lines.length && /^[-*]\\s+/.test(lines[i])) { items.push("<li>" + inline(lines[i].replace(/^[-*]\\s+/, "")) + "</li>"); i += 1; }',
  '        out.push("<ul>" + items.join("") + "</ul>");',
  "        continue;",
  "      }",
  "      if (/^\\|/.test(line)) {",
  "        const rows = [];",
  "        while (i < lines.length && /^\\|/.test(lines[i])) { rows.push(lines[i]); i += 1; }",
  "        const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());",
  "        const head = cells(rows[0]);",
  "        const body = rows.slice(2).map(cells);",
  "        out.push(",
  "          '<div class=\"markdown-table-wrap\"><table><thead><tr>' +",
  "            head.map((c) => '<th>' + inline(c) + '</th>').join('') +",
  "            '</tr></thead><tbody>' +",
  "            body.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +",
  "            '</tbody></table></div>',",
  "        );",
  "        continue;",
  "      }",
  "      if (/^\\s*$/.test(line)) { i += 1; continue; }",
  '      out.push("<p>" + inline(line) + "</p>");',
  "      i += 1;",
  "    }",
  '    return out.join("");',
  "  };",
  "  ed.injectRenderer(render);",
  "  ed.injectWidgetMountHook(() => {});",
  "  // 阅读栏拿到的就是这份 renderMarkdown 产物，这里同样填上，",
  "  // 否则阅读视图下 .markdown-body h1/pre 等目标测不到（空文档只剩 empty-state）",
  '  const view = document.querySelector("#markdownView");',
  '  if (view) { view.classList.remove("empty-state"); view.innerHTML = render(DOC); }',
  "  ed.value = DOC;",
  "  ed.setSelectionRange(0, 0);",
  "  window.__baseline = { ed };",
  "  try { ed.setWysiwygEnabled(true); } catch (e) { window.__baseline.error = String(e && e.message); }",
  "  window.__baselineReady = true;",
  "</scr" + "ipt>",
].join("\n");

/** 去掉宿主脚本、注入基线脚本。只作用于 HTTP 响应，不写盘。 */
function deriveBaselineHtml(html) {
  let out = html.replace(/<script src="\/app\.js[^"]*"[^>]*><\/script>/g, "");
  // 启动内联脚本（许可校验 / 启动遮罩）整段移除
  out = out.replace(/<script>[\s\S]*?<\/script>/, "");
  const injection = BASELINE_SCRIPT.replace("__DOC__", JSON.stringify(SAMPLE_DOC));
  return out.replace(/<\/body>/, `${injection}</body>`);
}

const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" || p === "/index.html") {
    const html = deriveBaselineHtml(readFileSync(join(ROOT, "public", "index.html"), "utf8"));
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(html);
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

const THEMES = ["light", "dark", "eye", "glow"];
const VIEWS = ["reader", "edit", "immersive"];
const PROPS = [
  "fontFamily",
  "fontSize",
  "lineHeight",
  "fontWeight",
  "color",
  "backgroundColor",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "marginTop",
  "marginBottom",
  "borderTopColor",
  "borderBottomWidth",
  "width",
  "display",
];
// 覆盖审计里点名的三类风险：正文度量、沉浸渲染容器、控件密度。
const TARGETS = [
  ["--prose", "#markdownView.markdown-body"],
  ["--prose-h1", "#markdownView.markdown-body h1"],
  ["--prose-p", "#markdownView.markdown-body p"],
  ["--prose-pre", "#markdownView.markdown-body pre"],
  ["--editor", "#editor"],
  ["--cm-content", "#editor .cm-content"],
  ["--cm-line", "#editor .cm-line"],
  ["--immersive-block", "#editor .cm-line .mt-md-wysiwyg.markdown-body"],
  ["--immersive-inline", "#editor .cm-line .mt-md-inline-mark.markdown-body"],
  ["--toolbar", "#editorToolbar"],
  ["--topbar", ".toolbar"],
  ["--status", "#editorStatusBar"],
  ["--sidebar", ".sidebar"],
  ["--sidebar-resizer", "#sidebarResizer"],
  ["--preview-splitter", "#previewSplitter"],
];

/** 把页面切到某个「主题 × 视图」组合。全部是运行时类名切换，不写任何文件、不改 DOM 结构。 */
const applyState = (theme, view) =>
  `(() => {
    const body = document.body;
    body.dataset.theme = ${JSON.stringify(theme)};
    body.classList.add("license-active");
    body.classList.remove("mode-edit", "mode-read", "immersive-editing", "lightweight-editor");
    const shell = document.querySelector(".app-shell");
    shell.classList.remove("immersive");
    for (const id of ["#appSplash", "#graphPanel"]) {
      const el = document.querySelector(id);
      if (el) el.style.display = "none";
    }
    const reader = document.querySelector("#readerPanel");
    const editor = document.querySelector("#editorPanel");
    const wantEdit = ${JSON.stringify(view)} !== "reader";
    reader.classList.toggle("hidden", wantEdit);
    editor.classList.toggle("hidden", !wantEdit);
    if (wantEdit) body.classList.add("mode-edit");
    else body.classList.add("mode-read");
    if (${JSON.stringify(view)} === "immersive") {
      shell.classList.add("immersive");
      body.classList.add("immersive-editing", "lightweight-editor");
    }
    document.documentElement.style.height = "100%";
    body.style.height = "100%";
  })()`;

const SAMPLE = (targets, props) =>
  `(() => {
    const out = {};
    for (const [name, sel] of ${JSON.stringify(targets)}) {
      const el = document.querySelector(sel);
      if (!el) { out[name] = null; continue; }
      const cs = getComputedStyle(el);
      const rec = {};
      for (const p of ${JSON.stringify(props)}) rec[p] = cs[p];
      const r = el.getBoundingClientRect();
      rec.rectW = Math.round(r.width);
      rec.rectH = Math.round(r.height);
      out[name] = rec;
    }
    return out;
  })()`;

const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load" });
// 等真实 CodeMirror 完成挂载与首次渲染
await page
  .waitForFunction(() => window.__baselineReady === true, { timeout: 15000 })
  .catch(() => {
    console.error("编辑器未在 15s 内就绪。pageerror：");
    pageErrors.slice(0, 5).forEach((e) => console.error("  " + e));
    process.exit(1);
  });
await new Promise((r) => setTimeout(r, 300));

const actual = {};
for (const theme of THEMES) {
  for (const view of VIEWS) {
    await page.evaluate(applyState(theme, view));
    // 帧间等待：同一帧内切换类名再读计算样式会拿到陈旧层叠结果（实测结论）
    await new Promise((r) => setTimeout(r, 220));
    actual[`${theme}/${view}`] = await page.evaluate(SAMPLE(TARGETS, PROPS));
  }
}
await browser.close();
server.close();

if (UPDATE || !existsSync(SNAPSHOT)) {
  mkdirSync(join(ROOT, "tests", "baselines"), { recursive: true });
  writeFileSync(
    SNAPSHOT,
    `${JSON.stringify(
      {
        _comment:
          "4 主题 × 3 视图 的计算样式基线（真实 Chromium）。刷新：node scripts/verify-baseline.mjs --update",
        _viewport: "1440x900",
        combos: actual,
      },
      null,
      2,
    )}\n`,
  );
  const n = Object.keys(actual).length;
  console.log(`基线已写入 tests/baselines/computed-styles.snapshot.json（${n} 组合 × ${TARGETS.length} 目标）`);
  const empty = [];
  for (const combo of Object.keys(actual)) {
    for (const [name] of TARGETS) if (actual[combo][name] === null) empty.push(`${combo} ${name}`);
  }
  if (empty.length) {
    console.warn(`注意：有 ${empty.length} 个目标取不到元素：`);
    empty.slice(0, 12).forEach((e) => console.warn("  " + e));
  }
  if (!UPDATE) console.log("（首次生成，未做比对）");
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(SNAPSHOT, "utf8")).combos;
const diffs = [];
for (const combo of Object.keys(actual)) {
  for (const [name] of TARGETS) {
    const a = actual[combo][name];
    const b = baseline[combo] ? baseline[combo][name] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const keys = a && b ? Object.keys(a).filter((k) => a[k] !== b[k]) : ["(整个目标)"];
      diffs.push(
        `${combo} ${name}: ` +
          keys
            .slice(0, 6)
            .map((k) => `${k} ${JSON.stringify(b && b[k])} → ${JSON.stringify(a && a[k])}`)
            .join("; "),
      );
    }
  }
}

if (diffs.length === 0) {
  console.log(`计算样式基线一致（${Object.keys(actual).length} 组合 × ${TARGETS.length} 目标）`);
  process.exit(0);
}
console.error(`计算样式有 ${diffs.length} 处差异：`);
for (const d of diffs.slice(0, 40)) console.error("  " + d);
if (diffs.length > 40) console.error(`  … 另有 ${diffs.length - 40} 处`);
console.error("\n若是有意调整：node scripts/verify-baseline.mjs --update");
process.exit(1);
