function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function normalizeCodeLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", py: "python", sh: "bash", shell: "bash",
    zsh: "bash", ps: "powershell", ps1: "powershell", yml: "yaml", md: "markdown",
    cc: "cpp", cxx: "cpp", "c++": "cpp", cs: "csharp", "c#": "csharp", rs: "rust",
    golang: "go", txt: "text", plain: "text", "text/plain": "text",
  };
  const normalized = aliases[raw] || raw;
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

function renderMarkdown(source, options = {}) {
  const searchTerm = options.searchTerm || "";
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let h1Index = 0;
  let h2Index = 0;
  let h3Index = 0;
  let h4Index = 0;
  let inCode = false;
  let code = [];
  let codeLanguage = "text";
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
        html.push(`<div class="code-block" data-language="${codeLanguage}"><span class="code-language">${escapeHtml(codeLanguage)}</span><button class="code-copy" type="button">复制</button><pre><code class="language-${codeLanguage}">${escapeHtml(code.join("\n"))}</code></pre></div>`);
        code = [];
        codeLanguage = "text";
      } else {
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
  return html.join("\n");
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
