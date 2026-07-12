import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { cp, readFile, writeFile, readdir, stat, mkdir, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = process.env.MYTEMPLE_DOCS_ROOT || path.join(__dirname, "docs");
const PUBLIC_ROOT = path.join(__dirname, "public");
const SOURCE_ROOT = process.env.MYTEMPLE_SOURCE_ROOT || path.join(__dirname, "source");
const DATA_ROOT = process.env.MYTEMPLE_DATA_ROOT || path.dirname(DOCS_ROOT);
const WORKSPACE_CONFIG = path.join(DATA_ROOT, "workspaces.json");
const PORT = Number(process.env.PORT || 4173);

let cache = { stamp: 0, files: [], tree: [], graph: { nodes: [], edges: [] }, workspaces: [] };
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const DEFAULT_WORKSPACE_ID = "default";

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

function isInside(root, absolute) {
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function workspaceId(root) {
  const normalized = path.resolve(root).toLowerCase();
  return `ws_${createHash("sha1").update(normalized).digest("hex").slice(0, 10)}`;
}

function workspaceRef(id, relative = "") {
  return `${id}:${relative}`;
}

function splitWorkspaceRef(input) {
  const decoded = decodeURIComponent(input || "").replace(/\\/g, "/");
  const colon = decoded.indexOf(":");
  if (colon > 0 && /^[a-zA-Z0-9_-]+$/.test(decoded.slice(0, colon))) {
    return { id: decoded.slice(0, colon), relative: decoded.slice(colon + 1) };
  }
  return { id: DEFAULT_WORKSPACE_ID, relative: decoded };
}

async function loadWorkspaces() {
  await mkdir(DATA_ROOT, { recursive: true });
  const defaults = [{
    id: DEFAULT_WORKSPACE_ID,
    name: "默认 docs",
    root: path.resolve(DOCS_ROOT),
    visible: true,
    mdOnly: true,
    builtin: true,
    lastUsed: Date.now(),
  }];
  try {
    const parsed = JSON.parse(await readFile(WORKSPACE_CONFIG, "utf8"));
    const custom = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    const merged = new Map(defaults.map((item) => [item.id, item]));
    for (const item of custom) {
      if (!item?.root) continue;
      const root = path.resolve(String(item.root));
      const id = item.id && /^[a-zA-Z0-9_-]+$/.test(item.id) ? item.id : workspaceId(root);
      merged.set(id, {
        id,
        name: String(item.name || path.basename(root) || root),
        root,
        visible: item.visible !== false,
        mdOnly: item.mdOnly !== false,
        builtin: id === DEFAULT_WORKSPACE_ID,
        lastUsed: Number(item.lastUsed || 0),
      });
    }
    const all = [...merged.values()].sort((a, b) => (b.visible - a.visible) || (b.lastUsed - a.lastUsed));
    const visible = all.filter((item) => item.visible);
    if (!visible.length) all[0].visible = true;
    if (visible.length > 2) {
      let kept = 0;
      for (const item of all) {
        if (!item.visible) continue;
        kept += 1;
        if (kept > 2) item.visible = false;
      }
      await saveWorkspaces({ workspaces: all, defaultWorkspaceId: parsed.defaultWorkspaceId || DEFAULT_WORKSPACE_ID });
    }
    return { workspaces: all, defaultWorkspaceId: String(parsed.defaultWorkspaceId || DEFAULT_WORKSPACE_ID) };
  } catch {
    await saveWorkspaces({ workspaces: defaults, defaultWorkspaceId: DEFAULT_WORKSPACE_ID });
    return { workspaces: defaults, defaultWorkspaceId: DEFAULT_WORKSPACE_ID };
  }
}

async function saveWorkspaces(config) {
  await mkdir(DATA_ROOT, { recursive: true });
  const payload = Array.isArray(config) ? { workspaces: config, defaultWorkspaceId: DEFAULT_WORKSPACE_ID } : config;
  await writeFile(WORKSPACE_CONFIG, JSON.stringify(payload, null, 2), "utf8");
}

async function normalizeDocPath(input) {
  const { workspaces } = await loadWorkspaces();
  const { id, relative: rawRelative } = splitWorkspaceRef(input);
  const workspace = workspaces.find((item) => item.id === id);
  if (!workspace) throw new Error("Workspace not found");
  const clean = path.posix.normalize(rawRelative || "").replace(/^(\.\.\/)+/, "").replace(/^\.$/, "");
  const absolute = path.resolve(workspace.root, clean);
  if (!isInside(workspace.root, absolute)) throw new Error("Invalid document path");
  return {
    workspace,
    workspaceId: workspace.id,
    relative: clean,
    ref: workspaceRef(workspace.id, clean),
    absolute,
  };
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
  await mkdir(DATA_ROOT, { recursive: true });
  if (!existsSync(DOCS_ROOT)) {
    await mkdir(DOCS_ROOT, { recursive: true });
  }
  if (!existsSync(SOURCE_ROOT)) {
    await mkdir(SOURCE_ROOT, { recursive: true });
  }
}

async function getLatestMtime(dir) {
  let latest = 0;
  try {
    latest = (await stat(dir)).mtimeMs;
  } catch {
    return 0;
  }
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

async function walk(workspace, dir = workspace.root, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const items = [];
  const mdOnly = workspace.mdOnly !== false;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))) {
    const absolute = path.join(dir, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      const children = await walk(workspace, absolute, relative);
      // mdOnly 模式下：如果文件夹既没有 .md 文件，也没有包含 md 文件的子文件夹，则不显示
      if (mdOnly && children.length === 0) continue;
      items.push({ type: "folder", name: entry.name, path: workspaceRef(workspace.id, relative), workspaceId: workspace.id, root: workspace.root, children });
    } else if (entry.isFile()) {
      const isMarkdown = entry.name.toLowerCase().endsWith(".md");
      if (mdOnly && !isMarkdown) continue;
      if (isMarkdown) {
        const { text: source, encoding } = await readMarkdownFile(absolute);
        const stats = await stat(absolute);
        items.push({
          type: "file",
          name: entry.name,
          title: extractTitle(source, entry.name),
          displayName: entry.name,
          path: workspaceRef(workspace.id, relative),
          relative,
          workspaceId: workspace.id,
          root: workspace.root,
          encoding,
          size: stats.size,
          modified: stats.mtimeMs,
        });
      } else {
        const stats = await stat(absolute);
        items.push({
          type: "file",
          name: entry.name,
          title: entry.name,
          displayName: entry.name,
          path: workspaceRef(workspace.id, relative),
          relative,
          workspaceId: workspace.id,
          root: workspace.root,
          size: stats.size,
          modified: stats.mtimeMs,
        });
      }
    }
  }
  return items;
}

async function uniqueMdTarget(dir, baseName) {
  let candidate = path.join(dir, `${baseName}.md`);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${baseName}-${index}.md`);
    index += 1;
  }
  return candidate;
}

async function convertFilesToMarkdown(workspace, dir = workspace.root, options = {}) {
  const { extensions = [], hasStar = false } = options;
  const entries = await readdir(dir, { withFileTypes: true });
  const changes = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      changes.push(...await convertFilesToMarkdown(workspace, absolute, options));
      continue;
    }
    if (!entry.isFile()) continue;
    const currentExt = path.extname(entry.name).toLowerCase().replace(/^\./, "");
    if (currentExt === "md") continue;
    const allowedToConvert = hasStar || extensions.some((ext) => ext === currentExt);
    if (!allowedToConvert) continue;
    const parsed = path.parse(entry.name);
    const base = parsed.name || entry.name;
    const target = await uniqueMdTarget(dir, base);
    await rename(absolute, target);
    changes.push({
      from: workspaceRef(workspace.id, path.relative(workspace.root, absolute).replace(/\\/g, "/")),
      to: workspaceRef(workspace.id, path.relative(workspace.root, target).replace(/\\/g, "/")),
    });
  }
  return changes;
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
    group: file.workspaceName || file.workspaceId || "docs",
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
  const { workspaces, defaultWorkspaceId } = await loadWorkspaces();
  const visibleWorkspaces = workspaces.filter((workspace) => workspace.visible).slice(0, 2);
  let latestMtime = 0;
  for (const workspace of visibleWorkspaces) {
    latestMtime = Math.max(latestMtime, await getLatestMtime(workspace.root));
  }
  if (!force && cache.stamp >= latestMtime && cache.files.length) return cache;
  const tree = [];
  const files = [];
  for (const workspace of visibleWorkspaces) {
    if (!existsSync(workspace.root)) continue;
    const children = await walk(workspace);
    tree.push({
      type: "workspace",
      name: workspace.name,
      path: workspaceRef(workspace.id),
      workspaceId: workspace.id,
      root: workspace.root,
      children,
    });
  }
  for (const item of flattenTree(tree)) {
    const { absolute, workspace } = await normalizeDocPath(item.path);
    const { text: content, encoding } = await readMarkdownFile(absolute);
    files.push({
      ...item,
      encoding,
      content,
      plain: content.replace(/[#>*_`[\]()!-]/g, " "),
      tags: extractTags(content),
      terms: extractTerms(content),
      workspaceName: workspace.name,
    });
  }
  cache = { stamp: Date.now(), files, tree, graph: buildGraph(files), workspaces, defaultWorkspaceId };
  return cache;
}

function search(files, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const parts = q.split(/\s+/).filter(Boolean);
  return files
    .map((file) => {
      const hay = `${file.title}\n${file.workspaceName || ""}\n${file.path}\n${file.plain}`.toLowerCase();
      let score = 0;
      for (const part of parts) {
        if (file.title.toLowerCase().includes(part)) score += 12;
        if (file.path.toLowerCase().includes(part)) score += 6;
        score += (hay.match(new RegExp(escapeRegExp(part), "g")) || []).length;
      }
      const first = parts.map((part) => hay.indexOf(part)).filter((idx) => idx >= 0).sort((a, b) => a - b)[0] || 0;
      const snippet = file.plain.slice(Math.max(0, first - 60), first + 180).replace(/\s+/g, " ").trim();
      return { path: file.path, title: file.title, workspaceName: file.workspaceName, score, snippet, tags: file.tags };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-Hans-CN"))
    .slice(0, 50);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function uniqueDestination(folderAbsolute, baseName) {
  const parsed = path.parse(baseName);
  let candidate = path.join(folderAbsolute, baseName);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = path.join(folderAbsolute, `${parsed.name}-copy${index > 1 ? `-${index}` : ""}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

async function copyEntry(source, targetFolder) {
  const sourceStat = await stat(source.absolute);
  const targetStat = await stat(targetFolder.absolute);
  if (!targetStat.isDirectory()) throw new Error("Target must be a folder");
  const destinationAbsolute = await uniqueDestination(targetFolder.absolute, path.basename(source.absolute));
  if (sourceStat.isDirectory()) {
    const sourceRoot = `${path.resolve(source.absolute)}${path.sep}`;
    const targetRoot = `${path.resolve(destinationAbsolute)}${path.sep}`;
    if (targetRoot.startsWith(sourceRoot)) throw new Error("Folder cannot be copied into itself");
    await cp(source.absolute, destinationAbsolute, { recursive: true, errorOnExist: true });
  } else {
    await mkdir(path.dirname(destinationAbsolute), { recursive: true });
    await cp(source.absolute, destinationAbsolute, { errorOnExist: true });
  }
  const relative = path.relative(targetFolder.workspace.root, destinationAbsolute).replace(/\\/g, "/");
  return {
    ok: true,
    path: workspaceRef(targetFolder.workspace.id, relative),
    type: sourceStat.isDirectory() ? "folder" : "file",
  };
}

async function addWorkspace(rootInput, nameInput = "") {
  const root = path.resolve(String(rootInput || "").trim());
  if (!rootInput || !existsSync(root) || !(await stat(root)).isDirectory()) {
    throw new Error("Workspace folder does not exist");
  }
  const { workspaces } = await loadWorkspaces();
  const id = workspaceId(root);
  const visibleCount = workspaces.filter((item) => item.visible).length;
  const existing = workspaces.find((item) => item.id === id);
  if (existing) {
    existing.name = String(nameInput || existing.name || path.basename(root) || root);
    existing.root = root;
    existing.visible = true;
    existing.lastUsed = Date.now();
  } else {
    workspaces.push({
      id,
      name: String(nameInput || path.basename(root) || root),
      root,
      visible: visibleCount < 2,
      mdOnly: true,
      builtin: false,
      lastUsed: Date.now(),
    });
  }
  const visible = workspaces.filter((item) => item.visible).sort((a, b) => b.lastUsed - a.lastUsed);
  for (const item of visible.slice(2)) item.visible = false;
  await saveWorkspaces(workspaces);
  cache.stamp = 0;
  return workspaces.find((item) => item.id === id);
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

  if (url.pathname === "/api/workspaces") {
    const { workspaces, defaultWorkspaceId } = await loadWorkspaces();
    return json(res, 200, {
      workspaces,
      defaultWorkspaceId,
      visible: workspaces.filter((item) => item.visible).slice(0, 2),
      recent: [...workspaces].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 8),
    });
  }

  if (url.pathname === "/api/workspaces/set-default" && req.method === "POST") {
    const payload = await readJson(req);
    const { workspaces } = await loadWorkspaces();
    const targetWorkspaceId = String(payload.id || DEFAULT_WORKSPACE_ID);
    const target = workspaces.find((item) => item.id === targetWorkspaceId) || workspaces[0];
    await saveWorkspaces({ workspaces, defaultWorkspaceId: target.id });
    await refreshCache(true);
    return json(res, 200, { ok: true, defaultWorkspaceId: target.id });
  }

  if (url.pathname === "/api/workspaces/set-md-only" && req.method === "POST") {
    const payload = await readJson(req);
    const { workspaces, defaultWorkspaceId } = await loadWorkspaces();
    const target = workspaces.find((item) => item.id === String(payload.id || ""));
    if (!target) return json(res, 404, { error: "Workspace not found" });
    target.mdOnly = payload.mdOnly !== false;
    target.lastUsed = Date.now();
    await saveWorkspaces({ workspaces, defaultWorkspaceId });
    await refreshCache(true);
    return json(res, 200, { ok: true, workspace: target });
  }

  if (url.pathname === "/api/workspaces/add" && req.method === "POST") {
    const payload = await readJson(req);
    const workspace = await addWorkspace(payload.path, payload.name);
    await refreshCache(true);
    return json(res, 200, { ok: true, workspace });
  }

  if (url.pathname === "/api/workspaces/show" && req.method === "POST") {
    const payload = await readJson(req);
    const { workspaces, defaultWorkspaceId } = await loadWorkspaces();
    const workspace = workspaces.find((item) => item.id === String(payload.id || ""));
    if (!workspace) return json(res, 404, { error: "Workspace not found" });
    workspace.visible = payload.visible !== false;
    workspace.lastUsed = Date.now();
    if (workspace.visible) {
      const visible = workspaces.filter((item) => item.visible && item.id !== workspace.id).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
      for (const item of visible.slice(1)) item.visible = false;
    }
    await saveWorkspaces({ workspaces, defaultWorkspaceId });
    await refreshCache(true);
    return json(res, 200, { ok: true, workspace });
  }

  if (url.pathname === "/api/workspaces/remove" && req.method === "POST") {
    const payload = await readJson(req);
    const targetId = String(payload.id || "");
    if (targetId === DEFAULT_WORKSPACE_ID) {
      return json(res, 400, { error: "默认工作路径不能删除" });
    }
    let { workspaces, defaultWorkspaceId } = await loadWorkspaces();
    workspaces = workspaces.filter((item) => item.id !== targetId);
    if (defaultWorkspaceId === targetId) defaultWorkspaceId = DEFAULT_WORKSPACE_ID;
    const visible = workspaces.filter((item) => item.visible).slice(0, 2);
    if (!visible.length && workspaces.length) workspaces[0].visible = true;
    await saveWorkspaces({ workspaces, defaultWorkspaceId });
    await refreshCache(true);
    return json(res, 200, { ok: true, workspaces });
  }

  if (url.pathname === "/api/workspaces/rename" && req.method === "POST") {
    const payload = await readJson(req);
    const { workspaces, defaultWorkspaceId } = await loadWorkspaces();
    const workspace = workspaces.find((item) => item.id === String(payload.id || ""));
    if (!workspace) return json(res, 404, { error: "Workspace not found" });
    workspace.name = String(payload.name || workspace.name).slice(0, 60);
    workspace.lastUsed = Date.now();
    await saveWorkspaces({ workspaces, defaultWorkspaceId });
    await refreshCache(true);
    return json(res, 200, { ok: true, workspace });
  }

  if (url.pathname === "/api/workspaces/paste" && req.method === "POST") {
    const payload = await readJson(req);
    const sourceRaw = payload.source;
    const targetFolder = String(payload.targetFolder || "").trim();
    const sources = Array.isArray(sourceRaw) ? sourceRaw.map((s) => String(s).trim()).filter(Boolean) : [String(sourceRaw || "").trim()];
    if (!sources.length) return json(res, 400, { error: "粘贴来源为空" });
    const target = await normalizeDocPath(targetFolder);
    let lastResult = { ok: true };
    for (const sourcePath of sources) {
      const source = await normalizeDocPath(sourcePath);
      lastResult = await copyEntry(source, target);
    }
    await refreshCache(true);
    return json(res, 200, lastResult);
  }

  // === 浏览器内嵌文件目录浏览器 ===
  if (url.pathname === "/api/browse-directory") {
    const body = req.method === "POST" ? await readJson(req) : {};
    const query = Object.fromEntries(url.searchParams.entries());
    const rawPath = String(body.path ?? query.path ?? "").trim();
    const act = String(body.action ?? query.action ?? "list").trim(); // list | roots | favorites
    try {
      if (act === "roots") {
        const roots = [];
        if (process.platform === "win32") {
          for (let code = 65; code <= 90; code++) {
            const drive = `${String.fromCharCode(code)}:\\`;
            try {
              if ((await stat(drive)).isDirectory()) roots.push({ label: drive, value: drive });
            } catch {}
          }
        } else {
          roots.push({ label: "/", value: "/" });
        }
        const home = process.env.USERPROFILE || process.env.HOME || process.env.USERDIR || "";
        const favorites = [];
        if (home) {
          const candidates = [
            { label: "桌面", sub: ["Desktop", "桌面"] },
            { label: "文档", sub: ["Documents", "文档"] },
            { label: "下载", sub: ["Downloads", "下载"] },
            { label: "用户", sub: [""] },
          ];
          for (const c of candidates) {
            for (const s of c.sub) {
              const fp = s ? path.join(home, s) : home;
              try {
                if ((await stat(fp)).isDirectory()) {
                  favorites.push({ label: c.label, value: fp });
                  break;
                }
              } catch {}
            }
          }
        }
        return json(res, 200, { roots, favorites });
      }
      const target = rawPath || (process.platform === "win32" ? (process.env.USERPROFILE || "C:\\") : "/");
      const resolved = path.resolve(target);
      const st = await stat(resolved);
      if (!st.isDirectory()) return json(res, 400, { error: "Not a directory" });
      const entries = (await readdir(resolved, { withFileTypes: true })).filter((e) => {
        if (!e.isDirectory()) return false;
        const name = e.name.toLowerCase();
        if (name.startsWith("$") || name.startsWith("system volume information")) return false;
        return true;
      });
      const items = entries.map((e) => ({ name: e.name, path: path.join(resolved, e.name) })).sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(resolved);
      const breadcrumbs = [];
      let cur = resolved;
      while (true) {
        breadcrumbs.unshift({ name: path.basename(cur) || cur, path: cur });
        const p = path.dirname(cur);
        if (p === cur || p.length >= cur.length) break;
        cur = p;
      }
      if (process.platform === "win32" && /^[A-Za-z]:\\$/.test(breadcrumbs[0]?.path || "")) breadcrumbs[0].name = breadcrumbs[0].path;
      return json(res, 200, { current: resolved, items, breadcrumbs, parent: parent !== resolved ? parent : null });
    } catch (e) {
      return json(res, 400, { error: e.message || "无法访问目录" });
    }
  }

  const data = await refreshCache(url.searchParams.get("refresh") === "1");
  if (url.pathname === "/api/tree") return json(res, 200, { tree: data.tree, count: data.files.length, workspaces: data.workspaces, defaultWorkspaceId: data.defaultWorkspaceId || "default" });
  if (url.pathname === "/api/graph") return json(res, 200, data.graph);
  if (url.pathname === "/api/search") return json(res, 200, { results: search(data.files, url.searchParams.get("q") || "") });
  if (url.pathname === "/api/doc") {
    const target = data.files.find((file) => file.path === url.searchParams.get("path"));
    if (!target) return json(res, 404, { error: "Document not found" });
    return json(res, 200, { path: target.path, title: target.title, content: target.content, tags: target.tags, terms: target.terms });
  }
  if (url.pathname === "/api/save" && req.method === "POST") {
    const payload = await readJson(req);
    const { ref, relative, absolute } = await normalizeDocPath(payload.path);
    if (!relative.toLowerCase().endsWith(".md")) return json(res, 400, { error: "Only .md files can be saved" });
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, String(payload.content ?? ""), "utf8");
    await refreshCache(true);
    return json(res, 200, { ok: true, path: ref });
  }
  if (url.pathname === "/api/browse-folder" && req.method === "POST") {
    let selected = "";
    if (process.platform === "win32") {
      try {
        const { writeFileSync, unlinkSync } = await import("node:fs");
        const { execFileSync } = await import("node:child_process");
        const os = await import("node:os");
        const tmpVbs = path.join(os.tmpdir(), `browse_${Date.now()}.vbs`);
        const vbs = `Set shell = CreateObject("Shell.Application")\r\nSet folder = shell.BrowseForFolder(0, "选择工作路径", &H10 or &H40, &H11)\r\nIf Not folder Is Nothing Then\r\n  WScript.Echo folder.Self.Path\r\nEnd If\r\n`;
        writeFileSync(tmpVbs, vbs, { encoding: "utf-8" });
        try {
          const buffer = execFileSync("wscript", [tmpVbs], { timeout: 130_000, windowsHide: false });
          if (buffer && buffer.length > 0) {
            selected = buffer.toString().trim();
          } else {
            const buffer2 = execFileSync("cscript", ["//Nologo", tmpVbs], { timeout: 130_000, windowsHide: false });
            selected = (buffer2 || "").toString().trim();
          }
        } catch (e) {
          if (e.stdout) selected = e.stdout.toString().trim();
          else if (e.stderr) {
            const stderr = e.stderr.toString();
            const match = stderr.match(/[A-Za-z]:\\[^\r\n]+/);
            if (match) selected = match[0].trim();
          }
          if (!selected) {
            try {
              const buffer2 = execFileSync("cscript", ["//Nologo", tmpVbs], { timeout: 130_000, windowsHide: false });
              selected = (buffer2 || "").toString().trim();
            } catch {}
          }
        }
        try { unlinkSync(tmpVbs); } catch {}
      } catch (e) {
        selected = "";
      }
    } else if (process.platform === "darwin") {
      try {
        const { execFileSync } = await import("node:child_process");
        const script = `choose folder with prompt "选择工作路径" default location (path to desktop folder)`;
        const buffer = execFileSync("osascript", ["-e", script], { timeout: 120_000 });
        selected = (buffer || "").toString().trim().replace(/^alias\s*"?"?/i, "").replace(/"$/,"").trim();
      } catch {
        selected = "";
      }
    } else {
      try {
        const { execFileSync } = await import("node:child_process");
        const buffer = execFileSync("zenity", ["--file-selection", "--directory", "--title=选择工作路径"], { timeout: 120_000 });
        selected = (buffer || "").toString().trim();
      } catch {
        selected = "";
      }
    }
    if (selected) return json(res, 200, { ok: true, path: selected });
    return json(res, 200, { ok: false, path: "" });
  }

  if (url.pathname === "/api/system-paths") {
    const home = process.env.USERPROFILE || process.env.HOME || process.env.USERDIR || "";
    const paths = [
      { label: "桌面", value: home ? `${home}\\Desktop` : "~/Desktop" },
      { label: "文档", value: home ? `${home}\\Documents` : "~/Documents" },
      { label: "下载", value: home ? `${home}\\Downloads` : "~/Downloads" },
      { label: "项目", value: home ? `${home}\\Projects` : "~/Projects" },
      { label: "工作", value: home ? `${home}\\Work` : "~/Work" },
    ];
    return json(res, 200, { paths });
  }

  if (url.pathname === "/api/create-folder" && req.method === "POST") {
    const payload = await readJson(req);
    const parent = String(payload.parent || "").trim();
    const name = sanitizeEntryName(payload.name);
    if (!name) return json(res, 400, { error: "Folder name is required" });
    const parentPath = await normalizeDocPath(parent);
    const relativePath = path.posix.join(parentPath.relative, name);
    const { absolute, ref } = await normalizeDocPath(workspaceRef(parentPath.workspace.id, relativePath));
    if (existsSync(absolute)) return json(res, 409, { error: "Folder already exists" });
    await mkdir(absolute, { recursive: false });
    await refreshCache(true);
    return json(res, 200, { ok: true, path: ref });
  }
  if (url.pathname === "/api/create-doc" && req.method === "POST") {
    const payload = await readJson(req);
    const parent = String(payload.parent || "").trim();
    const name = sanitizeEntryName(payload.name).replace(/\.md$/i, "");
    if (!name) return json(res, 400, { error: "Document name is required" });
    const fileName = `${name}.md`;
    const parentPath = await normalizeDocPath(parent);
    const relativePath = path.posix.join(parentPath.relative, fileName);
    const { absolute, ref } = await normalizeDocPath(workspaceRef(parentPath.workspace.id, relativePath));
    if (existsSync(absolute)) return json(res, 409, { error: "Document already exists" });
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `# ${name}\n\n`, "utf8");
    await refreshCache(true);
    return json(res, 200, { ok: true, path: ref });
  }
  if (url.pathname === "/api/normalize-md" && req.method === "POST") {
    const payload = await readJson(req);
    const { workspaces } = await loadWorkspaces();
    const visibleWorkspaces = workspaces.filter((item) => item.visible).slice(0, 2);
    const selectedWorkspaceIds = Array.isArray(payload.workspaceIds) && payload.workspaceIds.length
      ? payload.workspaceIds.map((id) => String(id))
      : visibleWorkspaces.map((item) => item.id);
    const filteredWorkspaces = workspaces.filter((item) => selectedWorkspaceIds.includes(item.id));
    const rawExtensions = Array.isArray(payload.extensions) ? payload.extensions : ["*"];
    const extensions = rawExtensions
      .map((ext) => String(ext).toLowerCase().replace(/^[.*\s]+/, "").trim())
      .filter(Boolean);
    const hasStar = rawExtensions.some((ext) => String(ext).trim() === "*");
    const changes = [];
    for (const workspace of filteredWorkspaces) {
      changes.push(...await convertFilesToMarkdown(workspace, undefined, { extensions, hasStar }));
    }
    await refreshCache(true);
    return json(res, 200, { ok: true, changed: changes.length, changes });
  }
  if (url.pathname === "/api/delete" && req.method === "POST") {
    const payload = await readJson(req);
    const pathRaw = payload.path;
    const targets = Array.isArray(pathRaw) ? pathRaw.map((s) => String(s).trim()).filter(Boolean) : [String(pathRaw || "").trim()];
    if (!targets.length) return json(res, 400, { error: "Delete path is required" });
    let lastRef = "";
    let lastType = "";
    for (const targetPath of targets) {
      const { ref, absolute } = await normalizeDocPath(targetPath);
      if (!existsSync(absolute)) continue;
      const targetStat = await stat(absolute);
      await rm(absolute, { recursive: targetStat.isDirectory(), force: false });
      lastRef = ref;
      lastType = targetStat.isDirectory() ? "folder" : "file";
    }
    await refreshCache(true);
    return json(res, 200, { ok: true, path: lastRef, type: lastType, count: targets.length });
  }
  if (url.pathname === "/api/move" && req.method === "POST") {
    const payload = await readJson(req);
    const sourcePath = String(payload.source || "").trim();
    const targetFolder = String(payload.targetFolder || "").trim();
    if (!sourcePath) return json(res, 400, { error: "Move source is required" });
    const source = await normalizeDocPath(sourcePath);
    const target = await normalizeDocPath(targetFolder);
    if (!existsSync(source.absolute)) return json(res, 404, { error: "Source not found" });
    if (!existsSync(target.absolute)) return json(res, 404, { error: "Target folder not found" });
    const sourceStat = await stat(source.absolute);
    const targetStat = await stat(target.absolute);
    if (!targetStat.isDirectory()) return json(res, 400, { error: "Target must be a folder" });
    if (sourceStat.isFile() && !source.relative.toLowerCase().endsWith(".md")) {
      return json(res, 400, { error: "Only .md files can be moved" });
    }
    if (sourceStat.isDirectory()) {
      if (!source.relative) return json(res, 400, { error: "Workspace root cannot be moved" });
      const sourceRoot = `${path.resolve(source.absolute)}${path.sep}`;
      const targetRoot = `${path.resolve(target.absolute)}${path.sep}`;
      if (targetRoot.startsWith(sourceRoot)) {
        return json(res, 400, { error: "Folder cannot be moved into itself" });
      }
    }
    const destinationRelative = path.posix.join(target.relative, path.posix.basename(source.relative));
    const destination = await normalizeDocPath(workspaceRef(target.workspace.id, destinationRelative));
    if (source.absolute === destination.absolute) return json(res, 200, { ok: true, path: source.relative });
    if (existsSync(destination.absolute)) return json(res, 409, { error: "Destination already exists" });
    if (source.workspace.id === target.workspace.id) {
      await rename(source.absolute, destination.absolute);
    } else {
      await copyEntry(source, target);
      await rm(source.absolute, { recursive: sourceStat.isDirectory(), force: false });
    }
    await refreshCache(true);
    return json(res, 200, {
      ok: true,
      from: source.ref,
      path: destination.ref,
      type: sourceStat.isDirectory() ? "folder" : "file",
    });
  }
  if (url.pathname === "/api/copy" && req.method === "POST") {
    const payload = await readJson(req);
    const sourcePath = String(payload.source || "").trim();
    const targetFolder = String(payload.targetFolder || "").trim();
    if (!sourcePath) return json(res, 400, { error: "Copy source is required" });
    const source = await normalizeDocPath(sourcePath);
    const target = await normalizeDocPath(targetFolder);
    if (!existsSync(source.absolute)) return json(res, 404, { error: "Source not found" });
    if (!existsSync(target.absolute)) return json(res, 404, { error: "Target folder not found" });
    const copied = await copyEntry(source, target);
    await refreshCache(true);
    return json(res, 200, copied);
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
