#!/usr/bin/env node
// 刷新 tests/baselines/tokens.snapshot.json。
// 只在「有意调整令牌值」后运行，并把变化写进提交说明；
// 令牌值的无意漂移由 tests/css-architecture.test.js 拦下。
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, THEMES, collectFromArtifact, declaredIn, layerFiles } from "./css-token-model.mjs";

const SNAPSHOT = join(ROOT, "tests", "baselines", "tokens.snapshot.json");

const TOKENS = [
  "--bg", "--panel", "--line", "--text", "--muted", "--soft",
  "--accent", "--accent-strong", "--accent-solid", "--on-accent", "--focus-ring",
  "--doc-font-size", "--prose-size", "--prose-leading", "--prose-measure",
  "--prose-scale", "--prose-gutter", "--prose-block-gap", "--prose-block-gap-fixed",
  "--status-bar-h", "--mt-immersive-measure",
  "--app-font-family", "--app-font-mono", "--font-sans",
  "--md-link", "--md-tag",
];

const defs = collectFromArtifact();
const previous = exists() ? JSON.parse(readFileSync(SNAPSHOT, "utf8")) : {};

function exists() { try { readFileSync(SNAPSHOT, "utf8"); return true; } catch { return false; } }

const snapshot = { _comment: "令牌基线（声明值，非浏览器计算值）。刷新：node scripts/update-token-snapshot.mjs", themes: {} };
const changes = [];
for (const theme of THEMES) {
  snapshot.themes[theme] = {};
  for (const token of TOKENS) {
    const v = declaredIn(defs, token, theme);
    snapshot.themes[theme][token] = v;
    if (previous.themes && theme in previous.themes && previous.themes[theme][token] !== v) {
      changes.push(`${theme} ${token}: ${JSON.stringify(previous.themes[theme][token])} → ${JSON.stringify(v)}`);
    }
  }
}

mkdirSync(join(ROOT, "tests", "baselines"), { recursive: true });
writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`快照已写入 tests/baselines/tokens.snapshot.json（${THEMES.length} 主题 × ${TOKENS.length} 令牌）`);
if (changes.length) {
  console.log(`\n与上次相比 ${changes.length} 处变化：`);
  changes.forEach((c) => console.log(`  ${c}`));
} else {
  console.log("与上次相比无变化。");
}
console.log(`层文件：${layerFiles().join(" + ")}`);
