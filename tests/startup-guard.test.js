/* 启动护栏回归锁（v2.3.9）
 *
 * 背景：v2.3.8 实测缺陷 —— skipSplash 分支一开始就把 appStarted 置 true，
 * 于是 license/bootstrap 阶段的异常被全局错误钩子当成「运行时错误」静默吞掉；
 * 错误文案还写进了已被 remove() 的 splash DOM，用户只看到一片空白。
 *
 * 本文件锁「契约」（防止回退），行为验证在 .verify/startup-guard-check.cjs。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8").replace(/\r\n/g, "\n");

const html = read("public/index.html");
const app = read("public/app.js");
const layer = read("frontend/styles/05-fallback-density.css");
const css = read("public/styles.css");

// 取 beginLoading 函数体：从声明到 hideSplash 之前
const bl = app.slice(app.indexOf("async function beginLoading()"), app.indexOf("\nfunction hideSplash()"));
const hideSplash = app.slice(app.indexOf("function hideSplash()"), app.indexOf("function showWelcomeIfNeeded()"));
// 内联启动护栏脚本（index.html 里唯一一个含 __kickRepaint 的 script 块）
const scriptStart = html.indexOf("// 启动护栏：全局错误捕获");
const scriptEnd = html.indexOf("</script>", scriptStart);
const guardScript = html.slice(scriptStart, scriptEnd);

test("① 可见恢复浮层：DOM 齐备且默认隐藏", () => {
  for (const id of ["startupGuard", "startupGuardTitle", "startupGuardMsg", "startupGuardDetail"]) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
  for (const id of ["startupGuardRecoverBtn", "startupGuardCopyBtn", "startupGuardReloadBtn"]) {
    assert.ok(html.includes(`id="${id}"`), `缺少恢复按钮 #${id}`);
  }
  assert.match(html, /id="startupGuard" class="startup-guard hidden"/, "浮层必须默认 hidden");
  assert.match(css, /\.startup-guard\s*\{[^}]*z-index:\s*100000/s, "浮层必须盖过 appSplash(99999)");
  assert.match(css, /\.startup-guard\.hidden\s*\{\s*display:\s*none\s*!important/, "hidden 必须真正隐藏");
});

test("② 启动完成标记推迟到 bootstrap 成功之后（不再被 skipSplash 提前置位）", () => {
  assert.doesNotMatch(bl, /__markAppStarted/, "skipSplash 分支不得提前标记启动完成");
  assert.match(hideSplash, /__markAppStarted/, "hideSplash 才标记启动完成");
  assert.match(hideSplash, /__kickRepaint/, "启动完成后做一次静默重绘探测");
  assert.match(guardScript, /if \(appStarted\) \{\s*if \(window\.console\) console\.warn\("\[runtime\]"/s,
    "启动完成后的运行时错误仍必须只 warn");
});

test("③ beginLoading 完整捕获启动异常，且入口还有一层兜底", () => {
  assert.match(bl, /try \{\s*await startupLicenseCheck\(\);/s, "startupLicenseCheck 必须包在 try 里");
  assert.match(bl, /catch \(e\) \{[\s\S]*__showStartupGuard/, "catch 必须显示可见错误浮层");
  assert.match(bl, /不 rethrow/, "catch 不得 rethrow 成 unhandledrejection 重复弹窗");
  assert.match(app, /beginLoading\(\)\.catch\(\(e\) => \{/, "入口必须有 .catch 兜底");
  assert.match(guardScript, /showGuard\("启动失败"[\s\S]*msg, true\)/, "启动期错误必须带自动刷新");
});

test("④ 错误文案不再只写进被移除的 splash DOM", () => {
  assert.match(guardScript, /splash 在 skipSplash 模式下已被移除/);
  assert.match(guardScript, /showGuard\("启动失败", "应用未能完成启动，下方是错误详情。"/);
  assert.match(guardScript, /autoReload && !autoReloadTimer/, "自动刷新只在启动失败浮层启用");
  assert.match(guardScript, /}, 10000\);/, "保留 10 秒自动刷新");
  assert.match(guardScript, /reloads < 2/, "连续失败最多自动重试 2 次，禁止无限刷新");
  assert.match(guardScript, /sessionStorage\.removeItem\("mtStartupReload"\)/, "启动成功必须清零重试计数");
  assert.match(guardScript, /}, 15000\);/, "保留 15 秒进度超时兜底");
});

test("⑤ 主界面可见性 watchdog 与启动卡死检查", () => {
  assert.match(guardScript, /__runStartupGuardCheck/, "watchdog 必须可手动触发（便于诊断与回归）");
  assert.match(guardScript, /__STARTUP_GUARD_MS/, "watchdog 延时必须可配置");
  assert.match(guardScript, /12000/, "默认 12 秒，避开慢机器冷启动");
  assert.match(guardScript, /}, 30000\);/, "30 秒仍未 markAppStarted 时提示启动卡住");
  assert.match(guardScript, /if \(errShown \|\| appStarted\) return;/, "启动已完成不得误报未完成");
});

test("⑥ shellHealthy 覆盖隐藏、零尺寸与内容被清空三种形态", () => {
  for (const frag of ['cs.display === "none"', 'cs.visibility === "hidden"', "parseFloat(cs.opacity) < 0.05",
    "r.width < 200 || r.height < 200", '.sidebar, .topbar, .workspace, #editor, #readerPanel']) {
    assert.ok(guardScript.includes(frag), `缺少健康检查：${frag}`);
  }
});

test("⑦ 一键恢复与静默重绘零视觉/零事件副作用", () => {
  assert.match(guardScript, /shell\.classList\.remove\("hidden"\)/, "恢复要清掉 hidden 类");
  assert.match(guardScript, /\["display", "visibility", "opacity", "transform"\]/, "恢复要清掉内联隐藏样式");
  assert.match(guardScript, /__kickRepaint\(\);/, "恢复要触发重绘探测");
  assert.match(guardScript, /if \(shellHealthy\(\)\) hideGuard\(\)/, "恢复成功后必须收起浮层");
  const kick = guardScript.slice(guardScript.indexOf("__kickRepaint = function"), guardScript.indexOf("function hideGuard"));
  assert.doesNotMatch(kick, /transform:|translateZ|dispatchEvent|new Event|addEventListener/,
    "静默重绘不得引入 transform 层、不得派发 resize 事件");
});

test("⑧ 浮层样式来自层源文件，且不违反体验层「零常驻 GPU 层」契约", () => {
  assert.match(layer, /\.startup-guard\s*\{/, "样式必须在 frontend/styles 层源文件中");
  const block = css.slice(css.indexOf(".startup-guard {"), css.indexOf(".startup-guard-detail.hidden"));
  // 只匹配真正的属性声明行；注释里提到该属性名不算违规
  assert.doesNotMatch(block, /^\s*(backdrop-filter|-webkit-backdrop-filter|will-change)\s*:/m,
    "常年隐藏浮层不得常驻 GPU 合成层");
  for (const token of ["--bg", "--panel", "--line", "--text", "--muted", "--warn",
    "--surface-2", "--control-bg", "--accent-solid", "--on-accent"]) {
    assert.ok(css.includes(`var(${token})`), `缺少令牌引用 ${token}`);
  }
  assert.doesNotMatch(layer.slice(layer.indexOf("启动护栏浮层")), /--[a-z-]+\s*:/,
    "不得新增自定义属性（令牌基线快照会红）");
});
