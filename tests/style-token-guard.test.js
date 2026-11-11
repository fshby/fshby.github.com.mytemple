/**
 * 行内样式标记 `{color|bg|size:值|内容}` 的值域守卫。
 *
 * 审计里这条曾被列为「样式注入」风险（把原值直接拼进 style="background-color:${raw}"，
 * 理论上可塞 `url(外部地址)` 造成访客 IP 泄漏）。实际核对三处实现，值域都被正则
 * 限制成 `#rrggbb` 或 1-2 位数字，`url(` / `;` / 引号根本进不来 —— 是误报。
 *
 * 但「现在安全」不等于「以后安全」：三处实现各自维护这条正则，谁哪天想加个
 * `rgb(...)` 支持就可能顺手把口子开大。这里把值域钉死，并要求三处保持一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ROOT = new URL("../", import.meta.url);
const FILES = [
  ["云端 markdown 渲染", "cloud/markdown-worker.js"],
  ["桌面预览渲染", "public/app.js"],
  ["桌面编辑器行内装饰", "frontend/editor-core.js"],
];

/** 从源码里抠出样式标记的值域分组。 */
function valuePattern(src, file) {
  // 形如 (color|bg|size):(#[0-9a-fA-F]{6}|\d{1,2})
  const m = src.match(/\((color\|bg\|size)\):\(([^)]+)\)\s*\\?\|?/);
  assert.ok(m, `${file} 未找到样式标记正则`);
  return m[2];
}

test("行内样式值域只有「#rrggbb」或「1-2 位数字」，三处一致", () => {
  const patterns = FILES.map(([name, rel]) => {
    const src = fs.readFileSync(new URL(rel, ROOT), "utf8");
    const p = valuePattern(src, rel);
    return { name, rel, p };
  });
  for (const { name, rel, p } of patterns) {
    assert.equal(p, "#[0-9a-fA-F]{6}|\\d{1,2}", `${name}（${rel}）的值域被放宽了：${p}`);
    // 值域里一旦出现这些字符，就等于把任意 CSS 放进 style
    for (const bad of ["url(", ";", '"', "'", "\\s"]) {
      assert.ok(!p.includes(bad), `${name} 的值域不得包含 ${bad}`);
    }
  }
});

test("渲染时不做二次拼接：值必须原样取自受限分组", () => {
  const cloud = fs.readFileSync(new URL("cloud/markdown-worker.js", ROOT), "utf8");
  assert.match(cloud, /if \(type === "bg"\) return `<span style="background-color:\$\{rawValue\}/,
    "背景色必须直接用受限分组 rawValue，不能改写/拼接");
  const desk = fs.readFileSync(new URL("public/app.js", ROOT), "utf8");
  assert.match(desk, /background-color:\$\{value\}/, "桌面端同样只用受限分组");
});
