import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir, stat, mkdir, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.join(__dirname, "docs");
const PUBLIC_ROOT = path.join(__dirname, "public");
const SOURCE_ROOT = path.join(__dirname, "source");
const PORT = Number(process.env.PORT || 4173);

let cache = { stamp: 0, files: [], tree: [], graph: { nodes: [], edges: [] } };
const MAX_ASSET_BYTES = 5 * 1024 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function normalizeDocPath(input) {
  const decoded = decodeURIComponent(input || "").replace(/\\/g, "/");
  const clean = path.posix.normalize(decoded).replace(/^(\.\.\/)+/, "");
  const absolute = path.resolve(DOCS_ROOT, clean);
  if (!absolute.startsWith(path.resolve(DOCS_ROOT))) {
    throw new Error("Invalid document path");
  }
  return { relative: clean, absolute };
}

function normalizeSourcePath(input) {
  const decoded = decodeURIComponent(input || "").replace(/\\/g, "/");
  const clean = path.posix.normalize(decoded).replace(/^(\.\.\/)+/, "");
  const absolute = path.resolve(SOURCE_ROOT, clean);
  if (!absolute.startsWith(path.resolve(SOURCE_ROOT))) {
    throw new Error("Invalid source path");
  }
  return { relative: clean, absolute };
}

function sanitizeEntryName(input) {
  return String(input || "")
    .trim()
    .replace(/[<>:"|?*\x00-\x1F]/g, "-")
    .replace(/[\\/]+/g, "-")
    .replace(/^\.+$/, "")
    .slice(0, 80);
}

async function ensureDocs() {
  if (!existsSync(DOCS_ROOT)) {
    await mkdir(DOCS_ROOT, { recursive: true });
  }
  if (!existsSync(SOURCE_ROOT)) {
    await mkdir(SOURCE_ROOT, { recursive: true });
  }
}

async function getLatestMtime(dir) {
  let latest = (await stat(dir)).mtimeMs;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const entryStat = await stat(absolute);
    latest = Math.max(latest, entryStat.mtimeMs);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await getLatestMtime(absolute));
    }
  }
  return latest;
}

async function walk(dir = DOCS_ROOT, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const items = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))) {
    const absolute = path.join(dir, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      const children = await walk(absolute, relative);
      items.push({ type: "folder", name: entry.name, path: relative, children });
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const { text: source, encoding } = await readMarkdownFile(absolute);
      const stats = await stat(absolute);
      items.push({
        type: "file",
        name: entry.name,
        title: extractTitle(source, entry.name),
        displayName: entry.name,
        path: relative,
        encoding,
        size: stats.size,
        modified: stats.mtimeMs,
      });
    }
  }
  return items;
}

function flattenTree(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === "file") out.push(node);
    if (node.children) flattenTree(node.children, out);
  }
  return out;
}

function extractTitle(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback.replace(/\.md$/i, "");
}

async function readMarkdownFile(absolute) {
  const buffer = await readFile(absolute);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(buffer.subarray(3)), encoding: "utf-8-bom" };
  }

  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const utf8Bad = replacementScore(utf8);
  if (utf8Bad === 0 && !looksLikeMojibake(utf8)) {
    return { text: utf8, encoding: "utf-8" };
  }

  let gbText = utf8;
  try {
    gbText = new TextDecoder("gb18030", { fatal: false }).decode(buffer);
  } catch {
    return { text: utf8, encoding: "utf-8" };
  }

  const gbBad = replacementScore(gbText);
  if (gbBad < utf8Bad || (utf8Bad > 0 && !looksLikeMojibake(gbText))) {
    return { text: gbText, encoding: "gb18030" };
  }
  return { text: utf8, encoding: "utf-8" };
}

function replacementScore(text) {
  return (text.match(/\uFFFD/g) || []).length;
}

function looksLikeMojibake(text) {
  return /[\u00c3\u00c2][\u0080-\u00bf]|\u00e6|\u00e7|\u00e5|\u00e9|\u9359|\u6d93|\u6d60|\u93c2|\u7ee0|\u7f03|\u6c28/.test(text);
}

function extractTerms(text) {
  const body = text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ");
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "you", "are", "was", "were"]);
  const counts = new Map();
  for (const token of body.match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu) || []) {
    if (stop.has(token) || token.length < 2) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([term, count]) => ({ term, count }));
}

function extractTags(text) {
  const tags = new Set();
  for (const match of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,})/gu)) tags.add(match[1].toLowerCase());
  const frontMatter = text.match(/^---\s*[\r\n]+([\s\S]*?)---/);
  const tagLine = frontMatter?.[1]?.match(/^tags:\s*(.+)$/m);
  if (tagLine) {
    tagLine[1].split(/[,\s]+/).filter(Boolean).forEach((tag) => tags.add(tag.replace(/^#/, "").toLowerCase()));
  }
  return [...tags];
}

function buildGraph(files) {
  const byBase = new Map(files.map((file) => [path.basename(file.path, ".md").toLowerCase(), file]));
  const byPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const nodes = files.map((file) => ({
    id: file.path,
    label: file.title,
    kind: "doc",
    group: file.path.split("/")[0] || "docs",
    weight: Math.max(1, file.terms.length),
  }));
  const edgeMap = new Map();
  const addEdge = (source, target, type, weight = 1) => {
    if (!source || !target || source.path === target.path) return;
    const key = [source.path, target.path, type].sort().join("|");
    const existing = edgeMap.get(key);
    if (existing) existing.weight += weight;
    else edgeMap.set(key, { source: source.path, target: target.path, type, weight });
  };

  for (const file of files) {
    for (const match of file.content.matchAll(/\[\[([^\]]+)\]\]|\]\(([^)]+\.md(?:#[^)]+)?)\)/gi)) {
      const raw = (match[1] || match[2] || "").split("#")[0].trim().replace(/\\/g, "/");
      const baseTarget = byBase.get(path.basename(raw, ".md").toLowerCase());
      const pathTarget = byPath.get(path.posix.normalize(path.posix.join(path.posix.dirname(file.path), raw)).toLowerCase());
      addEdge(file, pathTarget || baseTarget, "link", 3);
    }
  }

  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      const a = files[i];
      const b = files[j];
      const sharedTags = a.tags.filter((tag) => b.tags.includes(tag));
      const aTerms = new Set(a.terms.slice(0, 8).map((item) => item.term));
      const sharedTerms = b.terms.slice(0, 8).filter((item) => aTerms.has(item.term));
      if (sharedTags.length) addEdge(a, b, "tag", sharedTags.length * 2);
      if (sharedTerms.length >= 2) addEdge(a, b, "semantic", sharedTerms.length);
    }
  }

  const termMap = new Map();
  for (const file of files) {
    for (const item of file.terms.slice(0, 10)) {
      if (/^\d+$/.test(item.term) || item.term.length < 2) continue;
      if (!termMap.has(item.term)) termMap.set(item.term, []);
      termMap.get(item.term).push({ file, count: item.count });
    }
  }

  for (const [term, hits] of termMap) {
    if (hits.length < 2) continue;
    const keywordId = `keyword:${term}`;
    nodes.push({
      id: keywordId,
      label: term,
      kind: "keyword",
      group: "keywords",
      weight: hits.reduce((sum, hit) => sum + hit.count, 0),
    });
    for (const hit of hits.slice(0, 8)) {
      edgeMap.set(`${hit.file.path}|${keywordId}|keyword`, {
        source: hit.file.path,
        target: keywordId,
        type: "keyword",
        weight: Math.max(1, Math.min(6, hit.count)),
      });
    }
  }

  return { nodes, edges: [...edgeMap.values()].sort((a, b) => b.weight - a.weight).slice(0, 160) };
}

async function refreshCache(force = false) {
  await ensureDocs();
  const latestMtime = await getLatestMtime(DOCS_ROOT);
  if (!force && cache.stamp >= latestMtime && cache.files.length) return cache;
  const tree = await walk();
  const files = [];
  for (const item of flattenTree(tree)) {
    const { absolute } = normalizeDocPath(item.path);
    const { text: content, encoding } = await readMarkdownFile(absolute);
    files.push({
      ...item,
      encoding,
      content,
      plain: content.replace(/[#>*_`[\]()!-]/g, " "),
      tags: extractTags(content),
      terms: extractTerms(content),
    });
  }
  cache = { stamp: Date.now(), files, tree, graph: buildGraph(files) };
  return cache;
}

function search(files, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const parts = q.split(/\s+/).filter(Boolean);
  return files
    .map((file) => {
      const hay = `${file.title}\n${file.path}\n${file.plain}`.toLowerCase();
      let score = 0;
      for (const part of parts) {
        if (file.title.toLowerCase().includes(part)) score += 12;
        if (file.path.toLowerCase().includes(part)) score += 6;
        score += (hay.match(new RegExp(escapeRegExp(part), "g")) || []).length;
      }
      const first = parts.map((part) => hay.indexOf(part)).filter((idx) => idx >= 0).sort((a, b) => a - b)[0] || 0;
      const snippet = file.plain.slice(Math.max(0, first - 60), first + 180).replace(/\s+/g, " ").trim();
      return { path: file.path, title: file.title, score, snippet, tags: file.tags };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-Hans-CN"))
    .slice(0, 50);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/asset" && req.method === "POST") {
    await ensureDocs();
    const payload = await readJson(req);
    const match = String(payload.dataUrl || "").match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!match) return json(res, 400, { error: "Only png, jpeg, or webp images can be uploaded" });
    const imageBuffer = Buffer.from(match[2], "base64");
    if (imageBuffer.length > MAX_ASSET_BYTES) return json(res, 413, { error: "Image is too large" });
    const extByMime = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
    const ext = extByMime[match[1]];
    const safeName = String(payload.name || `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}${ext}`)
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const fileName = safeName.toLowerCase().endsWith(ext) ? safeName : `${safeName}${ext}`;
    const { relative, absolute } = normalizeSourcePath(fileName);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, imageBuffer);
    return json(res, 200, { path: `/source/${relative}`, markdown: `![${path.basename(relative, ext)}](/source/${relative})` });
  }

  const data = await refreshCache(url.searchParams.get("refresh") === "1");
  if (url.pathname === "/api/tree") return json(res, 200, { tree: data.tree, count: data.files.length });
  if (url.pathname === "/api/graph") return json(res, 200, data.graph);
  if (url.pathname === "/api/search") return json(res, 200, { results: search(data.files, url.searchParams.get("q") || "") });
  if (url.pathname === "/api/doc") {
    const target = data.files.find((file) => file.path === url.searchParams.get("path"));
    if (!target) return json(res, 404, { error: "Document not found" });
    return json(res, 200, { path: target.path, title: target.title, content: target.content, tags: target.tags, terms: target.terms });
  }
  if (url.pathname === "/api/save" && req.method === "POST") {
    const payload = await readJson(req);
    const { relative, absolute } = normalizeDocPath(payload.path);
    if (!relative.toLowerCase().endsWith(".md")) return json(res, 400, { error: "Only .md files can be saved" });
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, String(payload.content ?? ""), "utf8");
    await refreshCache(true);
    return json(res, 200, { ok: true, path: relative });
  }
  if (url.pathname === "/api/create-folder" && req.method === "POST") {
    const payload = await readJson(req);
    const parent = String(payload.parent || "").trim();
    const name = sanitizeEntryName(payload.name);
    if (!name) return json(res, 400, { error: "Folder name is required" });
    const { absolute } = normalizeDocPath(path.posix.join(parent, name));
    if (existsSync(absolute)) return json(res, 409, { error: "Folder already exists" });
    await mkdir(absolute, { recursive: false });
    await refreshCache(true);
    return json(res, 200, { ok: true, path: path.posix.join(parent, name) });
  }
  if (url.pathname === "/api/create-doc" && req.method === "POST") {
    const payload = await readJson(req);
    const parent = String(payload.parent || "").trim();
    const name = sanitizeEntryName(payload.name).replace(/\.md$/i, "");
    if (!name) return json(res, 400, { error: "Document name is required" });
    const fileName = `${name}.md`;
    const relativePath = path.posix.join(parent, fileName);
    const { absolute } = normalizeDocPath(relativePath);
    if (existsSync(absolute)) return json(res, 409, { error: "Document already exists" });
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `# ${name}\n\n`, "utf8");
    await refreshCache(true);
    return json(res, 200, { ok: true, path: relativePath });
  }
  if (url.pathname === "/api/delete" && req.method === "POST") {
    const payload = await readJson(req);
    const targetPath = String(payload.path || "").trim();
    if (!targetPath) return json(res, 400, { error: "Delete path is required" });
    const { relative, absolute } = normalizeDocPath(targetPath);
    if (!existsSync(absolute)) return json(res, 404, { error: "Target not found" });
    const targetStat = await stat(absolute);
    if (targetStat.isFile() && !relative.toLowerCase().endsWith(".md")) {
      return json(res, 400, { error: "Only .md files can be deleted" });
    }
    await rm(absolute, { recursive: targetStat.isDirectory(), force: false });
    await refreshCache(true);
    return json(res, 200, { ok: true, path: relative, type: targetStat.isDirectory() ? "folder" : "file" });
  }
  if (url.pathname === "/api/move" && req.method === "POST") {
    const payload = await readJson(req);
    const sourcePath = String(payload.source || "").trim();
    const targetFolder = String(payload.targetFolder || "").trim();
    if (!sourcePath) return json(res, 400, { error: "Move source is required" });
    const source = normalizeDocPath(sourcePath);
    const target = normalizeDocPath(targetFolder);
    if (!existsSync(source.absolute)) return json(res, 404, { error: "Source not found" });
    if (!existsSync(target.absolute)) return json(res, 404, { error: "Target folder not found" });
    const sourceStat = await stat(source.absolute);
    const targetStat = await stat(target.absolute);
    if (!targetStat.isDirectory()) return json(res, 400, { error: "Target must be a folder" });
    if (sourceStat.isFile() && !source.relative.toLowerCase().endsWith(".md")) {
      return json(res, 400, { error: "Only .md files can be moved" });
    }
    if (sourceStat.isDirectory()) {
      const sourceRoot = `${path.resolve(source.absolute)}${path.sep}`;
      const targetRoot = `${path.resolve(target.absolute)}${path.sep}`;
      if (targetRoot.startsWith(sourceRoot)) {
        return json(res, 400, { error: "Folder cannot be moved into itself" });
      }
    }
    const destinationRelative = path.posix.join(target.relative, path.posix.basename(source.relative));
    const destination = normalizeDocPath(destinationRelative);
    if (source.absolute === destination.absolute) return json(res, 200, { ok: true, path: source.relative });
    if (existsSync(destination.absolute)) return json(res, 409, { error: "Destination already exists" });
    await rename(source.absolute, destination.absolute);
    await refreshCache(true);
    return json(res, 200, {
      ok: true,
      from: source.relative,
      path: destination.relative,
      type: sourceStat.isDirectory() ? "folder" : "file",
    });
  }
  return json(res, 404, { error: "Unknown API route" });
}

async function serveStatic(res, pathname) {
  if (pathname.startsWith("/source/")) {
    const { absolute } = normalizeSourcePath(pathname.slice("/source/".length));
    try {
      const body = await readFile(absolute);
      return send(res, 200, body, mimeTypes[path.extname(absolute).toLowerCase()] || "application/octet-stream");
    } catch {
      return send(res, 404, "Not found", "text/plain; charset=utf-8");
    }
  }

  const clean = pathname === "/" ? "/index.html" : pathname;
  const absolute = path.resolve(PUBLIC_ROOT, `.${decodeURIComponent(clean)}`);
  if (!absolute.startsWith(path.resolve(PUBLIC_ROOT))) return send(res, 403, "Forbidden", "text/plain");
  try {
    const body = await readFile(absolute);
    send(res, 200, body, mimeTypes[path.extname(absolute)] || "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (error) {
    json(res, error.status || 500, { error: error.message || "Internal server error" });
  }
}).listen(PORT, () => {
  console.log(`Markdown knowledge app running at http://localhost:${PORT}`);
});
