// 回归测试：PR-5「工程护栏」—— 样式表分层 + 令牌完整性 + 主题覆盖契约 + 令牌基线。
//
// 为什么要把 public/styles.css 变成「合并产物」：
//   11.9k 行的单文件无法维护，但不拆又会回到老路。折中方案是
//   「frontend/styles/ 5 个层源文件 → scripts/build-css.mjs 按文件名顺序合并 → public/styles.css」，
//   级联顺序 = 文件名字典序（层与层的覆盖关系依赖它，顺序不可调换）。
//   本文件负责守住三件事：产物与源一致、令牌不悬空、主题不越权覆盖 Layer 0。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const STYLE_DIR = "frontend/styles";
const ARTIFACT = "public/styles.css";
const layers = readdirSync(join(ROOT, STYLE_DIR)).filter((f) => f.endsWith(".css")).sort();
const artifact = read(ARTIFACT);
const layerSources = layers.map((f) => read(`${STYLE_DIR}/${f}`));

// ── 解析工具：抹注释（保留换行）、按块收集自定义属性 ─────────────────────

/** 抹掉 /* *\/ 注释但保留换行，使行号与原文件一致。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));

/**
 * 收集所有自定义属性声明，并记录其选择器链（外层 @media 等用 " | " 连接）。
 * 返回 Map<token, Array<{ chain, value }>>，数组顺序 = 文件顺序（后者在级联中胜出）。
 */
function collectVarDefs(css) {
  const clean = stripComments(css);
  const defs = new Map();
  const stack = [];
  let sel = "";
  let body = "";
  let depth = 0;
  const flush = () => {
    const chain = stack.join(" | ");
    const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g;
    let m;
    while ((m = re.exec(body))) {
      if (!defs.has(m[1])) defs.set(m[1], []);
      defs.get(m[1]).push({ chain, value: m[2].trim() });
    }
  };
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "{") { depth += 1; stack.push(sel.trim()); sel = ""; body = ""; }
    else if (c === "}") { flush(); depth -= 1; stack.pop(); body = ""; }
    else if (depth === 0) sel += c;
    else body += c;
  }
  if (depth !== 0) throw new Error("括号不平衡");
  return defs;
}

const defs = collectVarDefs(artifact);
const THEMES = ["light", "dark", "eye", "glow", "image"];
const themeScope = (theme) => (theme === "light" ? ":root" : `body[data-theme="${theme}"]`);

/** 某主题作用域下某令牌的「最后一条声明」（级联：文件靠后者胜）。 */
function declared(token, theme) {
  const list = defs.get(token) || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].chain.includes(themeScope(theme))) return list[i].value;
  }
  return null;
}

// ── 1. 产物一致性 ─────────────────────────────────────────────────────────

test("PR-5：public/styles.css 必须与层源文件按序合并的结果逐字节一致", () => {
  assert.equal(layers.length, 5, `frontend/styles/ 应有 5 个层文件，实际 ${layers.length}`);
  assert.equal(
    artifact,
    layerSources.join(""),
    "public/styles.css 与层源文件不一致 —— 请改 frontend/styles/ 下的层源文件，再运行 npm run build:css；不要手改产物",
  );
  // 每个层都必须带层头注释（说明自己的职责与「勿调换顺序」），否则后来者会把它当普通文件乱改
  for (const src of layerSources) {
    assert.match(src, /^\/\* ═══ 层 \d\/5 · /, "每个层文件必须以层头注释开头");
    assert.match(src, /npm run build:css/, "层头必须提示如何重新生成产物");
  }
  // 产物自身括号/注释平衡（防某层被截断后悄悄产出一个坏文件）
  let depth = 0;
  let inComment = false;
  for (let i = 0; i < artifact.length; i += 1) {
    const c = artifact[i];
    if (inComment) { if (c === "*" && artifact[i + 1] === "/") { inComment = false; i += 1; } continue; }
    if (c === "/" && artifact[i + 1] === "*") { inComment = true; i += 1; continue; }
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    assert.ok(depth >= 0, `出现多余的 }（offset ${i}）`);
  }
  assert.equal(depth, 0, "括号不平衡");
  assert.equal(inComment, false, "注释未闭合");
});

test("PR-5：样式表对外路径与引用方式不变（不影响 WebView2 缓存与打包）", () => {
  const html = read("public/index.html");
  assert.match(html, /href="\/styles\.css\?v=/, "index.html 必须继续以 /styles.css 引用（带 ?v= 缓存戳）");
  assert.doesNotMatch(html, /frontend\/styles\//, "层源文件不得被浏览器直接引用");
  assert.doesNotMatch(html, /@import/, "不得用 @import 拆分（会引入运行时串行请求与闪烁）");
  // 打包资源仍指向 public/（tauri.conf.json 的 bundle.resources）
  const tauri = read("src-tauri/tauri.conf.json");
  assert.match(tauri, /"\.\.\/public"/, "bundle.resources 必须仍打包 public/ 目录");
});

// ── 2. 令牌完整性 ─────────────────────────────────────────────────────────

test("PR-5：所有 var() 引用的令牌都有定义（不允许悬空引用）", () => {
  const clean = stripComments(artifact);
  const refs = new Map();
  const re = /var\(\s*(--[a-zA-Z0-9-]+)/g;
  let m;
  while ((m = re.exec(clean))) {
    if (!refs.has(m[1])) refs.set(m[1], 0);
    refs.set(m[1], refs.get(m[1]) + 1);
  }
  const dangling = [...refs.keys()].filter((t) => !defs.has(t));
  assert.deepEqual(
    dangling,
    [],
    `存在 ${dangling.length} 个未定义就被引用的令牌：${dangling.slice(0, 8).join(", ")}`,
  );
  // 令牌总量必须保持在一个 sane 区间：突然暴增/归零都说明拆分或迁移出了问题
  assert.ok(defs.size > 150, `令牌定义数异常（${defs.size}）`);
});

// ── 3. 主题覆盖契约 ───────────────────────────────────────────────────────

test("PR-5：Layer 0 度量刻度全主题共享，任何主题不得覆盖", () => {
  // Layer 0 是「度量与刻度」：间距 / 圆角 / 字号阶 / 时长 / 缓动 / 层级 / 等宽字体栈
  const LAYER0 = [
    "--space-1", "--space-2", "--space-3", "--space-4", "--space-6", "--space-8",
    "--radius-1", "--radius-2", "--radius-3",
    "--fs-xs", "--fs-sm", "--fs-md", "--fs-lg", "--fs-xl", "--fs-2xl",
    "--dur-1", "--dur-2", "--dur-3", "--ease-standard",
    "--z-base", "--z-sticky", "--z-modal", "--z-toast",
    "--app-font-mono",
  ];
  for (const token of LAYER0) {
    const list = defs.get(token) || [];
    assert.ok(list.length >= 1, `Layer 0 令牌 ${token} 缺失`);
    for (const d of list) {
      assert.ok(
        !/data-theme=/.test(d.chain),
        `Layer 0 令牌 ${token} 被主题作用域覆盖（${d.chain.slice(0, 60)}）—— 度量刻度必须全主题共享`,
      );
    }
  }
});

test("PR-5：兼容别名层必须覆盖全部主题作用域（var() 在声明所在元素解析）", () => {
  // 别名层把旧名映射到新令牌；只写 :root 会让深色主题锁死浅色值（实测结论）
  const ALIASES = [
    "--hover", "--border", "--secondary", "--btn-bg", "--btn-fg",
    "--danger", "--warning", "--font-sans", "--mono", "--focus-ring",
  ];
  const aliasBlocks = [];
  for (const token of ALIASES) {
    for (const d of defs.get(token) || []) {
      // 命中「多主题选择器列表」的那条定义（链里同时含 :root 与多个 data-theme）
      if (d.chain.includes(":root") && d.chain.includes('data-theme="dark"')) aliasBlocks.push(d.chain);
    }
  }
  assert.ok(aliasBlocks.length >= ALIASES.length, "别名令牌必须写在覆盖全部主题的选择器列表里");
  for (const theme of THEMES) {
    const scope = themeScope(theme);
    assert.ok(
      aliasBlocks.every((chain) => chain.includes(scope)),
      `别名层选择器列表必须覆盖 ${scope}（实测：var() 在声明所在元素上解析，漏掉会让该主题锁死浅色值）`,
    );
  }
  // 实心强调底与其上的文字色：每个主题都必须「可解析」，且不得出现「改了 --accent 却没改 --accent-solid」的锁死。
  //   · 主题覆盖了 --accent      → 该主题必须同时声明 --accent-solid / --on-accent（否则 var() 在 :root 上解析，取到旧值）
  //   · 主题未覆盖 --accent      → 从 :root 继承即可（image 是叠加型主题，属这一类）
  for (const theme of THEMES) {
    for (const token of ["--accent-solid", "--on-accent"]) {
      const own = declared(token, theme);
      const inherited = declared(token, "light");
      assert.ok(own || inherited, `${theme} 主题下 ${token} 既未声明也无法从 :root 继承`);
      if (declared("--accent", theme)) {
        assert.ok(
          own,
          `${theme} 主题覆盖了 --accent 却没声明 ${token} —— var() 在声明所在元素（:root）上解析，该主题会锁死浅色值`,
        );
      }
    }
  }
});

// ── 4. 令牌基线快照 ───────────────────────────────────────────────────────

test("PR-5：令牌基线快照可复现（意外改动令牌值会让测试红）", () => {
  const SNAPSHOT = "tests/baselines/tokens.snapshot.json";
  assert.ok(existsSync(join(ROOT, SNAPSHOT)), "缺少基线快照文件（运行 node scripts/update-token-snapshot.mjs 生成）");
  const baseline = JSON.parse(read(SNAPSHOT)).themes;

  const TOKENS = [
    // 语义色
    "--bg", "--panel", "--line", "--text", "--muted", "--soft",
    "--accent", "--accent-strong", "--accent-solid", "--on-accent", "--focus-ring",
    // 正文度量（三视图共用）
    "--doc-font-size", "--prose-size", "--prose-leading", "--prose-measure",
    "--prose-scale", "--prose-gutter", "--prose-block-gap", "--prose-block-gap-fixed",
    // 沉浸与密度
    "--status-bar-h", "--mt-immersive-measure",
    // 字体栈
    "--app-font-family", "--app-font-mono", "--font-sans",
    // Markdown 语义色
    "--md-link", "--md-tag",
  ];

  const actual = {};
  for (const theme of THEMES) {
    actual[theme] = {};
    for (const token of TOKENS) actual[theme][token] = declared(token, theme);
  }

  const diffs = [];
  for (const theme of THEMES) {
    for (const token of TOKENS) {
      if (baseline[theme]?.[token] !== actual[theme][token]) {
        diffs.push(`${theme}${token}: ${JSON.stringify(baseline[theme]?.[token])} → ${JSON.stringify(actual[theme][token])}`);
      }
    }
  }
  assert.deepEqual(diffs, [], [
    "令牌基线发生变化。若是有意调整：",
    "  1) 改 frontend/styles/ 对应层源文件并 npm run build:css；",
    "  2) 跑 node scripts/update-token-snapshot.mjs 刷新 tests/baselines/tokens.snapshot.json；",
    "  3) 在 PR 描述里说明哪些令牌变了、影响哪个视图。",
    "本次差异：",
    ...diffs.slice(0, 12),
  ].join("\n"));
});

// ── 5. 计算样式基线：跨视图不变量 ─────────────────────────────────────────
//
// tests/baselines/computed-styles.snapshot.json 由 scripts/verify-baseline.mjs
// 用真实 Chromium 实测产出（4 主题 × 3 视图）。浏览器无法进 CI，所以这里不重跑，
// 只对「已经测出来的事实」做不变量断言 —— 这些不变量一旦被打破，说明有人改坏了
// 度量令牌或沉浸渲染容器，而快照本身也会随之变化、CI 立刻能发现。

const COMPUTED = "tests/baselines/computed-styles.snapshot.json";
const px = (v) => (v == null ? null : parseFloat(v));
const ratio = (rec) => px(rec.lineHeight) / px(rec.fontSize);

test("PR-5：计算样式基线覆盖 4 主题 × 3 视图且无缺失目标", () => {
  assert.ok(existsSync(join(ROOT, COMPUTED)), "缺少计算样式基线（运行 node scripts/verify-baseline.mjs --update）");
  const combos = JSON.parse(read(COMPUTED)).combos;
  const VIEWS = ["reader", "edit", "immersive"];
  const expectKeys = [];
  for (const theme of ["light", "dark", "eye", "glow"]) {
    for (const view of VIEWS) expectKeys.push(`${theme}/${view}`);
  }
  assert.deepEqual(Object.keys(combos).sort(), expectKeys.sort(), "必须是 4 主题 × 3 视图 = 12 组合");
  const names = Object.keys(combos["light/reader"]);
  const missing = [];
  for (const key of expectKeys) {
    for (const name of names) if (combos[key][name] === null) missing.push(`${key} ${name}`);
  }
  assert.deepEqual(missing, [], `以下目标在基线里取不到元素（探针页失效）：${missing.slice(0, 8).join(", ")}`);
});

test("PR-5：三视图行高与沉浸放大系数必须与令牌承诺一致", () => {
  const combos = JSON.parse(read(COMPUTED)).combos;
  for (const theme of ["light", "dark", "eye", "glow"]) {
    const reader = combos[`${theme}/reader`]["--prose"];
    const edit = combos[`${theme}/edit`]["--cm-line"];
    const imm = combos[`${theme}/immersive`]["--immersive-block"];

    // 行高比：三视图必须同源（PR-2 的核心承诺）
    const r = ratio(reader);
    assert.ok(
      Math.abs(ratio(edit) - r) < 0.002 && Math.abs(ratio(imm) - r) < 0.002,
      `${theme}：三视图行高比不一致 —— 阅读 ${r.toFixed(4)} / 编辑 ${ratio(edit).toFixed(4)} / 沉浸 ${ratio(imm).toFixed(4)}`,
    );
    assert.ok(Math.abs(r - 1.78) < 0.002, `${theme}：正文行高比应为 1.78，实际 ${r.toFixed(4)}`);

    // 沉浸放大系数：正文基准字号 × --prose-scale（1.04）
    const scale = px(imm.fontSize) / px(reader.fontSize);
    assert.ok(
      Math.abs(scale - 1.04) < 0.002,
      `${theme}：沉浸字号/阅读字号 = ${scale.toFixed(4)}，应等于 --prose-scale（1.04）`,
    );

    // 同一句话内不得出现两种字号：行内语义标记片段必须与块级渲染容器一致
    const inline = combos[`${theme}/immersive`]["--immersive-inline"];
    assert.equal(
      inline.fontSize,
      imm.fontSize,
      `${theme}：行内标记字号 ${inline.fontSize} 与块级渲染容器 ${imm.fontSize} 不一致`,
    );
  }

  // 版心宽度由令牌驱动，跨主题必须完全一致（主题只换色，不换度量）
  const widths = ["light", "dark", "eye", "glow"].map((t) => combos[`${t}/reader`]["--prose"].width);
  assert.equal(new Set(widths).size, 1, `版心宽度跨主题漂移：${widths.join(" / ")}`);
});

test("PR-5：沉浸渲染容器必须落在正文字体栈上，源文本保持等宽", () => {
  const combos = JSON.parse(read(COMPUTED)).combos;
  for (const theme of ["light", "dark", "eye", "glow"]) {
    const prose = combos[`${theme}/reader`]["--prose"].fontFamily;
    const source = combos[`${theme}/edit`]["--cm-line"].fontFamily;
    const imm = combos[`${theme}/immersive`];
    const block = imm["--immersive-block"].fontFamily;
    const inline = imm["--immersive-inline"].fontFamily;

    // 渲染态必须是正文字体（不是 #editor 的等宽栈），否则读起来像代码
    assert.equal(block, prose, `${theme}：沉浸块级渲染容器未跟随正文字体（${block}）`);
    assert.equal(inline, prose, `${theme}：沉浸行内片段未跟随正文字体（${inline}）`);
    assert.notEqual(source, prose, `${theme}：源文本与渲染正文的字体不该相同（源应保持等宽）`);
  }
});

test("PR-5：沉浸行内渲染容器必须中和块级容器属性", () => {
  const combos = JSON.parse(read(COMPUTED)).combos;
  for (const theme of ["light", "dark", "eye", "glow"]) {
    const inline = combos[`${theme}/immersive`]["--immersive-inline"];
    // .markdown-body 自带的版心宽度/大内边距必须被中和，否则一段话中间会突然缩进
    assert.equal(inline.paddingLeft, "0px", `${theme}：行内片段左侧内边距未中和（${inline.paddingLeft}）`);
    assert.equal(inline.paddingTop, "0px", `${theme}：行内片段上侧内边距未中和（${inline.paddingTop}）`);
    assert.equal(inline.width, "auto", `${theme}：行内片段版心宽度未中和（${inline.width}）`);
    assert.equal(inline.display, "inline", `${theme}：行内片段应为行内盒（${inline.display}）`);
  }
});

// ── 6. 浏览器侧护栏的夹具防漂移 ───────────────────────────────────────────
//
// 两个护栏脚本（audit-contrast / verify-baseline）都依赖「夹具里写的类名仍然存在」。
// 类名一旦被重命名，脚本不会报错，只会静默地把该目标当成「元素缺失」跳过 ——
// 于是护栏变成摆设。这里把「夹具用到的类名必须仍出现在 public/styles.css 中」钉死。

test("PR-5：对比度夹具的类名必须仍存在于样式表中（防止护栏静默失效）", () => {
  const html = read("tests/fixtures/contrast-probe.html");
  const classes = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  assert.ok(classes.size >= 10, `夹具类名过少（${classes.size}），疑似读取失败`);
  const missing = [...classes].filter((c) => !artifact.includes(`.${c}`));
  assert.deepEqual(missing, [], `夹具引用的类名已不在样式表中：${missing.join(", ")} —— 请同步 tests/fixtures/contrast-probe.html`);
});

test("PR-5：两个浏览器护栏脚本与夹具都必须存在", () => {
  for (const p of [
    "scripts/audit-contrast.mjs",
    "scripts/verify-baseline.mjs",
    "scripts/build-css.mjs",
    "scripts/css-token-model.mjs",
    "scripts/update-token-snapshot.mjs",
    "tests/fixtures/contrast-probe.html",
  ]) {
    assert.ok(existsSync(join(ROOT, p)), `缺少 ${p}`);
  }
  // package.json 必须把它们暴露成可执行脚本，否则后来者不知道要跑
  const pkg = JSON.parse(read("package.json"));
  for (const name of ["build:css", "update:css-snapshot", "audit:contrast", "verify:computed"]) {
    assert.ok(pkg.scripts[name], `package.json 缺少 npm script：${name}`);
  }
});
