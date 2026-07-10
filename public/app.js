const text = {
  emptyResult: "\u6ca1\u6709\u5339\u914d\u7ed3\u679c",
  retryKeyword: "\u6362\u4e00\u4e2a\u5173\u952e\u8bcd\u8bd5\u8bd5",
  noGraph: "\u6682\u65e0\u53ef\u7ed8\u5236\u7684 Markdown \u6587\u6863",
  docsUnit: "\u7bc7 Markdown",
  newFolder: "\u65b0\u5efa\u6587\u4ef6\u5939",
  newDoc: "\u65b0\u5efa Markdown",
  deleteConfirm: "\u786e\u5b9a\u5220\u9664\u5f53\u524d\u9879\u5417\uff1f",
};

const state = {
  tree: [],
  flatFiles: [],
  currentPath: "",
  currentContent: "",
  mode: "view",
  graph: { nodes: [], edges: [] },
  graphReady: false,
  selectedNode: "",
  selectedFolder: "",
  folderExplicit: false,
  openSeq: 0,
  searchSeq: 0,
  createMode: "doc",
  collapsedFolders: new Set(),
  graphDrag: null,
  undo: { stack: [], index: -1, applying: false },
  deleteTarget: "",
  dragItem: null,
};

const els = {
  tree: document.querySelector("#tree"),
  docCount: document.querySelector("#docCount"),
  searchInput: document.querySelector("#searchInput"),
  searchResults: document.querySelector("#searchResults"),
  docPath: document.querySelector("#docPath"),
  docTitle: document.querySelector("#docTitle"),
  readerPanel: document.querySelector("#readerPanel"),
  editorPanel: document.querySelector("#editorPanel"),
  graphPanel: document.querySelector("#graphPanel"),
  markdownView: document.querySelector("#markdownView"),
  editor: document.querySelector("#editor"),
  preview: document.querySelector("#preview"),
  viewBtn: document.querySelector("#viewBtn"),
  editBtn: document.querySelector("#editBtn"),
  graphBtn: document.querySelector("#graphBtn"),
  deleteBtn: document.querySelector("#deleteBtn"),
  saveBtn: document.querySelector("#saveBtn"),
  fitGraphBtn: document.querySelector("#fitGraphBtn"),
  canvas: document.querySelector("#graphCanvas"),
  newFolderBtn: document.querySelector("#newFolderBtn"),
  newDocBtn: document.querySelector("#newDocBtn"),
  createModal: document.querySelector("#createModal"),
  createForm: document.querySelector("#createForm"),
  createTitle: document.querySelector("#createTitle"),
  createParent: document.querySelector("#createParent"),
  createName: document.querySelector("#createName"),
  cancelCreateBtn: document.querySelector("#cancelCreateBtn"),
  deleteModal: document.querySelector("#deleteModal"),
  deleteTarget: document.querySelector("#deleteTarget"),
  cancelDeleteBtn: document.querySelector("#cancelDeleteBtn"),
  confirmDeleteBtn: document.querySelector("#confirmDeleteBtn"),
  editorToolbar: document.querySelector("#editorToolbar"),
  textColor: document.querySelector("#textColor"),
  bgColor: document.querySelector("#bgColor"),
  fontSize: document.querySelector("#fontSize"),
};

const api = {
  async get(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
  async post(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function displayName(file) {
  return file.displayName || file.name || file.path.split("/").pop();
}

function inlineMarkdown(value) {
  let html = escapeHtml(value)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />')
    .replace(/==([^=]+)==/g, "<mark>$1</mark>")
    .replace(/\+\+([^+]+)\+\+/g, "<u>$1</u>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  const styleToken = /\{(color|bg|size):(#[0-9a-fA-F]{6}|\d{1,2})\|([^{}]*)\}/g;
  for (let i = 0; i < 8; i += 1) {
    styleToken.lastIndex = 0;
    if (!styleToken.test(html)) break;
    styleToken.lastIndex = 0;
    html = html.replace(styleToken, (_, type, value, content) => {
      if (type === "color") return `<span style="color:${value}">${content}</span>`;
      if (type === "bg") return `<span style="background-color:${value};padding:0 3px;border-radius:3px">${content}</span>`;
      return `<span style="font-size:${value}px">${content}</span>`;
    });
  }

  return html
    .replace(/\[\[([^\]]+)\]\]/g, '<a href="#" data-doc-link="$1">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inCode = false;
  let code = [];
  let list = null;
  let table = [];

  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map((row) => row.split("|").map((cell) => cell.trim()).filter(Boolean));
    if (rows.length > 1) {
      const [head, , ...body] = rows;
      html.push(`<table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    }
    table = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushList();
      flushTable();
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
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
    if (/^\|.+\|$/.test(line)) {
      flushList();
      table.push(line);
      continue;
    }
    flushTable();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushList();
      html.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushList();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((bullet || ordered)[1]);
      continue;
    }
    if (!line.trim()) {
      flushList();
      html.push("");
      continue;
    }
    flushList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  flushList();
  flushTable();
  if (inCode) html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  return html.join("\n");
}

function renderTree(nodes, container = els.tree) {
  container.innerHTML = "";
  for (const node of nodes) {
    if (node.type === "folder") {
      const collapsed = state.collapsedFolders.has(node.path);
      const wrapper = document.createElement("div");
      wrapper.className = `tree-folder ${collapsed ? "collapsed" : ""}`;
      const title = document.createElement("button");
      title.className = `folder-title ${state.selectedFolder === node.path ? "selected" : ""}`;
      title.type = "button";
      title.draggable = true;
      title.innerHTML = `<span class="folder-icon">v</span><span>${escapeHtml(node.name)}</span>`;
      title.addEventListener("click", () => {
        state.selectedFolder = node.path;
        state.folderExplicit = true;
        if (state.collapsedFolders.has(node.path)) state.collapsedFolders.delete(node.path);
        else state.collapsedFolders.add(node.path);
        renderTree(state.tree);
      });
      title.addEventListener("dragstart", (event) => startTreeDrag(event, { type: "folder", path: node.path }));
      title.addEventListener("dragend", endTreeDrag);
      title.addEventListener("dragover", allowFolderDrop);
      title.addEventListener("dragleave", clearFolderDrop);
      title.addEventListener("drop", (event) => dropOnFolder(event, node.path));
      const children = document.createElement("div");
      children.className = "folder-children";
      renderTree(node.children, children);
      wrapper.append(title);
      wrapper.append(children);
      container.append(wrapper);
      continue;
    }

    const button = document.createElement("button");
    button.className = `file-item ${state.currentPath === node.path ? "active" : ""}`;
    button.draggable = true;
    button.title = node.title && node.title !== displayName(node) ? node.title : node.path;
    button.innerHTML = `<span class="file-icon">-</span><span>${escapeHtml(displayName(node))}</span>`;
    button.addEventListener("click", () => openDoc(node.path));
    button.addEventListener("dragstart", (event) => startTreeDrag(event, { type: "file", path: node.path }));
    button.addEventListener("dragend", endTreeDrag);
    container.append(button);
  }
}

function startTreeDrag(event, item) {
  state.dragItem = item;
  event.currentTarget.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/json", JSON.stringify(item));
  event.dataTransfer.setData("text/plain", item.path);
}

function endTreeDrag(event) {
  event.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  state.dragItem = null;
}

function allowFolderDrop(event) {
  if (!state.dragItem) return;
  event.preventDefault();
  event.currentTarget.classList.add("drop-target");
  event.dataTransfer.dropEffect = "move";
}

function clearFolderDrop(event) {
  event.currentTarget.classList.remove("drop-target");
}

async function dropOnFolder(event, targetFolder) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove("drop-target");
  const item = state.dragItem || JSON.parse(event.dataTransfer.getData("application/json") || "null");
  if (!item || item.path === targetFolder) return;
  const moved = await api.post("/api/move", { source: item.path, targetFolder });
  state.graphReady = false;
  await bootstrap(true);
  if (moved.type === "file" && moved.path) await openDoc(moved.path);
  if (moved.type === "folder" && moved.path) {
    state.selectedFolder = moved.path;
    state.folderExplicit = true;
    renderTree(state.tree);
  }
}

function allowRootDrop(event) {
  if (!state.dragItem || event.target.closest(".folder-title")) return;
  event.preventDefault();
  els.tree.classList.add("drop-root");
  event.dataTransfer.dropEffect = "move";
}

function clearRootDrop() {
  els.tree.classList.remove("drop-root");
}

async function dropOnRoot(event) {
  if (!state.dragItem || event.target.closest(".folder-title")) return;
  event.preventDefault();
  clearRootDrop();
  const moved = await api.post("/api/move", { source: state.dragItem.path, targetFolder: "" });
  state.graphReady = false;
  await bootstrap(true);
  if (moved.type === "file" && moved.path) await openDoc(moved.path);
  if (moved.type === "folder" && moved.path) {
    state.selectedFolder = moved.path;
    state.folderExplicit = true;
    renderTree(state.tree);
  }
}

function flatten(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === "file") out.push(node);
    if (node.children) flatten(node.children, out);
  }
  return out;
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  els.readerPanel.classList.toggle("hidden", mode !== "view");
  els.editorPanel.classList.toggle("hidden", mode !== "edit");
  els.graphPanel.classList.toggle("hidden", mode !== "graph");
  els.saveBtn.classList.toggle("hidden", mode !== "edit" || !state.currentPath);
  els.viewBtn.classList.toggle("active", mode === "view");
  els.editBtn.classList.toggle("active", mode === "edit");
  els.graphBtn.classList.toggle("active", mode === "graph");
  if (mode === "graph") requestAnimationFrame(() => initGraph());
}

function resetUndo(content) {
  state.undo.stack = [content];
  state.undo.index = 0;
  state.undo.applying = false;
}

function recordUndo(value) {
  if (state.undo.applying) return;
  if (state.undo.stack[state.undo.index] === value) return;
  state.undo.stack = state.undo.stack.slice(0, state.undo.index + 1);
  state.undo.stack.push(value);
  if (state.undo.stack.length > 80) state.undo.stack.shift();
  state.undo.index = state.undo.stack.length - 1;
}

function applyEditorValue(value) {
  state.undo.applying = true;
  els.editor.value = value;
  state.currentContent = value;
  els.preview.innerHTML = renderMarkdown(value);
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
  state.undo.applying = false;
}

function undoEditor() {
  if (state.undo.index <= 0) return;
  state.undo.index -= 1;
  applyEditorValue(state.undo.stack[state.undo.index]);
}

function redoEditor() {
  if (state.undo.index >= state.undo.stack.length - 1) return;
  state.undo.index += 1;
  applyEditorValue(state.undo.stack[state.undo.index]);
}

async function openDoc(docPath) {
  const seq = ++state.openSeq;
  const doc = await api.get(`/api/doc?path=${encodeURIComponent(docPath)}`);
  if (seq !== state.openSeq) return;

  const item = state.flatFiles.find((file) => file.path === doc.path) || doc;
  state.currentPath = doc.path;
  state.currentContent = doc.content;
  state.selectedNode = doc.path;
  state.selectedFolder = doc.path.includes("/") ? doc.path.split("/").slice(0, -1).join("/") : "";
  state.folderExplicit = false;
  els.docPath.textContent = doc.path;
  els.docTitle.textContent = displayName(item);
  els.docTitle.title = doc.title || displayName(item);
  els.markdownView.classList.remove("empty-state");
  els.markdownView.innerHTML = renderMarkdown(doc.content);
  els.editor.value = doc.content;
  els.preview.innerHTML = renderMarkdown(doc.content);
  resetUndo(doc.content);
  renderTree(state.tree);
  if (state.mode === "graph") drawGraph();
}

function debounce(fn, wait = 180) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const updatePreview = debounce(() => {
  els.preview.innerHTML = renderMarkdown(state.currentContent);
}, 80);

async function runSearch() {
  const seq = ++state.searchSeq;
  const query = els.searchInput.value.trim();
  els.searchResults.classList.toggle("hidden", !query);
  if (!query) {
    els.searchResults.innerHTML = "";
    return;
  }
  const { results } = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
  if (seq !== state.searchSeq) return;
  els.searchResults.innerHTML = results.length
    ? results.map((item) => {
        const file = state.flatFiles.find((entry) => entry.path === item.path) || item;
        return `<button class="search-item" data-path="${escapeHtml(item.path)}"><strong>${escapeHtml(displayName(file))}</strong><span>${escapeHtml(item.snippet || item.path)}</span></button>`;
      }).join("")
    : `<div class="search-item"><strong>${text.emptyResult}</strong><span>${text.retryKeyword}</span></div>`;
}

function currentParent() {
  if (state.selectedFolder) return state.selectedFolder;
  if (!state.currentPath || !state.currentPath.includes("/")) return "";
  return state.currentPath.split("/").slice(0, -1).join("/");
}

function openCreateModal(mode) {
  state.createMode = mode;
  const parent = currentParent();
  els.createTitle.textContent = mode === "folder" ? text.newFolder : text.newDoc;
  els.createParent.textContent = parent ? `docs/${parent}` : "docs";
  els.createName.value = "";
  els.createModal.classList.remove("hidden");
  els.createName.focus();
}

function closeCreateModal() {
  els.createModal.classList.add("hidden");
}

async function submitCreate(event) {
  event.preventDefault();
  const name = els.createName.value.trim();
  if (!name) return;
  const parent = currentParent();
  const endpoint = state.createMode === "folder" ? "/api/create-folder" : "/api/create-doc";
  const created = await api.post(endpoint, { parent, name });
  await bootstrap(true);
  if (state.createMode === "doc" && created.path) await openDoc(created.path);
  closeCreateModal();
}

function selectedDeletePath() {
  return state.folderExplicit ? state.selectedFolder : state.currentPath || state.selectedFolder;
}

async function deleteSelected() {
  const target = selectedDeletePath();
  if (!target) return;
  state.deleteTarget = target;
  els.deleteTarget.textContent = target;
  els.deleteModal.classList.remove("hidden");
}

function closeDeleteModal() {
  state.deleteTarget = "";
  els.deleteModal.classList.add("hidden");
}

async function confirmDeleteSelected() {
  const target = state.deleteTarget;
  if (!target) return;
  await api.post("/api/delete", { path: target });
  state.currentPath = "";
  state.currentContent = "";
  state.selectedNode = "";
  if (state.selectedFolder === target || target.startsWith(`${state.selectedFolder}/`)) state.selectedFolder = "";
  state.folderExplicit = false;
  els.docPath.textContent = "docs";
  els.docTitle.textContent = "\u9009\u62e9\u4e00\u7bc7 Markdown \u6587\u6863";
  els.markdownView.classList.add("empty-state");
  els.markdownView.innerHTML = "<h2>\u6253\u5f00\u5de6\u4fa7\u76ee\u5f55\u4e2d\u7684\u6587\u6863</h2><p>\u652f\u6301\u6587\u4ef6\u5939\u5206\u7c7b\u3001\u5168\u6587\u641c\u7d22\u3001\u6587\u6863\u5207\u6362\u3001\u7f16\u8f91\u4fdd\u5b58\u548c\u5173\u8054\u56fe\u8c31\u6d4f\u89c8\u3002</p>";
  els.editor.value = "";
  els.preview.innerHTML = "";
  resetUndo("");
  state.graphReady = false;
  await bootstrap(true);
  setMode("view");
  closeDeleteModal();
}

function closeSearchWhenIdle(event) {
  if (event.target.closest(".search-box") || event.target.closest("#searchResults")) return;
  els.searchResults.classList.add("hidden");
}

function resizeCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  els.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  els.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  els.canvas.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
}

async function initGraph(force = false) {
  if (!state.graphReady || force) {
    const graph = await api.get("/api/graph");
    state.graph = layoutGraph(graph);
    state.graphReady = true;
  }
  resizeCanvas();
  drawGraph();
}

function layoutGraph(graph) {
  const nodes = graph.nodes.map((node) => ({
    ...node,
    label: node.kind === "keyword" ? node.label : node.id.split("/").pop(),
  }));
  const groups = [...new Set(nodes.map((node) => node.group || "docs"))];
  const byGroup = new Map(groups.map((group) => [group, []]));
  for (const node of nodes) byGroup.get(node.group || "docs").push(node);

  const centerX = 520;
  const centerY = 340;
  const groupRadius = Math.max(180, groups.length * 48);
  groups.forEach((group, groupIndex) => {
    const bucket = byGroup.get(group);
    const groupAngle = (Math.PI * 2 * groupIndex) / Math.max(1, groups.length);
    const gx = centerX + Math.cos(groupAngle) * groupRadius;
    const gy = centerY + Math.sin(groupAngle) * groupRadius;
    const localRadius = Math.max(42, bucket.length * 12);
    bucket.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, bucket.length);
      node.x = gx + Math.cos(angle) * localRadius;
      node.y = gy + Math.sin(angle) * localRadius;
    });
  });

  const usefulEdges = graph.edges
    .filter((edge) => edge.type === "keyword" || edge.type !== "semantic" || edge.weight >= 4)
    .sort((a, b) => {
      const order = { link: 0, tag: 1, semantic: 2 };
      return (order[a.type] ?? 9) - (order[b.type] ?? 9) || b.weight - a.weight;
    })
    .slice(0, Math.max(80, nodes.length * 4));

  return { nodes, edges: usefulEdges };
}

function graphTransform(rect, nodes) {
  const minX = Math.min(...nodes.map((n) => n.x));
  const maxX = Math.max(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxY = Math.max(...nodes.map((n) => n.y));
  const scale = Math.min((rect.width - 90) / Math.max(1, maxX - minX), (rect.height - 90) / Math.max(1, maxY - minY), 1.35);
  return {
    scale,
    tx: (rect.width - (minX + maxX) * scale) / 2,
    ty: (rect.height - (minY + maxY) * scale) / 2,
  };
}

function graphPoint(node) {
  const rect = els.canvas.getBoundingClientRect();
  const { scale, tx, ty } = graphTransform(rect, state.graph.nodes || []);
  return { x: node.x * scale + tx, y: node.y * scale + ty };
}

function screenToGraph(clientX, clientY) {
  const rect = els.canvas.getBoundingClientRect();
  const { scale, tx, ty } = graphTransform(rect, state.graph.nodes || []);
  return {
    x: (clientX - rect.left - tx) / scale,
    y: (clientY - rect.top - ty) / scale,
  };
}

function drawGraph() {
  if (state.mode !== "graph") return;
  const ctx = els.canvas.getContext("2d");
  const rect = els.canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  const nodes = state.graph.nodes || [];
  if (!nodes.length) {
    ctx.fillStyle = "#667085";
    ctx.fillText(text.noGraph, 24, 32);
    return;
  }

  const { scale, tx, ty } = graphTransform(rect, nodes);
  const point = (node) => ({ x: node.x * scale + tx, y: node.y * scale + ty });
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const edge of state.graph.edges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;
    const pa = point(a);
    const pb = point(b);
    ctx.strokeStyle = edge.type === "link" ? "#0f766e" : edge.type === "tag" ? "#b45309" : edge.type === "keyword" ? "#6941c6" : "#98a2b3";
    ctx.globalAlpha = edge.type === "semantic" ? 0.22 : edge.type === "keyword" ? 0.42 : 0.58;
    ctx.lineWidth = Math.min(3, 0.8 + edge.weight * 0.2);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  for (const node of nodes) {
    const p = point(node);
    const active = node.id === state.selectedNode;
    const keyword = node.kind === "keyword";
    ctx.fillStyle = active ? "#0f766e" : keyword ? "#f4efff" : "#ffffff";
    ctx.strokeStyle = active ? "#115e59" : keyword ? "#6941c6" : "#98a2b3";
    ctx.lineWidth = active ? 3 : 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, active ? 13 : keyword ? 8 : 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = active ? "#115e59" : keyword ? "#53389e" : "#1d2430";
    ctx.font = active ? "700 13px Segoe UI" : keyword ? "700 11px Segoe UI" : "12px Segoe UI";
    ctx.fillText(node.label, p.x + 15, p.y + 4);
  }
}

function hitGraph(event) {
  const nodes = state.graph.nodes || [];
  if (!nodes.length) return null;
  const rect = els.canvas.getBoundingClientRect();
  const { scale, tx, ty } = graphTransform(rect, nodes);
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return nodes.find((node) => Math.hypot(node.x * scale + tx - x, node.y * scale + ty - y) < 18);
}

function insertAtCursor(value) {
  const start = els.editor.selectionStart ?? els.editor.value.length;
  const end = els.editor.selectionEnd ?? start;
  els.editor.value = `${els.editor.value.slice(0, start)}${value}${els.editor.value.slice(end)}`;
  const next = start + value.length;
  els.editor.selectionStart = next;
  els.editor.selectionEnd = next;
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function wrapSelection(before, after = before, placeholder = "text") {
  let start = els.editor.selectionStart ?? els.editor.value.length;
  let end = els.editor.selectionEnd ?? start;
  if (start === end && els.editor.value) {
    const lineStart = els.editor.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const nextLine = els.editor.value.indexOf("\n", start);
    const lineEnd = nextLine === -1 ? els.editor.value.length : nextLine;
    if (lineEnd > lineStart) {
      start = lineStart;
      end = lineEnd;
    }
  }
  const selected = els.editor.value.slice(start, end) || placeholder;
  const nextValue = `${els.editor.value.slice(0, start)}${before}${selected}${after}${els.editor.value.slice(end)}`;
  els.editor.value = nextValue;
  els.editor.focus();
  els.editor.selectionStart = start + before.length;
  els.editor.selectionEnd = start + before.length + selected.length;
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertDivider() {
  const cursor = els.editor.selectionEnd ?? els.editor.value.length;
  const nextLine = els.editor.value.indexOf("\n", cursor);
  const insertAt = nextLine === -1 ? els.editor.value.length : nextLine;
  const prefix = els.editor.value.slice(0, insertAt).endsWith("\n") ? "" : "\n";
  const value = `${prefix}---\n`;
  els.editor.value = `${els.editor.value.slice(0, insertAt)}${value}${els.editor.value.slice(insertAt)}`;
  const next = insertAt + value.length;
  els.editor.focus();
  els.editor.selectionStart = next;
  els.editor.selectionEnd = next;
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyFormat(format) {
  const color = els.textColor.value;
  const bg = els.bgColor.value;
  const size = els.fontSize.value;
  const actions = {
    bold: () => wrapSelection("**", "**"),
    underline: () => wrapSelection("++", "++"),
    strike: () => wrapSelection("~~", "~~"),
    highlight: () => wrapSelection("==", "=="),
    color: () => wrapSelection(`{color:${color}|`, "}"),
    bg: () => wrapSelection(`{bg:${bg}|`, "}"),
    size: () => wrapSelection(`{size:${size}|`, "}"),
    hr: () => insertDivider(),
  };
  actions[format]?.();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1600;
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  bitmap.close?.();
  return blob || file;
}

async function handleEditorPaste(event) {
  const image = [...(event.clipboardData?.items || [])]
    .find((item) => item.kind === "file" && item.type.startsWith("image/"))
    ?.getAsFile();
  if (!image) return;
  event.preventDefault();
  const compressed = await compressImage(image);
  const dataUrl = await blobToDataUrl(compressed);
  const uploaded = await api.post("/api/asset", {
    dataUrl,
    name: `screenshot-${Date.now()}.webp`,
  });
  insertAtCursor(`\n${uploaded.markdown}\n`);
}

els.searchInput.addEventListener("input", debounce(runSearch, 160));
els.tree.addEventListener("dragover", allowRootDrop);
els.tree.addEventListener("dragleave", clearRootDrop);
els.tree.addEventListener("drop", dropOnRoot);
els.searchInput.addEventListener("focus", () => {
  if (els.searchInput.value.trim()) runSearch();
});
document.addEventListener("click", closeSearchWhenIdle);
els.searchResults.addEventListener("click", (event) => {
  const button = event.target.closest("[data-path]");
  if (button) {
    els.searchResults.classList.add("hidden");
    openDoc(button.dataset.path);
  }
});
els.markdownView.addEventListener("click", (event) => {
  const link = event.target.closest("[data-doc-link]");
  if (!link) return;
  event.preventDefault();
  const label = link.dataset.docLink.toLowerCase();
  const file = state.flatFiles.find((item) => item.title.toLowerCase() === label || item.path.toLowerCase().endsWith(`${label}.md`));
  if (file) openDoc(file.path);
});
els.editor.addEventListener("input", () => {
  state.currentContent = els.editor.value;
  recordUndo(state.currentContent);
  updatePreview();
});
els.editor.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return;
  if (event.key.toLowerCase() === "z" && !event.shiftKey) {
    event.preventDefault();
    undoEditor();
  } else if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) {
    event.preventDefault();
    redoEditor();
  }
});
els.editor.addEventListener("paste", handleEditorPaste);
els.editorToolbar.addEventListener("mousedown", (event) => {
  if (event.target.closest("[data-format]")) event.preventDefault();
});
els.editorToolbar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-format]");
  if (button) applyFormat(button.dataset.format);
});
els.newFolderBtn.addEventListener("click", () => openCreateModal("folder"));
els.newDocBtn.addEventListener("click", () => openCreateModal("doc"));
els.createForm.addEventListener("submit", submitCreate);
els.cancelCreateBtn.addEventListener("click", closeCreateModal);
els.createModal.addEventListener("click", (event) => {
  if (event.target === els.createModal) closeCreateModal();
});
els.cancelDeleteBtn.addEventListener("click", closeDeleteModal);
els.confirmDeleteBtn.addEventListener("click", confirmDeleteSelected);
els.deleteModal.addEventListener("click", (event) => {
  if (event.target === els.deleteModal) closeDeleteModal();
});
els.viewBtn.addEventListener("click", () => setMode("view"));
els.editBtn.addEventListener("click", () => state.currentPath && setMode("edit"));
els.graphBtn.addEventListener("click", () => setMode("graph"));
els.deleteBtn.addEventListener("click", deleteSelected);
els.saveBtn.addEventListener("click", async () => {
  await api.post("/api/save", { path: state.currentPath, content: els.editor.value });
  state.currentContent = els.editor.value;
  els.markdownView.innerHTML = renderMarkdown(state.currentContent);
  state.graphReady = false;
  await bootstrap(true);
  await openDoc(state.currentPath);
});
els.fitGraphBtn.addEventListener("click", () => {
  state.graphReady = false;
  initGraph(true);
});
els.canvas.addEventListener("pointerdown", (event) => {
  if (state.mode !== "graph") return;
  const node = hitGraph(event);
  if (!node) return;
  const graphPos = screenToGraph(event.clientX, event.clientY);
  state.graphDrag = {
    node,
    offsetX: node.x - graphPos.x,
    offsetY: node.y - graphPos.y,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  els.canvas.classList.add("dragging");
  els.canvas.setPointerCapture?.(event.pointerId);
});
els.canvas.addEventListener("pointermove", (event) => {
  if (!state.graphDrag) return;
  const graphPos = screenToGraph(event.clientX, event.clientY);
  state.graphDrag.node.x = graphPos.x + state.graphDrag.offsetX;
  state.graphDrag.node.y = graphPos.y + state.graphDrag.offsetY;
  state.graphDrag.moved ||= Math.hypot(event.clientX - state.graphDrag.startX, event.clientY - state.graphDrag.startY) > 4;
  drawGraph();
});
els.canvas.addEventListener("pointerup", (event) => {
  if (!state.graphDrag) return;
  const drag = state.graphDrag;
  state.graphDrag = null;
  els.canvas.classList.remove("dragging");
  els.canvas.releasePointerCapture?.(event.pointerId);
  if (!drag.moved) openDoc(drag.node.id);
});
els.canvas.addEventListener("pointercancel", () => {
  state.graphDrag = null;
  els.canvas.classList.remove("dragging");
});
window.addEventListener("resize", debounce(() => {
  if (state.mode === "graph") {
    resizeCanvas();
    drawGraph();
  }
}, 120));

async function bootstrap(refresh = false) {
  const data = await api.get(`/api/tree${refresh ? "?refresh=1" : ""}`);
  state.tree = data.tree;
  state.flatFiles = flatten(state.tree, []);
  els.docCount.textContent = `${data.count} ${text.docsUnit}`;
  renderTree(state.tree);
}

bootstrap();
