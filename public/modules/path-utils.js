// 字符串与路径引用工具函数。
// 从 app.js 抽取，不依赖任何 app 模块级状态（state/els/DOM 均不触碰）。
// displayPath 因引用 state.workspaces 留在 app.js。

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function displayName(file) {
  return file.displayName || file.name || file.path.split("/").pop();
}

export function splitPathRef(value = "") {
  const text = String(value || "");
  const index = text.indexOf(":");
  if (index > 0) return { workspaceId: text.slice(0, index), relative: text.slice(index + 1) };
  return { workspaceId: "default", relative: text };
}

export function joinPathRef(workspaceId, relative = "") {
  return `${workspaceId || "default"}:${String(relative || "").replace(/^\/+/, "")}`;
}

export function parentPathRef(value = "") {
  const ref = splitPathRef(value);
  if (!ref.relative) return joinPathRef(ref.workspaceId);
  const parent = ref.relative.includes("/") ? ref.relative.split("/").slice(0, -1).join("/") : "";
  return joinPathRef(ref.workspaceId, parent);
}

export function compactName(value, limit = 20) {
  const name = String(value || "");
  return name.length > limit ? `${name.slice(0, limit)}...` : name;
}

export function splitWorkspaceRef(path) {
  const value = String(path || "");
  const colon = value.indexOf(":");
  if (colon > 0) {
    return { id: value.slice(0, colon), relative: value.slice(colon + 1) };
  }
  return { id: value, relative: "" };
}

export function plainText(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~+#>|{}\[\]]/g, "")
    .trim();
}

export function headingId(text, index) {
  const base = plainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `h-${base || "section"}-${index}`;
}
