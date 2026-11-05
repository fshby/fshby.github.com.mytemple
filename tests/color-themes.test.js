// color-themes.js：自定义高亮颜色按主题分组存储的纯逻辑单测。
// 背景：旧扁平结构全主题共用一套，换主题后深色字留在深底上（2026-11 用户反馈）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeColorsByTheme,
  getThemeColors,
  withThemeColor,
  withoutTheme,
} from "../public/modules/color-themes.js";

test("旧扁平结构整体迁移到指定主题名下", () => {
  const flat = { heading: "#112233", link: "#445566" };
  const out = normalizeColorsByTheme(flat, "light");
  assert.deepEqual(out, { light: { heading: "#112233", link: "#445566" } });
  // 迁移不修改入参
  assert.deepEqual(flat, { heading: "#112233", link: "#445566" });
});

test("旧扁平结构：非法颜色被过滤，全非法则返回空", () => {
  assert.deepEqual(normalizeColorsByTheme({ heading: "red" }, "dark"), {});
  assert.deepEqual(normalizeColorsByTheme({ heading: "#abc" }, "dark"), {});
});

test("新结构按主题过滤：非法主题与非法值剔除", () => {
  const raw = {
    dark: { heading: "#112233", bad: "nope" },
    nonsense: { heading: "#112233" },
    eye: {},
  };
  assert.deepEqual(normalizeColorsByTheme(raw, "light"), { dark: { heading: "#112233" } });
});

test("空/异常输入返回空对象", () => {
  assert.deepEqual(normalizeColorsByTheme(null, "dark"), {});
  assert.deepEqual(normalizeColorsByTheme(undefined, "dark"), {});
  assert.deepEqual(normalizeColorsByTheme({}, "dark"), {});
  assert.deepEqual(normalizeColorsByTheme("x", "dark"), {});
});

test("getThemeColors：未自定义主题回落空对象", () => {
  const by = { dark: { heading: "#112233" } };
  assert.deepEqual(getThemeColors(by, "dark"), { heading: "#112233" });
  assert.deepEqual(getThemeColors(by, "light"), {});
  assert.deepEqual(getThemeColors(null, "light"), {});
});

test("withThemeColor：写入当前主题且不影响其他主题", () => {
  const by = { dark: { heading: "#112233" } };
  const out = withThemeColor(by, "light", "link", "#445566");
  assert.deepEqual(out, { dark: { heading: "#112233" }, light: { link: "#445566" } });
  // 不修改入参
  assert.deepEqual(by, { dark: { heading: "#112233" } });
});

test("withThemeColor：非法主题/键/值直接原样返回", () => {
  const by = { dark: { heading: "#112233" } };
  assert.deepEqual(withThemeColor(by, "nope", "link", "#445566"), by);
  assert.deepEqual(withThemeColor(by, "dark", "", "#445566"), by);
  assert.deepEqual(withThemeColor(by, "dark", "link", "red"), by);
});

test("withoutTheme：只移除目标主题，其余保留", () => {
  const by = { dark: { heading: "#112233" }, light: { link: "#445566" } };
  const out = withoutTheme(by, "dark");
  assert.deepEqual(out, { light: { link: "#445566" } });
  // 原对象不变
  assert.deepEqual(by, { dark: { heading: "#112233" }, light: { link: "#445566" } });
  // 不存在的主题幂等
  assert.deepEqual(withoutTheme(out, "dark"), out);
  assert.deepEqual(withoutTheme(null, "dark"), {});
});

test("端到端场景：浅色自定义深色标题 → 切 dark 后 dark 无自定义 → 回落主题默认", () => {
  let by = normalizeColorsByTheme({ heading: "#2a2520" }, "light");
  by = withThemeColor(by, "light", "code", "#3c3c3c");
  // 用户切换到 dark：dark 名下没有任何自定义
  assert.deepEqual(getThemeColors(by, "dark"), {});
  // dark 上重新自定义后互不干扰
  by = withThemeColor(by, "dark", "heading", "#d8d3c6");
  assert.deepEqual(getThemeColors(by, "light").heading, "#2a2520");
  assert.deepEqual(getThemeColors(by, "dark").heading, "#d8d3c6");
});
