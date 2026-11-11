// lan-share.test.js — 局域网共享静态结构回归
//
// 行为级验证（PIN 限速 / token / 白名单外 404）需要真桌面应用在跑，
// 用 .verify/lan-share-check.cjs 对本机 127.0.0.1:7321 实测；
// 这里锁住「结构层」的三道安全边界，防止回归：
//   ① 访客通道路由白名单：不出现删除/移动/重命名/浏览/Agent 等敏感端点
//   ② 访客静态资源白名单：不暴露主应用入口 / 云端模块
//   ③ 访客前端（guest.js）不调用任何白名单外的 API
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const readFile = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// CI（linux）下 public/ 与 src-tauri/ 都在仓库里，直接读
function repoFile(...p) {
  const f = path.join(ROOT, ...p);
  assert.ok(fs.existsSync(f), `缺少文件 ${path.join(...p)}`);
  return readFile(...p);
}

test("LAN: 访客通道路由白名单不含敏感端点", () => {
  const src = repoFile("src-tauri", "src", "handlers.rs");
  const start = src.indexOf("pub fn build_lan_router");
  assert.ok(start > 0, "handlers.rs 缺少 build_lan_router");
  const end = src.indexOf("}", src.indexOf(".with_state(state)", start));
  const body = src.slice(start, end);

  // 必须存在的白名单端点
  for (const route of ["/api/lan/verify", "/api/lan/state", "/api/workspaces", "/api/tree", "/api/doc", "/api/doc-check", "/api/search", "/api/save", "/api/create-doc", "/api/create-folder"]) {
    assert.ok(body.includes(`"${route}"`), `访客路由缺少白名单端点 ${route}`);
  }
  // 绝不允许出现的敏感端点（删除/移动/重命名/浏览/Agent/授权/截图/上传/云端资产）
  const forbidden = ["/api/delete", "/api/move", "/api/rename", "/api/copy", "/api/browse", "/api/agent", "/api/license", "/api/screenshot", "/api/upload", "/api/asset", "/api/import", "/api/export", "/api/ai", "/api/files", "/api/frontmatter", "/ws-asset", "/source/"];
  for (const f of forbidden) {
    assert.ok(!body.includes(`"${f}`), `访客路由出现了禁止端点 ${f}`);
  }
});

test("LAN: lan_guard 无 token 必须 401 且 verify 免 token", () => {
  const src = repoFile("src-tauri", "src", "handlers.rs");
  const guardStart = src.indexOf("pub async fn lan_guard");
  assert.ok(guardStart > 0, "缺少 lan_guard 中间件");
  const guardBody = src.slice(guardStart, src.indexOf("async fn lan_fallback", guardStart));
  assert.ok(guardBody.includes("/api/lan/verify"), "lan_guard 必须放行 /api/lan/verify（否则访客永远配不上对）");
  assert.ok(guardBody.includes("check_token"), "lan_guard 必须校验 token");
  assert.ok(guardBody.includes("UNAUTHORIZED"), "无 token 必须返回 401");
  assert.ok(guardBody.includes("FORBIDDEN"), "只读模式写入必须 403");
  // 只读写入端点集合
  const writeStart = src.indexOf("const LAN_WRITE_ROUTES");
  const writeBody = src.slice(writeStart, src.indexOf("];", writeStart));
  assert.ok(writeBody.includes('"/api/save"'), "只读集合必须包含 /api/save");
  assert.ok(writeBody.includes('"/api/create-doc"') && writeBody.includes('"/api/create-folder"'), "只读集合必须包含新建端点");
});

test("LAN: 访客协议端点（verify/state）必须平铺返回，不得包 ApiResponse", () => {
  // 回归锁（2026-11-11 真机实测发现的 bug）：lan_verify / lan_guest_state 此前用
  // json_ok 包了一层 {ok, data:{...}}，而 guest.js 按平铺协议读 data.token /
  // s.readOnly —— 真机上输对口令也进不去访客页、只读判断恒失效。
  const src = repoFile("src-tauri", "src", "handlers.rs");
  const verifyStart = src.indexOf("async fn lan_verify");
  const verifyBody = src.slice(verifyStart, src.indexOf("async fn lan_guest_state", verifyStart));
  assert.ok(verifyBody.includes("raw_json"), "lan_verify 成功响应必须 raw_json 平铺");
  assert.ok(!verifyBody.includes("json_ok"), "lan_verify 不得用 json_ok 包装");
  const stateStart = src.indexOf("async fn lan_guest_state");
  const stateBody = src.slice(stateStart, src.indexOf("async fn lan_enable", stateStart));
  assert.ok(stateBody.includes("raw_json"), "lan_guest_state 成功响应必须 raw_json 平铺");
  assert.ok(!stateBody.includes("json_ok"), "lan_guest_state 不得用 json_ok 包装");
  // guest.js 按平铺协议读（护栏：改协议必须两端同步）
  const guest = repoFile("public", "guest.js");
  assert.ok(guest.includes("data.ok && data.token"), "guest.js 配对读取 data.token（平铺协议）");
  assert.ok(guest.includes("s && s.readOnly"), "guest.js 会话态读取 s.readOnly（平铺协议）");
});

test("LAN: 访客静态白名单不暴露主应用与云端模块", () => {
  const src = repoFile("src-tauri", "src", "lan.rs");
  const start = src.indexOf("pub const LAN_STATIC_ALLOW");
  const body = src.slice(start, src.indexOf("];", start));
  for (const banned of ["app.js", "index.html", "cloud-", "share", "privacy", "splash", "recorder", "screenshot", "graph-worker", "markdown-worker", "cloud-config"]) {
    assert.ok(!body.includes(banned), `访客静态白名单不允许出现 ${banned}`);
  }
  for (const needed of ["guest.html", "guest.js", "guest.css", "editor-core.js", "styles.css"]) {
    assert.ok(body.includes(`"${needed}"`), `访客静态白名单缺少 ${needed}`);
  }
});

test("LAN: guest.js 不调用白名单外 API 且带 token 头", () => {
  const src = repoFile("public", "guest.js");
  assert.ok(src.includes("X-Lan-Token"), "guest.js 请求必须带 X-Lan-Token");
  const forbidden = ["/api/delete", "/api/move", "/api/rename", "/api/copy", "/api/browse", "/api/agent", "/api/license", "/api/screenshot", "/api/upload", "/api/asset", "/api/ai", "/api/files"];
  for (const f of forbidden) {
    assert.ok(!src.includes(f), `guest.js 调用了禁止端点 ${f}`);
  }
  // 保存冲突处理必须存在（乐观锁语义）
  assert.ok(src.includes("conflict"), "guest.js 必须处理保存冲突");
  assert.ok(src.includes("baseHash"), "guest.js 保存必须带 baseHash");
});

test("LAN: guest.html 有 CSP 且无外链资源", () => {
  const src = repoFile("public", "guest.html");
  assert.ok(src.includes("Content-Security-Policy"), "guest.html 必须有 CSP");
  assert.ok(src.includes("default-src 'self'"), "CSP 必须 default-src 'self'");
  assert.ok(!src.includes("https://"), "guest.html 不允许任何外链（CSP self 也拦，但结构上就杜绝）");
  assert.ok(src.includes('id="gate"') && src.includes('id="pinInput"'), "必须保留 PIN 配对门");
  assert.ok(!src.includes("allow-same-origin"), "不得出现 allow-same-origin");
});

test("LAN: 管理端点只挂回环主通道", () => {
  const src = repoFile("src-tauri", "src", "handlers.rs");
  const start = src.indexOf("pub fn build_native_router");
  const body = src.slice(start, src.indexOf("pub fn build_lan_router", start));
  for (const route of ["/api/lan/status", "/api/lan/enable", "/api/lan/disable", "/api/lan/mode", "/api/lan/regenerate-pin"]) {
    assert.ok(body.includes(`"${route}"`), `回环通道缺少管理端点 ${route}`);
  }
});

test("LAN: 桌面设置面板与持久化配置存在", () => {
  const indexHtml = repoFile("public", "index.html");
  assert.ok(indexHtml.includes('data-settings-tab="lan"') && indexHtml.includes('data-settings-panel="lan"'), "设置面板缺少局域网共享页签");
  assert.ok(indexHtml.includes('id="lanShareToggle"'), "缺少共享开关");
  const appJs = repoFile("public", "app.js");
  for (const route of ["/api/lan/status", "/api/lan/enable", "/api/lan/disable", "/api/lan/mode", "/api/lan/regenerate-pin"]) {
    assert.ok(appJs.includes(`"${route}"`) || appJs.includes(`'${route}'`), `app.js 缺少 ${route} 调用`);
  }
  const libRs = repoFile("src-tauri", "src", "lib.rs");
  assert.ok(libRs.includes("pub mod lan;"), "lib.rs 未注册 lan 模块");
  assert.ok(libRs.includes("autostart"), "lib.rs 缺少开机自启动调用");
  const appRs = repoFile("src-tauri", "src", "app.rs");
  assert.ok(appRs.includes("lan: Arc<crate::lan::LanShareState>"), "AppState 缺少 lan 字段");
});

// 环境自检：本机（Windows 工作区）应有 lan-share.json 的 data_root 写入路径约定
test("LAN: lan-share.json 持久化文件名固定", () => {
  const src = repoFile("src-tauri", "src", "lan.rs");
  assert.ok(src.includes('join("lan-share.json")'), "lan.rs 必须持久化 lan-share.json");
  assert.ok(os.platform() !== "win32" || src.includes("lan_ips"), "lan.rs 缺少局域网 IP 探测");
});
