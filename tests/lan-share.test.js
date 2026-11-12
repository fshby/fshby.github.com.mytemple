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
  // 注意 /source 走的是访客专用包装版（lan_serve_source：白名单闸门 + 无模糊扫描），
  // 桌面版 serve_source（跨工作区模糊扫描 + cloud_read_cors）绝不允许挂进访客路由。
  const forbidden = ["/api/delete", "/api/move", "/api/rename", "/api/copy", "/api/browse", "/api/agent", "/api/license", "/api/screenshot", "/api/upload", "/api/asset", "/api/import", "/api/export", "/api/ai", "/api/files", "/api/frontmatter", "/ws-asset"];
  for (const f of forbidden) {
    assert.ok(!body.includes(`"${f}`), `访客路由出现了禁止端点 ${f}`);
  }
  assert.ok(!body.includes("get(serve_source)"), "桌面版 serve_source 不允许挂访客路由（模糊扫描会跨工作区泄漏）");
  // 图片/媒体资产端点（访客版）：必须存在且用 lan 包装 handler
  assert.ok(body.includes('"/source/*path", get(lan_serve_source)'), "访客路由必须有 /source 资产端点且挂 lan_serve_source 包装版");
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
  // 回归锁（2026-11-12 真机端到端实测）：① 共享关闭后守卫必须 503 拒绝一切
  //（disable abort 只关监听，残留 keep-alive 连接仍在服务，不能放行）；
  // ② 访客静态白名单（含根路径）必须免 token，否则访客浏览器拿不到 PIN 门页面。
  assert.ok(guardBody.includes("is_enabled"), "lan_guard 必须先检查共享开关（关闭后 503 拒绝残留连接）");
  assert.ok(guardBody.includes("SERVICE_UNAVAILABLE"), "关闭态必须 503");
  assert.ok(guardBody.includes("LAN_STATIC_ALLOW"), "lan_guard 必须豁免访客静态白名单（否则 PIN 页拿不到）");
  // 豁免必须精确匹配白名单文件名（format! 逐字比对），不得用前缀放行
  assert.ok(guardBody.includes('path == format!("/{f}")'), "静态豁免必须按精确文件名匹配");
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
  const stateBody = src.slice(stateStart, src.indexOf("// ── 访客工作区白名单", stateStart));
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

test("LAN: 共享工作区白名单（后端执行点 + 桌面 UI）", () => {
  const lanRs = repoFile("src-tauri", "src", "lan.rs");
  assert.ok(lanRs.includes("shared_ws"), "lan.rs 缺少 shared_ws 白名单存储");
  assert.ok(lanRs.includes("pub async fn is_ws_allowed"), "缺少 is_ws_allowed");
  assert.ok(lanRs.includes("pub async fn set_workspaces"), "缺少 set_workspaces");
  assert.ok(lanRs.includes('"workspaces"'), "lan-share.json 持久化必须包含 workspaces 字段");
  const handlers = repoFile("src-tauri", "src", "handlers.rs");
  for (const fn of ["lan_get_workspaces", "lan_get_tree", "lan_get_doc", "lan_check_doc", "lan_search", "lan_save", "lan_create_doc", "lan_create_folder", "lan_ws_gate", "lan_set_workspaces"]) {
    assert.ok(handlers.includes(`async fn ${fn}`), `handlers.rs 缺少访客包装 handler ${fn}`);
  }
  // 白名单外一律 404（不泄露存在性）
  const gateStart = handlers.indexOf("async fn lan_ws_gate");
  const gateBody = handlers.slice(gateStart, handlers.indexOf("async fn lan_filter_ws_array", gateStart));
  assert.ok(gateBody.includes("NOT_FOUND"), "白名单外工作区必须 404（不泄露存在性）");
  // 访客路由必须挂包装版（不能回落主通道 handler）
  const routerStart = handlers.indexOf("pub fn build_lan_router");
  const routerBody = handlers.slice(routerStart, handlers.indexOf("pub fn build_native_router", routerStart));
  for (const route of ['"/api/workspaces", get(lan_get_workspaces)', '"/api/tree", get(lan_get_tree)', '"/api/doc", get(lan_get_doc)', '"/api/save", post(lan_save)']) {
    assert.ok(routerBody.includes(route), `访客路由必须挂 lan 包装版：${route}`);
  }
  // 桌面 UI
  const indexHtml = repoFile("public", "index.html");
  assert.ok(indexHtml.includes('id="lanWsList"'), "设置面板缺少共享工作区多选列表");
  assert.ok(indexHtml.includes("lan-switch"), "LAN 开关需要自定义滑动样式（裸 checkbox 无勾选视觉）");
  const appJs = repoFile("public", "app.js");
  assert.ok(appJs.includes("lanUnwrap"), "app.js 必须解包 /api/lan/* 的 ApiResponse 包装层（否则开关弹回、地址恒「—」）");
  assert.ok(appJs.includes("/api/lan/workspaces"), "app.js 缺少共享范围设置调用");
  assert.ok(appJs.includes('classList.toggle("hidden", !s.enabled)'), "info 显隐必须用 .hidden 类（HTML hidden 属性会被 CSS 覆盖）");
});

// 环境自检：本机（Windows 工作区）应有 lan-share.json 的 data_root 写入路径约定
test("LAN: lan-share.json 持久化文件名固定", () => {
  const src = repoFile("src-tauri", "src", "lan.rs");
  assert.ok(src.includes('join("lan-share.json")'), "lan.rs 必须持久化 lan-share.json");
  assert.ok(os.platform() !== "win32" || src.includes("lan_ips"), "lan.rs 缺少局域网 IP 探测");
});

// ══ 2026-11-12：访客页对齐桌面端（预览视图 / 图片 / 侧栏折叠）════════════

test("LAN: /source 访客资产端点安全收紧（白名单闸门 + 无模糊扫描 + 防穿越）", () => {
  const src = repoFile("src-tauri", "src", "handlers.rs");
  const start = src.indexOf("async fn lan_serve_source");
  assert.ok(start > 0, "缺少 lan_serve_source");
  const body = src.slice(start, src.indexOf("async fn lan_save", start));
  assert.ok(body.includes("is_ws_allowed"), "必须校验共享工作区白名单（未共享工作区资产不得 404 之外的响应）");
  // 桌面版的跨工作区模糊扫描会泄漏未共享工作区的同名图片，访客版禁止
  assert.ok(!body.includes("read_dir"), "访客版不得做跨工作区模糊扫描（泄漏面不可控）");
  assert.ok(!body.includes("data_root"), "访客版不得读 data_root 全局资产");
  // 防路径穿越 / Windows 盘符（PathBuf::join 遇绝对路径会整体替换前缀）
  assert.ok(body.includes('".."'), "必须拒绝 .. 穿越");
  assert.ok(body.includes("':'"), "必须拒绝盘符冒号");
  assert.ok(body.includes("'\\\\'"), "必须拒绝反斜杠");
});

test("LAN: 访客静态放行 vendor/ 与 markdown-worker.js（预览管线依赖）+ 防穿越", () => {
  const src = repoFile("src-tauri", "src", "handlers.rs");
  const start = src.indexOf("async fn lan_fallback");
  const body = src.slice(start, start + 2200);
  assert.ok(body.includes('name == "markdown-worker.js"'), "访客预览渲染需要 markdown-worker.js");
  assert.ok(body.includes('name.starts_with("vendor/")'), "访客预览需要 vendor/ 子树（KaTeX/Mermaid/hljs 自托管库）");
  // 放行范围扩大后，路径穿越防护必须先行（名称含 .. : \ 一律 404）
  const guardIdx = body.indexOf('name.contains("..")');
  const vendorIdx = body.indexOf('name.starts_with("vendor/")');
  assert.ok(guardIdx > 0 && vendorIdx > 0 && guardIdx < vendorIdx, "穿越防护必须先于 vendor 放行判断");
  assert.ok(body.includes("woff2"), "KaTeX 字体 woff2 需要 mime");
  // 主应用入口仍然不可达（vendor 放行是目录级的，不含根级文件）
  const lanRs = repoFile("src-tauri", "src", "lan.rs");
  const constBody = lanRs.slice(lanRs.indexOf("pub const LAN_STATIC_ALLOW"), lanRs.indexOf("];", lanRs.indexOf("pub const LAN_STATIC_ALLOW")));
  for (const banned of ["app.js", "index.html"]) {
    assert.ok(!constBody.includes(banned), `静态白名单不允许 ${banned}`);
  }
});

test("LAN: guest.html/guest.js 有编辑/预览双视图与完整预览管线", () => {
  const html = repoFile("public", "guest.html");
  assert.ok(html.includes('id="viewToggle"') && html.includes('id="editViewBtn"') && html.includes('id="previewViewBtn"'), "缺少视图切换控件");
  assert.ok(html.includes('id="readerHost"') && html.includes('id="markdownView"') && html.includes('markdown-body'), "缺少预览阅读区");
  assert.ok(html.includes("/vendor/highlight") === false, "hljs 由 guest.js 按需加载，html 里不预载");

  const js = repoFile("public", "guest.js");
  // 预览管线五件套：worker / KaTeX / Mermaid（含塌缩防护）/ hljs / 图片改写
  assert.ok(js.includes("/markdown-worker.js?v=") && js.includes("&assets=/vendor/"), "必须用同源 worker + vendor 资产");
  assert.ok(js.includes("mt-html-frame-height"), "必须监听沙箱帧高度上报");
  assert.ok(js.includes("HTML_FRAME_MAX_HEIGHT = 200000"), "沙箱帧高度上限必须三端同值 200000");
  assert.ok(js.includes("renderMathInPreview"), "必须有 KaTeX 公式渲染");
  assert.ok(js.includes("loadMermaidAsync") && js.includes("renderMermaidSerialized"), "必须有 Mermaid 渲染");
  // Mermaid 塌缩防护与桌面端同源（页面隐藏期间渲染 → 布局压成一条线）
  assert.ok(js.includes("waitUntilChartsPageVisible"), "渲染前必须等页面可见（后台标签页渲染会塌缩）");
  assert.ok(js.includes("mermaidMeasurementDegenerate"), "必须有自测量塌缩检测");
  assert.ok(js.includes("rewriteMediaSrc"), "必须有图片/视频相对路径改写");
  assert.ok(js.includes("highlightCodeBlocks") && js.includes("highlight.min.js"), "必须有 hljs 代码高亮");
  // 只读共享默认进预览（访客主要场景是阅读）
  assert.ok(js.includes('state.readOnly ? "preview" : "edit"'), "只读共享应默认预览视图");
});

test("LAN: guest.css 侧栏折叠在所有宽度生效（「目录不能隐藏」回归锁）", () => {
  const css = repoFile("public", "guest.css");
  const collapsedIdx = css.indexOf(".sidebar.collapsed");
  assert.ok(collapsedIdx > 0, "缺少 .sidebar.collapsed 规则");
  const mediaIdx = css.indexOf("@media");
  assert.ok(mediaIdx > collapsedIdx, ".sidebar.collapsed 必须在 @media 之外（全局生效；旧实现只在窄屏生效）");
  // 折叠用 display:none（语义上直接隐藏，不参与布局）
  const rule = css.slice(collapsedIdx, css.indexOf("}", collapsedIdx));
  assert.ok(rule.includes("display: none"), "折叠必须 display:none");
  // 配色必须引用主应用 tokens（观感对齐桌面端）
  assert.ok(css.includes("var(--accent"), "配色必须使用主应用 accent token");
  assert.ok(css.includes("var(--bg"), "背景必须使用主应用 bg token");
});
