// 导出/幻灯片相关的纯函数集合：从 app.js 抽取，不依赖模块级 state/els。

// 去除 Markdown frontmatter（--- ... ---），纯函数。
export function stripFrontmatter(markdown) {
  const source = String(markdown || "");
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return source;
  const before = source.slice(0, match.index).trimEnd();
  const after = source.slice(match.index + match[0].length).trimStart();
  return (before ? before + "\n\n" : "") + after;
}

// 转义正则元字符，纯函数。
export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 将 Markdown 文本按"逻辑块"拆分：fenced 代码块、表格、连续列表、普通段落各自作为独立块。
// 这样后续分页不会把 ```...``` 之类的整块结构切碎到两个页面导致内容丢失。
export function splitIntoLogicalBlocks(source) {
  const lines = String(source || "").split(/\r?\n/);
  const blocks = [];
  let buffer = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced 代码块（``` 或 ~~~）作为整块
    const fence = line.match(/^(\s*)(```+|~~~+)/);
    if (fence) {
      const marker = fence[2];
      // 如果上一段非空先封页
      if (buffer.length) { blocks.push(buffer.join("\n").trim()); buffer = []; }
      const closeRe = new RegExp(`^\\s*${escapeRegex(marker[0])}{${marker.length},}\\s*$`);
      buffer.push(line);
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        buffer.push(lines[i]);
        i++;
      }
      if (i < lines.length) { buffer.push(lines[i]); i++; }
      blocks.push(buffer.join("\n").trim());
      buffer = [];
      continue;
    }
    // 表格（至少一行含 | 且分隔前后非空）作为整块
    if (/^\s*\|?\s*[^|\r\n]+\s*(\|\s*[^|\r\n]+\s*)+\|?\s*$/.test(line)) {
      if (buffer.length) { blocks.push(buffer.join("\n").trim()); buffer = []; }
      while (i < lines.length && /^\s*\|?\s*[^|\r\n]+\s*(\|\s*[^|\r\n]+\s*)+\|?\s*$/.test(lines[i])) {
        buffer.push(lines[i]);
        i++;
      }
      blocks.push(buffer.join("\n").trim());
      buffer = [];
      continue;
    }
    // 空行 → 作为段落分隔：如果 buffer 有内容就成块
    if (/^\s*$/.test(line)) {
      if (buffer.length) { blocks.push(buffer.join("\n").trim()); buffer = []; }
      i++;
      continue;
    }
    buffer.push(line);
    i++;
  }
  if (buffer.length) blocks.push(buffer.join("\n").trim());
  return blocks.filter(Boolean);
}

// 估算一个 Markdown 逻辑块在幻灯片中占据的"等效行数"，用于自动分页阈值。
export function estimateBlockLines(block) {
  const text = String(block || "");
  if (!text) return 0;
  const first = text.split(/\r?\n/)[0] || "";
  // 代码块按实际行 + 视觉边距
  if (/^(```+|~~~+)/.test(first)) {
    const n = text.split(/\r?\n/).length;
    return Math.max(3, Math.min(10, n + 1));
  }
  // 表格按实际行
  if (/^\s*\|/.test(first) || /\|/.test(first)) {
    const n = text.split(/\r?\n/).length;
    return Math.max(2, Math.min(8, n + 1));
  }
  // 列表按实际行
  if (/^\s*[-*+]\s+/.test(first) || /^\s*\d+\.\s+/.test(first)) {
    const n = text.split(/\r?\n/).filter((l) => /^\s*([-*+]|\d+\.)\s+/.test(l)).length;
    return Math.max(1, Math.min(6, n + 1));
  }
  // 标题按视觉高度
  if (/^#+\s+/.test(first)) return 2;
  // 引用块按实际行
  if (/^>\s?/.test(first)) {
    return Math.max(2, Math.min(5, text.split(/\r?\n/).length + 1));
  }
  // 图片占位
  if (/^!\[.*?\]\(.*?\)/.test(first)) return 4;
  // 普通段落：按文字量估算（中文每 20 字≈一行）
  const chars = text.replace(/\s+/g, "").length;
  const rawLines = text.split(/\r?\n/).length;
  const est = Math.max(rawLines, Math.ceil(chars / 22));
  return Math.max(1, Math.min(5, est));
}

// 将 Markdown 拆分为幻灯片：优先 --- 分页，其次一/二级标题，最后按逻辑块累计行数分页。
export function splitMarkdownIntoSlides(markdown) {
  const source = stripFrontmatter(String(markdown || "")).trim();
  if (!source) return [];

  // 1) 优先按独立成行的 --- 分页（水平分隔线作为用户显式幻灯片断点）
  const byRule = source.split(/(?:\r?\n|\r)\s*-{3,}\s*(?:\r?\n|\r)/).map((s) => s.trim()).filter(Boolean);
  if (byRule.length > 1) return byRule;

  // 2) 按一级或二级标题拆分
  const headingRe = /^#{1,2}\s+/m;
  if (headingRe.test(source)) {
    const lines = source.split(/\r?\n/);
    const chunks = [];
    let buffer = [];
    for (const line of lines) {
      if (/^#{1,2}\s+/.test(line) && buffer.length) {
        chunks.push(buffer.join("\n").trim());
        buffer = [];
      }
      buffer.push(line);
    }
    if (buffer.length) chunks.push(buffer.join("\n").trim());
    return chunks.filter(Boolean);
  }

  // 3) 无标题时：先把文档切分成"逻辑块"，再按块累计行数分页
  //    这样可以避免把代码块、表格等整体结构切断（用户反馈的内容丢失主要来源于此）
  const blocks = splitIntoLogicalBlocks(source);
  if (blocks.length <= 1) return [source];

  // 单张幻灯片预估可容纳的"逻辑行"上限（图片/代码按实际行数算，段落按文字行数算）
  const LINES_PER_SLIDE = 7;
  const slides = [];
  let current = [];
  let lineCount = 0;
  for (const block of blocks) {
    const bl = estimateBlockLines(block);
    // 非空页 + 加入后超出阈值 → 先封页再开新页
    if (current.length && lineCount + bl > LINES_PER_SLIDE) {
      slides.push(current.join("\n\n").trim());
      current = [];
      lineCount = 0;
    }
    // 单个块超限也单独成页，不要丢弃
    current.push(block.trim());
    lineCount += bl;
  }
  if (current.length) slides.push(current.join("\n\n").trim());
  return slides.filter(Boolean);
}

// 将 HTML 中指向 127.0.0.1/localhost 的资源 URL 规范化为相对路径，纯函数（依赖浏览器 document）。
export function normalizeAssetUrlsToRelative(html) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  wrapper.querySelectorAll("[src], [href]").forEach((el) => {
    const attr = el.hasAttribute("src") ? "src" : "href";
    const value = el.getAttribute(attr) || "";
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i.test(value)) {
      try {
        const url = new URL(value, window.location.origin);
        if (url.pathname) el.setAttribute(attr, url.pathname + url.search + url.hash);
      } catch (_) { /* keep original */ }
    }
  });
  return wrapper.innerHTML;
}
