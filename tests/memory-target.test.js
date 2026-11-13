// memory-target.test.js — 低显存模式（MemoryUsageTargetLevel）结构回归
//
// 背景：用户实测 GPU 进程 686MB / 渲染器 465MB，而旧「低显存模式」只削
// backdrop-filter/shadow，对显存/内存几乎没有可感知影响。v2.3.12 起
// 开关同时驱动 ICoreWebView2_19::MemoryUsageTargetLevel（LOW/NORMAL），
// 并削减预览容器的常驻合成层。本测试锁住三处接线，防止回归：
//   ① Rust：SetMemoryUsageTargetLevel 存在且覆盖全部 webview 窗口
//   ② Rust：非强制的合成层自愈在窗口最小化时跳过（别再白抖整窗重绘）
//   ③ 前端：开关与启动恢复都会同步 /api/memory/target；CSS 削减 #preview will-change
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const repoFile = (...p) => {
  const f = path.join(ROOT, ...p);
  assert.ok(fs.existsSync(f), `缺少文件 ${path.join(...p)}`);
  return fs.readFileSync(f, "utf8");
};

test("MemoryTarget: Rust 实现 SetMemoryUsageTargetLevel 且遍历全部 webview 窗口", () => {
  const lib = repoFile("src-tauri", "src", "lib.rs");
  const fnIdx = lib.indexOf("pub fn set_memory_usage_target");
  assert.ok(fnIdx > 0, "lib.rs 缺少 set_memory_usage_target");
  const fn = lib.slice(fnIdx, lib.indexOf("// ── 系统托盘", fnIdx));
  assert.match(fn, /SetMemoryUsageTargetLevel/, "必须调用 SetMemoryUsageTargetLevel");
  assert.match(fn, /COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW/, "必须支持 LOW");
  assert.match(fn, /COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL/, "必须支持关闭时恢复 NORMAL");
  assert.match(fn, /webview_windows\(\)/, "必须遍历全部 webview 窗口（主窗口+截图/录屏共享 GPU 进程）");
  assert.match(fn, /cast::<ICoreWebView2_19>/, "必须经 ICoreWebView2_19 接口");
});

test("MemoryTarget: 新端点三处同步（handlers.rs + IPC_ROUTE_MAP + tauri 命令）", () => {
  const handlers = repoFile("src-tauri", "src", "handlers.rs");
  assert.match(handlers, /\.route\("\/api\/memory\/target", post\(memory_target\)\)/, "HTTP 路由未注册");
  const appJs = repoFile("public", "app.js");
  assert.match(appJs, /add\("POST", "\/api\/memory\/target",\s+"api_memory_target"/, "IPC_ROUTE_MAP 未注册");
  const lib = repoFile("src-tauri", "src", "lib.rs");
  assert.match(lib, /pub async fn api_memory_target/, "tauri 命令未定义");
  assert.match(lib, /tauri_cmd::api_memory_target/, "tauri 命令未注册进 invoke_handler");
});

test("MemoryTarget: 前端开关与启动恢复都同步运行时", () => {
  const appJs = repoFile("public", "app.js");
  const fnIdx = appJs.indexOf("function setLowGpuMode");
  assert.ok(fnIdx > 0, "缺少 setLowGpuMode");
  const fn = appJs.slice(fnIdx, appJs.indexOf("function setImmersiveEditing"));
  assert.match(fn, /\/api\/memory\/target/, "开关切换必须调用 /api/memory/target");
  assert.match(fn, /low:\s*state\.lowGpuMode/, "必须传当前开关状态");
  // 启动恢复：无论开关状态都调用一次（用户手动关闭过时也要恢复 NORMAL）
  const restoreIdx = appJs.indexOf("lowGpuMode restore failed");
  assert.ok(restoreIdx > 0, "缺少启动恢复点");
  const after = appJs.slice(restoreIdx, restoreIdx + 2000);
  assert.match(after, /\/api\/memory\/target/, "启动时必须把低显存状态同步到运行时");
});

test("MemoryTarget: 最小化时非强制合成层自愈跳过", () => {
  const lib = repoFile("src-tauri", "src", "lib.rs");
  const fnIdx = lib.indexOf("pub fn nudge_webview_composition");
  const fn = lib.slice(fnIdx, fnIdx + 3500);
  assert.match(fn, /is_minimized\(\)/, "必须检查最小化状态");
  // 跳过分支必须在 force 检查之后（force=true 不受限）
  const forceIdx = fn.indexOf("!force && win.is_minimized()");
  assert.ok(forceIdx > 0, "跳过条件必须带 !force（用户主动点「显示修复」不受限）");
});

test("MemoryTarget: 低显存 CSS 削减 #preview 常驻合成层", () => {
  const css = repoFile("public", "styles.css");
  assert.match(css, /body\.low-gpu-mode #preview\s*\{[^}]*will-change:\s*auto/, "低显存模式必须退回 #preview 的 will-change");
});
