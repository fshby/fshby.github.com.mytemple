/* 工作区空间色（Workspace Accent）
 *
 * 借鉴 Arc / ArcMD 的「每个空间有自己的颜色」这一体验层亮点，但完全不碰数据模型：
 *   · 不新增后端字段、不改 workspaces.json、不改任何 API；
 *   · 颜色由工作区 id 稳定哈希得出，用户可在「工作路径」弹窗里覆盖（只存 localStorage）；
 *   · 对外只下发 4 个 CSS 变量，所有染色规则写在样式层，其他主题令牌一个不动。
 *
 * 性能约束：纯函数 + 一次 DOM 写入，无定时器、无观察器、无逐节点遍历。
 */
export const WORKSPACE_ACCENTS = [
  { id: "sand", name: "砂金", hex: "#8a7c5c" },
  { id: "rose", name: "胭粉", hex: "#b56f74" },
  { id: "sage", name: "苔绿", hex: "#6f8f6a" },
  { id: "azure", name: "雾蓝", hex: "#5d83a6" },
  { id: "lilac", name: "藕紫", hex: "#8c76a6" },
  { id: "amber", name: "琥珀", hex: "#b5844e" },
];

const STORAGE_KEY = "mtWorkspaceAccents";
const BY_ID = new Map(WORKSPACE_ACCENTS.map((a) => [a.id, a]));

function stableIndex(text) {
  // FNV-1a：同一个 id 在任何设备/任何启动顺序下都得到同一个颜色
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % WORKSPACE_ACCENTS.length;
}

function readOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    return {};
  }
}

export function accentForWorkspace(wsId) {
  const id = String(wsId || "");
  const saved = readOverrides()[id];
  if (BY_ID.has(saved)) return BY_ID.get(saved);
  return WORKSPACE_ACCENTS[stableIndex(id)];
}

export function setWorkspaceAccent(wsId, accentId) {
  if (!BY_ID.has(accentId)) return false;
  const overrides = readOverrides();
  overrides[String(wsId || "")] = accentId;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch (_) { /* 隐私模式下降级为本次会话有效 */ }
  return true;
}

/** 把空间色下发到 :root（inline style 覆盖，不写入 CSS 文件 → 主题令牌基线零漂移）。 */
export function applyWorkspaceAccent(wsId, root = document.documentElement) {
  const accent = accentForWorkspace(wsId);
  if (!root || !accent) return accent;
  root.dataset.wsAccent = accent.id;
  root.style.setProperty("--ws-accent", accent.hex);
  root.style.setProperty("--ws-accent-soft", `${accent.hex}1f`);   // 12%
  root.style.setProperty("--ws-accent-wash", `${accent.hex}0c`);   // 5%
  root.style.setProperty("--ws-accent-line", `${accent.hex}59`);   // 35%
  return accent;
}
