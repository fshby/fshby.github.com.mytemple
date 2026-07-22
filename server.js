import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { cp, readFile, writeFile, readdir, stat, mkdir, rm, rename } from "node:fs/promises";
import { existsSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = process.env.MYTEMPLE_DOCS_ROOT || path.join(__dirname, "docs");
const PUBLIC_ROOT = path.join(__dirname, "public");
const SOURCE_ROOT = process.env.MYTEMPLE_SOURCE_ROOT || path.join(__dirname, "source");

const APP_DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(process.env.APPDATA, "..", "Local"), "MyTempleKnowledgeData");
const DATA_ROOT = process.env.MYTEMPLE_DATA_ROOT || APP_DATA_DIR;
const WORKSPACE_CONFIG = path.join(DATA_ROOT, "workspaces.json");
const PORT = Number(process.env.PORT || 4173);
const KNOWLEDGE_INDEX_FILENAME = "知识库主清单.json";
const KNOWLEDGE_INDEX_SCHEMA_VERSION = 1;

let cache = {
  stamp: 0,
  files: [],
  tree: [],
  graph: { nodes: [], edges: [] },
  graphDirty: false,
  graphVersion: 0,
  knowledgeVersion: "",
  graphProjection: null,
  documentCache: new Map(),
  knowledgeDocuments: new Map(),
  workspaces: [],
};
let cacheRefreshPromise = null;
let structureDirty = true;
let structureGeneration = 1;
const dirtyPaths = new Set();
const dirtyVersions = new Map();
let dirtyVersion = 0;
let watcherSignature = "";
let workspaceWatchers = new Map();
let watcherRefreshTimer = 0;
let knowledgeIndexSyncPromise = Promise.resolve();
let knowledgeIndexSyncTimer = 0;
let knowledgeIndexVersion = "";
let knowledgeIndexLoaded = false;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BODY = 10 * 1024 * 1024;

let workspacesCache = null;
let workspacesCacheStamp = 0;
const DEFAULT_WORKSPACE_ID = "default";
const LOG_LEVEL = process.env.MYTEMPLE_LOG_LEVEL || "warn";

function log(level, message) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[LOG_LEVEL.toLowerCase()] || 2;
  const messageLevel = levels[level.toLowerCase()] || 2;
  if (messageLevel >= currentLevel) {
    console[level](message);
  }
}

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

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
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

function splitWorkspaceRef(input, alreadyDecoded = false) {
  const decoded = alreadyDecoded ? (input || "").replace(/\\/g, "/") : decodeURIComponent(input || "").replace(/\\/g, "/");
  const colon = decoded.indexOf(":");
  if (colon > 0) {
    const prefix = decoded.slice(0, colon);
    if (/^[a-zA-Z0-9_-]+$/.test(prefix) && !/^[A-Za-z]$/.test(prefix)) {
      return { id: prefix, relative: decoded.slice(colon + 1) };
    }
  }
  return { id: DEFAULT_WORKSPACE_ID, relative: decoded };
}

async function loadWorkspaces(force = false) {
  await mkdir(DATA_ROOT, { recursive: true });
  if (!force) {
    try {
      const stat = await stat(WORKSPACE_CONFIG);
      if (workspacesCache && workspacesCacheStamp >= stat.mtimeMs) {
        return workspacesCache;
      }
    } catch {}
  }

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
      workspacesCacheStamp = Date.now();
      workspacesCache = { workspaces: all, defaultWorkspaceId: String(parsed.defaultWorkspaceId || DEFAULT_WORKSPACE_ID) };
      log("info", `Loaded ${all.length} workspaces, ${all.filter((w) => w.visible).length} visible`);
      return workspacesCache;
    }
    workspacesCacheStamp = Date.now();
    workspacesCache = { workspaces: all, defaultWorkspaceId: String(parsed.defaultWorkspaceId || DEFAULT_WORKSPACE_ID) };
    log("info", `Loaded ${all.length} workspaces, ${all.filter((w) => w.visible).length} visible`);
    return workspacesCache;
  } catch (e) {
    log("warn", `Failed to load workspaces config: ${e.message}, using defaults`);
    await saveWorkspaces({ workspaces: defaults, defaultWorkspaceId: DEFAULT_WORKSPACE_ID });
    workspacesCacheStamp = Date.now();
    workspacesCache = { workspaces: defaults, defaultWorkspaceId: DEFAULT_WORKSPACE_ID };
    return workspacesCache;
  }
}

async function saveWorkspaces(config) {
  await mkdir(DATA_ROOT, { recursive: true });
  const payload = Array.isArray(config) ? { workspaces: config, defaultWorkspaceId: DEFAULT_WORKSPACE_ID } : config;
  await writeFile(WORKSPACE_CONFIG, JSON.stringify(payload, null, 2), "utf8");
  workspacesCache = null;
  workspacesCacheStamp = 0;
}

async function normalizeDocPath(input, alreadyDecoded = false) {
  const { workspaces } = await loadWorkspaces();
  const { id, relative: rawRelative } = splitWorkspaceRef(input, alreadyDecoded);
  let workspace = workspaces.find((item) => item.id === id);
  if (!workspace) {
    log("warn", `Workspace not found for id: ${id}, reloading workspaces`);
    const reloaded = await loadWorkspaces(true);
    workspace = reloaded.workspaces.find((item) => item.id === id);
    if (!workspace) {
      throw new Error(`工作区不存在: ${id}`);
    }
  }
  const normalizedRelative = path.posix.normalize(rawRelative || "");
  if (normalizedRelative === ".." || normalizedRelative.startsWith("../") || path.posix.isAbsolute(normalizedRelative)) {
    throw new Error("无效的文档路径");
  }
  const clean = normalizedRelative.replace(/^\.$/, "");
  const absolute = path.resolve(workspace.root, clean);
  if (!isInside(workspace.root, absolute)) throw new Error("无效的文档路径");
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
  const clean = path.posix.normalize(decoded).replace(/^(\.\.\/)+/, "").replace(/^\.$/, "");
  const absolute = path.resolve(SOURCE_ROOT, clean);
  if (!isInside(SOURCE_ROOT, absolute)) {
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

function closeWorkspaceWatchers() {
  for (const entries of workspaceWatchers.values()) {
    for (const watcher of entries) {
      try { watcher.close(); } catch {}
    }
  }
  workspaceWatchers = new Map();
  watcherSignature = "";
}

function isIgnoredWorkspacePath(absolute) {
  const name = path.basename(absolute).toLowerCase();
  return name === KNOWLEDGE_INDEX_FILENAME.toLowerCase()
    || name.startsWith(`.${KNOWLEDGE_INDEX_FILENAME.toLowerCase()}.`)
    || name.endsWith(".tmp")
    || name.endsWith(".swp")
    || name.endsWith("~");
}

function workspaceForAbsolute(workspaces, absolute) {
  return workspaces.find((workspace) => isInside(workspace.root, absolute));
}

function markWorkspaceDirty(workspace, filename, eventType, baseDir = workspace.root) {
  const rawName = filename == null ? "" : String(filename).replace(/\\/g, path.sep);
  const absolute = path.resolve(baseDir, rawName || ".");
  if (isIgnoredWorkspacePath(absolute)) return;
  dirtyVersion += 1;
  dirtyPaths.add(absolute);
  dirtyVersions.set(absolute, dirtyVersion);
  if (eventType === "rename" || !rawName || !path.extname(absolute).toLowerCase().endsWith(".md")) {
    structureDirty = true;
    structureGeneration += 1;
  }
  scheduleWatchedRefresh();
}

function scheduleWatchedRefresh() {
  clearTimeout(watcherRefreshTimer);
  watcherRefreshTimer = setTimeout(() => {
    watcherRefreshTimer = 0;
    refreshCache().catch((error) => log("warn", `文件监听刷新失败: ${error.message}`));
  }, 160);
}

async function collectWorkspaceDirectories(root, out = []) {
  out.push(root);
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    await collectWorkspaceDirectories(path.join(root, entry.name), out);
  }
  return out;
}

function addWorkspaceWatcher(workspace, baseDir, recursive, entries) {
  try {
    const watcher = watch(baseDir, recursive ? { recursive: true } : undefined, (eventType, filename) => {
      markWorkspaceDirty(workspace, filename, eventType, baseDir);
    });
    watcher.on("error", (error) => {
      log("warn", `文件监听异常 (${workspace.root}): ${error.message}`);
      structureDirty = true;
      structureGeneration += 1;
      scheduleWatchedRefresh();
    });
    entries.push(watcher);
    return true;
  } catch (error) {
    log("debug", `递归文件监听不可用 (${baseDir}): ${error.message}`);
    return false;
  }
}

async function installWorkspaceWatchers(workspaces, force = false) {
  const visible = workspaces.filter((workspace) => workspace.visible).slice(0, 2);
  const signature = visible.map((workspace) => `${workspace.id}|${path.resolve(workspace.root)}`).join("\n");
  if (!force && signature === watcherSignature) return;
  closeWorkspaceWatchers();
  for (const workspace of visible) {
    if (!existsSync(workspace.root)) continue;
    const entries = [];
    if (!addWorkspaceWatcher(workspace, workspace.root, true, entries)) {
      const directories = await collectWorkspaceDirectories(workspace.root);
      for (const directory of directories) addWorkspaceWatcher(workspace, directory, false, entries);
    }
    workspaceWatchers.set(workspace.id, entries);
  }
  watcherSignature = signature;
}

function markStructureDirty() {
  structureDirty = true;
  structureGeneration += 1;
}

async function walk(workspace, dir = workspace.root, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const items = [];
  const mdOnly = workspace.mdOnly !== false;
  const EMPTY_FOLDER_GRACE_PERIOD = 80 * 1000;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))) {
    const absolute = path.join(dir, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      const children = await walk(workspace, absolute, relative);
      if (mdOnly && children.length === 0) {
        try {
          const stats = await stat(absolute);
          if (Date.now() - stats.birthtimeMs < EMPTY_FOLDER_GRACE_PERIOD) {
            items.push({ type: "folder", name: entry.name, path: workspaceRef(workspace.id, relative), workspaceId: workspace.id, root: workspace.root, children });
            continue;
          }
        } catch {}
        continue;
      }
      items.push({ type: "folder", name: entry.name, path: workspaceRef(workspace.id, relative), workspaceId: workspace.id, root: workspace.root, children });
    } else if (entry.isFile()) {
      if (entry.name === KNOWLEDGE_INDEX_FILENAME) continue;
      const isMarkdown = entry.name.toLowerCase().endsWith(".md");
      if (mdOnly && !isMarkdown) continue;
      try {
        if (isMarkdown) {
          const stats = await stat(absolute);
          items.push({
            type: "file",
            name: entry.name,
            title: entry.name.replace(/\.md$/i, ""),
            displayName: entry.name,
            path: workspaceRef(workspace.id, relative),
            relative,
            workspaceId: workspace.id,
            root: workspace.root,
            encoding: "",
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
      } catch (e) {
        if (e.code === "EPERM" || e.code === "EACCES") {
          log("warn", `跳过无法访问的文件: ${absolute}`);
        } else {
          throw e;
        }
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
  let buffer;
  try {
    buffer = await readFile(absolute);
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES") {
      log("warn", `无法读取文件 (权限问题): ${absolute}`);
      return { text: "", encoding: "utf-8" };
    }
    throw e;
  }
  const hash = createHash("sha256").update(buffer).digest("hex");
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(buffer.subarray(3)), encoding: "utf-8-bom", hash };
  }

  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const utf8Bad = replacementScore(utf8);
  if (utf8Bad === 0 && !looksLikeMojibake(utf8)) {
    return { text: utf8, encoding: "utf-8", hash };
  }

  let gbText = utf8;
  try {
    gbText = new TextDecoder("gb18030", { fatal: false }).decode(buffer);
  } catch {
    return { text: utf8, encoding: "utf-8", hash };
  }

  const gbBad = replacementScore(gbText);
  if (gbBad < utf8Bad || (utf8Bad > 0 && !looksLikeMojibake(gbText))) {
    return { text: gbText, encoding: "gb18030", hash };
  }
  return { text: utf8, encoding: "utf-8", hash };
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
    .replace(/^---\s*[\r\n]+[\s\S]*?^---\s*$/m, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*[a-z_][\w.-]{1,32}\s*(?:=|:)\s*\S.*$/gim, " ")
    .replace(/https?:\/\/\S+|www\.\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ");
  const stop = new Set([
    "the", "and", "for", "with", "from", "this", "that", "you", "are", "was", "were",
    "http", "https", "www", "com", "org", "net", "html", "href", "src",
    "一个", "这个", "可以", "进行", "使用", "支持", "以及", "相关", "文档", "内容", "功能",
    "或者", "如果", "需要", "没有", "我们", "你们", "他们", "其中", "通过", "由于", "就是", "不是", "能够", "已经", "可能",
    "整理", "记录", "方法", "实践", "说明", "介绍", "示例", "问题", "数据", "信息",
    "文件", "命令", "视频", "地址", "密码", "测试", "版本", "属性", "桌面", "网络", "设备", "服务", "名称", "内容",
    "确认", "融合", "播放", "建议", "直接", "平台", "配置", "查看", "网关", "是否", "输入", "关闭", "恢复", "格式", "显示",
  ]);
  const counts = new Map();
  let tokens;
  try {
    const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
    tokens = [...segmenter.segment(body)].filter((part) => part.isWordLike).map((part) => part.segment);
  } catch {
    tokens = body.match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu) || [];
  }
  for (const token of tokens) {
    if (stop.has(token) || token.length < 2) continue;
    if (token.length > 32) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([term, count]) => ({ term, count }));
}

function extractTags(text) {
  const tags = new Set();
  const frontMatter = text.match(/^---\s*[\r\n]+([\s\S]*?)---/);
  const tagLine = frontMatter?.[1]?.match(/^(?:tags|tag):[^\S\r\n]*(.*)$/mi);
  if (tagLine) {
    tagLine[1].replace(/[\[\]"']/g, " ").split(/[,\s]+/).filter(Boolean)
      .forEach((tag) => tags.add(tag.replace(/^#/, "").toLowerCase()));
    const afterTagLine = frontMatter[1].slice((tagLine.index || 0) + tagLine[0].length);
    const tagBlock = afterTagLine.split(/\r?\n(?=[\p{L}_-][\p{L}\p{N}_-]*:\s*)/u)[0];
    for (const match of tagBlock.matchAll(/^\s*-\s*#?([\p{L}\p{N}_/-]{2,})\s*$/gmu)) {
      tags.add(match[1].toLowerCase());
    }
  }
  const withoutFrontMatter = frontMatter ? text.slice(frontMatter[0].length) : text;
  let inFence = false;
  for (const line of withoutFrontMatter.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s{0,3}#{1,6}\s+/.test(line)) continue;
    for (const match of line.matchAll(/(?:^|[\s([{>])#(?!#)([\p{L}\p{N}_/-]{2,})/gu)) {
      tags.add(match[1].toLowerCase());
    }
  }
  return [...tags];
}

function documentTemplate(name) {
  const today = new Date().toISOString().slice(0, 10);
  return `---\ntags:\n  - 待分类\ncreated: ${today}\n---\n\n# ${name}\n\n`;
}

function cleanSuggestedTag(value) {
  return String(value || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/[\s#,:;，；：]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .toLowerCase();
}

function replaceFrontmatterTags(content, tags) {
  const normalizedTags = [...new Set(tags.map(cleanSuggestedTag).filter((tag) => tag && tag !== "待分类"))].slice(0, 5);
  const tagLines = normalizedTags.length
    ? ["tags:", ...normalizedTags.map((tag) => `  - ${tag}`)]
    : ["tags: []"];
  const match = String(content || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*/);
  if (!match) {
    return `---\n${tagLines.join("\n")}\n---\n\n${String(content || "").replace(/^\s+/, "")}`;
  }
  const bodyLines = match[1].split(/\r?\n/);
  const tagIndex = bodyLines.findIndex((line) => /^(?:tags|tag):/i.test(line.trim()));
  if (tagIndex >= 0) {
    let end = tagIndex + 1;
    while (end < bodyLines.length && /^\s+-\s+/.test(bodyLines[end])) end += 1;
    bodyLines.splice(tagIndex, end - tagIndex, ...tagLines);
  } else {
    bodyLines.push(...tagLines);
  }
  const suffix = String(content).slice(match[0].length).replace(/^\s*/, "");
  return `---\n${bodyLines.join("\n")}\n---\n\n${suffix}`;
}

function suggestSemanticTags(files, maxTags = 3) {
  const termDocs = new Map();
  const titleTerms = new Map(files.map((file) => [file.path, new Set(extractTerms(file.title || "").map((item) => cleanSuggestedTag(item.term)))]));
  for (const file of files) {
    for (const item of file.terms || []) {
      const term = cleanSuggestedTag(item.term);
      if (!term || term.length < 2 || /^\d+$/.test(term)) continue;
      if (!termDocs.has(term)) termDocs.set(term, []);
      termDocs.get(term).push({ file, count: item.count || 1 });
    }
  }
  const total = Math.max(1, files.length);
  const semanticStop = new Set(["文件", "命令", "视频", "地址", "密码", "测试", "版本", "属性", "桌面", "网络", "设备", "服务", "名称", "内容"]);
  const rankedCandidates = [];
  for (const [term, hits] of termDocs) {
    const minDocumentFrequency = total < 10 ? 2 : 3;
    if (hits.length < minDocumentFrequency || hits.length > Math.max(3, Math.ceil(total * 0.5))) continue;
    const hasHan = /\p{Script=Han}/u.test(term);
    if (!hasHan || semanticStop.has(term) || term.length > 6) continue;
    const idf = Math.log((total + 1) / (hits.length + 1)) + 1;
    const globalScore = idf * hits.reduce((sum, hit) => sum + Math.log2(1 + hit.count), 0);
    rankedCandidates.push([term, { hits, idf, globalScore }]);
  }
  const candidateLimit = Math.min(28, Math.max(10, Math.ceil(Math.sqrt(total) * 2.2)));
  const candidates = new Map(rankedCandidates.sort((a, b) => b[1].globalScore - a[1].globalScore).slice(0, candidateLimit));
  const changes = [];
  for (const file of files) {
    const existing = new Set((file.tags || []).map(cleanSuggestedTag));
    const ranked = [...candidates.entries()]
      .map(([term, info]) => {
        const hit = info.hits.find((item) => item.file.path === file.path);
        const titleBoost = titleTerms.get(file.path)?.has(term) ? 3.2 : 0;
        return hit ? { term, score: Math.log2(1 + hit.count) * info.idf + titleBoost } : null;
      })
      .filter(Boolean)
      .filter((item) => item.score >= 5.5)
      .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term, "zh-Hans-CN"));
    const additions = ranked.map((item) => item.term).filter((term) => !existing.has(term)).slice(0, Math.max(1, Math.min(5, maxTags)));
    const nextTags = [...new Set([...existing].filter((tag) => tag !== "待分类").concat(additions))];
    if (!additions.length || nextTags.join("|") === [...existing].filter((tag) => tag !== "待分类").join("|")) continue;
    changes.push({ path: file.path, title: file.title, before: [...existing].filter(Boolean), after: nextTags, content: replaceFrontmatterTags(file.content, nextTags) });
  }
  return changes;
}

function documentRelationSignature(content, tags = [], terms = []) {
  const links = [...String(content || "").matchAll(/\[\[([^\]]+)\]\]|\]\(([^)]+\.md(?:#[^)]+)?)\)/gi)]
    .map((match) => (match[1] || match[2] || "").split("|")[0].split("#")[0].trim().replace(/\\/g, "/").toLowerCase())
    .filter(Boolean)
    .sort();
  const normalizedTerms = (terms || []).slice(0, 10).map((item) => [item.term, item.count]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({ links, tags: [...new Set(tags)].sort(), terms: normalizedTerms });
}

function applyDocumentMetadata(item, workspace) {
  return {
    ...item,
    workspaceName: workspace.name,
    root: workspace.root,
    workspaceId: workspace.id,
  };
}

async function hydrateDocument(item, workspace, previous = null, forceRead = false) {
  const metadata = applyDocumentMetadata(item, workspace);
  if (previous && !forceRead && previous.size === item.size && previous.modified === item.modified) {
    return Object.assign(previous, metadata);
  }
  const absolute = path.resolve(workspace.root, item.relative || "");
  const parsed = await readMarkdownFile(absolute);
  if (previous && parsed.hash === previous.contentSha256) {
    return Object.assign(previous, metadata, {
      encoding: parsed.encoding,
      size: item.size,
      modified: item.modified,
    });
  }
  const tags = extractTags(parsed.text);
  const terms = extractTerms(parsed.text);
  return {
    ...metadata,
    title: extractTitle(parsed.text, item.name),
    encoding: parsed.encoding,
    content: parsed.text,
    contentSha256: parsed.hash,
    plain: parsed.text.replace(/[#>*_`[\]()!-]/g, " "),
    tags,
    terms,
    relationSignature: documentRelationSignature(parsed.text, tags, terms),
  };
}

function buildGraph(files) {
  const byBase = new Map(files.map((file) => [path.basename(file.relative || file.path, ".md").toLowerCase(), file]));
  const byWorkspaceBase = new Map(files.map((file) => [`${file.workspaceId}:${path.basename(file.relative || file.path, ".md").toLowerCase()}`, file]));
  const byPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const nodes = files.map((file) => ({
    id: file.path,
    label: file.title,
    kind: "doc",
    group: file.workspaceName || file.workspaceId || "docs",
    weight: 1,
    modified: file.modified || 0,
  }));
  const edgeMap = new Map();
  const nodeIds = new Set(nodes.map((node) => node.id));
  const addNode = (node) => {
    if (nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
    nodes.push(node);
    return true;
  };
  const addEdge = (source, target, type, weight = 1, directed = false) => {
    const sourceId = typeof source === "string" ? source : source?.path;
    const targetId = typeof target === "string" ? target : target?.path;
    if (!sourceId || !targetId || sourceId === targetId) return;
    const pair = directed ? `${sourceId}|${targetId}` : [sourceId, targetId].sort().join("|");
    const key = `${pair}|${type}`;
    const existing = edgeMap.get(key);
    if (existing) existing.weight += weight;
    else edgeMap.set(key, { source: sourceId, target: targetId, type, weight, directed });
  };

  let missingCount = 0;
  for (const file of files) {
    for (const match of file.content.matchAll(/\[\[([^\]]+)\]\]|\]\(([^)]+\.md(?:#[^)]+)?)\)/gi)) {
      const raw = (match[1] || match[2] || "").split("|")[0].split("#")[0].trim().replace(/\\/g, "/");
      if (!raw) continue;
      const rawWithExtension = raw.toLowerCase().endsWith(".md") ? raw : `${raw}.md`;
      const rawBase = path.basename(rawWithExtension, ".md").toLowerCase();
      const baseTarget = byWorkspaceBase.get(`${file.workspaceId}:${rawBase}`) || byBase.get(rawBase);
      const relativeTarget = path.posix.normalize(path.posix.join(path.posix.dirname(file.relative || ""), rawWithExtension));
      const pathTarget = byPath.get(workspaceRef(file.workspaceId, relativeTarget).toLowerCase());
      const target = pathTarget || baseTarget;
      if (target) {
        addEdge(file, target, "link", 3, true);
      } else {
        const missingId = `missing:${file.workspaceId || "default"}:${raw.toLowerCase()}`;
        if (nodeIds.has(missingId) || missingCount < 120) {
          if (addNode({ id: missingId, label: path.basename(raw, ".md"), kind: "missing", group: "未创建", weight: 1 })) missingCount += 1;
          addEdge(file, missingId, "missing", 2, true);
        }
      }
    }
  }

  const tagFileMap = new Map();
  for (const file of files) {
    for (const tag of file.tags) {
      if (!tagFileMap.has(tag)) tagFileMap.set(tag, []);
      tagFileMap.get(tag).push(file);
    }
  }

  const topTags = [...tagFileMap.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 160);
  for (const [tag, tagFiles] of topTags) {
    const tagId = `tag:${tag}`;
    addNode({ id: tagId, label: `#${tag}`, kind: "tag", group: "标签", weight: tagFiles.length });
    for (const file of tagFiles) {
      addEdge(file, tagId, "tag", 2);
    }
  }

  const termFileMap = new Map();
  for (const file of files) {
    for (const item of file.terms.slice(0, 10)) {
      if (/^\d+$/.test(item.term) || item.term.length < 2) continue;
      if (!termFileMap.has(item.term)) termFileMap.set(item.term, []);
      termFileMap.get(item.term).push({ file, count: item.count });
    }
  }

  const keywordLimit = Math.min(48, Math.max(12, Math.ceil(Math.sqrt(Math.max(1, files.length)) * 3)));
  const keywordCandidates = [...termFileMap.entries()]
    .filter(([, hits]) => hits.length >= 2 && hits.length <= Math.max(12, Math.ceil(files.length * 0.45)))
    .map(([term, hits]) => ({
      term,
      hits,
      score: (Math.log((files.length + 1) / (hits.length + 1)) + 1)
        * hits.reduce((sum, hit) => sum + Math.log2(1 + hit.count), 0)
        * (1 + Math.log2(1 + hits.length) * 0.35),
    }))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term, "zh-Hans-CN"))
    .slice(0, keywordLimit);

  const semanticDegree = new Map();
  for (const { term, hits } of keywordCandidates) {
    const selectedHits = hits
      .sort((a, b) => b.count - a.count)
      .filter((hit) => (semanticDegree.get(hit.file.path) || 0) < 5)
      .slice(0, 10);
    if (selectedHits.length < 2) continue;
    const keywordId = `keyword:${term}`;
    addNode({
      id: keywordId,
      label: term,
      kind: "keyword",
      group: "语义",
      weight: selectedHits.reduce((sum, hit) => sum + hit.count, 0),
    });
    for (const hit of selectedHits) {
      addEdge(hit.file, keywordId, "keyword", Math.max(1, Math.min(6, hit.count)));
      semanticDegree.set(hit.file.path, (semanticDegree.get(hit.file.path) || 0) + 1);
    }
  }

  const edgeOrder = { link: 0, missing: 1, tag: 2, keyword: 3 };
  const edgeLimit = Math.min(2400, Math.max(240, files.length * 8));
  const edges = [...edgeMap.values()]
    .sort((a, b) => (edgeOrder[a.type] ?? 9) - (edgeOrder[b.type] ?? 9) || b.weight - a.weight)
    .slice(0, edgeLimit);
  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }
  for (const node of nodes) {
    node.degree = degree.get(node.id) || 0;
    node.orphan = node.kind === "doc" && (degree.get(node.id) || 0) === 0;
    node.weight = Math.max(node.weight || 1, 1 + node.degree);
  }

  return { nodes, edges, stats: { documents: files.length, nodes: nodes.length, edges: edges.length } };
}

function extractIndexHeadings(content) {
  return [...String(content || "").matchAll(/^\s*(#{1,6})\s+(.+?)\s*$/gm)]
    .slice(0, 32)
    .map((match) => ({ level: match[1].length, title: match[2].replace(/\s+#+\s*$/, "").trim() }))
    .filter((item) => item.title);
}

function createIndexExcerpt(content, limit = 320) {
  const text = String(content || "")
    .replace(/^---\s*[\r\n]+[\s\S]*?^---\s*$/m, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_`>#~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function createGraphProjection(graph) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoingLinks = new Map();
  const backlinks = new Map();
  const concepts = new Map();
  const missingLinks = new Map();
  const pushUnique = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };
  for (const edge of graph.edges) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (edge.type === "link") {
      pushUnique(outgoingLinks, edge.source, edge.target);
      pushUnique(backlinks, edge.target, edge.source);
    } else if (edge.type === "missing") {
      pushUnique(missingLinks, edge.source, targetNode?.label || edge.target);
    } else if (edge.type === "keyword") {
      if (sourceNode?.kind === "doc") pushUnique(concepts, sourceNode.id, targetNode?.label || targetNode?.id);
      if (targetNode?.kind === "doc") pushUnique(concepts, targetNode.id, sourceNode?.label || sourceNode?.id);
    }
  }
  return { version: 0, outgoingLinks, backlinks, concepts, missingLinks };
}

function getGraphProjection(data) {
  if (data.graphProjection?.version === data.graphVersion) return data.graphProjection;
  const projection = createGraphProjection(data.graph);
  projection.version = data.graphVersion;
  data.graphProjection = projection;
  return projection;
}

function calculateKnowledgeVersion(data) {
  const workspacePart = (data.workspaces || [])
    .filter((workspace) => workspace.visible)
    .map((workspace) => `${workspace.id}|${workspace.name}|${path.resolve(workspace.root)}`)
    .sort()
    .join("\n");
  const documentPart = (data.files || [])
    .map((file) => `${file.path}|${file.contentSha256 || ""}`)
    .sort()
    .join("\n");
  return createHash("sha1")
    .update(`${data.defaultWorkspaceId || DEFAULT_WORKSPACE_ID}\n${workspacePart}\n${documentPart}`)
    .digest("hex");
}

function refreshKnowledgeVersion(data = cache) {
  data.knowledgeVersion = calculateKnowledgeVersion(data);
  return data.knowledgeVersion;
}

function buildKnowledgeIndex(data) {
  if (data.graphDirty) {
    data.graph = buildGraph(data.files);
    data.graphDirty = false;
    data.graphVersion = (data.graphVersion || 0) + 1;
    data.graphProjection = null;
  }
  const graph = data.graph;
  const knowledgeVersion = refreshKnowledgeVersion(data);
  const projection = getGraphProjection(data);
  const visibleWorkspaceIds = new Set(data.files.map((file) => file.workspaceId));
  const previousDocuments = data.knowledgeDocuments || new Map();
  const nextDocuments = new Map();
  const documents = [...data.files]
    .sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"))
    .map((file) => {
      const signature = `${file.contentSha256 || ""}|${data.graphVersion || 0}`;
      const previous = previousDocuments.get(file.path);
      if (previous?.signature === signature) {
        nextDocuments.set(file.path, previous);
        return previous.document;
      }
      const document = {
        id: file.path,
        workspaceId: file.workspaceId,
        workspace: file.workspaceName,
        relativePath: file.relative,
        absolutePath: path.resolve(file.root, file.relative || ""),
        title: file.title,
        tags: file.tags,
        headings: extractIndexHeadings(file.content),
        keywords: (file.terms || []).slice(0, 12),
        semanticConcepts: [...(projection.concepts.get(file.path) || [])].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
        outgoingLinks: [...(projection.outgoingLinks.get(file.path) || [])].sort(),
        backlinks: [...(projection.backlinks.get(file.path) || [])].sort(),
        missingLinks: [...(projection.missingLinks.get(file.path) || [])].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
        excerpt: createIndexExcerpt(file.content),
        bytes: file.size || 0,
        modifiedAt: file.modified ? new Date(file.modified).toISOString() : "",
        contentSha256: file.contentSha256 || "",
      };
      nextDocuments.set(file.path, { signature, document });
      return document;
    });
  data.knowledgeDocuments = nextDocuments;
  const workspaceCounts = new Map();
  for (const document of documents) workspaceCounts.set(document.workspaceId, (workspaceCounts.get(document.workspaceId) || 0) + 1);
  const workspaces = data.workspaces
    .filter((workspace) => visibleWorkspaceIds.has(workspace.id))
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      root: workspace.root,
      documentCount: workspaceCounts.get(workspace.id) || 0,
    }));
  return {
    schemaVersion: KNOWLEDGE_INDEX_SCHEMA_VERSION,
    knowledgeVersion,
    generatedAt: new Date().toISOString(),
    purpose: "供 AI 大模型快速定位本地知识库文档、标签、语义概念和图谱关系；命中候选后再读取 absolutePath 对应原文。",
    aiUsage: [
      "先检索 documents 的 title、tags、headings、keywords 和 excerpt。",
      "使用 outgoingLinks、backlinks、semanticConcepts 和 graph 扩展关联上下文。",
      "最后按 absolutePath 读取少量候选原文，避免一次加载整个知识库。",
    ],
    library: {
      defaultWorkspaceId: data.defaultWorkspaceId || DEFAULT_WORKSPACE_ID,
      workspaceCount: workspaces.length,
      documentCount: documents.length,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      tagCount: graph.nodes.filter((node) => node.kind === "tag").length,
      semanticConceptCount: graph.nodes.filter((node) => node.kind === "keyword").length,
      missingLinkCount: graph.nodes.filter((node) => node.kind === "missing").length,
    },
    workspaces,
    documents,
    graph: {
      nodes: graph.nodes.map(({ id, label, kind, group, weight, degree, orphan, modified }) => ({ id, label, kind, group, weight, degree, orphan: Boolean(orphan), modified: modified || 0 })),
      edges: graph.edges.map(({ source, target, type, weight, directed }) => ({ source, target, type, weight, directed: Boolean(directed) })),
    },
  };
}

async function writeKnowledgeIndex(data) {
  const indexPath = path.join(DOCS_ROOT, KNOWLEDGE_INDEX_FILENAME);
  await mkdir(DOCS_ROOT, { recursive: true });
  const index = buildKnowledgeIndex(data);
  const tempPath = path.join(DOCS_ROOT, `.${KNOWLEDGE_INDEX_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    try {
      await rename(tempPath, indexPath);
    } catch (error) {
      if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
      await rm(indexPath, { force: true });
      await rename(tempPath, indexPath);
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
  return { indexPath, index };
}

async function loadKnowledgeIndexVersion() {
  if (knowledgeIndexLoaded) return knowledgeIndexVersion;
  knowledgeIndexLoaded = true;
  try {
    const existing = JSON.parse(await readFile(path.join(DOCS_ROOT, KNOWLEDGE_INDEX_FILENAME), "utf8"));
    knowledgeIndexVersion = String(existing.knowledgeVersion || "");
  } catch {
    knowledgeIndexVersion = "";
  }
  return knowledgeIndexVersion;
}

function syncKnowledgeIndex() {
  knowledgeIndexSyncPromise = knowledgeIndexSyncPromise
    .catch(() => {})
    .then(async () => {
      await loadKnowledgeIndexVersion();
      const version = refreshKnowledgeVersion(cache);
      if (!version || version === knowledgeIndexVersion) return null;
      const result = await writeKnowledgeIndex(cache);
      knowledgeIndexVersion = result.index.knowledgeVersion || version;
      return result;
    })
    .then((result) => {
      if (cache.knowledgeVersion && cache.knowledgeVersion !== knowledgeIndexVersion) scheduleKnowledgeIndexSync();
      return result;
    });
  return knowledgeIndexSyncPromise;
}

function scheduleKnowledgeIndexSync() {
  const version = refreshKnowledgeVersion(cache);
  if (!version || version === knowledgeIndexVersion) return;
  clearTimeout(knowledgeIndexSyncTimer);
  knowledgeIndexSyncTimer = setTimeout(() => {
    knowledgeIndexSyncTimer = 0;
    syncKnowledgeIndex().catch((error) => log("warn", `知识库主清单更新失败: ${error.message}`));
  }, 450);
}

/* Retained below only as a migration reference; the active cache path is the
   watcher-driven implementation after this block. */
/*
async function legacyRefreshCache(force = false) {
  await ensureDocs();
  const { workspaces, defaultWorkspaceId } = await loadWorkspaces();
  const visibleWorkspaces = workspaces.filter((workspace) => workspace.visible).slice(0, 2);
  if (!force && cache.stamp) return cache;
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
    try {
      const { text: content, encoding } = await readMarkdownFile(absolute);
      item.title = extractTitle(content, item.name);
      item.encoding = encoding;
      files.push({
        ...item,
        encoding,
        content,
        plain: content.replace(/[#>*_`[\]()!-]/g, " "),
        tags: extractTags(content),
        terms: extractTerms(content),
        workspaceName: workspace.name,
      });
    } catch (e) {
      if (e.code === "EPERM" || e.code === "EACCES") {
        log("warn", `跳过无法访问的文件: ${absolute}`);
      } else {
        throw e;
      }
    }
  }
  cache = { stamp: Date.now(), files, tree, graph: buildGraph(files), graphDirty: false, workspaces, defaultWorkspaceId };
  try {
    scheduleKnowledgeIndexSync();
  } catch (error) {
    log("warn", `知识库主清单更新失败: ${error.message}`);
  }
  return cache;
}

async function legacyUpdateCachedDocument(normalized, content) {
  const cachedFile = cache.files.find((file) => file.path === normalized.ref);
  if (!cachedFile) return false;
  const stats = await stat(normalized.absolute);
  const title = extractTitle(content, path.basename(normalized.absolute));
  const next = {
    title,
    encoding: "utf-8",
    size: stats.size,
    modified: stats.mtimeMs,
    content,
    plain: content.replace(/[#>*_`[\]()!-]/g, " "),
    tags: extractTags(content),
    terms: extractTerms(content),
  };
  Object.assign(cachedFile, next);
  const treeFile = flattenTree(cache.tree).find((file) => file.path === normalized.ref);
  if (treeFile) Object.assign(treeFile, {
    title: next.title,
    encoding: next.encoding,
    size: next.size,
    modified: next.modified,
  });
  cache.graphDirty = true;
  cache.stamp = Math.max(Date.now(), stats.mtimeMs);
  scheduleKnowledgeIndexSync();
  return true;
}
*/

function updateGraphDocumentNodes(graph, files) {
  const byId = new Map(files.map((file) => [file.path, file]));
  for (const node of graph.nodes) {
    if (node.kind !== "doc") continue;
    const file = byId.get(node.id);
    if (!file) continue;
    node.label = file.title;
    node.group = file.workspaceName || file.workspaceId || "docs";
    node.modified = file.modified || 0;
  }
  graph.stats.documents = files.length;
  return graph;
}

function clearProcessedDirty(pending) {
  for (const [absolute, version] of pending) {
    if (dirtyVersions.get(absolute) !== version) continue;
    dirtyVersions.delete(absolute);
    dirtyPaths.delete(absolute);
  }
}

async function rebuildTreeCache(workspaces, defaultWorkspaceId, pending) {
  const visibleWorkspaces = workspaces.filter((workspace) => workspace.visible).slice(0, 2);
  const previousFiles = cache.documentCache?.size
    ? cache.documentCache
    : new Map(cache.files.map((file) => [file.path, file]));
  const tree = [];
  const files = [];
  const documentCache = new Map();
  let relationChanged = !cache.stamp;
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
    const workspace = visibleWorkspaces.find((candidate) => candidate.id === item.workspaceId);
    if (!workspace) continue;
    const absolute = path.resolve(workspace.root, item.relative || "");
    const previous = previousFiles.get(item.path);
    try {
      const next = await hydrateDocument(item, workspace, previous, pending.has(absolute));
      if (!previous || previous.relationSignature !== next.relationSignature) relationChanged = true;
      files.push(next);
      documentCache.set(next.path, next);
    } catch (error) {
      if (["ENOENT", "EPERM", "EACCES"].includes(error.code)) {
        log("debug", `跳过暂不可读文件: ${absolute}`);
        markStructureDirty();
        continue;
      }
      throw error;
    }
  }
  if (previousFiles.size !== documentCache.size || [...previousFiles.keys()].some((key) => !documentCache.has(key))) relationChanged = true;
  const graph = relationChanged || !cache.graph?.nodes?.length
    ? buildGraph(files)
    : updateGraphDocumentNodes(cache.graph, files);
  const nextGraphVersion = relationChanged ? (cache.graphVersion || 0) + 1 : cache.graphVersion || 0;
  cache = {
    ...cache,
    stamp: Date.now(),
    files,
    tree,
    graph,
    graphDirty: false,
    graphVersion: nextGraphVersion,
    graphProjection: relationChanged ? null : cache.graphProjection,
    documentCache,
    workspaces,
    defaultWorkspaceId,
  };
  clearProcessedDirty(pending);
  scheduleKnowledgeIndexSync();
  return { relationChanged, visibleWorkspaces };
}

async function applyDirtyDocuments(workspaces, pending) {
  const visibleWorkspaces = workspaces.filter((workspace) => workspace.visible).slice(0, 2);
  let relationChanged = false;
  let requiresStructure = false;
  for (const [absolute, version] of pending) {
    const workspace = workspaceForAbsolute(visibleWorkspaces, absolute);
    if (!workspace) continue;
    const relative = path.relative(workspace.root, absolute).replace(/\\/g, "/");
    if (!relative.toLowerCase().endsWith(".md")) {
      requiresStructure = true;
      continue;
    }
    const ref = workspaceRef(workspace.id, relative);
    const previous = cache.documentCache.get(ref) || cache.files.find((file) => file.path === ref);
    if (!previous) {
      requiresStructure = true;
      continue;
    }
    let stats;
    try { stats = await stat(absolute); } catch (error) {
      if (error.code === "ENOENT") requiresStructure = true;
      continue;
    }
    if (!stats.isFile()) {
      requiresStructure = true;
      continue;
    }
    const item = {
      ...previous,
      type: "file",
      name: path.basename(relative),
      relative,
      size: stats.size,
      modified: stats.mtimeMs,
    };
    const next = await hydrateDocument(item, workspace, previous, true);
    relationChanged ||= previous.relationSignature !== next.relationSignature;
    const index = cache.files.findIndex((file) => file.path === ref);
    if (index >= 0) cache.files[index] = next;
    cache.documentCache.set(ref, next);
    const treeFile = flattenTree(cache.tree).find((file) => file.path === ref);
    if (treeFile) Object.assign(treeFile, { title: next.title, encoding: next.encoding, size: next.size, modified: next.modified });
    if (dirtyVersions.get(absolute) === version) {
      dirtyVersions.delete(absolute);
      dirtyPaths.delete(absolute);
    }
  }
  if (requiresStructure) markStructureDirty();
  if (relationChanged) {
    cache.graphDirty = true;
    cache.graphProjection = null;
  } else if (cache.graph?.nodes?.length) {
    updateGraphDocumentNodes(cache.graph, cache.files);
  }
  if (pending.size) {
    cache.stamp = Date.now();
    scheduleKnowledgeIndexSync();
  }
  return { relationChanged, requiresStructure };
}

async function refreshCacheInternal() {
  await ensureDocs();
  const { workspaces, defaultWorkspaceId } = await loadWorkspaces();
  const visibleWorkspaces = workspaces.filter((workspace) => workspace.visible).slice(0, 2);
  const expectedSignature = visibleWorkspaces.map((workspace) => `${workspace.id}|${path.resolve(workspace.root)}`).join("\n");
  if (cache.stamp && expectedSignature !== watcherSignature) markStructureDirty();
  await installWorkspaceWatchers(workspaces);
  const pending = new Map([...dirtyPaths].map((absolute) => [absolute, dirtyVersions.get(absolute)]));
  if (!cache.stamp || structureDirty) {
    const generation = structureGeneration;
    const result = await rebuildTreeCache(workspaces, defaultWorkspaceId, pending);
    if (structureGeneration === generation) structureDirty = false;
    if (result.visibleWorkspaces.length) await installWorkspaceWatchers(workspaces, true);
    return cache;
  }
  if (pending.size) await applyDirtyDocuments(workspaces, pending);
  return cache;
}

async function refreshCache(force = false) {
  if (force) markStructureDirty();
  if (cacheRefreshPromise) return cacheRefreshPromise;
  cacheRefreshPromise = (async () => {
    let attempts = 0;
    do {
      await refreshCacheInternal();
      attempts += 1;
    } while (attempts < 3 && (structureDirty || dirtyPaths.size));
    return cache;
  })()
    .finally(() => { cacheRefreshPromise = null; });
  return cacheRefreshPromise;
}

async function updateCachedDocument(normalized, content) {
  const cachedFile = cache.documentCache.get(normalized.ref) || cache.files.find((file) => file.path === normalized.ref);
  if (!cachedFile) return false;
  const stats = await stat(normalized.absolute);
  const tags = extractTags(content);
  const terms = extractTerms(content);
  const relationSignature = documentRelationSignature(content, tags, terms);
  const next = {
    ...cachedFile,
    title: extractTitle(content, path.basename(normalized.absolute)),
    encoding: "utf-8",
    size: stats.size,
    modified: stats.mtimeMs,
    content,
    contentSha256: createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"),
    plain: content.replace(/[#>*_`[\]()!-]/g, " "),
    tags,
    terms,
    relationSignature,
  };
  const index = cache.files.findIndex((file) => file.path === normalized.ref);
  if (index >= 0) cache.files[index] = next;
  cache.documentCache.set(normalized.ref, next);
  const treeFile = flattenTree(cache.tree).find((file) => file.path === normalized.ref);
  if (treeFile) Object.assign(treeFile, {
    title: next.title,
    encoding: next.encoding,
    size: next.size,
    modified: next.modified,
  });
  if (cachedFile.relationSignature !== relationSignature) {
    cache.graphDirty = true;
    cache.graphProjection = null;
  } else if (cache.graph?.nodes?.length) {
    updateGraphDocumentNodes(cache.graph, cache.files);
  }
  cache.stamp = Date.now();
  scheduleKnowledgeIndexSync();
  return true;
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
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += chunk.length;
    if (totalLength > MAX_REQUEST_BODY) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
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

  if (url.pathname === "/api/version") {
    try {
      const projectVersionPath = path.join(__dirname, "version.json");
      const dataVersionPath = path.join(DATA_ROOT, "version.json");
      let versionData;
      if (existsSync(projectVersionPath)) {
        versionData = JSON.parse(readFileSync(projectVersionPath, "utf8"));
      } else if (existsSync(dataVersionPath)) {
        versionData = JSON.parse(readFileSync(dataVersionPath, "utf8"));
      } else {
        versionData = { version: "1.0.0", downloadUrl: "", releaseNotes: "", releaseDate: "" };
      }
      return json(res, 200, versionData);
    } catch (e) {
      return json(res, 200, { version: "1.0.0", downloadUrl: "", releaseNotes: "", releaseDate: "" });
    }
  }

  const data = await refreshCache(url.searchParams.get("refresh") === "1");
  if (url.pathname === "/api/tree") return json(res, 200, { tree: data.tree, count: data.files.length, workspaces: data.workspaces, defaultWorkspaceId: data.defaultWorkspaceId || "default" });
  if (url.pathname === "/api/graph") {
    if (data.graphDirty) {
      data.graph = buildGraph(data.files);
      data.graphDirty = false;
      data.graphVersion = (data.graphVersion || 0) + 1;
      data.graphProjection = null;
      scheduleKnowledgeIndexSync();
    }
    return json(res, 200, data.graph);
  }
  if (url.pathname === "/api/search") return json(res, 200, { results: search(data.files, url.searchParams.get("q") || "") });
  if (url.pathname === "/api/doc") {
    const docPath = url.searchParams.get("path");
    const target = data.files.find((file) => file.path === docPath);
    if (!target) {
      try {
        const normalized = await normalizeDocPath(docPath, true);
        const content = await readFile(normalized.absolute, "utf8");
        const title = extractTitle(content, path.basename(normalized.absolute));
        return json(res, 200, { path: normalized.ref, title, content, tags: [], terms: [] });
      } catch (e) {
        return json(res, 404, { error: "Document not found" });
      }
    }
    return json(res, 200, { path: target.path, title: target.title, content: target.content, tags: target.tags, terms: target.terms });
  }
  if (url.pathname === "/api/save" && req.method === "POST") {
    const payload = await readJson(req);
    const docPath = String(payload.path || "").trim();
    if (!docPath) {
      log("warn", "Save request missing path");
      return json(res, 400, { error: "文档路径为空" });
    }
    let normalized;
    try {
      normalized = await normalizeDocPath(docPath);
    } catch (e) {
      log("error", `Failed to normalize doc path: ${docPath}, error: ${e.message}`);
      return json(res, 400, { error: `无效的文档路径: ${e.message}` });
    }
    const { ref, relative, absolute, workspace } = normalized;
    if (!relative.toLowerCase().endsWith(".md")) {
      log("warn", `Save request for non-md file: ${relative}`);
      return json(res, 400, { error: "只能保存 .md 文件" });
    }
    try {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, String(payload.content ?? ""), "utf8");
      log("info", `Saved document: ${absolute}`);
    } catch (e) {
      if (e.code === "EPERM" || e.code === "EACCES") {
        log("error", `Permission denied when saving: ${absolute}`);
        return json(res, 403, { error: `无法保存文件，权限不足: ${path.basename(absolute)}` });
      }
      log("error", `Failed to save document: ${absolute}, error: ${e.message}`);
      return json(res, 500, { error: `保存文件失败: ${e.message}` });
    }
    try {
      const updated = await updateCachedDocument(normalized, String(payload.content ?? ""));
      if (!updated) await refreshCache(true);
    } catch (e) {
      log("error", `Failed to refresh cache after save: ${e.message}`);
    }
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

  if (url.pathname === "/api/open-folder" && req.method === "POST") {
    const payload = await readJson(req);
    const target = String(payload.path || "").trim();
    if (!target) return json(res, 400, { error: "Path is required" });
    try {
      const { execFile } = await import("node:child_process");
      if (process.platform === "win32") {
        execFile("explorer", [target]);
      } else if (process.platform === "darwin") {
        execFile("open", [target]);
      } else {
        execFile("xdg-open", [target]);
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { error: e.message || "Failed to open folder" });
    }
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
    await writeFile(absolute, documentTemplate(name), "utf8");
    await refreshCache(true);
    return json(res, 200, { ok: true, path: ref });
  }
  if (url.pathname === "/api/semantic-tags" && req.method === "POST") {
    const payload = await readJson(req);
    const data = await refreshCache();
    const visibleWorkspaces = data.workspaces.filter((item) => item.visible).slice(0, 2);
    const selectedWorkspaceIds = Array.isArray(payload.workspaceIds) && payload.workspaceIds.length
      ? payload.workspaceIds.map((id) => String(id))
      : visibleWorkspaces.map((item) => item.id);
    const selectedFiles = data.files.filter((file) => selectedWorkspaceIds.includes(file.workspaceId));
    const maxTags = Math.max(1, Math.min(5, Number(payload.maxTags || 3)));
    const changes = suggestSemanticTags(selectedFiles, maxTags);
    if (payload.apply === true) {
      let applied = 0;
      for (const change of changes) {
        const normalized = await normalizeDocPath(change.path);
        await writeFile(normalized.absolute, change.content, "utf8");
        await updateCachedDocument(normalized, change.content);
        applied += 1;
      }
      return json(res, 200, { ok: true, applied, changed: changes.length });
    }
    return json(res, 200, {
      ok: true,
      total: selectedFiles.length,
      changed: changes.length,
      changes: changes.slice(0, 60).map(({ path: filePath, title, before, after }) => ({ path: filePath, title, before, after })),
    });
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
      return send(res, 200, body, mimeTypes[path.extname(absolute).toLowerCase()] || "application/octet-stream", {
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      });
    } catch {
      return send(res, 404, "Not found", "text/plain; charset=utf-8");
    }
  }

  const clean = pathname === "/" ? "/index.html" : pathname;
  const absolute = path.resolve(PUBLIC_ROOT, `.${decodeURIComponent(clean)}`);
  if (!isInside(PUBLIC_ROOT, absolute)) return send(res, 403, "Forbidden", "text/plain");
  try {
    const body = await readFile(absolute);
    const extension = path.extname(absolute).toLowerCase();
    const cacheable = [".css", ".js", ".webp"].includes(extension);
    send(res, 200, body, mimeTypes[extension] || "application/octet-stream", cacheable ? {
      "Cache-Control": "public, max-age=31536000, immutable",
    } : undefined);
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

const REQUEST_TIMEOUT = 30 * 1000;

createServer(async (req, res) => {
  const timeoutId = setTimeout(() => {
    if (!res.writableEnded) {
      json(res, 504, { error: "Request timeout" });
    }
  }, REQUEST_TIMEOUT);

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (error) {
    if (!res.writableEnded) {
      json(res, error.status || 500, { error: error.message || "Internal server error" });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}).listen(PORT, () => {
  console.log(`Markdown knowledge app running at http://localhost:${PORT}`);
});
