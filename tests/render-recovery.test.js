/* 渲染自愈回归锁（v2.3.9）
 *
 * 背景：用户在 v2.3.9 实测「启动后主界面整体不绘制，只剩主题背景与角落浮层」——
 * DOM 全部健康（computed style 可见、尺寸正常），startupGuard watchdog 因此判定无异常
 * 不弹浮层，这是 DOM 探针的原理性盲区：页面内无法感知「合成层未把画面送上去」。
 *
 * 修复：Rust 侧 nudge_webview_composition 抖动 WebView2 控件 bounds（1px 往返），
 * 强制整棵视觉树重新合成；配合启动期/聚焦/DPI 事件自动触发，以及用户可见的
 * #renderFixBtn（5 秒内二次点击 = reload 兜底）。
 *
 * 本文件锁「契约」（防止回退），行为验证在 .verify/render-recovery-check.cjs。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8").replace(/\r\n/g, "\n");

const html = read("public/index.html");
const app = read("public/app.js");
const lib = read("src-tauri/src/lib.rs");
const handlers = read("src-tauri/src/handlers.rs");
const cargo = read("src-tauri/Cargo.toml");
const layer = read("frontend/styles/05-fallback-density.css");
const css = read("public/styles.css");

// app.js 里 renderFixBtn 接线块
const fixBlock = app.slice(app.indexOf("显示修复（渲染自愈）"), app.indexOf("els.renderFixBtn.addEventListener") + 900);
// index.html 里内联启动护栏脚本
const scriptStart = html.indexOf("// 启动护栏：全局错误捕获");
const guardScript = html.slice(scriptStart, html.indexOf("</script>", scriptStart));

test("① Rust：nudge 实现抖动 WebView2 bounds（1px 往返），非窗口级操作", () => {
  assert.match(lib, /pub fn nudge_webview_composition\(app: &tauri::AppHandle, force: bool\) -> bool/,
    "函数签名必须带 force 去抖参数");
  assert.match(lib, /with_webview/, "必须走 with_webview（webview 级，不影响窗口最大化状态）");
  assert.match(lib, /controller\.Bounds\(&mut rect\)/, "必须先读当前 bounds");
  assert.match(lib, /right: rect\.right \+ 1/, "必须 +1px 抖动");
  assert.match(lib, /controller\.SetBounds\(bumped\)[\s\S]*controller\.SetBounds\(rect\)/,
    "必须抖完立即复原");
  assert.match(lib, /LAST_NUDGE_MS/, "必须带去抖（聚焦事件可能连续触发）");
  assert.doesNotMatch(lib.slice(lib.indexOf("pub fn nudge_webview_composition"), lib.indexOf("// ── 系统托盘")),
    /set_size|set_inner_size/, "不得抖窗口尺寸（会破坏最大化状态）");
});

test("② Rust：自动触发覆盖启动、聚焦恢复与 DPI 变化", () => {
  assert.match(lib, /create_main_window[\s\S]*Focused\(true\) \| tauri::WindowEvent::ScaleFactorChanged/s,
    "聚焦恢复与 DPI 变化必须触发自愈");
  assert.match(lib, /std::thread::sleep\(std::time::Duration::from_millis\(2500\)\);[\s\S]*nudge_webview_composition\(&h, true\)/s,
    "启动后 2.5s 必须主动自愈一次（force=true 跳过去抖）");
});

test("③ Rust：tauri 命令与 HTTP 端点双通道注册（三处同步）", () => {
  assert.match(lib, /pub async fn api_window_nudge\(app_handle: tauri::AppHandle\)/, "缺少 tauri 命令");
  assert.match(lib, /tauri_cmd::api_window_nudge,/, "generate_handler 必须注册命令");
  assert.match(handlers, /\.route\("\/api\/window\/nudge", post\(window_nudge\)\)/, "缺少 axum 路由");
  assert.match(handlers, /async fn window_nudge\(\) -> impl IntoResponse \{[\s\S]*crate::APP_HANDLE\.get\(\)[\s\S]*nudge_webview_composition\(app_handle, true\)/s,
    "HTTP 端点必须走同一自愈函数");
  assert.match(app, /add\("POST", "\/api\/window\/nudge",\s+"api_window_nudge"/, "IPC_ROUTE_MAP 必须同步");
  // 依赖版本必须与依赖链同源，否则 ICoreWebView2Controller 类型不一致编译不过
  assert.match(cargo, /\[target\."cfg\(windows\)"\.dependencies\][\s\S]*webview2-com = "0\.38"[\s\S]*windows = \{ version = "0\.61"/s,
    "Cargo.toml 必须显式声明与 lock 同源的 webview2-com / windows");
});

test("④ 前端：#renderFixBtn 常驻且位于咖啡按钮上方", () => {
  assert.match(html, /id="renderFixBtn" class="coffee-button render-fix-button"/, "按钮必须存在并复用 fixed 骨架");
  assert.match(css, /\.render-fix-button\s*\{/, "样式必须在产物中");
  assert.match(layer, /\.render-fix-button\s*\{/, "样式必须在层源文件中");
  const m = css.match(/\.render-fix-button\s*\{[^}]*\}/s)[0];
  assert.match(m, /bottom:\s*76px/, "必须位于咖啡按钮（生效几何 bottom 20 + 46 + 10）正上方");
  assert.match(m, /background:\s*var\(--control-bg\)/, "必须用中性色与咖啡按钮区分");
});

test("⑤ 前端：一次自愈、二次 reload 的两段式语义", () => {
  assert.match(fixBlock, /fetch\("\/api\/window\/nudge"[\s\S]*method: "POST"/s, "首次点击必须请求自愈端点");
  assert.match(fixBlock, /now - renderFixLastAt > 5000/, "必须用 5 秒窗口区分两段语义");
  assert.match(fixBlock, /已强制界面重绘，若仍空白请在 5 秒内再次点击刷新页面/, "自愈后必须提示用户");
  assert.match(fixBlock, /window\.location\.reload\(\)/, "二次点击必须 reload 兜底");
  assert.match(fixBlock, /sessionStorage\.setItem\("mtStartupReload", "0"\)/,
    "手动 reload 前清零自动重试计数，避免与启动护栏互相干扰");
});

test("⑥ 启动护栏恢复流程同时请求 Rust 自愈（覆盖 DOM 探针盲区）", () => {
  const recover = guardScript.slice(guardScript.indexOf("__recoverRender = function"), guardScript.indexOf("function showStartupError"));
  assert.match(recover, /fetch\("\/api\/window\/nudge"/, "一键恢复必须触发原生自愈");
  assert.match(recover, /DOM 探针发现不了/, "必须留有盲区说明（防回退注释）");
  assert.match(recover, /__forceContentRepaint/, "一键恢复必须先做内容级强制提交");
});

test("⑦ 内容级强制提交（v2.3.11）：__forceContentRepaint 定义且被按钮路径调用", () => {
  assert.match(guardScript, /window\.__forceContentRepaint = function/, "护栏脚本必须定义内容级重绘");
  const fn = guardScript.slice(guardScript.indexOf("window.__forceContentRepaint = function"), guardScript.indexOf("window.__forceContentRepaint = function") + 400);
  assert.match(fn, /willChange = "transform"/, "必须用 will-change 建层制造布局事件");
  assert.match(fn, /willChange = ""/, "建层后必须立即销毁（不留常驻 GPU 层）");
  assert.match(fn, /void b\.offsetWidth/, "必须同步 flush 布局");
  assert.match(fixBlock, /window\.__forceContentRepaint\(\)/, "显示修复按钮必须先本地做内容级重绘");
});

test("⑧ Rust：自愈升级为表面+失同步+内容三连，挂钩页面就绪与周期兜底", () => {
  assert.match(lib, /controller\.NotifyParentWindowPositionChanged\(\)/,
    "必须调用 WebView2 官方位置失同步修复（bounds 抖动救不回的实测场景）");
  assert.match(lib, /window\.__forceContentRepaint/, "nudge 必须 eval 内容级强制提交");
  assert.match(lib, /fn schedule_page_load_nudge/, "必须有页面就绪自愈挂钩");
  assert.match(lib, /schedule_page_load_nudge\(window\)/, "on_page_load 两条路径都必须调度");
  assert.match(lib, /Duration::from_secs\(45\)/, "必须有周期性静默兜底（虚拟显示器翻转可能无窗口事件）");
  // eval 只允许调护栏函数本身，不得执行其它任意注入
  assert.match(lib, /"try\{ if \(window\.__forceContentRepaint\) window\.__forceContentRepaint\(\); \}catch\(e\)\{\}"/,
    "eval 注入串必须与护栏函数精确匹配");
});
