// 自定义高亮颜色按主题分组存储的工具（Markdown 文字高亮 / 代码语法高亮共用）。
//
// 背景（2026-11 用户反馈）：旧版存储是扁平 { key: "#fff" }，一套颜色全局内联
// 生效 —— 在浅色主题设置深色标题后切到 dark，深色字留在深底上被吞掉。
// 现改为 { [theme]: { key: "#fff" } }，每个主题独立记忆；未自定义的主题
// 回落 CSS 主题默认值。旧数据在读取时整体迁移到「设置时的主题」名下。
//
// 本模块保持纯函数、无 DOM 依赖，node --test 可直接引入。

export const COLOR_THEME_KEYS = ["light", "dark", "eye", "glow", "image"];
const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * 规范化存储结构为按主题分组。
 * @param {*} raw localStorage 读出的原始值
 * @param {string} fallbackTheme 旧扁平数据的迁移目标主题（= 读取时的当前主题）
 * @returns {{[theme: string]: {[key: string]: string}}}
 */
export function normalizeColorsByTheme(raw, fallbackTheme = "dark") {
  if (!raw || typeof raw !== "object") return {};
  const entries = Object.entries(raw);
  if (!entries.length) return {};
  // 旧扁平结构：值直接是颜色字符串 → 整体迁移到当前主题名下
  if (entries.some(([, v]) => typeof v === "string")) {
    const flat = {};
    for (const [k, v] of entries) {
      if (typeof v === "string" && HEX_RE.test(v)) flat[k] = v;
    }
    return COLOR_THEME_KEYS.includes(fallbackTheme) && Object.keys(flat).length
      ? { [fallbackTheme]: flat }
      : {};
  }
  // 新结构：过滤非法主题与非法颜色值
  const out = {};
  for (const [theme, colors] of entries) {
    if (!COLOR_THEME_KEYS.includes(theme) || !colors || typeof colors !== "object") continue;
    const picked = {};
    for (const [k, v] of Object.entries(colors)) {
      if (typeof v === "string" && HEX_RE.test(v)) picked[k] = v;
    }
    if (Object.keys(picked).length) out[theme] = picked;
  }
  return out;
}

/** 取某主题的自定义颜色（无则空对象） */
export function getThemeColors(byTheme, theme) {
  return (byTheme && typeof byTheme === "object" && byTheme[theme]) || {};
}

/** 设置某主题下的一个颜色，返回新对象（不修改入参） */
export function withThemeColor(byTheme, theme, key, value) {
  if (!COLOR_THEME_KEYS.includes(theme)) return byTheme || {};
  if (typeof key !== "string" || !key) return byTheme || {};
  if (typeof value !== "string" || !HEX_RE.test(value)) return byTheme || {};
  const prev = (byTheme && typeof byTheme === "object" && byTheme[theme]) || {};
  return { ...(byTheme || {}), [theme]: { ...prev, [key]: value } };
}

/** 移除某主题的整套自定义（恢复该主题默认配色），返回新对象 */
export function withoutTheme(byTheme, theme) {
  if (!byTheme || typeof byTheme !== "object" || !(theme in byTheme)) return byTheme || {};
  const out = { ...byTheme };
  delete out[theme];
  return out;
}
