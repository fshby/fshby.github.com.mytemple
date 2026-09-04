function escapeHtml(value) {
  const v = String(value || "")
    // 去掉 < 0x20 控制字符（保留 \t\n\r）+ U+FFFE/FFFF 非法码点
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 检测 Chart.js / ECharts JSON 配置，返回可直接在 srcdoc iframe 中渲染的完整 HTML。
 * 无法识别时返回 null。
 */
function detectAndBuildChartHtml(content) {
  let jsonStr = String(content || "").trim();
  if (!jsonStr) return null;
  // 兼容前后有说明文本，提取最外层 JSON 对象
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];
  let cfg;
  try { cfg = JSON.parse(jsonStr); } catch { return null; }
  if (!cfg || typeof cfg !== "object") return null;

  const chartjsTypes = ["pie","doughnut","bar","line","radar","polarArea","bubble","scatter"];
  const isChartjs =
    (typeof cfg.type === "string" && chartjsTypes.includes(cfg.type)) ||
    (cfg.data && Array.isArray(cfg.data.labels) && Array.isArray(cfg.data.datasets));
  const echartsKeys = ["series","xAxis","yAxis","tooltip","legend","grid","title","visualMap","dataset"];
  const echartsHitCount = echartsKeys.filter(k => cfg[k] !== undefined).length;
  const isECharts =
    (cfg.series && Array.isArray(cfg.series) && cfg.series.length > 0) ||
    (cfg.option && (cfg.option.series || cfg.option.xAxis)) ||
    echartsHitCount >= 2;

  if (isChartjs) {
    const safeJson = JSON.stringify(cfg).replace(/<\/script/gi, "<\\/script");
    return "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\"/><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/><title>Chart.js</title>"
      +"<script src=\"https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js\"><\/script>"
      +"<style>html,body{margin:0;padding:12px;height:100%;box-sizing:border-box;font-family:Arial,sans-serif;background:#fff}#c{width:100%;height:calc(100vh - 24px);min-height:360px}</style>"
      +"</head><body><canvas id=\"c\"></canvas><script>"
      +"try{const CFG="+safeJson+";(CFG.options=CFG.options||{}).responsive=true;CFG.options.maintainAspectRatio=false;new Chart(document.getElementById('c'),CFG);}"
      +"catch(e){document.body.innerHTML='<pre style=color:#c00;padding:12px>'+String(e&&e.message||e).replace(/[<>]/g,'').slice(0,800)+'</pre>'}"
      +"<\/script></body></html>";
  }
  if (isECharts) {
    const opt = cfg.option ? cfg.option : cfg;
    const safeJson = JSON.stringify(opt).replace(/<\/script/gi, "<\\/script");
    return "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\"/><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/><title>ECharts</title>"
      +"<script src=\"https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js\"><\/script>"
      +"<style>html,body{margin:0;padding:0;height:100%;background:#fff}#c{width:100%;height:100vh;min-height:420px}</style>"
      +"</head><body><div id=\"c\"></div><script>"
      +"try{const ch=echarts.init(document.getElementById('c'));ch.setOption("+safeJson+");window.addEventListener('resize',function(){ch.resize()})}"
      +"catch(e){document.body.innerHTML='<pre style=color:#c00;padding:12px>'+String(e&&e.message||e).replace(/[<>]/g,'').slice(0,800)+'</pre>'}"
      +"<\/script></body></html>";
  }
  return null;
}

function plainText(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~+#>|{}\[\]]/g, "")
    .trim();
}

function headingId(text, index) {
  const base = plainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `h-${base || "section"}-${index}`;
}
// Markdown 渲染缓存版本戳：解析器或 CSS 规则升级时递增，确保旧缓存不被复用。
const MARKDOWN_RENDER_VERSION = "callout-v9-final-v13-20260824-url-auto-1.8.63";

function safeMarkdownUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "#";
  if (url.startsWith("#")) return url;
  const protocol = url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (protocol) {
    if (!["http", "https", "mailto"].includes(protocol)) return "#";
    return url;
  }
  // 无协议前缀的 URL：自动补 http://（如 mytemple.fshby.cc、example.com/path）
  if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+(:\d+)?(\/|$)/.test(url)) {
    return "http://" + url;
  }
  // IP 地址格式（如 127.0.0.1:8080/path）
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/|$)/.test(url)) {
    return "http://" + url;
  }
  return url;
}

function splitMarkdownTableRow(line) {
  let value = String(line || "").trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells = [];
  let cell = "";
  let escaped = false;
  let inCode = false;
  for (const char of value) {
    if (escaped) {
      cell += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
      cell += char;
    } else if (char === "`") {
      inCode = !inCode;
      cell += char;
    } else if (char === "|" && !inCode) {
      cells.push(cell.trim().replace(/\\\|/g, "|"));
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim().replace(/\\\|/g, "|"));
  return cells;
}

function markdownTableAlignment(cell) {
  const value = String(cell || "").trim();
  if (!/^:?-{3,}:?$/.test(value)) return null;
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

// highlight.js 11.10 支持的语言白名单（common 版 + 扩展语言包 langs/）
const HLJS_SUPPORTED = new Set([
  // highlight.min.js common 版
  "python","javascript","typescript","java","c","cpp","csharp","rust","go",
  "php","ruby","bash","shell","sql","html","css","scss","less","xml","json",
  "yaml","markdown","kotlin","swift","scala","lua","r","perl","fortran",
  "ini","toml","makefile","tex","bat","diff","git","graphql","proto","handlebars",
  "jsx","tsx","js","ts","py","rb","rs","cs","sh","hbs",
  // langs/ 扩展语言包
  "powershell","dockerfile","cmake","groovy","dart","nginx","nsis","apache",
  "properties","haskell","elixir","clojure","vb",
]);

function normalizeCodeLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", py: "python", pyw: "python", rb: "ruby",
    sh: "bash", shell: "bash", zsh: "bash", ps: "powershell", ps1: "powershell", psm1: "powershell",
    yml: "yaml", md: "markdown", c: "c", h: "c", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
    "c++": "cpp", cs: "csharp", "c#": "csharp", rs: "rust", golang: "go", goh: "go",
    txt: "text", plain: "text", "text/plain": "text",
    // Windows 脚本：cmd 用 bat（hljs 只支持 bat）
    bat: "bat", cmd: "bat", batch: "bat",
    // java 原生支持，不用映射
    // 脚本语言
    vbs: "vb", vba: "vb", vb: "vb",
    pl: "perl", pm: "perl",
    php: "php", php3: "php", php4: "php", php5: "php", phtml: "php",
    lua: "lua",
    r: "r", rmd: "r",
    scala: "scala", sc: "scala",
    swift: "swift",
    kt: "kotlin", kts: "kotlin",
    dart: "dart",
    // 配置/标记语言
    ini: "ini", cfg: "ini", conf: "ini", properties: "properties", prop: "properties",
    toml: "toml",
    xml: "xml", svg: "xml", xhtml: "xml", wsdl: "xml", xslt: "xml", jsp: "xml", aspx: "xml", cshtml: "xml",
    // MySQL / SQL → hljs 原生支持 sql
    sql: "sql", mysql: "sql", mariadb: "sql", ddl: "sql", dml: "sql",
    html: "html", htm: "html",
    css: "css", scss: "scss", sass: "scss", less: "less",
    json: "json", jsonc: "json", json5: "json",
    // 构建/脚本
    make: "makefile", makefile: "makefile", mk: "makefile", gmk: "makefile", gnumake: "makefile",
    dockerfile: "dockerfile", docker: "dockerfile",
    cmake: "cmake", cmakelists: "cmake",
    groovy: "groovy", gradle: "groovy",
    // 其他常见
    nsis: "nsis", nsh: "nsis",
    nginx: "nginx",
    htaccess: "apache", apache: "apache",
    gitignore: "git", git: "git", dockerignore: "dockerfile", gitattributes: "git",
    // 更多工程语言
    graphql: "graphql", gql: "graphql",
    proto: "proto", protobuf: "proto",
    handlebars: "handlebars", hbs: "handlebars",
    tex: "tex", latex: "tex",
    diff: "diff", patch: "diff",
    haskell: "haskell", hs: "haskell",
    elixir: "elixir", ex: "elixir", exs: "elixir",
    clojure: "clojure", clj: "clojure", cljs: "clojure",
    // 框架/扩展：Vue / React(JSX) / TSX → 近似映射
    vue: "html", vuejs: "html", svelte: "html",
    jsx: "javascript", react: "javascript", "react-jsx": "javascript",
    tsx: "typescript", "react-tsx": "typescript",
    // CSV/表格 → 纯文本展示（hljs 没有原生 csv）
    csv: "text", tsv: "text",
    // hljs 不支持但有近似可映射
    solidity: "javascript",
    terraform: "text",
    matlab: "text",
    "objective-c": "c",
    m: "c", mm: "cpp",
  };
  // 自定义特殊渲染标记（非 hljs 语言，绕过白名单校验）
  const SPECIAL = new Set(["mermaid", "excalidraw", "chart", "html-inline", "html-web", "raw-html"]);
  let normalized = aliases[raw] || raw;
  // hljs 实际不支持 且 非特殊渲染标记 → 用 text
  if (!SPECIAL.has(normalized) && normalized !== "text" && !HLJS_SUPPORTED.has(normalized)) {
    normalized = "text";
  }
  return /^[a-z0-9_+-]{1,24}$/.test(normalized) ? normalized : "text";
}

function extractOutline(source) {
  const outline = [];
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let h1Index = 0;
  let h2Index = 0;
  let h3Index = 0;
  let h4Index = 0;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = line.match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[2].length;
      let index;
      if (level === 1) {
        index = h1Index++;
        h2Index = 0;
        h3Index = 0;
        h4Index = 0;
      } else if (level === 2) {
        index = `sub-${h2Index++}`;
        h3Index = 0;
        h4Index = 0;
      } else if (level === 3) {
        index = `h3-${h3Index++}`;
        h4Index = 0;
      } else {
        index = `h4-${h4Index++}`;
      }
      outline.push({ id: headingId(heading[3], index), title: plainText(heading[3]), level });
      continue;
    }
    const autoHeading = line.match(/^(\s*)([一二三四五六七八九十]{1,4}[、．.)]\s*.+)$/);
    if (autoHeading) {
      outline.push({ id: headingId(autoHeading[2], `auto-${h2Index++}`), title: plainText(autoHeading[2]), level: 2 });
      h3Index = 0;
      h4Index = 0;
      continue;
    }
    const dottedHeading = line.match(/^(\s*)(\d+(?:\.\d+)+)[、．.)]\s*([^-*].+)$/);
    if (dottedHeading) {
      outline.push({ id: headingId(dottedHeading[3], `num-h3-${h3Index++}`), title: plainText(dottedHeading[3]), level: 3 });
      h4Index = 0;
      continue;
    }
    const numHeading = line.match(/^(\s*)(\((?:\d{1,3})\)|(\d{1,3})([、．.)]))\s*([^-*].+)$/);
    if (numHeading && !/^\s*\d+[.)]\s+\[[ xX]\](?:\s|$)/.test(line)) {
      outline.push({ id: headingId(numHeading[5], `num-h4-${h4Index++}`), title: plainText(numHeading[5]), level: 4 });
    }
  }
  return outline;
}

function inlineMarkdown(value, searchTerm = "") {
  let html = escapeHtml(value)
    // 块级数学公式 $$...$$
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => `<span class="math-block" data-math="${escapeHtml(math.trim())}"></span>`)
    // 行内数学公式 $...$（不匹配 $$ 和行首独立 $）
    .replace(/(?<!\$)\$(?!\$)([^\n$]+?)(?<!\$)\$/g, (_, math) => `<span class="math-inline" data-math="${escapeHtml(math.trim())}"></span>`)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
      const lowerSrc = String(src || "").toLowerCase();
      if (/\.(mp4|webm|mov|avi)(\?|#|$)/.test(lowerSrc)) {
        return `<video src="${src}" alt="${alt}" class="auto-size-video" controls preload="metadata"></video>`;
      }
      return `<img src="${src}" alt="${alt}" class="auto-size-image" loading="lazy" />`;
    })
    .replace(/==([^=]+)==/g, "<mark>$1</mark>")
    .replace(/\+\+([^+]+)\+\+/g, "<u>$1</u>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  const styleToken = /\{(color|bg|size):(#[0-9a-fA-F]{6}|\d{1,2})\|([^{}]*)\}/g;
  for (let index = 0; index < 8; index += 1) {
    styleToken.lastIndex = 0;
    if (!styleToken.test(html)) break;
    styleToken.lastIndex = 0;
    html = html.replace(styleToken, (_, type, rawValue, content) => {
      if (type === "color") return `<span style="color:${rawValue}">${content}</span>`;
      if (type === "bg") return `<span style="background-color:${rawValue};padding:0 3px;border-radius:3px">${content}</span>`;
      return `<span style="font-size:${rawValue}px">${content}</span>`;
    });
  }

  if (searchTerm) {
    const safeTerm = escapeHtml(searchTerm).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(safeTerm, "i"), (match) => `<mark class="search-hit">${match}</mark>`);
  }

  return html
    .replace(/\[\[([^\]]+)\]\]/g, '<a href="#" data-doc-link="$1">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `<a href="${safeMarkdownUrl(url)}">${label}</a>`);
}

// 把文本中非代码 fence 段里的 $$...$$ 用占位符保护起来，供 renderMarkdown 逐行处理后再还原。
// 代码 fence 本身（包含闭合 ``` 行）不做替换，避免代码块里字面量的 $$ 被误解析成公式。
function protectBlockMathPlaceholders(source, placeholders) {
  const rawLines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  let inF = false;
  const segments = [];
  let buf = "";
  for (const line of rawLines) {
    if (line.startsWith("```")) {
      if (!inF) {
        segments.push({ fence: false, text: buf });
        buf = line + "\n";
        inF = true;
      } else {
        buf += line + "\n";
        segments.push({ fence: true, text: buf });
        buf = "";
        inF = false;
      }
      continue;
    }
    buf += line + "\n";
  }
  if (buf) segments.push({ fence: inF, text: buf });
  const protectOne = (text, store) => text.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
    const idx = store.length;
    store.push(math);
    // 使用极少出现在 Markdown 里的控制字符做 token 边界，避免 inlineMarkdown（escapeHtml + 正则）
    // 把占位符截断或二次编码；\n 不会被转义，逐行 split 时可跨越多行。
    return `\u0000MBLK_${idx}_MBLK\u0000`;
  });
  let rebuilt = "";
  for (const seg of segments) {
    if (seg.fence) rebuilt += seg.text;
    else rebuilt += protectOne(seg.text, placeholders);
  }
  // 去除 buf 循环里每行追加的多余末尾换行，让 split("\n") 与原 source 一致（不影响公式占位符）
  if (rebuilt.endsWith("\n")) rebuilt = rebuilt.slice(0, -1);
  return rebuilt;
}

function restoreBlockMathPlaceholders(html, placeholders) {
  if (!placeholders || !placeholders.length) return html;
  let out = html;
  const restoreOne = (idxStr) => {
    const i = parseInt(idxStr, 10);
    const math = i >= 0 && i < placeholders.length ? placeholders[i] : "";
    return `<span class="math-block" data-math="${escapeHtml(String(math).trim())}"></span>`;
  };
  // 先处理占位符跨行被 <br /> 或 \n 切散的情况：因为 \u0000MBLK...MBLK\u0000 内部的 \n
  // 可能被段落行处理替换为 <br /> 或被包裹 <p>，所以用 [\s\S]*? 跨行匹配，
  // 中间允许 <br> / <br /> / \n / 空白，不允许跨其他占位符。
  out = out.replace(/\u0000MBLK_(\d+)_MBLK\u0000/g, (_, i) => restoreOne(i));
  // 二次兜底：占位符跨行被多个 <p>/<br> 切开时拼 \u0000MBLK_{n} 开头 + _MBLK\u0000 结尾
  out = out.replace(/\u0000MBLK_(\d+)[\s\S]*?_MBLK\u0000/g, (_, i) => restoreOne(i));
  return out;
}

function renderMarkdown(source, options = {}) {
  const searchTerm = options.searchTerm || "";
  // bugfix: 原实现逐行 for + <p>${inlineMarkdown(line)}</p> 会把 $$\n公式体\n$$ 切成多段，
  // inlineMarkdown 的 $$ 正则（[\s\S]+?）虽可跨行，但此时已被不同 <p> 包裹，根本跨不过去；
  // 导致多行块级公式（绝大多数用户写法）在阅读栏（Worker 渲染）和阅读模式下都是空白。
  // 这里先把非代码区 $$...$$ 整段替换为唯一占位符，所有 placeholders 保存在数组内，
  // 整份 HTML 产出后再用 restoreBlockMathPlaceholders 还原为 math-block span。
  const mathBlockPlaceholders = [];
  const preprocessed = protectBlockMathPlaceholders(source, mathBlockPlaceholders);
  const lines = preprocessed.split("\n");
  const html = [];
  let h1Index = 0;
  let h2Index = 0;
  let h3Index = 0;
  let h4Index = 0;
  let inCode = false;
  let code = [];
  let codeLanguage = "text";
  let codeStartLine = -1;
  let list = null;
  let table = [];
  let blockquote = [];
  let blockquoteStartLine = -1;
  let detailsBlock = null; // { startLine, lines: [] }

  const flushList = () => {
    if (!list) return;
    const hasTasks = list.items.some((item) => item.task);
    const listClass = hasTasks ? ' class="contains-task-list"' : "";
    const items = list.items.map((item) => `<li${item.task ? ' class="task-list-item"' : ""}>${item.html}</li>`).join("");
    html.push(`<${list.type}${listClass}>${items}</${list.type}>`);
    list = null;
  };

  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map(splitMarkdownTableRow);
    if (rows.length > 1) {
      const [head, divider, ...body] = rows;
      const alignments = divider.map(markdownTableAlignment);
      const columnCount = head.length;
      const cell = (tag, value, index) => `<${tag} style="text-align:${alignments[index] || "left"}">${inlineMarkdown(value || "", searchTerm)}</${tag}>`;
      html.push(`<div class="markdown-table-wrap"><table><thead><tr>${head.map((value, index) => cell("th", value, index)).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${Array.from({ length: columnCount }, (_, index) => cell("td", row[index], index)).join("")}</tr>`).join("")}</tbody></table></div>`);
    }
    table = [];
  };

  const CALLOUT_DEFAULT_TITLES = {
    note: "备注", info: "信息", tip: "提示", success: "成功", warning: "警告",
    todo: "待办", important: "重要", caution: "注意", danger: "危险",
    failure: "失败", bug: "缺陷", question: "疑问", quote: "引用",
    abstract: "摘要", example: "示例",
  };
  // callout 类型集合（indexOf 快速校验，不依赖长正则锚定）
  const CALLOUT_TYPES = new Set(["note","info","tip","warning","danger","quote","success","question","bug","example","failure","abstract","todo","important","caution"]);

  const flushBlockquote = () => {
    if (!blockquote.length) return;
    const rawFirst = blockquote[0];
    // 1. 递归剥除所有层级 > 前缀（支持 > > [!type] 嵌套）
    let firstClean = rawFirst;
    while (/^>\s?/.test(firstClean)) firstClean = firstClean.replace(/^>\s?/, "");
    firstClean = firstClean.trim();
    // 2. indexOf 定位 [! 锚点，兼容前导污染字符
    const anchorIdx = firstClean.indexOf("[!");
    let calloutHeader = anchorIdx >= 0 ? firstClean.slice(anchorIdx) : firstClean;
    calloutHeader = calloutHeader.replace(/^\s+/, "");
    // 3. indexOf + Set 提取类型，去除正则对 "^" 锚定的依赖
    let type = null;
    let explicitTitle = "";
    if (calloutHeader.startsWith("[!")) {
      const closeBracket = calloutHeader.indexOf("]");
      if (closeBracket > 2) {
        const rawType = calloutHeader.slice(2, closeBracket).trim().toLowerCase();
        if (CALLOUT_TYPES.has(rawType)) {
          type = rawType;
          explicitTitle = calloutHeader.slice(closeBracket + 1).trim();
        }
      }
    }
    if (type) {
      const defaultTitle = CALLOUT_DEFAULT_TITLES[type] || type.charAt(0).toUpperCase() + type.slice(1);
      const title = explicitTitle || defaultTitle;
      const body = blockquote.slice(1).map((l) => {
        let clean = l;
        while (/^>\s?/.test(clean)) clean = clean.replace(/^>\s?/, "");
        return clean;
      });
      const titleHtml = `<strong class="callout-title">${inlineMarkdown(title, searchTerm)}</strong>`;
      const bodyHtml = body.map((l) => inlineMarkdown(l, searchTerm)).filter(Boolean).join("<br />");
      html.push(`<div class="callout callout-${type}" data-callout-type="${type}">${titleHtml}${bodyHtml ? `<div class="callout-body">${bodyHtml}</div>` : ""}</div>`);
    } else {
      const content = blockquote.map((l) => inlineMarkdown(l, searchTerm)).join("<br />");
      html.push(`<blockquote>${content}</blockquote>`);
    }
    blockquote = [];
    blockquoteStartLine = -1;
  };

  const flushDetails = () => {
    if (!detailsBlock) return;
    const { lines, startLine } = detailsBlock;
    let processed = lines.slice();
    // 1) 跨行 summary 内容渲染：<summary>文本</summary> → 文本 inlineMarkdown 后包回标签
    try {
      const joined = processed.join("\u0001");
      const rendered = joined.replace(/<summary>([\s\S]*?)<\/summary>/g, (_, content) => {
        const text = String(content || "").replace(/\u0001/g, "\n").trim();
        return `<summary>${inlineMarkdown(text, searchTerm)}</summary>`;
      });
      processed = rendered.split("\u0001");
    } catch (_) { /* fallback */ }
    // 2) 逐行分类：含 HTML 标签行 → 直接保留（不送 inlineMarkdown 避免二次 escape）；
    //             纯文本行 → inlineMarkdown + <p> 包装
    const renderedParts = [];
    for (let i = 0; i < processed.length; i++) {
      const p = processed[i];
      const trimmed = p.trim();
      const hasHtmlTag = /<[a-zA-Z\/!?]/.test(p);
      if (hasHtmlTag) {
        renderedParts.push(p);
      } else if (trimmed) {
        renderedParts.push(`<p>${inlineMarkdown(trimmed, searchTerm)}</p>`);
      } else {
        renderedParts.push(p);
      }
    }
    html.push(`<div data-source-line="${startLine}">${renderedParts.join("\n")}</div>`);
    detailsBlock = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // ===== details 细节块（HTML5 折叠块）累积状态机 =====
    // 小写化 + indexOf 检测，绕过正则对空白/属性的敏感性
    const lowerLine = line.toLowerCase().replace(/\r/g, "");
    const hasOpenTag = lowerLine.indexOf("<details") >= 0;
    const hasCloseTag = lowerLine.indexOf("</details>") >= 0;
    let detailsStart = false;
    if (hasOpenTag) {
      const openPos = lowerLine.indexOf("<details");
      const afterTag = lowerLine.charAt(openPos + 8);
      if (!afterTag || afterTag === ">" || /\s/.test(afterTag)) {
        const beforeOpen = lowerLine.slice(0, openPos);
        if (!beforeOpen || /^\s*$/.test(beforeOpen)) detailsStart = true;
      }
    }
    const detailsEnd = hasCloseTag;
    if (detailsBlock) {
      detailsBlock.lines.push(line);
      if (detailsEnd) flushDetails();
      continue;
    }
    if (detailsStart) {
      flushList();
      flushTable();
      flushBlockquote();
      detailsBlock = { startLine: index, lines: [line] };
      if (detailsEnd && lowerLine.indexOf("</details>") > lowerLine.indexOf("<details")) {
        flushDetails();
      }
      continue;
    }
    if (line.startsWith("```")) {
      flushList();
      flushTable();
      flushBlockquote();
      if (inCode) {
        const raw = code.join("\n");
        const normalizedLang = normalizeCodeLanguage(codeLanguage);
        // bugfix: 阅读栏 / Worker 渲染主路径原先只输出 .code-block pre code，
        // 导致 mermaid/excalidraw 的代码块没有 .chart-block + 空 .mermaid-container / .excalidraw-container，
        // 后续 renderChartsInPreview querySelectorAll(".chart-block.mermaid-block") 永远查不到——
        // 表现为“阅读模式和阅读栏里 Mermaid 都是 code 不渲染、Excalidraw 都是纯 JSON 不显示卡片”。
        // 与主 app.js renderMarkdown L2887-2891 对齐，保证两端产出相同占位结构。
        if (normalizedLang === "mermaid") {
          html.push(`<div class="chart-block mermaid-block" data-chart="mermaid" data-source-line="${codeStartLine}"><pre class="mermaid-source">${escapeHtml(raw)}</pre><div class="mermaid-container" aria-label="Mermaid 图表"></div></div>`);
        } else if (normalizedLang === "excalidraw") {
          html.push(`<div class="chart-block excalidraw-block" data-chart="excalidraw" data-source-line="${codeStartLine}"><pre class="excalidraw-source">${escapeHtml(raw)}</pre><div class="excalidraw-container" aria-label="Excalidraw 绘图"></div></div>`);
        } else if (normalizedLang === "chart") {
          // Chart.js / ECharts JSON：识别后生成自包含 iframe（CDN 加载对应库）
          // 识别失败则 fallback 为普通代码块展示 JSON
          const chartHtml = detectAndBuildChartHtml(raw);
          if (chartHtml) {
            html.push(`<div class="html-inline-block"><iframe class="html-inline-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" srcdoc="${escapeHtml(chartHtml)}"></iframe></div>`);
          } else {
            html.push(`<div class="code-block" data-language="chart"><span class="code-language">chart JSON</span><button class="code-copy" type="button">复制</button><pre><code class="language-json">${escapeHtml(raw)}</code></pre></div>`);
          }
        } else if (normalizedLang === "html-inline" || normalizedLang === "raw-html") {
          // 内嵌 HTML 网页：srcdoc 模式（HTML 内容直接内嵌）
          // allow-scripts + sandbox 隔离：脚本可运行但无法访问父 DOM
          html.push(`<div class="html-inline-block"><iframe class="html-inline-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" srcdoc="${escapeHtml(raw)}"></iframe></div>`);
        } else if (normalizedLang === "html-web") {
          // iframe URL 模式：加载外部网页
          const url = String(raw || "").trim().split("\n")[0].trim();
          const safeUrl = /^https?:\/\//i.test(url) ? url : "";
          if (safeUrl) {
            html.push(`<div class="html-inline-block"><iframe class="html-inline-frame" src="${escapeHtml(safeUrl)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" loading="lazy"></iframe></div>`);
          } else {
            html.push(`<div class="code-block"><pre><code class="language-text">html-web 需要一个有效 URL：https://example.com</code></pre></div>`);
          }
        } else {
          html.push(`<div class="code-block" data-language="${codeLanguage}"><span class="code-language">${escapeHtml(codeLanguage)}</span><button class="code-copy" type="button">复制</button><pre><code class="language-${codeLanguage}">${escapeHtml(raw)}</code></pre></div>`);
        }
        code = [];
        codeLanguage = "text";
        codeStartLine = -1;
      } else {
        codeStartLine = index;
        codeLanguage = normalizeCodeLanguage(line.slice(3).trim().split(/\s+/)[0]);
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushList();
      flushTable();
      flushBlockquote();
      html.push("<hr />");
      continue;
    }
    const row = line.includes("|") ? splitMarkdownTableRow(line) : [];
    const nextRow = lines[index + 1]?.includes("|") ? splitMarkdownTableRow(lines[index + 1]) : [];
    const startsTable = !table.length && row.length >= 2 && nextRow.length === row.length
      && nextRow.every((cell) => markdownTableAlignment(cell));
    if (startsTable) {
      flushList();
      flushBlockquote();
      table.push(line, lines[index + 1]);
      index += 1;
      continue;
    }
    if (table.length && row.length >= 2) {
      table.push(line);
      continue;
    }
    flushTable();
    const indentedHeading = line.match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (indentedHeading) {
      flushList();
      const indent = indentedHeading[1].length;
      const level = indentedHeading[2].length;
      let id;
      if (level === 1) {
        id = headingId(indentedHeading[3], h1Index++);
        h2Index = 0;
        h3Index = 0;
        h4Index = 0;
      } else if (level === 2) {
        id = headingId(indentedHeading[3], `sub-${h2Index++}`);
        h3Index = 0;
        h4Index = 0;
      } else if (level === 3) {
        id = headingId(indentedHeading[3], `h3-${h3Index++}`);
        h4Index = 0;
      } else {
        id = headingId(indentedHeading[3], `h4-${h4Index++}`);
      }
      html.push(`<h${level}${id ? ` id="${escapeHtml(id)}"` : ""} style="margin-left: ${indent * 16}px;">${inlineMarkdown(indentedHeading[3], searchTerm)}</h${level}>`);
      continue;
    }
    const cnHeading = line.match(/^(\s*)([一二三四五六七八九十]{1,4}[、．.)]\s*.+)$/);
    if (cnHeading) {
      flushList();
      const id = headingId(cnHeading[2], `auto-${h2Index++}`);
      h3Index = 0;
      h4Index = 0;
      html.push(`<h2 id="${escapeHtml(id)}" style="margin-left: ${cnHeading[1].length * 16}px;">${inlineMarkdown(cnHeading[2], searchTerm)}</h2>`);
      continue;
    }
    const dottedHeading = line.match(/^(\s*)(\d+(?:\.\d+)+)([、．.)])\s*([^-*].+)$/);
    if (dottedHeading && dottedHeading[4].trim().length > 0) {
      flushList();
      const id = headingId(dottedHeading[4], `num-h3-${h3Index++}`);
      h4Index = 0;
      html.push(`<h3 id="${escapeHtml(id)}" style="margin-left: ${dottedHeading[1].length * 16}px;">${inlineMarkdown(dottedHeading[2] + dottedHeading[3] + dottedHeading[4], searchTerm)}</h3>`);
      continue;
    }
    const numHeading = line.match(/^(\s*)(\((?:\d{1,3})\)|(\d{1,3})([、．.)]))\s*([^-*].+)$/);
    if (numHeading && !/^\s*\d+[.)]\s+\[[ xX]\](?:\s|$)/.test(line) && numHeading[5].trim().length > 0) {
      flushList();
      const id = headingId(numHeading[5], `num-h4-${h4Index++}`);
      html.push(`<h4 id="${escapeHtml(id)}" style="margin-left: ${numHeading[1].length * 16}px;">${inlineMarkdown(numHeading[2] + numHeading[5], searchTerm)}</h4>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushList();
      flushTable();
      blockquote.push(quote[1]);
      if (blockquoteStartLine < 0) blockquoteStartLine = index;
      continue;
    }
    flushBlockquote();
    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const type = bullet ? "ul" : "ol";
      const indent = bullet ? bullet[1].length : ordered[1].length;
      const content = bullet ? bullet[2] : ordered[3];
      const task = content.match(/^\[([ xX])\](?:\s+(.*))?$/);
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      const marginStyle = indent > 0 ? ` style="margin-left: ${indent * 16}px;"` : "";
      if (task) {
        const checked = task[1].toLowerCase() === "x";
        list.items.push({
          task: true,
          html: `<label${marginStyle}><input type="checkbox" data-task-line="${index}"${checked ? " checked" : ""} aria-label="${checked ? "已完成" : "未完成"}" title="点击更新任务状态" /><span>${inlineMarkdown(task[2] || "", searchTerm)}</span></label>`,
        });
      } else {
        list.items.push({ task: false, html: `<span${marginStyle}>${inlineMarkdown(content, searchTerm)}</span>` });
      }
      continue;
    }
    const indentedImage = line.match(/^(\s*)(!\[([^\]]*)\]\(([^)]+)\))/);
    if (indentedImage) {
      flushList();
      const indent = indentedImage[1].length;
      const maxWidth = Math.max(50, 100 - indent * 10);
      html.push(`<div style="margin-left: ${indent * 16}px; width: ${maxWidth < 100 ? `${maxWidth}%` : "100%"};"><p>${inlineMarkdown(indentedImage[2], searchTerm)}</p></div>`);
      continue;
    }
    if (!line.trim()) {
      flushList();
      flushBlockquote();
      html.push("");
      continue;
    }
    flushList();
    html.push(`<p>${inlineMarkdown(line, searchTerm)}</p>`);
  }
  flushList();
  flushTable();
  flushBlockquote();
  flushDetails();
  if (inCode) {
    html.push(`<div class="code-block" data-language="${codeLanguage}"><span class="code-language">${escapeHtml(codeLanguage)}</span><button class="code-copy" type="button">复制</button><pre><code class="language-${codeLanguage}">${escapeHtml(code.join("\n"))}</code></pre></div>`);
  }
  // bugfix: 还原预处理阶段保护的块级公式占位符 → <span class="math-block" data-math="...">。
  // 必须在 html.join 后做：因为逐行 <p> 包裹、段落换行、footnotes/links 等标签已经产出，
  // 此时还原出的 span 不再被 <p> 二次包裹或跨行切断，KaTeX 渲染拿到完整公式体。
  const joinedHtml = html.join("\n");
  try {
    return restoreBlockMathPlaceholders(joinedHtml, mathBlockPlaceholders);
  } catch (_) {
    return joinedHtml;
  }
}

self._markdownCache = self._markdownCache || new Map();
self._markdownCacheBytes = self._markdownCacheBytes || 0;

function workerCacheKey(source, searchTerm, includeHtml, includeOutline) {
  const text = String(source || "");
  return `${MARKDOWN_RENDER_VERSION}\n${includeHtml ? 1 : 0}${includeOutline ? 1 : 0}\n${searchTerm || ""}\n${text.length}\n${text}`;
}

function renderWithCache({ source = "", searchTerm = "", includeHtml = true, includeOutline = true } = {}) {
  const text = String(source || "");
  if (searchTerm || text.length > 900000) {
    return {
      html: includeHtml ? renderMarkdown(text, { searchTerm }) : null,
      outline: includeOutline ? extractOutline(text) : null,
    };
  }
  const key = workerCacheKey(text, searchTerm, includeHtml, includeOutline);
  const hit = self._markdownCache.get(key);
  if (hit) {
    self._markdownCache.delete(key);
    self._markdownCache.set(key, hit);
    return hit.value;
  }
  const value = {
    html: includeHtml ? renderMarkdown(text, { searchTerm }) : null,
    outline: includeOutline ? extractOutline(text) : null,
  };
  const htmlLength = value.html?.length || 0;
  const outlineLength = JSON.stringify(value.outline || []).length;
  const size = text.length + htmlLength + outlineLength;
  self._markdownCache.set(key, { value, size });
  self._markdownCacheBytes += size;
  while (self._markdownCache.size > 18 || self._markdownCacheBytes > 8_000_000) {
    const oldestKey = self._markdownCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = self._markdownCache.get(oldestKey);
    self._markdownCacheBytes -= oldest?.size || 0;
    self._markdownCache.delete(oldestKey);
  }
  return value;
}

self.onmessage = async (event) => {
  const data = event.data || {};
  const { seq, searchTerm = "", includeHtml = true, includeOutline = true, useBlob = false } = data;
  // Blob 传输：从 Blob 重建源文本
  let source = data.source || "";
  if (useBlob && data.blob) {
    try { source = await data.blob.text(); } catch (_) { source = ""; }
  }
  const result = renderWithCache({ source, searchTerm, includeHtml, includeOutline });
  // 大响应也用 Blob 传输（避免结构化克隆在主线程产生峰值）
  const HTML_BLOB_THRESHOLD = 100 * 1024; // 100KB
  if (useBlob && result.html && result.html.length > HTML_BLOB_THRESHOLD) {
    const htmlBlob = new Blob([result.html]);
    self.postMessage({ seq, useBlob: true, htmlBlob, outline: result.outline }, [htmlBlob]);
  } else {
    self.postMessage({ seq, useBlob: false, html: result.html, outline: result.outline });
  }
};
