// CSS 令牌模型的唯一实现：解析 public/styles.css，给出「某主题作用域下某令牌的声明值」。
// tests/css-architecture.test.js（快照校验）与 scripts/update-token-snapshot.mjs（快照刷新）
// 共用这里，避免两份解析逻辑各改各的。
//
// 注意：这里给的是「声明值」，不是浏览器计算值 —— 浏览器级的 12 组合
// （4 主题 × 阅读/编辑/沉浸）计算样式基线由 scripts/verify-baseline.mjs 用真实
// Chromium 实测（沙箱/CI 无 WebView2，故不入 npm test）。
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const THEMES = ["light", "dark", "eye", "glow", "image"];
export const THEME_SCOPES = { light: ":root", dark: 'body[data-theme="dark"]', eye: 'body[data-theme="eye"]', glow: 'body[data-theme="glow"]', image: 'body[data-theme="image"]' };

/** 抹掉块注释但保留换行，使行号与原文件一致。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));

/** 收集全部自定义属性声明；返回 Map<token, Array<{ chain, value }>>（文件顺序）。 */
export function collectVarDefs(css) {
  const clean = stripComments(css);
  const defs = new Map();
  const stack = [];
  let sel = "";
  let body = "";
  let depth = 0;
  const flush = () => {
    const chain = stack.join(" | ");
    const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g;
    let m;
    while ((m = re.exec(body))) {
      if (!defs.has(m[1])) defs.set(m[1], []);
      defs.get(m[1]).push({ chain, value: m[2].trim() });
    }
  };
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (c === "{") { depth += 1; stack.push(sel.trim()); sel = ""; body = ""; }
    else if (c === "}") { flush(); depth -= 1; stack.pop(); body = ""; }
    else if (depth === 0) sel += c;
    else body += c;
  }
  if (depth !== 0) throw new Error("public/styles.css 括号不平衡，请先运行 npm run build:css");
  return defs;
}

export function loadArtifact() {
  return readFileSync(join(ROOT, "public", "styles.css"), "utf8");
}

export function collectFromArtifact() {
  return collectVarDefs(loadArtifact());
}

/** 某主题作用域下某令牌的「最后一条声明」（级联：文件靠后者胜）；无则 null。 */
export function declaredIn(defs, token, theme) {
  const list = defs.get(token) || [];
  const scope = THEME_SCOPES[theme];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].chain.includes(scope)) return list[i].value;
  }
  return null;
}

/** 层源文件名（字典序 = 级联顺序）。 */
export function layerFiles() {
  return readdirSync(join(ROOT, "frontend", "styles")).filter((f) => f.endsWith(".css")).sort();
}
