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

function safeMarkdownUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "#";
  const protocol = url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (protocol && !["http", "https", "mailto"].includes(protocol)) return "#";
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
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="auto-size-image" loading="lazy" />')
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

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
      flushList();
      flushTable();
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
      html.push("<hr />");
      continue;
    }
    const row = line.includes("|") ? splitMarkdownTableRow(line) : [];
    const nextRow = lines[index + 1]?.includes("|") ? splitMarkdownTableRow(lines[index + 1]) : [];
    const startsTable = !table.length && row.length >= 2 && nextRow.length === row.length
      && nextRow.every((cell) => markdownTableAlignment(cell));
    if (startsTable) {
      flushList();
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
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushList();
      html.push(`<blockquote>${inlineMarkdown(quote[1], searchTerm)}</blockquote>`);
      continue;
    }
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
      html.push("");
      continue;
    }
    flushList();
    html.push(`<p>${inlineMarkdown(line, searchTerm)}</p>`);
  }
  flushList();
  flushTable();
  if (inCode) {
    html.push(`<div class="code-block" data-language="${codeLanguage}"><span class="code-language">${escapeHtml(codeLanguage)}</span><button class="code-copy" type="button">复制</button><pre><code class="language-${codeLanguage}">${escapeHtml(code.join("\n"))}</code></pre></div>`);
  }
  return html.join("\n");
}

self.onmessage = (event) => {
  const { seq, source = "", searchTerm = "", includeHtml = true, includeOutline = true } = event.data || {};
  self.postMessage({
    seq,
    html: includeHtml ? renderMarkdown(source, { searchTerm }) : null,
    outline: includeOutline ? extractOutline(source) : null,
  });
};
