// 回归测试：PC ↔ 云端 贯通（只读白名单 CORS）+ Android 客户端工程
//
// 背景：云服务强制「请求来源 == 应用发布域名」（精确 Origin 校验），
// 桌面 WebView 的源是 http://127.0.0.1:<port>，不在白名单内 —— 桌面端无法直接上传。
// 解法是：桌面端「云端」面板带 ?local=http://127.0.0.1:<port> 打开云端工作台，
// 由工作台（Origin 就是白名单域名）去读本机**只读**接口，再上传到云端。
//
// 这里锁住的是「改错了也不报错、但会静默破坏安全」的契约：
//   - 本机只对**唯一一个**来源开放，且只挂在三个只读 GET 端点上，写端点一律不开放；
//   - 必须回 Access-Control-Allow-Private-Network，否则 Chrome PNA 会拦掉预检；
//   - 云端应用只允许读本机，绝不向本机发写请求；
//   - APK 必须走 server.url 远程加载（不能用 hostname 覆盖，否则 API 被本地资源拦截）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
const exists = (rel) => existsSync(new URL(rel, ROOT));

const handlersRs = read("src-tauri/src/handlers.rs");
const cloudApp = read("cloud/app.js");
const cloudHtml = read("cloud/index.html");
const cloudSyncJs = read("public/modules/cloud-sync.js");
const rootGitignore = read(".gitignore");

/** 取某个名称的函数体（按大括号配平，跳过字符串/注释里的花括号）。 */
function fnBody(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `未找到 ${marker}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let i = open;
  let mode = null; // null | "'" | '"' | "`" | "//" | "/*"
  for (; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "//") { if (c === "\n") mode = null; continue; }
    if (mode === "/*") { if (c === "*" && n === "/") { mode = null; i += 1; } continue; }
    if (mode) {
      if (mode === "`" && c === "\\") { i += 1; continue; }
      if (c === mode) mode = null;
      continue;
    }
    if (c === "/" && n === "/") { mode = "//"; i += 1; continue; }
    if (c === "/" && n === "*") { mode = "/*"; i += 1; continue; }
    if (c === '"' || c === "'" || c === "`") { mode = c; continue; }
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`${marker} 花括号不配对`);
}

/* ══ 一、本机只读白名单 CORS（Rust 侧）══════════════════════════ */

test("跨源放行只认唯一一个来源，不使用通配", () => {
  assert.match(
    handlersRs,
    /const CLOUD_WORKBENCH_ORIGIN: &str = "https:\/\/mytemple-cloud\.app\.workbuddy\.host";/,
    "必须把云端工作台域名写成常量",
  );
  const body = fnBody(handlersRs, "fn apply_cloud_cors_headers");
  assert.doesNotMatch(body, /"\*"/, "Access-Control-Allow-Origin 不得为通配 *");
  assert.match(body, /ACCESS_CONTROL_ALLOW_ORIGIN/, "必须设置 Allow-Origin");
  assert.match(body, /ACCESS_CONTROL_ALLOW_METHODS/, "必须限定方法");
  assert.match(body, /"GET, OPTIONS"/, "只允许 GET 与预检 OPTIONS");
});

test("必须回 Access-Control-Allow-Private-Network（否则 Chrome PNA 拦掉预检）", () => {
  const body = fnBody(handlersRs, "fn apply_cloud_cors_headers");
  assert.match(
    body,
    /access-control-allow-private-network[\s\S]*?HeaderValue::from_static\("true"\)/,
    "公网页面访问 127.0.0.1 会被私有网络访问策略拦截，必须显式同意",
  );
});

test("来源不匹配时不加任何 CORS 头（桌面自身行为逐字节不变）", () => {
  const body = fnBody(handlersRs, "async fn cloud_read_cors");
  assert.match(body, /let allowed = origin\.as_deref\(\) == Some\(CLOUD_WORKBENCH_ORIGIN\);/);
  assert.match(body, /if allowed \{\s*apply_cloud_cors_headers\(&mut res, CLOUD_WORKBENCH_ORIGIN\);/);
  // 预检短路：OPTIONS 直接 204，不进业务处理
  assert.match(body, /Method::OPTIONS/);
  assert.match(body, /StatusCode::NO_CONTENT/);
});

test("只读中间件只挂在三个只读 GET 端点上，写端点一律不挂", () => {
  const occurrences = [...handlersRs.matchAll(/layer\(axum::middleware::from_fn\(cloud_read_cors\)\)/g)];
  assert.equal(occurrences.length, 3, `cloud_read_cors 应恰好挂 3 处，实测 ${occurrences.length}`);

  // 三处都必须挂在 get(...) 上
  for (const m of occurrences) {
    const lineStart = handlersRs.lastIndexOf("\n", m.index);
    const line = handlersRs.slice(lineStart, m.index + m[0].length);
    assert.match(line, /get\((get_workspaces|list_files|read_file)\)/, `挂载点必须是只读 handler：${line.trim()}`);
  }
  for (const [path, handler] of [
    ["/api/workspaces", "get_workspaces"],
    ["/api/files", "list_files"],
    ["/api/files/*path", "read_file"],
  ]) {
    assert.match(
      handlersRs,
      new RegExp(`"${path.replace(/[/*]/g, (c) => "\\" + c)}",\\s*\\n\\s*get\\(${handler}\\)\\.layer\\(axum::middleware::from_fn\\(cloud_read_cors\\)\\)`),
      `${path} 应挂只读放行`,
    );
  }
  // 写端点绝对不能出现这个层
  for (const writeHandler of ["save_file", "save_doc", "delete_file", "delete_docs", "move_entry", "upload_asset"]) {
    const routeLine = handlersRs
      .split("\n")
      .find((l) => l.includes(writeHandler) && l.includes(".route(")) || "";
    assert.doesNotMatch(routeLine, /cloud_read_cors/, `${writeHandler} 不得挂跨源放行：${routeLine.trim()}`);
  }
});

/* ══ 二、云端应用只读本机（JS 侧）═══════════════════════════════ */

test("?local= 只接受本机回环地址 + 数字端口，其余一律拒绝", () => {
  assert.match(cloudApp, /const LOCAL_ORIGIN_RE = \/\^http:\\\/\\\/\(\?:127\\\.0\\\.0\\\.1\|localhost\):\(\\d\{1,5\}\)\$\/;/);
  const body = fnBody(cloudApp, "function localOrigin()");
  assert.match(body, /LOCAL_ORIGIN_RE\.test\(raw\)/, "必须走严格正则");
  assert.match(body, /port >= 1 && port <= 65535/, "端口必须落在合法区间");
  assert.doesNotMatch(body, /LOCAL_ORIGIN_RE = \/\^http:\\\/\\\//, "不得放宽到任意 http 源");
});

test("本机交互全部是 GET 读取，不向本机发任何写请求", () => {
  const body = fnBody(cloudApp, "async function localGet");
  assert.doesNotMatch(body, /method:\s*"(POST|PUT|PATCH|DELETE)"/i, "只读接口不得带写方法");
  assert.match(body, /cache: "no-store"/, "本机读取必须绕开缓存");
  // 本机路径只出现三个只读端点
  const paths = [...cloudApp.matchAll(/localGet\(\s*(?:LOCAL_ORIGIN|origin)\s*,\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 3, `应至少调用 3 次本机只读接口，实测 ${paths.length}`);
  for (const p of paths) {
    assert.ok(
      /^\/api\/(workspaces|files)(\/|$)/.test(p),
      `本机只读路径不得超出白名单：${p}`,
    );
  }
  assert.doesNotMatch(cloudApp, /fetch\(\s*LOCAL_ORIGIN[\s\S]{0,80}?method:/, "不得向本机发起带方法的请求");
});

test("从本机导入：索引解包正确、按工作区过滤、只取文本类文件", () => {
  const body = fnBody(cloudApp, "async function readLocalIndex");
  assert.match(body, /wsRes\.workspaces/, "工作区列表取 .workspaces");
  assert.match(body, /wsRes\.defaultWorkspaceId/, "优先取默认工作区");
  assert.match(body, /filesRes\.data/, "文件列表是 {ok,data:[…]}，必须解包 .data");
  assert.match(body, /TEXT_EXT\.test/, "只收 Markdown / 文本");
  assert.match(body, /f\.workspace_id === def\.id/, "必须按工作区过滤，避免串到别的库");
});

test("从本机导入：指纹一致直接跳过，读取才用正文；只提交有变化的", () => {
  assert.match(cloudApp, /function relFromRef\(ref, wsId\)/, "FileEntry.path 形如 <wsId>/<相对路径>，要剥前缀");
  const body = fnBody(cloudApp, "async function runLocalImport");
  assert.match(body, /have\.get\(rel\) === f\.content_sha256/, "本机已给指纹，一致就跳过（连正文都不读）");
  assert.match(body, /candidates\.push\(\{ relPath: rel, text, mtime: entry\.modified \|\| null \}\)/, "带 mtime 便于云端侧比对");
  assert.match(body, /\.select\("rel_path, content_sha"\)/, "先取云端指纹再决定传什么");
  assert.doesNotMatch(body, /\.delete\(\)|\.insert\(|\.update\(/, "本机导入流程不得直接操作云端表（交给 runUpload 统一 upsert）");
});

test("从本机导入失败时给出可操作的提示（桌面端需运行 + 同一台电脑）", () => {
  const body = fnBody(cloudApp, "async function runLocalImport");
  assert.match(body, /桌面端正在运行/, "必须提示桌面端需运行");
  assert.match(body, /同一台电脑/, "必须提示需在同一台电脑上打开");
  // 页面里必须真的有这块 UI，且默认隐藏（只在带 ?local= 时才显示）
  assert.match(cloudHtml, /id="localImport"[^>]*hidden/, "一键推送块默认隐藏");
  assert.match(cloudHtml, /id="localImportBtn"/, "需要触发按钮");
  assert.match(cloudHtml, /id="localImportNote"/, "需要状态提示位");
  assert.match(cloudApp, /el\.localImport\.hidden = false/, "仅在带 ?local= 时显示");
});

/* ══ 三、桌面入口 ═══════════════════════════════════════════════ */

test("桌面入口的「一键推送」带上本机端口，普通打开不带", () => {
  const body = fnBody(cloudSyncJs, "async function openWorkbench");
  assert.match(body, /withLocal/, "必须有「是否带本机地址」的开关");
  assert.match(body, /\?local=\$\{encodeURIComponent\(`http:\/\/127\.0\.0\.1:\$\{localPort\(\)\}`\)\}/, "必须带 ?local=<本机回环地址>");
  assert.match(body, /_blank/, "仍走系统浏览器打开（Origin 才是白名单域名）");
  const portFn = fnBody(cloudSyncJs, "function localPort()");
  assert.match(portFn, /window\.location\.port/, "端口必须取自 WebView 真实端口，不能写死");
  assert.match(cloudSyncJs, /data-act="push"/, "必须有「一键推送到云端」按钮");
  assert.match(cloudSyncJs, /if \(act === "push"\) openWorkbench\(true\)/, "按钮必须真的带本机地址打开");
});

test("桌面入口读取 /api/files 必须解包 ok/data（曾漏解包导致篇数恒为空）", () => {
  const body = fnBody(cloudSyncJs, "async function gatherFacts");
  assert.match(body, /Array\.isArray\(files\?\.data\) \? files\.data/, "/api/files 是 {ok,data:[…]}");
  // /api/workspaces 是裸对象，不能再往下解一层
  assert.match(body, /Array\.isArray\(ws\?\.workspaces\)/, "/api/workspaces 返回裸对象");
  assert.doesNotMatch(body, /ws\?\.data/, "/api/workspaces 没有 data 包装");
});

/* ══ 四、Android 客户端工程 ════════════════════════════════════ */

const capCfg = JSON.parse(read("apk/capacitor.config.json"));
const capCfgApk = read("apk/android/app/src/main/assets/capacitor.config.json");
const variablesGradle = read("apk/android/variables.gradle");
const appGradle = read("apk/android/app/build.gradle");

test("APK 以 server.url 远程加载云端工作台，Origin 天然等于白名单域名", () => {
  assert.equal(capCfg.webDir, "www");
  assert.equal(capCfg.server.url, "https://mytemple-cloud.app.workbuddy.host/");
  assert.equal(capCfg.server.androidScheme, "https");
  assert.equal(capCfg.server.errorPath, "offline.html", "断网时由该页兜底，避免白屏");
});

test("APK 绝不能自定义 server.hostname（会让数据面请求被本地资源拦截）", () => {
  assert.ok(
    !("hostname" in (capCfg.server || {})),
    "hostname 覆盖会把该主机名下所有请求（含同域的云端数据面）当成本地资源处理，云功能会整体失效",
  );
});

test("APK 允许 workbuddy / 微信域名在应用内导航（登录回跳才能落在应用内）", () => {
  const allow = capCfg.server.allowNavigation || [];
  assert.ok(allow.includes("mytemple-cloud.app.workbuddy.host"), "必须含应用自身域名");
  assert.ok(allow.some((h) => h === "www.workbuddy.cn" || h.endsWith(".workbuddy.cn")), "必须含 OAuth 中转域名");
  assert.ok(allow.some((h) => h === "open.weixin.qq.com" || h.endsWith(".weixin.qq.com")), "必须含微信授权域名");
});

test("APK 打进包里的配置与源配置一致（cap sync 不能漏）", () => {
  const packed = JSON.parse(capCfgApk);
  assert.equal(packed.server.url, capCfg.server.url);
  assert.equal(packed.server.errorPath, capCfg.server.errorPath);
  assert.equal(packed.appId, capCfg.appId);
  assert.deepEqual(packed.server.allowNavigation, capCfg.server.allowNavigation);
});

test("图标全部为矢量自适应图标：minSdk 26 与位图素材的存在性必须自洽", () => {
  assert.match(variablesGradle, /minSdkVersion = 26/, "自适应图标（anydpi-v26）要求 minSdk ≥ 26");
  const resDir = new URL("apk/android/app/src/main/res/", ROOT);
  const dirs = readdirSync(resDir);
  const pngMipmaps = dirs.filter((d) => /^mipmap-(hdpi|mdpi|xhdpi|xxhdpi|xxxhdpi)$/.test(d));
  assert.deepEqual(pngMipmaps, [], `minSdk 26 下不该再有位图 mipmap：${pngMipmaps.join(", ")}`);
  assert.ok(dirs.includes("mipmap-anydpi-v26"), "必须有自适应图标目录");
  const anydpiFiles = readdirSync(new URL("mipmap-anydpi-v26/", resDir));
  assert.deepEqual(anydpiFiles.sort(), ["ic_launcher.xml", "ic_launcher_round.xml"]);
  const launcher = read("apk/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml");
  assert.match(launcher, /@drawable\/ic_launcher_foreground/, "前景层指向矢量图");
  assert.match(launcher, /@color\/ic_launcher_background/, "背景层指向色值");
  assert.match(launcher, /<monochrome /, "Android 13+ 主题图标需要单色层");
  // 启动图也必须是矢量（模板的位图 splash 已删除）
  assert.match(read("apk/android/app/src/main/res/values/styles.xml"), /@drawable\/splash/);
  assert.ok(exists("apk/android/app/src/main/res/drawable/splash.xml"), "启动图应为矢量 layer-list");
});

test("正式签名走 keystore.properties，凭据不得入库", () => {
  assert.match(appGradle, /signingConfigs\s*\{/, "需要签名配置");
  assert.match(appGradle, /rootProject\.file\('keystore\.properties'\)/, "签名凭据从 keystore.properties 读");
  assert.match(appGradle, /if \(rootProject\.file\('keystore\.properties'\)\.exists\(\)\)/, "缺凭据时不应让构建直接崩");
  assert.match(rootGitignore, /^apk\/android\/keystore\.properties$/m, "凭据文件必须被忽略");
  assert.match(rootGitignore, /^\*\.jks$/m, "密钥库必须被忽略");
  // 注意：keystore.properties 在构建机上**本来就该存在**（否则打不出签名包），
  // 被忽略的是它「入库」这件事 —— 所以这里断言 gitignore 规则，而不是文件不存在。
  assert.doesNotMatch(appGradle, /storePassword\s+"/, "不得把口令硬编码进 build.gradle");
  assert.doesNotMatch(appGradle, /storePassword\s*=\s*'[^']+'/, "不得把口令硬编码进 build.gradle");
});

test("APK 工程不依赖已提交的构建产物", () => {
  const androidIgnore = read("apk/android/.gitignore");
  assert.match(androidIgnore, /^build\/$/m, "构建产物目录应被忽略");
  assert.match(androidIgnore, /^local\.properties$/m, "SDK 路径是本机配置，应被忽略");
  assert.match(androidIgnore, /^\*\.apk$/m, "APK 产物应被忽略");
});
