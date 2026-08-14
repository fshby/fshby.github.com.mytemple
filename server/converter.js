/**
 * 统一文档转换模块
 * 导入: DOCX/PDF/XLSX/HTML/PPTX/EPUB/CSV/TXT/JSON → Markdown
 * 导出: Markdown → HTML/DOCX/TXT
 */

import mammoth from "mammoth";
import TurndownService from "turndown";
import * as xlsx from "xlsx";
import { marked } from "marked";
import { unzipSync } from "node:zlib";

/* ── 共用工具 ── */

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});

// 表格支持
turndown.use([
  (service) => {
    service.addRule("tableCell", {
      filter: ["th", "td"],
      replacement(content, node) {
        return ` ${content.trim().replace(/\n/g, " ")} |`;
      },
    });
    service.addRule("tableRow", {
      filter: "tr",
      replacement(content, node) {
        const cells = content.split("|").filter((c) => c.trim() !== "");
        if (cells.length === 0) return "";
        const row = `|${cells.join("|")}|\n`;
        // 表头行后加分隔行
        if (node.parentNode.tagName === "THEAD" ||
            (node.rowIndex === 0 && !node.previousElementSibling)) {
          return row + `|${cells.map(() => "---").join("|")}|\n`;
        }
        return row;
      },
    });
    service.addRule("table", {
      filter: "table",
      replacement(content, node) {
        return `\n\n${content}\n`;
      },
    });
  },
]);

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "").trim();
}

function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/* ── ZIP 解析（用于 PPTX / EPUB） ── */

function parseZipEntries(buffer) {
  const entries = {};
  if (buffer.length < 22) return entries;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error("Invalid ZIP: EOCD not found");
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const cdEntries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compMethod = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const uncompSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compData = buffer.subarray(dataStart, dataStart + compSize);
    let fileData;
    if (compMethod === 0) {
      fileData = compData;
    } else if (compMethod === 8) {
      fileData = unzipSync(compData);
    } else {
      fileData = Buffer.alloc(0);
    }
    entries[name] = { data: fileData, size: uncompSize };
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ── 导入转换 ── */

/**
 * DOCX → Markdown
 * 使用 mammoth 提取 HTML，再用 turndown 转为 Markdown
 */
export async function docxToMarkdown(buffer) {
  const result = await mammoth.convertToHtml({ buffer });
  let html = result.value || "";
  if (!html.trim()) return "# 导入的文档\n\n（文档内容为空）";
  // turndown 处理
  let md = turndown.turndown(html);
  return md.trim() || "# 导入的文档\n\n（文档内容为空）";
}

/**
 * PDF → Markdown
 * 使用 pdf-parse 提取文本
 */
export async function pdfToMarkdown(buffer) {
  const pdfParse = (await import("pdf-parse")).default;
  const data = await pdfParse(buffer);
  let text = data.text || "";
  if (!text.trim()) return "# 导入的 PDF\n\n（PDF 无可提取文本，可能是扫描件）";
  // 清理 PDF 提取的文本：合并断行
  const lines = text.split("\n");
  const paragraphs = [];
  let current = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (current) { paragraphs.push(current); current = ""; }
    } else {
      current = current ? `${current} ${trimmed}` : trimmed;
    }
  }
  if (current) paragraphs.push(current);
  return `# 导入的 PDF\n\n${paragraphs.join("\n\n")}`;
}

/**
 * XLSX / XLS → Markdown
 * 使用 SheetJS 读取工作表，每个 sheet 转为 Markdown 表格
 */
export async function xlsxToMarkdown(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheets = workbook.SheetNames;
  if (sheets.length === 0) return "# 导入的 Excel\n\n（无工作表）";

  const parts = [];
  for (const sheetName of sheets) {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false });
    if (rows.length === 0) continue;

    parts.push(`## ${sheetName}\n`);
    const headers = rows[0].map((h) => String(h ?? "").trim() || " ");
    parts.push(`| ${headers.join(" | ")} |`);
    parts.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const cells = headers.map((_, idx) => String(row[idx] ?? "").trim().replace(/\n/g, " ") || " ");
      parts.push(`| ${cells.join(" | ")} |`);
    }
    parts.push("");
  }
  return parts.join("\n") || "# 导入的 Excel\n\n（工作表为空）";
}

/**
 * HTML → Markdown
 * 使用 turndown
 */
export function htmlToMarkdown(html) {
  let text = html.replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  let md = turndown.turndown(text);
  return md.trim() || "# 导入的 HTML\n\n（内容为空）";
}

/**
 * PPTX → Markdown
 * 解压 ZIP，提取每张幻灯片的文本
 */
export async function pptxToMarkdown(buffer) {
  const entries = parseZipEntries(buffer);
  const slideKeys = Object.keys(entries)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)?.[1] || "0", 10);
      const nb = parseInt(b.match(/slide(\d+)/)?.[1] || "0", 10);
      return na - nb;
    });

  if (slideKeys.length === 0) return "# 导入的 PPT\n\n（无幻灯片内容）";

  const parts = ["# 导入的 PPT\n"];
  for (let idx = 0; idx < slideKeys.length; idx++) {
    const xml = entries[slideKeys[idx]].data.toString("utf8");
    // 提取所有 <a:t> 文本节点
    const texts = [];
    const matches = xml.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g);
    for (const m of matches) {
      const t = decodeXmlEntities(m[1]).trim();
      if (t) texts.push(t);
    }
    if (texts.length > 0) {
      parts.push(`\n## 幻灯片 ${idx + 1}\n`);
      parts.push(texts.join("\n\n"));
      parts.push("");
    }
  }
  return parts.join("\n") || "# 导入的 PPT\n\n（幻灯片内容为空）";
}

/**
 * EPUB → Markdown
 * 解压 ZIP，提取 HTML 章节，用 turndown 转 Markdown
 */
export async function epubToMarkdown(buffer) {
  const entries = parseZipEntries(buffer);
  // 读取 OPF 获取章节顺序
  const opfKey = Object.keys(entries).find((k) => k.endsWith(".opf"));
  let chapterKeys = [];

  if (opfKey) {
    const opfXml = entries[opfKey].data.toString("utf8");
    const manifest = new Map();
    const itemMatches = opfXml.matchAll(/<item\s+[^>]*id="([^"]*)"[^>]*href="([^"]*)"[^>]*media-type="([^"]*)"[^>]*\/?>/g);
    for (const m of itemMatches) {
      manifest.set(m[1], { href: m[2], mediaType: m[3] });
    }
    // spine 顺序
    const spineMatches = opfXml.matchAll(/<itemref\s+[^>]*idref="([^"]*)"[^>]*\/?>/gi);
    for (const m of spineMatches) {
      const item = manifest.get(m[1]);
      if (item && (item.mediaType === "application/xhtml+xml" || item.mediaType === "text/html")) {
        // 相对于 OPF 所在目录
        const opfDir = opfKey.split("/").slice(0, -1).join("/");
        const fullPath = opfDir ? `${opfDir}/${item.href}` : item.href;
        chapterKeys.push(fullPath);
      }
    }
  }

  // 如果没找到章节，退而求其次
  if (chapterKeys.length === 0) {
    chapterKeys = Object.keys(entries)
      .filter((k) => (k.endsWith(".html") || k.endsWith(".xhtml")) && !k.includes("nav"))
      .sort();
  }

  if (chapterKeys.length === 0) return "# 导入的 EPUB\n\n（无章节内容）";

  const parts = ["# 导入的 EPUB\n"];
  for (const key of chapterKeys) {
    const entry = entries[key];
    if (!entry) continue;
    const html = entry.data.toString("utf8");
    let md = turndown.turndown(html).trim();
    if (md) {
      parts.push(`\n${md}\n`);
    }
  }
  return parts.join("\n") || "# 导入的 EPUB\n\n（内容为空）";
}

/**
 * CSV → Markdown 表格
 */
export function csvToMarkdown(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "";
  const parseRow = (line) => {
    const cells = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === "," && !inQuotes) { cells.push(cell.trim()); cell = ""; }
      else { cell += ch; }
    }
    cells.push(cell.trim());
    return cells;
  };
  const headers = parseRow(lines[0]);
  let md = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n`;
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    md += `| ${row.map((c) => c || " ").join(" | ")} |\n`;
  }
  return md;
}

/**
 * TXT → Markdown
 */
export function txtToMarkdown(name, text) {
  return `# ${name}\n\n${text}`;
}

/**
 * JSON → Markdown 代码块
 */
export function jsonToMarkdown(name, text) {
  try {
    const parsed = JSON.parse(text);
    return `# ${name}\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  } catch {
    return `# ${name}\n\n\`\`\`json\n${text}\n\`\`\``;
  }
}

/* ── 导出转换 ── */

/**
 * Markdown → HTML（带样式模板）
 */
export function markdownToHtml(md, options = {}) {
  const { title = "导出文档", author = "", watermark = "" } = options;
  const body = marked.parse(md, { async: false });
  const titleTag = title ? `<h1 class="doc-title">${escapeHtml(title)}</h1>` : "";
  const authorTag = author ? `<p class="doc-author">${escapeHtml(author)}</p>` : "";
  const watermarkTag = watermark
    ? `<div class="watermark">${escapeHtml(watermark)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif; max-width: 800px; margin: 2em auto; padding: 0 1em; color: #333; line-height: 1.8; }
  .doc-title { font-size: 2em; border-bottom: 2px solid #eee; padding-bottom: 0.3em; }
  .doc-author { color: #888; font-size: 0.9em; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 0.5em 0.8em; text-align: left; }
  th { background: #f5f5f5; }
  code { background: #f5f5f5; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f5f5f5; padding: 1em; border-radius: 5px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #ddd; margin: 1em 0; padding: 0.5em 1em; color: #666; }
  img { max-width: 100%; }
  a { color: #4a90d9; }
  .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg); font-size: 3em; color: rgba(0,0,0,0.05); pointer-events: none; z-index: 999; white-space: nowrap; }
  @media print { .watermark { position: absolute; } }
</style>
</head>
<body>
${watermarkTag}
${titleTag}
${authorTag}
${body}
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Markdown → DOCX
 * 先转 HTML，再用 html-to-docx 生成 DOCX
 */
export async function markdownToDocx(md, options = {}) {
  const { title = "导出文档", author = "", watermark = "" } = options;
  const htmlToDocx = (await import("html-to-docx")).default;
  const body = marked.parse(md, { async: false });
  const titleTag = title ? `<h1>${escapeHtml(title)}</h1>` : "";
  const authorTag = author ? `<p><em>${escapeHtml(author)}</em></p>` : "";

  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title></head>
<body>
${titleTag}
${authorTag}
${body}
</body>
</html>`;

  const docxBuffer = await htmlToDocx(fullHtml, null, {
    table: { row: { cantSplit: true } },
    footer: false,
    pageNumber: false,
  });
  return docxBuffer;
}

/**
 * Markdown → 纯文本
 * 去除 Markdown 语法符号
 */
export function markdownToTxt(md) {
  let text = md;
  // 去除 frontmatter
  text = text.replace(/^---[\s\S]*?---\n?/, "");
  // 去除标题井号
  text = text.replace(/^#{1,6}\s+/gm, "");
  // 去除加粗/斜体
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/_([^_]+)_/g, "$1");
  // 去除代码块
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```$/g, ""));
  text = text.replace(/`([^`]+)`/g, "$1");
  // 去除链接，保留文本
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // 去除图片
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  // 去除引用标记
  text = text.replace(/^>\s+/gm, "");
  // 去除列表标记
  text = text.replace(/^[-*+]\s+/gm, "");
  text = text.replace(/^\d+\.\s+/gm, "");
  // 去除表格分隔行
  text = text.replace(/^\|[\s:|-]+\|$/gm, "");
  // 去除表格管道符
  text = text.replace(/^\|/gm, "").replace(/\|$/gm, "").replace(/\|/g, "\t");
  // 去除水平线
  text = text.replace(/^---+$/gm, "");
  // 压缩多余空行
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/* ── 统一入口：根据扩展名分发 ── */

/**
 * 导入：根据文件扩展名选择转换器
 * @returns {Promise<{ markdown: string, title: string }>}
 */
export async function importToMarkdown(fileName, buffer) {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const safeName = baseName.replace(/[\\/:*?"<>|]/g, "_");
  const text = buffer.toString("utf8");

  let markdown = "";

  switch (ext) {
    case "docx":
      markdown = await docxToMarkdown(buffer);
      break;
    case "pdf":
      markdown = await pdfToMarkdown(buffer);
      break;
    case "xlsx":
    case "xls":
      markdown = await xlsxToMarkdown(buffer);
      break;
    case "html":
    case "htm":
      markdown = htmlToMarkdown(text);
      break;
    case "pptx":
      markdown = await pptxToMarkdown(buffer);
      break;
    case "epub":
      markdown = await epubToMarkdown(buffer);
      break;
    case "csv":
      markdown = csvToMarkdown(text);
      break;
    case "txt":
      markdown = txtToMarkdown(safeName, text);
      break;
    case "json":
      markdown = jsonToMarkdown(safeName, text);
      break;
    case "md":
      markdown = text;
      break;
    default:
      markdown = `# ${safeName}\n\n> 此文件为 .${ext.toUpperCase()} 格式，已创建占位文档。支持完整转换的格式：DOCX、PDF、XLSX、HTML、PPTX、EPUB、CSV、TXT、JSON、Markdown。\n\n\`\`\`\n[原始文件: ${fileName}]\n大小: ${formatFileSize(buffer.length)}\n\`\`\``;
  }

  return { markdown, title: safeName };
}

/**
 * 导出：根据目标格式选择转换器
 * @returns {Promise<{ buffer: Buffer, mimeType: string, ext: string }>}
 */
export async function exportFromMarkdown(md, format, options = {}) {
  switch (format) {
    case "html": {
      const html = markdownToHtml(md, options);
      return { buffer: Buffer.from(html, "utf8"), mimeType: "text/html", ext: "html" };
    }
    case "docx": {
      const docxBuffer = await markdownToDocx(md, options);
      return { buffer: docxBuffer, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
    }
    case "txt": {
      const text = markdownToTxt(md);
      return { buffer: Buffer.from(text, "utf8"), mimeType: "text/plain", ext: "txt" };
    }
    case "md": {
      return { buffer: Buffer.from(md, "utf8"), mimeType: "text/markdown", ext: "md" };
    }
    default:
      throw new Error(`不支持的导出格式: ${format}`);
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
