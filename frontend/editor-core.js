import { EditorState, EditorSelection, Transaction, Compartment } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  Decoration,
  WidgetType,
} from "@codemirror/view";
import { defaultKeymap, deleteLine, history, undo, redo } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap, search, SearchQuery, SearchCursor, getSearchQuery, setSearchQuery, openSearchPanel, findNext, findPrevious } from "@codemirror/search";
import { tags } from "@lezer/highlight";

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--cm-heading)" },
  { tag: tags.heading1, color: "var(--cm-heading-strong)", fontWeight: "700" },
  { tag: tags.heading2, color: "var(--cm-heading-strong)", fontWeight: "650" },
  { tag: tags.heading3, color: "var(--cm-heading)", fontWeight: "650" },
  { tag: tags.link, color: "var(--cm-link)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--cm-url)" },
  { tag: tags.emphasis, color: "var(--cm-emphasis)", fontStyle: "italic" },
  { tag: tags.strong, color: "var(--cm-strong)", fontWeight: "700" },
  { tag: tags.monospace, color: "var(--cm-code)" },
  { tag: tags.comment, color: "var(--cm-comment)" },
  { tag: tags.keyword, color: "var(--cm-keyword)" },
  { tag: tags.string, color: "var(--cm-string)" },
  { tag: tags.number, color: "var(--cm-number)" },
  { tag: tags.bool, color: "var(--cm-bool)" },
  { tag: tags.typeName, color: "var(--cm-type)" },
  { tag: tags.className, color: "var(--cm-type)" },
  { tag: tags.propertyName, color: "var(--cm-property)" },
  { tag: tags.operator, color: "var(--cm-operator)" },
  { tag: tags.punctuation, color: "var(--cm-punctuation)" },
  { tag: tags.invalid, color: "var(--cm-invalid)", textDecoration: "underline wavy" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    minWidth: "0",
    color: "var(--text)",
    backgroundColor: "transparent",
    fontSize: "var(--doc-font-size)",
    "--cm-heading": "var(--accent-strong)",
    "--cm-heading-strong": "var(--accent-strong)",
    "--cm-link": "#2563eb",
    "--cm-url": "#4338ca",
    "--cm-emphasis": "var(--text)",
    "--cm-strong": "var(--text)",
    "--cm-code": "var(--code-text)",
    "--cm-comment": "var(--muted)",
    "--cm-keyword": "#7c3aed",
    "--cm-string": "#047857",
    "--cm-number": "#b45309",
    "--cm-bool": "#be123c",
    "--cm-type": "#0369a1",
    "--cm-property": "#0f766e",
    "--cm-operator": "#475569",
    "--cm-punctuation": "var(--muted)",
    "--cm-invalid": "#dc2626",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
    lineHeight: "1.72",
  },
  ".cm-content": {
    padding: "26px max(28px, calc((100% - 800px) / 2)) 60vh",
    caretColor: "var(--accent-strong)",
  },
  ".cm-line": { padding: "0 2px" },
  ".cm-gutters": {
    backgroundColor: "color-mix(in srgb, var(--surface-1) 92%, transparent)",
    color: "var(--muted)",
    borderRight: "1px solid var(--hairline)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent) !important",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent-strong)" },
  ".cm-panels": {
    backgroundColor: "var(--surface-1)",
    color: "var(--text)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-1)",
    color: "var(--text)",
    border: "1px solid var(--line)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 40%, transparent) !important",
    borderRadius: "2px",
    boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent-strong) 50%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent-strong) 55%, transparent) !important",
    boxShadow: "0 0 0 2px var(--accent-strong)",
  },
});

/**
 * 沉浸式渲染（所见即所得）扩展。
 *
 * 设计原则：**默认关闭，可运行时热切换，关闭时编辑器行为与旧版逐字节一致**。
 * - 通过 Compartment + 空扩展实现动态开关，不重建 EditorView（不丢历史/选区/滚动）。
 * - Markdown 渲染函数由外部注入（injectRenderer），核心不依赖 app.js 的 renderMarkdown。
 * - 只对「光标不在其中的块」施加行级装饰，光标所在块保持源码可编辑 —— 与参考站
 *   MarkdownAssistant 的「编辑 / 沉浸」双模式交互一致。
 */
const markdownBlockMark = Decoration.line({ class: "mt-md-block" });

/**
 * 行内样式标记 `{color|bg|size:值|内容}` 的「只读渲染」装饰。
 *
 * 背景：`{bg:#fee2e2|文字}` 这类自定义标记由 app.js 的 inlineMarkdown 转成
 * 带内联样式的 <span>。但沉浸模式的块级渲染只覆盖 5 类块（代码/公式/引用/表格/列表/标题），
 * **普通段落从不进入块替换**（块替换会干扰光标落点，是刻意的收窄）。
 * 于是裸段落里的标记永远显示源码 —— 用户看到的「字体和背景没生效」。
 *
 * 解法：不改块结构，改用 Decoration.mark 把「标记本身的字符范围」包一层，
 * 并把它**同时**标记为 atomic + 隐藏。CodeMirror 对 atomicRanges 内被
 * `display:none` 隐藏的文本，不会把光标停在中间 —— 编辑器自身就是这么实现
 * 「隐藏 Markdown 标记符」的（hideMarkup 装饰 与 atomicRanges 成对使用）。
 * 因此这里不会出现「光标卡在标记里」的问题，段落也依旧是普通段落。
 */
class InlineStyleWidget extends WidgetType {
  constructor(html) {
    super();
    this.html = html;
  }
  // 内容相同才复用，避免每次重渲染都替换 DOM 节点
  eq(other) {
    return other instanceof InlineStyleWidget && other.html === this.html;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "mt-md-inline-style";
    span.innerHTML = this.html || "";
    return span;
  }
  ignoreEvent() {
    // 点击渲染结果仍把事件交给编辑器，保证可定位光标
    return false;
  }
}

/**
 * 行内数学公式 `$…$` / `$$…$$` 的「只读渲染」装饰。
 *
 * 与行内样式标记同源的问题：块级渲染只覆盖 5 类块（且 `$$` 围栏要求定界符独占一行），
 * 混在普通段落里的公式从不进入渲染管线 —— 沉浸模式下用户看到的是一串 LaTeX 源码。
 *
 * 解法与 InlineStyleWidget 一致：只把「定界符连同公式体」的字符范围替换掉，
 * 段落仍是普通段落。真正的 KaTeX 排版交给宿主注入的挂载钩子
 * （app.js::renderMathInPreview —— 它按 `[data-math]` 取待渲染元素），
 * 因此这里只要造出正确的 `.math-inline[data-math]` 结构即可，核心不依赖 KaTeX。
 *
 * 一律按**行内**排版（不区分 `$` / `$$`）：`.math-block` 是 display:block，
 * 插进段落文本行会把这一行劈成「公式前 / 公式后」两个匿名块，观感比缩小的公式更糟。
 * 真正需要独占一行居中排版的 `$$…$$` 由块级识别（collectMdBlockRanges）接管。
 */
class InlineMathWidget extends WidgetType {
  constructor(latex, source, onMount) {
    super();
    this.latex = latex;
    // 保留原始源码（含用户写的定界符），KaTeX 不可用时降级显示
    this.source = source;
    this.onMount = onMount || null;
  }
  eq(other) {
    return (
      other instanceof InlineMathWidget &&
      other.latex === this.latex &&
      other.source === this.source
    );
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "math-inline mt-md-inline-math";
    span.setAttribute("data-math", this.latex);
    // 未渲染前（KaTeX 尚未加载 / 无外网）显示源码，避免布局从空到有的跳动。
    span.textContent = this.source;
    if (typeof this.onMount === "function") {
      const cb = this.onMount;
      queueMicrotask(() => {
        try {
          cb(span);
        } catch (_) {}
      });
    }
    return span;
  }
  ignoreEvent() {
    // 点击渲染结果仍把事件交给编辑器，保证可定位光标
    return false;
  }
}

// 标记语法：{color:#rrggbb|内容} / {bg:#rrggbb|内容} / {size:1-2位数字|内容}
// 值域与 app.js::inlineMarkdown 的 styleToken 完全一致，避免两处解析分叉。
const INLINE_STYLE_TOKEN = /\{(color|bg|size):(#[0-9a-fA-F]{6}|\d{1,2})\|/g;

// editor-core 不依赖 app.js 的工具链，本地实现最小转义（与 path-utils.escapeHtml 逐字符一致）
function escapeHtmlLocal(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
const escapeHtml = escapeHtmlLocal;

/**
 * 把一段文本里的自定义样式标记递归转成 HTML（与 inlineMarkdown 的输出一致）。
 * 用「花括号配对」扫描而不是单个正则替换，这样才能正确处理嵌套：
 *   {size:18|{color:#16a34a|文字}} —— 简单正则只认得最内层，外层 {size:18|…} 会泄漏成源码。
 * 未闭合的标记（用户正在输入）整段跳过、保持源码 —— 输入过程不会被半截语法打断。
 */
function renderInlineStyleHtml(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    INLINE_STYLE_TOKEN.lastIndex = i;
    const m = INLINE_STYLE_TOKEN.exec(text);
    if (!m) {
      out += escapeHtml(text.slice(i));
      break;
    }
    out += escapeHtml(text.slice(i, m.index));
    // 花括号配对找匹配的闭括号（内容里允许嵌套一层或多层标记）
    let depth = 0;
    let close = -1;
    for (let k = m.index + 1; k < text.length; k += 1) {
      if (text[k] === "{") depth += 1;
      else if (text[k] === "}") {
        if (depth === 0) { close = k; break; }
        depth -= 1;
      }
    }
    if (close === -1) {
      // 未闭合：原样保留（正则可能吃到后面的嵌套，所以只保留到「{」前已输出的部分，
      // 从「{」开始逐字符原样输出，等待下一次输入事件重新扫描）
      out += escapeHtml(text.slice(m.index));
      break;
    }
    const type = m[1];
    const value = m[2];
    const inner = text.slice(m.index + m[0].length, close);
    const innerHtml = renderInlineStyleHtml(inner);
    if (type === "color") out += `<span style="color:${value}">${innerHtml}</span>`;
    else if (type === "bg") out += `<span style="background-color:${value};padding:0 3px;border-radius:3px">${innerHtml}</span>`;
    else out += `<span style="font-size:${value}px">${innerHtml}</span>`;
    i = close + 1;
  }
  return out;
}

/**
 * 扫描一行文本里的自定义样式标记（最外层），返回「整段标记」的渲染结果与字符范围。
 * 嵌套由 renderInlineStyleHtml 递归处理；这里只负责给最外层标记定位。
 */
function scanInlineStyleTokens(text) {
  const out = [];
  INLINE_STYLE_TOKEN.lastIndex = 0;
  let m;
  while ((m = INLINE_STYLE_TOKEN.exec(text)) !== null) {
    let depth = 0;
    let close = -1;
    for (let k = m.index + 1; k < text.length; k += 1) {
      if (text[k] === "{") depth += 1;
      else if (text[k] === "}") {
        if (depth === 0) { close = k; break; }
        depth -= 1;
      }
    }
    if (close === -1) break; // 未闭合的半截标记：后面不再扫（保持源码）
    out.push({
      from: m.index,
      to: close + 1,
      html: renderInlineStyleHtml(text.slice(m.index, close + 1)),
    });
    INLINE_STYLE_TOKEN.lastIndex = close + 1;
  }
  return out;
}

/**
 * 扫描一行文本里的行内数学公式（`$…$` 与同一行内的 `$$…$$`）。
 *
 * 与块级公式互补：独占一行的 `$$` 围栏由 collectMdBlockRanges 接管（整块替换），
 * 本函数只处理**混在普通段落里**的公式，替换范围仅覆盖定界符与公式体，
 * 段落结构、行高与光标落点都不受影响。
 *
 * 保守规则（宁可漏渲染也不误伤正文）：
 *   - 反斜杠转义的 `\$` 不算定界符；
 *   - 开定界符右侧、闭定界符左侧不得是空白 —— 避免「售价 $ 5 元」这类误判；
 *   - 未配对时直接放弃该行剩余部分（保持源码，等待下一次输入）；
 *   - 不支持跨行：行内装饰本就逐行计算，跨行公式走 `$$` 围栏。
 */
function scanInlineMathTokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "$" || (i > 0 && text[i - 1] === "\\")) {
      i += 1;
      continue;
    }
    const display = text[i + 1] === "$";
    const open = i + (display ? 2 : 1);
    if (open >= text.length || /\s/.test(text[open])) {
      i = open;
      continue;
    }
    let close = -1;
    for (let k = open; k < text.length; k += 1) {
      if (text[k] === "\\") { k += 1; continue; }
      if (text[k] !== "$") continue;
      if (display) {
        if (text[k + 1] === "$") { close = k; break; }
      } else if (!/\s/.test(text[k - 1])) {
        close = k;
        break;
      }
    }
    if (close === -1) break; // 未闭合的半截公式：保持源码
    const end = close + (display ? 2 : 1);
    const latex = text.slice(open, close).trim();
    if (latex) out.push({ from: i, to: end, latex });
    i = end;
  }
  return out;
}

/* ---------------------------------------------------------------------------
   行内语义标记：**粗体** / *斜体* / `代码` / [文字](url) / ~~删除~~ / ==高亮==
   ---------------------------------------------------------------------------
   与行内样式标记、行内公式同源的问题：块级渲染只接管「整块」，
   普通段落里的 Markdown 语义标记一直以源码形式裸露 —— 叠加等宽字体后，
   观感是「半渲染的 Markdown 编辑器」，而不是「写作即成品」。

   解法与 InlineStyleWidget 完全一致：只把「标记字符范围」替换为渲染结果，
   段落本身仍是普通段落，光标落点与行高不受影响。容器复用 .markdown-body 类，
   直接取得 strong / em / code / a / del / mark 的语义样式，不再维护一份会过期的副本。

   保守规则（宁可漏渲染也不误伤正文）：
     - 反斜杠转义（\* \_ \` \[ \~ \=）一律不参与匹配；
     - 定界符内侧不得是空白，「* 星号 *」保持源码；
     - 行内代码优先级最高，其内部不再解析其它标记；
     - 与样式标记 / 行内公式 / 链接重叠时让路（重叠的 replace 装饰会让 CodeMirror 抛错）。
--------------------------------------------------------------------------- */

const INLINE_MARK_MAX_DEPTH = 4;

/** 只放行可交给系统浏览器打开的协议；相对路径不渲染为可点击链接，避免 WebView 内部跳转。 */
function safeInlineUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url.startsWith("#")) return url;
  const protocol = (url.match(/^([a-z][a-z0-9+.-]*):/i) || [])[1];
  if (protocol) return /^(https?|mailto|tel)$/i.test(protocol) ? url : "";
  return "";
}

/** 纯文本段落 → HTML：先还原反斜杠转义，再做 HTML 转义。 */
function inlineTextToHtml(text) {
  return escapeHtml(String(text).replace(/\\([\\`*_[\]()~=#+\-.!>])/g, "$1"));
}

/**
 * 扫描一行里的行内语义标记。返回按位置升序、互不重叠的 { from, to, html } 列表。
 *
 * 嵌套（**粗 \`码\` 体** / [**粗**](url)）的取舍：
 *   同一段文本只能有一个替换装饰（重叠的 replace 会让 CodeMirror 直接抛错），
 *   而外层标记的 html 本身就是由 renderInlineMarkHtml 递归渲染内层得到的，
 *   所以这里按「起点升序、终点降序」贪心取最外层子集：
 *     · 被已选范围包含的候选 → 丢弃（外层递归时会把它渲染出来）；
 *     · 包含已选范围的候选 → 取代之（并回看，可能连吞多个）；
 *     · 交叉重叠（互不包含）→ 丢弃后到的，宁可漏渲染也不误伤正文。
 */
function scanInlineMarkTokens(text, depth) {
  const d = depth || 0;
  if (!text || d >= INLINE_MARK_MAX_DEPTH) return [];
  const candidates = [];
  const inner = (s) => renderInlineMarkHtml(s, d + 1);
  let m;

  // 1) 行内代码：优先级最高，内部一律不再解析
  const codeRe = /(?<!\\)`([^`\n]+)`/g;
  while ((m = codeRe.exec(text)) !== null) {
    candidates.push({
      from: m.index,
      to: m.index + m[0].length,
      html: `<code>${escapeHtml(m[1])}</code>`,
    });
  }

  // 2) 链接 [文字](url) 与 [文字](url "标题")
  const linkRe = /(?<!\\)\[([^\]\n]*)\]\(\s*([^)\s]*)\s*(?:"([^"\n]*)")?\s*\)/g;
  while ((m = linkRe.exec(text)) !== null) {
    const label = inner(m[1]) || inlineTextToHtml(m[2]);
    const url = safeInlineUrl(m[2]);
    if (!url) {
      // 非外链协议（相对路径 / 未知协议）：只保留文字，不生成可点击元素
      candidates.push({ from: m.index, to: m.index + m[0].length, html: label });
      continue;
    }
    const title = escapeHtml(m[3] || m[2]);
    candidates.push({
      from: m.index,
      to: m.index + m[0].length,
      html: `<a class="mt-md-inline-link" role="link" data-href="${escapeHtml(url)}" title="${title}">${label}</a>`,
    });
  }

  // 3) 加粗
  const strongRe = /(?<!\\)\*\*(?=\S)([\s\S]*?\S)\*\*/g;
  while ((m = strongRe.exec(text)) !== null) {
    candidates.push({ from: m.index, to: m.index + m[0].length, html: `<strong>${inner(m[1])}</strong>` });
  }

  // 4) 斜体（* 与 _；_ 需避免 foo_bar_baz 这类标识符误判）
  const emStarRe = /(?<![\w*\\])\*(?=\S)([^*\n]*?[^\s*])\*(?!\*)/g;
  while ((m = emStarRe.exec(text)) !== null) {
    candidates.push({ from: m.index, to: m.index + m[0].length, html: `<em>${inner(m[1])}</em>` });
  }
  const emUnderRe = /(?<![\w_\\])_(?=\S)([^_\n]*?[^\s_])_(?![\w_])/g;
  while ((m = emUnderRe.exec(text)) !== null) {
    candidates.push({ from: m.index, to: m.index + m[0].length, html: `<em>${inner(m[1])}</em>` });
  }

  // 5) 删除线
  const delRe = /(?<!\\)~~(?=\S)([^~\n]*?[^\s~])~~/g;
  while ((m = delRe.exec(text)) !== null) {
    candidates.push({ from: m.index, to: m.index + m[0].length, html: `<del>${inner(m[1])}</del>` });
  }

  // 6) 高亮
  const markRe = /(?<!\\)==(?=\S)([^=\n]*?[^\s=])==/g;
  while ((m = markRe.exec(text)) !== null) {
    candidates.push({ from: m.index, to: m.index + m[0].length, html: `<mark>${inner(m[1])}</mark>` });
  }

  candidates.sort((a, b) => a.from - b.from || b.to - a.to);
  const out = [];
  for (const c of candidates) {
    let keep = true;
    while (out.length) {
      const last = out[out.length - 1];
      if (c.from >= last.to) break;              // 不重叠，接在后面
      if (c.to <= last.to) { keep = false; break; }  // 被包含 → 让路（外层会递归渲染它）
      if (c.from <= last.from) { out.pop(); continue; } // 包含 → 取代并回看
      keep = false;                              // 交叉重叠 → 丢弃后到的
      break;
    }
    if (keep) out.push(c);
  }
  return out;
}

/** 把一行文本转成「行内标记已渲染」的 HTML；无标记时等价于转义。 */
function renderInlineMarkHtml(text, depth) {
  const d = depth || 0;
  if (!text) return "";
  if (d >= INLINE_MARK_MAX_DEPTH) return inlineTextToHtml(text);
  const tokens = scanInlineMarkTokens(text, d);
  if (!tokens.length) return inlineTextToHtml(text);
  let out = "";
  let cursor = 0;
  for (const tok of tokens) {
    out += inlineTextToHtml(text.slice(cursor, tok.from));
    out += tok.html;
    cursor = tok.to;
  }
  out += inlineTextToHtml(text.slice(cursor));
  return out;
}

/**
 * 行内语义标记的「只读渲染」装饰。
 * 容器同时挂 .markdown-body，取得 strong/em/code/a/del/mark 的语义样式；
 * 容器级属性（限宽/居中/内边距/字号/行高）由 styles.css 中和为继承值。
 */
class InlineMarkWidget extends WidgetType {
  constructor(html, key) {
    super();
    this.html = html;
    this.key = key;
  }
  eq(other) {
    return other instanceof InlineMarkWidget && other.key === this.key;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "mt-md-inline-mark markdown-body";
    span.innerHTML = this.html || "";
    // 普通点击交给编辑器定位光标；Ctrl / Cmd + 点击才打开外部链接，
    // 与预览栏「外链交给系统浏览器」的策略保持一致。
    for (const a of span.querySelectorAll("a[data-href]")) {
      a.addEventListener("click", (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        const url = a.getAttribute("data-href") || "";
        if (!url) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof window !== "undefined" && typeof window.__mtOpenExternal === "function") {
          window.__mtOpenExternal(url);
        }
      });
    }
    return span;
  }
  ignoreEvent() {
    // 点击渲染结果仍把事件交给编辑器，保证可定位光标
    return false;
  }
}

class MarkdownPreviewWidget extends WidgetType {
  constructor(html, signature, onMount) {
    super();
    this.html = html;
    this.signature = signature;
    this.onMount = onMount || null;
  }
  eq(other) {
    return other instanceof MarkdownPreviewWidget && other.signature === this.signature;
  }
  toDOM() {
    const wrap = document.createElement("div");
    // 必须同时携带 markdown-body：
    // 预览面板（#preview / #markdownView）用的是 .markdown-body，其排版规则有 400+ 条
    // （图片限宽限高、表格边框与内边距、代码块底色、引用缩进、链接取主题色、按主题微调…）。
    // 沉浸容器若只叫 .mt-md-wysiwyg，这些规则一条都匹配不上，
    // 会导致图片按原始像素硬渲染、表格塌成细条、行高退回 normal、链接变成 UA 蓝。
    // 容器级属性（width/margin/padding/font-size/line-height）由 styles.css 里的
    // `.app-shell.immersive .cm-line .mt-md-wysiwyg.markdown-body` 规则中和掉。
    wrap.className = "mt-md-wysiwyg markdown-body";
    wrap.innerHTML = this.html || "";
    // 挂载后交给宿主做二次渲染（KaTeX 公式 / Mermaid 图表 / 代码高亮等）。
    // 这些渲染是异步且依赖 DOM 已存在的，必须在挂载后触发。
    if (typeof this.onMount === "function") {
      const cb = this.onMount;
      queueMicrotask(() => {
        try {
          cb(wrap);
        } catch (_) {}
      });
    }
    return wrap;
  }
  ignoreEvent() {
    // 点击预览内容时仍把光标交给编辑器处理，避免「点不进正文」。
    return false;
  }
}

/**
 * 空占位：替换多行块除首行外的内容。
 * CodeMirror 的 ViewPlugin 不允许提供「替换换行符」的装饰，因此跨行块只能
 * 逐行处理——首行放渲染结果，其余行清空占位（保留换行符，不破坏行结构）。
 */
class MarkdownBlankWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "mt-md-blank";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  eq() {
    return true;
  }
  ignoreEvent() {
    return false;
  }
}

/**
 * 计算需要渲染的「块」范围。
 * 覆盖：围栏代码块、数学公式块、标题 / 分隔线 / 独立图片行、
 *       表格、引用与提示块（callout）、列表。
 * 普通段落不处理——块级替换会影响光标落点，收窄类型是控制风险的关键。
 */
function collectMdBlockRanges(doc) {
  const ranges = [];
  const isFence = (t) => /^\s*(`{3,}|~{3,})/.test(t);
  const isMathFence = (t) => /^\s*\$\$\s*$/.test(t);
  const isQuote = (t) => /^\s*>/.test(t);
  const isTableRow = (t) => /^\s*\|.*\|\s*$/.test(t);
  const isListItem = (t) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(t);
  const isImageOnly = (t) => /^\s*(?:!\[[^\]]*\]\([^)]*\)\s*)+$/.test(t);
  const isIndented = (t) => /^(?:\s{2,}|\t)/.test(t) && t.trim() !== "";
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    const text = line.text;

    // 1) 围栏代码块 / 数学公式块：按同种围栏配对
    if (isFence(text) || isMathFence(text)) {
      const matcher = isMathFence(text) ? isMathFence : isFence;
      let j = i + 1;
      while (j <= doc.lines && !matcher(doc.line(j).text)) j += 1;
      const end = Math.min(j, doc.lines);
      ranges.push({ from: doc.line(i).from, to: doc.line(end).to, startLine: i, endLine: end });
      i = end + 1;
      continue;
    }

    // 2) 引用 / 提示块：连续的 > 行
    if (isQuote(text)) {
      let j = i;
      while (j <= doc.lines && isQuote(doc.line(j).text)) j += 1;
      const end = j - 1;
      ranges.push({ from: doc.line(i).from, to: doc.line(end).to, startLine: i, endLine: end });
      i = end + 1;
      continue;
    }

    // 3) 表格：连续的 | ... | 行（含分隔行）
    if (isTableRow(text)) {
      let j = i;
      while (j <= doc.lines && isTableRow(doc.line(j).text)) j += 1;
      const end = j - 1;
      ranges.push({ from: doc.line(i).from, to: doc.line(end).to, startLine: i, endLine: end });
      i = end + 1;
      continue;
    }

    // 4) 列表：从列表项开始，吞掉其缩进续行
    if (isListItem(text)) {
      let j = i;
      while (
        j + 1 <= doc.lines &&
        (isListItem(doc.line(j + 1).text) || isIndented(doc.line(j + 1).text))
      ) {
        j += 1;
      }
      const end = j;
      ranges.push({ from: line.from, to: doc.line(end).to, startLine: i, endLine: end });
      i = end + 1;
      continue;
    }

    // 5) 标题 / 分隔线 / 独立图片行 / 含图片的段落（图片常在段落内单独一行）
    if (
      /^\s{0,3}(#{1,6})\s+/.test(text) ||
      /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(text) ||
      isImageOnly(text)
    ) {
      ranges.push({ from: line.from, to: line.to, startLine: i, endLine: i });
    }
    i += 1;
  }
  return ranges;
}

function buildMarkdownWysiwygExtension(getRenderer, isEnabled, onWidgetMount) {
  const mount = () => (typeof onWidgetMount === "function" ? onWidgetMount() : null);
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.compute(view);
      }
      update(update) {
        if (!update.docChanged && !update.selectionSet && !update.viewportChanged) return;
        this.decorations = this.compute(update.view);
      }
      compute(view) {
        if (!isEnabled()) return Decoration.none;
        const renderer = getRenderer();
        if (typeof renderer !== "function") return Decoration.none;
        const doc = view.state.doc;
        const cursorLines = new Set();
        for (const range of view.state.selection.ranges) {
          const fromLine = doc.lineAt(range.from).number;
          const toLine = doc.lineAt(range.to).number;
          for (let n = fromLine; n <= toLine; n += 1) cursorLines.add(n);
        }
        // 只渲染视口附近的块（上下各预留一屏），避免大文档每次按键全量重渲染。
        const visible = view.visibleRanges;
        const visFrom = visible.length ? doc.lineAt(Math.max(0, visible[0].from - 1)).number : 1;
        const visTo = visible.length
          ? doc.lineAt(Math.min(doc.length, visible[visible.length - 1].to + 1)).number
          : doc.lines;
        const margin = Math.max(20, visTo - visFrom);
        const builder = [];
        const blockRanges = collectMdBlockRanges(doc);
        // 被块级渲染覆盖的行号，行内样式标记要避开，避免同一段文本被渲染两次。
        const blockedLines = new Set();
        for (const block of blockRanges) {
          for (let n = block.startLine; n <= block.endLine; n += 1) blockedLines.add(n);
        }
        for (const block of blockRanges) {
          if (block.endLine < visFrom - margin || block.startLine > visTo + margin) continue;
          let hasCursor = false;
          for (let n = block.startLine; n <= block.endLine; n += 1) {
            if (cursorLines.has(n)) { hasCursor = true; break; }
          }
          // 光标所在块保持源码，便于直接编辑；其余块渲染为最终效果。
          if (hasCursor) continue;
          const source = doc.sliceString(block.from, block.to);
          let html;
          try {
            html = renderer(source);
          } catch (_) {
            continue;
          }
          if (!html) continue;
          const signature = `${block.from}:${block.to}:${source.length}`;
          builder.push(markdownBlockMark.range(block.from));
          // 逐行装饰，避免跨行 replace（CodeMirror 禁止 plugin 提供吞换行符的装饰）：
          // 首行整行替换为渲染结果；其余行内容替换为空占位，换行符保留。
          // 注意：widget 必须在 Decoration.replace(spec) 创建时传入，range() 无第三参数。
          if (block.startLine === block.endLine) {
            builder.push(
              Decoration.replace({
                widget: new MarkdownPreviewWidget(html, signature, mount()),
                block: false,
              }).range(block.from, block.to),
            );
          } else {
            const first = doc.line(block.startLine);
            builder.push(
              Decoration.replace({
                widget: new MarkdownPreviewWidget(html, signature, mount()),
                block: false,
              }).range(first.from, first.to),
            );
            for (let n = block.startLine + 1; n <= block.endLine; n += 1) {
              const l = doc.line(n);
              if (l.from === l.to) continue;
              builder.push(
                Decoration.replace({ widget: new MarkdownBlankWidget(), block: false }).range(l.from, l.to),
              );
            }
          }
        }

        // ── 行内装饰：自定义样式标记 + 行内公式 ────────────────────────────────
        // 普通段落不参与上面的块替换（保护光标落点），但段落里的自定义标记与
        // 数学公式必须在沉浸模式下可见，否则用户看到的是「字体和背景没生效」
        // 与「公式显示成 LaTeX 源码」。
        // 这里只把「标记字符范围」替换成渲染结果，段落本身仍是普通段落。
        for (let n = 1; n <= doc.lines; n += 1) {
          if (blockedLines.has(n)) continue;   // 已由块级渲染接管
          if (cursorLines.has(n)) continue;    // 光标所在行保持源码可编辑
          const line = doc.line(n);
          const text = line.text;
          if (!text) continue;
          // 同一段文本只能有一个替换装饰（重叠会让 CodeMirror 直接抛错）。
          // 优先级：自定义样式标记 > 行内公式 > 行内语义标记；后者与前两者重叠时让路。
          const claimed = [];
          const overlapsClaimed = (f, t) => claimed.some(([cf, ct]) => f < ct && t > cf);
          if (text.indexOf("{") !== -1) {
            for (const tok of scanInlineStyleTokens(text)) {
              if (tok.from === tok.to) continue;
              claimed.push([tok.from, tok.to]);
              builder.push(
                Decoration.replace({
                  widget: new InlineStyleWidget(tok.html),
                  block: false,
                }).range(line.from + tok.from, line.from + tok.to),
              );
            }
          }
          if (text.indexOf("$") !== -1) {
            for (const tok of scanInlineMathTokens(text)) {
              if (overlapsClaimed(tok.from, tok.to)) continue;
              claimed.push([tok.from, tok.to]);
              builder.push(
                Decoration.replace({
                  widget: new InlineMathWidget(tok.latex, text.slice(tok.from, tok.to), mount()),
                  block: false,
                }).range(line.from + tok.from, line.from + tok.to),
              );
            }
          }
          // 行内语义标记：**粗体** / *斜体* / `代码` / [文字](url) / ~~删除~~ / ==高亮==
          if (/[*_`[\]~=]/.test(text)) {
            for (const tok of scanInlineMarkTokens(text)) {
              if (overlapsClaimed(tok.from, tok.to)) continue;
              claimed.push([tok.from, tok.to]);
              builder.push(
                Decoration.replace({
                  widget: new InlineMarkWidget(tok.html, `${tok.from}:${tok.to}:${tok.html}`),
                  block: false,
                }).range(line.from + tok.from, line.from + tok.to),
              );
            }
          }
        }
        return Decoration.set(builder, true);
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations || Decoration.none),
    },
  );
}

const professionalKeymap = [
  {
    key: "Mod-d",
    run(view) {
      const changes = view.state.changeByRange((range) => {
        const doc = view.state.doc;
        const first = doc.lineAt(range.from);
        // 选中多行时复制全部所选行；选区落在下一行行首时归属上一行，
        // 与 moveCurrentLine 行为一致，避免多复制一条空行。
        const last = doc.lineAt(Math.max(range.from, range.to - 1));
        const text = doc.sliceDoc(first.from, last.to);
        const insert = `\n${text}`;
        return {
          changes: { from: last.to, insert },
          range: EditorSelection.cursor(last.to + insert.length),
        };
      });
      view.dispatch(changes);
      return true;
    },
  },
  {
    key: "Shift-Alt-ArrowUp",
    preventDefault: true,
    run: (view) => moveCurrentLine(view, -1),
  },
  {
    key: "Shift-Alt-ArrowDown",
    preventDefault: true,
    run: (view) => moveCurrentLine(view, 1),
  },
  { key: "Mod-Shift-k", run: deleteLine },
  // Native undo/redo: replaying transactions incrementally avoids the
  // full-document re-render flicker that a whole-doc replace would cause.
  { key: "Mod-z", run: undo, preventDefault: true },
  { key: "Mod-y", run: redo, preventDefault: true },
  { key: "Mod-Shift-z", run: redo, preventDefault: true },
  { key: "Shift-Mod-z", run: redo, preventDefault: true },
  // VSCode Markdown All-in-One style toggles.
  { key: "Alt-s", run: toggleStrikethrough, preventDefault: true },
  { key: "Alt-c", run: toggleTaskLine, preventDefault: true },
  ...closeBracketsKeymap,
  ...foldKeymap,
  // 移除 searchKeymap 中的 Mod-d（selectNextOccurrence），
  // 避免与上方自定义的「向下复制选中行」冲突；保留其余搜索快捷键。
  ...searchKeymap.filter((binding) => binding.key !== "Mod-d"),
  ...defaultKeymap.filter((binding) => !/^(Mod-z|Mod-y|Mod-Shift-z|Tab|Mod-b|Mod-i)$/.test(binding.key || "")),
];

function wrapSelectionWith(view, marker) {
  const { state, dispatch } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const wrapped = `${marker}${selected || "文本"}${marker}`;
    return {
      changes: { from: range.from, to: range.to, insert: wrapped },
      range: selected
        ? EditorSelection.range(range.from + marker.length, range.to + marker.length)
        : EditorSelection.range(range.from + marker.length, range.from + marker.length + 2),
    };
  });
  dispatch(changes, { scrollIntoView: true });
  return true;
}

function toggleStrikethrough(view) {
  return wrapSelectionWith(view, "~~");
}

function toggleTaskLine(view) {
  const { state, dispatch } = view;
  const doc = state.doc;
  const changes = state.changeByRange((range) => {
    const line = doc.lineAt(range.from);
    const text = line.text;
    const taskMatch = text.match(/^(\s*(?:[-*]|\d+[.)])\s+)\[([ xX])\]/);
    if (taskMatch) {
      const checked = taskMatch[2] !== " " && taskMatch[2].toLowerCase() !== " ";
      const replacement = text.replace(taskMatch[0], `${taskMatch[1]}[${checked ? " " : "x"}]`);
      return {
        changes: { from: line.from, to: line.to, insert: replacement },
        range: EditorSelection.range(line.from + range.from - line.from, line.from + range.to - line.from),
      };
    }
    const listMatch = text.match(/^(\s*(?:[-*]|\d+[.)])\s+)(.*)$/);
    if (listMatch) {
      const replacement = `${listMatch[1]}[ ] ${listMatch[2]}`;
      return {
        changes: { from: line.from, to: line.to, insert: replacement },
        range,
      };
    }
    return { range };
  });
  if (changes.changes.empty) return false;
  dispatch(changes, { scrollIntoView: true });
  return true;
}

function moveCurrentLine(view, direction) {
  const selection = view.state.selection.main;
  const doc = view.state.doc;
  const first = doc.lineAt(selection.from);
  // A selection ending at the next line's start belongs to the previous line.
  const last = doc.lineAt(Math.max(selection.from, selection.to - 1));
  const targetNumber = direction < 0 ? first.number - 1 : last.number + 1;
  if (targetNumber < 1 || targetNumber > doc.lines) return true;

  const target = doc.line(targetNumber);
  const block = doc.sliceString(first.from, last.to);
  const targetText = doc.sliceString(target.from, target.to);
  const replacement = direction < 0 ? `${block}\n${targetText}` : `${targetText}\n${block}`;
  const from = direction < 0 ? target.from : first.from;
  const to = direction < 0 ? last.to : target.to;
  const newBlockFrom = direction < 0 ? target.from : first.from + targetText.length + 1;
  const anchorOffset = selection.anchor - first.from;
  const headOffset = selection.head - first.from;

  view.dispatch({
    changes: { from, to, insert: replacement },
    selection: EditorSelection.single(newBlockFrom + anchorOffset, newBlockFrom + headOffset),
    scrollIntoView: true,
  });
  return true;
}

class MarkdownEditorAdapter {
  constructor(host, initialValue = "") {
    this.host = host;
    this.events = new EventTarget();
    this.lastSelection = "0:0";
    // 沉浸渲染：默认关闭（wysiwygEnabled=false），渲染器为空，行为与旧版完全一致。
    this.wysiwygEnabled = false;
    this.wysiwygRenderer = null;
    this.wysiwygCompartment = new Compartment();
    this.wysiwygMountHook = null;
    this.wysiwygExtension = buildMarkdownWysiwygExtension(
      () => this.wysiwygRenderer,
      () => this.wysiwygEnabled,
      () => {
        const hook = this.wysiwygMountHook;
        return hook ? (el) => hook(el) : null;
      },
    );
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          EditorState.allowMultipleSelections.of(true),
          EditorView.clickAddsSelectionRange.of((event) => event.altKey),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          markdown(),
          syntaxHighlighting(markdownHighlightStyle, { fallback: true }),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search(),
          keymap.of(professionalKeymap),
          EditorView.lineWrapping,
          editorTheme,
          // 默认空扩展：不产生任何装饰，渲染/编辑行为与旧版逐字节一致。
          this.wysiwygCompartment.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.events.dispatchEvent(new Event("input"));
            if (update.selectionSet) {
              const main = update.state.selection.main;
              const signature = `${main.from}:${main.to}`;
              if (signature !== this.lastSelection) {
                this.lastSelection = signature;
                this.events.dispatchEvent(new Event("select"));
              }
            }
          }),
          ViewPlugin.fromClass(class {
            constructor(view) {
              view.contentDOM.spellcheck = false;
              view.contentDOM.setAttribute("aria-label", "Markdown 专业编辑器");
            }
          }),
        ],
      }),
    });
  }

  get value() {
    return this.view.state.doc.toString();
  }

  set value(nextValue) {
    const value = String(nextValue ?? "");
    if (value === this.value) return;
    const previous = this.value;
    const selection = this.view.state.selection;
    const mapPosition = (position) => {
      const point = Math.max(0, Math.min(previous.length, Number(position) || 0));
      let prefix = 0;
      const limit = Math.min(previous.length, value.length);
      while (prefix < limit && previous[prefix] === value[prefix]) prefix += 1;
      let suffix = 0;
      while (
        suffix < previous.length - prefix &&
        suffix < value.length - prefix &&
        previous[previous.length - 1 - suffix] === value[value.length - 1 - suffix]
      ) suffix += 1;
      if (point <= prefix) return point;
      if (point >= previous.length - suffix) {
        return Math.max(prefix, Math.min(value.length, value.length - (previous.length - point)));
      }
      // When a formatter changes the current line, keep the cursor inside the
      // corresponding changed span instead of sending it to document start.
      const newSpan = Math.max(0, value.length - prefix - suffix);
      return Math.max(prefix, Math.min(value.length, prefix + Math.min(newSpan, point - prefix)));
    };
    const ranges = selection.ranges.map((range) =>
      EditorSelection.range(mapPosition(range.anchor), mapPosition(range.head)),
    );
    const nextSelection = EditorSelection.create(ranges, Math.min(selection.mainIndex, ranges.length - 1));
    const scrollTop = this.view.scrollDOM.scrollTop;
    const scrollLeft = this.view.scrollDOM.scrollLeft;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: value },
      selection: nextSelection,
      annotations: Transaction.addToHistory.of(false),
    });
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = scrollTop;
      this.view.scrollDOM.scrollLeft = scrollLeft;
    });
  }

  get selectionStart() {
    return this.view.state.selection.main.from;
  }

  set selectionStart(value) {
    this.setSelectionRange(value, Math.max(Number(value) || 0, this.selectionEnd));
  }

  get selectionEnd() {
    return this.view.state.selection.main.to;
  }

  set selectionEnd(value) {
    this.setSelectionRange(Math.min(this.selectionStart, Number(value) || 0), value);
  }

  get scrollTop() {
    return this.view.scrollDOM.scrollTop;
  }

  set scrollTop(value) {
    this.view.scrollDOM.scrollTop = Number(value) || 0;
  }

  get scrollLeft() {
    return this.view.scrollDOM.scrollLeft;
  }

  set scrollLeft(value) {
    this.view.scrollDOM.scrollLeft = Number(value) || 0;
  }

  get scrollHeight() {
    return this.view.scrollDOM.scrollHeight;
  }

  get clientHeight() {
    return this.view.scrollDOM.clientHeight;
  }

  get classList() {
    return this.host.classList;
  }

  get style() {
    return this.host.style;
  }

  get isContentEditable() {
    return true;
  }

  get tagName() {
    return "DIV";
  }

  get hasFocus() {
    return this.view.hasFocus;
  }

  focus() {
    this.view.focus();
  }

  /**
   * 注入 Markdown → HTML 渲染器（由宿主提供，核心不硬编码）。
   * 签名：renderer(source: string) => string
   */
  injectRenderer(renderer) {
    this.wysiwygRenderer = typeof renderer === "function" ? renderer : null;
    return this;
  }

  /**
   * 注入「挂载后处理」钩子：接收渲染结果容器，用于 KaTeX 公式 / Mermaid 图表 /
   * 代码高亮等必须依赖真实 DOM 且异步完成的二次渲染。
   */
  injectWidgetMountHook(hook) {
    this.wysiwygMountHook = typeof hook === "function" ? hook : null;
    return this;
  }

  /**
   * 开/关沉浸式渲染（所见即所得）。通过 Compartment 热切换，不重建 EditorView，
   * 因此不会丢失撤销历史、选区与滚动位置；关闭后编辑器恢复原始源码显示。
   */
  setWysiwygEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.wysiwygEnabled) return this.wysiwygEnabled;
    this.wysiwygEnabled = next;
    this.view.dispatch({
      effects: this.wysiwygCompartment.reconfigure(next ? this.wysiwygExtension : []),
    });
    return this.wysiwygEnabled;
  }

  get wysiwygActive() {
    return this.wysiwygEnabled;
  }

  contains(node) {
    return this.host.contains(node);
  }

  getBoundingClientRect() {
    return this.view.contentDOM.getBoundingClientRect();
  }

  setSelectionRange(start, end = start) {
    const length = this.view.state.doc.length;
    const from = Math.max(0, Math.min(length, Number(start) || 0));
    const to = Math.max(from, Math.min(length, Number(end) || 0));
    this.view.dispatch({ selection: EditorSelection.single(from, to) });
  }

  setRangeText(replacement, start = this.selectionStart, end = this.selectionEnd, selectionMode = "preserve") {
    const insert = String(replacement ?? "");
    const length = this.view.state.doc.length;
    const from = Math.max(0, Math.min(length, Number(start) || 0));
    const to = Math.max(from, Math.min(length, Number(end) || 0));
    let anchor = from + insert.length;
    let head = anchor;
    if (selectionMode === "select") {
      anchor = from;
      head = from + insert.length;
    } else if (selectionMode === "start") {
      anchor = from;
      head = from;
    }
    this.view.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.single(anchor, head),
    });
  }

  undo() {
    undo({ state: this.view.state, dispatch: this.view.dispatch.bind(this.view) });
  }

  redo() {
    redo({ state: this.view.state, dispatch: this.view.dispatch.bind(this.view) });
  }

  scrollToLine(lineNumber) {
    const doc = this.view.state.doc;
    const target = Math.max(1, Math.min(doc.lines, Number(lineNumber) || 1));
    const line = doc.line(target);
    this.view.dispatch({
      selection: EditorSelection.single(line.from),
      scrollIntoView: { y: "center" },
    });
    this.view.focus();
    requestAnimationFrame(() => {
      const coords = this.view.coordsAtPos(line.from);
      if (!coords) return;
      const editorRect = this.view.scrollDOM.getBoundingClientRect();
      const lineCenter = coords.top + (coords.bottom - coords.top) / 2;
      const editorCenter = editorRect.top + this.view.scrollDOM.clientHeight / 2;
      const offset = lineCenter - editorCenter;
      if (Math.abs(offset) > 5) {
        this.view.scrollDOM.scrollTop += offset;
      }
    });
  }

  searchInEditor(query) {
    const term = String(query || "").trim();
    if (!term) return { total: 0, current: 0, matches: [] };
    const searchQuery = new SearchQuery({ search: term });
    const cursor = searchQuery.getCursor(this.view.state);
    const matches = [];
    while (true) {
      const result = cursor.next();
      if (result.done) break;
      matches.push({ from: result.value.from, to: result.value.to });
    }
    return { total: matches.length, matches };
  }

  replaceAll(searchText, replacementText) {
    const term = String(searchText || "").trim();
    if (!term) return 0;
    const replacement = String(replacementText ?? "");
    const searchQuery = new SearchQuery({ search: term });
    const cursor = searchQuery.getCursor(this.view.state);
    const changes = [];
    while (true) {
      const result = cursor.next();
      if (result.done) break;
      changes.push({ from: result.value.from, to: result.value.to, insert: replacement });
    }
    if (changes.length > 0) {
      this.view.dispatch({ changes });
    }
    this.view.focus();
    return changes.length;
  }

  jumpToMatch(from, to) {
    this.view.dispatch({
      selection: EditorSelection.single(from, to),
      scrollIntoView: true,
    });
    this.view.focus();
  }

  openSearchPanelWithQuery(query) {
    const term = String(query || "");
    this.view.focus();
    if (term) {
      const searchQuery = new SearchQuery({ search: term });
      this.view.dispatch({
        effects: setSearchQuery.of(searchQuery),
      });
    }
    openSearchPanel(this.view);
  }

  findNext() {
    findNext(this.view);
  }

  findPrevious() {
    findPrevious(this.view);
  }

  addEventListener(type, listener, options) {
    if (["input", "select"].includes(type)) {
      this.events.addEventListener(type, listener, options);
      return;
    }
    if (type === "scroll") {
      this.view.scrollDOM.addEventListener(type, listener, options);
      return;
    }
    this.view.contentDOM.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    if (["input", "select"].includes(type)) {
      this.events.removeEventListener(type, listener, options);
      return;
    }
    if (type === "scroll") {
      this.view.scrollDOM.removeEventListener(type, listener, options);
      return;
    }
    this.view.contentDOM.removeEventListener(type, listener, options);
  }

  dispatchEvent(event) {
    return this.events.dispatchEvent(event);
  }
}

export function createMarkdownEditor(host, initialValue = "") {
  if (!host) throw new Error("Markdown editor host is missing");
  return new MarkdownEditorAdapter(host, initialValue);
}
