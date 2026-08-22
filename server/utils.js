// 纯工具函数与知识图谱构建器。
// 从 server.js 抽取，不持有任何模块级可变状态，仅依赖入参与 Node 内建模块。
import { createHash } from "node:crypto";
import path from "node:path";

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Content-Length": buf.length, ...headers });
  res.end(buf);
}

export function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

export function isInside(root, absolute) {
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function workspaceId(root) {
  const normalized = path.resolve(root).toLowerCase();
  return `ws_${createHash("sha1").update(normalized).digest("hex").slice(0, 10)}`;
}

export function workspaceRef(id, relative = "") {
  return `${id}:${relative}`;
}

export function extractIndexHeadings(content) {
  return [...String(content || "").matchAll(/^\s*(#{1,6})\s+(.+?)\s*$/gm)]
    .slice(0, 32)
    .map((match) => ({ level: match[1].length, title: match[2].replace(/\s+#+\s*$/, "").trim() }))
    .filter((item) => item.title);
}

export function createIndexExcerpt(content, limit = 320) {
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

export function createGraphProjection(graph) {
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

export function buildGraph(files) {
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

  // 大规模图谱裁剪：当节点总数超过阈值时，优先保留高连接度节点
  const MAX_GRAPH_NODES = 1200;
  if (nodes.length > MAX_GRAPH_NODES) {
    const docNodes = nodes.filter((n) => n.kind === "doc");
    const nonDocNodes = nodes.filter((n) => n.kind !== "doc");
    // 按连接度降序排列文档节点，保留高优先级的
    docNodes.sort((a, b) => (b.degree || 0) - (a.degree || 0) || (b.weight || 0) - (a.weight || 0));
    const keepCount = Math.max(0, MAX_GRAPH_NODES - nonDocNodes.length);
    const keptDocIds = new Set(docNodes.slice(0, keepCount).map((n) => n.id));
    const trimmedNodes = [...nonDocNodes, ...docNodes.slice(0, keepCount)];
    const trimmedEdges = edges.filter((e) => keptDocIds.has(e.source) || keptDocIds.has(e.target));
    // 重新计算 degree（因为裁剪后部分边的端点可能已移除）
    const newDegree = new Map();
    for (const edge of trimmedEdges) {
      newDegree.set(edge.source, (newDegree.get(edge.source) || 0) + 1);
      newDegree.set(edge.target, (newDegree.get(edge.target) || 0) + 1);
    }
    for (const node of trimmedNodes) {
      node.degree = newDegree.get(node.id) || 0;
      node.orphan = node.kind === "doc" && (newDegree.get(node.id) || 0) === 0;
      node.weight = Math.max(node.weight || 1, 1 + node.degree);
    }
    return { nodes: trimmedNodes, edges: trimmedEdges, stats: { documents: files.length, nodes: trimmedNodes.length, edges: trimmedEdges.length, pruned: true } };
  }

  return { nodes, edges, stats: { documents: files.length, nodes: nodes.length, edges: edges.length } };
}
