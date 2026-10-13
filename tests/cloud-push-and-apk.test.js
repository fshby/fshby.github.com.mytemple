// 回归测试：PC ↔ 云端 贯通（只读白名单 CORS）+ Android 客户端工程
//
// 背景（2026-10-12 修正）：早期以为云服务强制「请求来源 == 应用发布域名」，
// 于是让云端页代为读本机只读接口再上传。实测推翻 —— 跨源预检对
// http://127.0.0.1:<port> 放行，鉴权只看 X-Wb-Webapp-Access-Key + JWT + RLS。
// 现在桌面端自己直连云数据面（public/modules/cloud-client.js），
// 而「云端页读本机只读接口」降级为**备用路径**：桌面端面板带
// ?local=http://127.0.0.1:<port> 打开云端工作台时才会用到。
//
// 这里锁住的是「改错了也不报错、但会静默破坏安全」的契约：
//   - 本机只对**唯一一个**来源开放，且只挂在三个只读 GET 端点上，写端点一律不开放；
//   - 必须回 Access-Control-Allow-Private-Network，否则 Chrome PNA 会拦掉预检；
//   - 云端应用只允许读本机，绝不向本机发写请求；
//   - APK 必须走 server.url 远程加载（不能用 hostname 覆盖，否则 API 被本地资源拦截）；
//   - APK 的原生能力必须是**渐进增强**：浏览器里不得产生任何行为或界面差异。
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

test("只读中间件只挂在四个只读 GET 端点上，写端点一律不挂", () => {
  const occurrences = [...handlersRs.matchAll(/layer\(axum::middleware::from_fn\(cloud_read_cors\)\)/g)];
  assert.equal(occurrences.length, 4, `cloud_read_cors 应恰好挂 4 处，实测 ${occurrences.length}`);

  // 四处都必须挂在 get(...) 上
  for (const m of occurrences) {
    const lineStart = handlersRs.lastIndexOf("\n", m.index);
    const line = handlersRs.slice(lineStart, m.index + m[0].length);
    assert.match(line, /get\((get_workspaces|list_files|read_file|serve_source)\)/, `挂载点必须是只读 handler：${line.trim()}`);
  }
  for (const [path, handler] of [
    ["/api/workspaces", "get_workspaces"],
    ["/api/files", "list_files"],
    ["/api/files/*path", "read_file"],
    // 图片字节也走这条只读边界：/api/files 只回文本索引，云端「一键推送」要靠它把
    // 笔记里引用的本机截图读出来（serve_source 本身已有 `..` 穿越防护）。
    ["/source/*path", "serve_source"],
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

test("本机交互全部是只读请求，不向本机发任何写请求", () => {
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
  // 图片字节读取：只允许 GET / HEAD（HEAD 用来先拿体积，体积没变就不下载整张图）
  const assetFetches = [...cloudApp.matchAll(/fetch\(\s*localAssetUrl\([^)]*\)\s*,\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(assetFetches.length >= 1, "图片读取必须走 localAssetUrl");
  for (const opt of assetFetches) {
    assert.match(opt, /cache: "no-store"/, "本机图片读取也要绕开缓存：换图后不能读到旧字节");
    assert.doesNotMatch(opt, /method:\s*"(POST|PUT|PATCH|DELETE)"/i, `本机图片只读，不得带写方法：${opt.trim()}`);
  }
});

test("从本机导入：索引解包正确、按工作区过滤、只取文本类文件", () => {
  const body = fnBody(cloudApp, "async function readLocalIndex");
  assert.match(body, /wsRes\.workspaces/, "工作区列表取 .workspaces");
  assert.match(body, /wsRes\.defaultWorkspaceId/, "优先取默认工作区");
  assert.match(body, /filesRes\.data/, "文件列表是 {ok,data:[…]}，必须解包 .data");
  assert.match(body, /TEXT_EXT\.test/, "只收 Markdown / 文本");
  assert.match(body, /f\.workspace_id === def\.id/, "必须按工作区过滤，避免串到别的库");
});

test("从本机导入：指纹一致就不重复上传；图片则必须逐篇扫引用（正文没变≠图片已上云）", () => {
  assert.match(cloudApp, /function relFromRef\(ref, wsId\)/, "FileEntry.path 形如 <wsId>/<相对路径>，要剥前缀");
  const body = fnBody(cloudApp, "async function runLocalImport");
  assert.match(body, /have\.get\(rel\) === f\.content_sha256/, "本机已给指纹，一致就不上传");
  assert.match(body, /candidates\.push\(\{ relPath: rel, text, mtime: entry\.modified \|\| null \}\)/, "带 mtime 便于云端侧比对");
  assert.match(body, /\.select\("rel_path, content_sha"\)/, "先取云端指纹再决定传什么");
  assert.doesNotMatch(body, /\.delete\(\)|\.insert\(|\.update\(/, "本机导入流程不得直接操作云端表（交给 runUpload 统一 upsert）");
  // 图片必须从**每一篇**的正文里找：文档没改，不代表它引用的截图已经在云端
  //（图片同步上线前推送过的笔记，全部正文一致、图片全缺 —— 只按指纹判断就永远修不回来）
  assert.match(body, /scanned\.push\(\{ rel, text \}\)/, "每篇正文都要留下，供引用扫描");
  assert.match(body, /collectLocalAssets\(scanned, cloudWs, setNote\)/, "图片扫描要覆盖全部本机文档");
  // 没有文档变化但图片缺失时不能提前返回
  assert.match(body, /if \(!candidates\.length && !assets\.length\)/, "只有文档与图片都齐了才算「已是最新」");
  assert.match(body, /await runUpload\(candidates, assets, 0\)/, "图片要随这一次导入一起上云");
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

test("本机图片：按引用解析候选路径、先 HEAD 比体积、读到的字节交给同一条存储链路", () => {
  // 引用提取要覆盖 Markdown 与内联 HTML 两种写法
  assert.match(cloudApp, /function extractAssetRefs\(md\)/, "必须有引用提取");
  const ex = fnBody(cloudApp, "function extractAssetRefs");
  assert.ok(ex.includes("!\\[[^\\]]*\\]\\("), "要认 ![alt](url)");
  assert.ok(ex.includes("img|video|source"), "要认 <img|video|source src=…>");

  // 本机 URL 与桌面端同语义：引用什么路径，就是同源下的那个路径
  assert.match(cloudApp, /function localAssetUrl\(rel\)/, "必须有本机资源 URL 拼装");
  assert.match(cloudApp, /return LOCAL_ORIGIN \+ "\/" \+ String\(rel\)\.split\("\/"\)\.map\(encodeURIComponent\)\.join\("\/"\);/,
    "本机资源路径要逐段转义后拼在 LOCAL_ORIGIN 上");

  const body = fnBody(cloudApp, "async function collectLocalAssets");
  assert.ok(body.length > 500, "collectLocalAssets 实现缺失");
  // 候选按优先级顺序试，第一个能读到的就是它（与渲染时同一套解析顺序）
  assert.match(body, /assetRelCandidates\(ref, d\.rel\)/, "必须复用同一套引用解析");
  assert.match(body, /ASSET_EXT\.test\(p\)/, "只取图片 / 视频类引用");
  // 先 HEAD 拿体积，体积与清单一致就不下载整张图
  assert.match(body, /method: "HEAD"/, "必须先发 HEAD 探体积");
  assert.match(body, /content-length/, "体积取自 Content-Length");
  assert.match(body, /state\.assetManifest\.get\(assetManifestKey\(ws, rel\)\) === size/, "体积没变就不下载");
  assert.match(body, /skipFetch: true/, "跳过下载的条目不得带着假字节进上传队列");
  // 单张读不到不能打断整批
  assert.match(body, /catch \(_\) \{ \/\* 单张读不到就跳过/, "单张失败要吞掉，不能影响其它图片与文档");
});

test("本机图片与网页选择两条路共用同一套存储上传（对象路径、增量、计数都不另起一套）", () => {
  const body = fnBody(cloudApp, "async function runLocalImport");
  assert.match(body, /collectLocalAssets\(/, "本机导入必须走资源收集");
  // 关键：收集完直接交给 runUpload → uploadAssets，绝不自己写一份 upload 逻辑
  assert.match(body, /runUpload\(candidates, assets, 0\)/, "资源必须交给统一入口");
  assert.doesNotMatch(body, /storage\.upload\(/, "本机导入不得自己调存储上传（否则增量与计数会分叉）");
  const up = fnBody(cloudApp, "async function uploadAssets");
  assert.match(up, /cloud\.storage\.upload\(/, "统一入口才真正上传");
});

/* ══ 三、桌面入口 ═══════════════════════════════════════════════ */

test("面板保留两条打开路径：带本机只读地址 / 不带，且端口取自真实 location.port", () => {
  const body = fnBody(cloudSyncJs, "async function openWorkbench");
  assert.match(body, /withLocal/, "必须有「是否带本机地址」的开关");
  assert.match(body, /\?local=\$\{encodeURIComponent\(`http:\/\/127\.0\.0\.1:\$\{localPort\(\)\}`\)\}/, "必须带 ?local=<本机回环地址>");
  assert.match(body, /_blank/, "浏览器打不开时的回退：新标签打开");
  const portFn = fnBody(cloudSyncJs, "function localPort()");
  assert.match(portFn, /window\.location\.port/, "端口必须取自 WebView 真实端口，不能写死");
  // 面板须同时保留「直接同步」(data-act=push/pull) 与「只读备用路径」(open-local)
  assert.match(cloudSyncJs, /data-act="pull"/, "必须有「拉取云端更新」按钮");
  assert.match(cloudSyncJs, /data-act="push"/, "必须有「推送本机 → 云端」按钮");
  assert.match(cloudSyncJs, /act === "open-local"[\s\S]{0,400}openWorkbench\(true\)/, "只读路径必须真的带上本机地址");
});

test("本机接口的解包与冲突语义（曾漏解包导致篇数恒为空；冲突是 200 不是 4xx）", () => {
  const client = read("public/modules/cloud-client.js");
  const idx = fnBody(client, "async function readLocalIndex");
  assert.match(idx, /Array\.isArray\(filesRes && filesRes\.data\)/, "/api/files 是 {ok,data:[…]}，必须解包");
  assert.match(idx, /Array\.isArray\(wsRes && wsRes\.workspaces\)/, "/api/workspaces 返回裸对象");
  assert.doesNotMatch(idx, /wsRes\?\.data/, "/api/workspaces 没有 data 包装");
  // 关键：/api/save 的 baseHash 冲突返回 HTTP 200 + {ok:false,conflict:true}（ipc::save_doc），
  // 只判 res.ok 会把「拒绝写入」当成写入成功，进而静默覆盖本机。
  const req = fnBody(client, "async function localRequest");
  assert.match(req, /body\.ok === false/, "必须把 {ok:false} 当失败，否则冲突会被吞掉");
  assert.match(req, /err\.conflict = true|conflict = true/, "必须把 conflict 标志透出去");
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

/* ══ 五、APK 原生能力（渐进增强） ═══════════════════════════════
 * 云端页同时服务浏览器与 APK 的 WebView，所以原生能力只能做成渐进增强：
 * 判定失败时浏览器侧的行为与界面必须与之前**完全一致**。
 * 这里锁的是：判定方式、返回键优先级、插件与 Capacitor 大版本一致、
 * 以及「原生 UI 默认隐藏」。 */

test("原生判定用 Capacitor.isNativePlatform()，不解析 UA", () => {
  assert.match(cloudApp, /isNativePlatform/, "必须用 Capacitor 官方判定");
  assert.doesNotMatch(cloudApp, /navigator\.userAgent/, "不得用 UA 判定原生环境（可被伪造）");
  // 插件实例只能从 Capacitor.Plugins 取，且必须包在 NATIVE 分支里
  assert.match(cloudApp, /const CAP = \(NATIVE && window\.Capacitor\.Plugins\)/, "插件实例必须来自 Capacitor.Plugins 且受 NATIVE 保护");
});

test("Android 返回键优先级：先关弹层 → 再退出文档 → 最后才退出应用", () => {
  const body = fnBody(cloudApp, 'CAP.App.addListener("backButton"');
  assert.match(body, /closeTopSheet\(\)\) return/, "第一步必须关弹层");
  assert.match(body, /backToList\(\)/, "第二步必须从文档页回列表");
  assert.match(body, /exitApp\(\)/, "最终才允许退出应用");
  const close = fnBody(cloudApp, "function closeTopSheet()");
  // 确认框必须走它自己的取消按钮：否则 askConfirm 的 Promise 永不 resolve，界面卡死
  assert.match(close, /confirmCancel\.click\(\)/, "确认框必须点取消按钮而不是直接隐藏");
});

test("原生专属 UI 默认隐藏，浏览器不会看到任何新元素", () => {
  assert.match(cloudHtml, /id="nativeActions" class="native-actions" hidden/, "原生动作条必须默认 hidden");
  assert.match(cloudHtml, /id="offlineBar" class="offline-bar" role="status" hidden/, "离线提示条必须默认 hidden");
  assert.match(cloudApp, /el\.nativeActions\.hidden = false/, "只有原生分支才把它显示出来");
  assert.match(read("cloud/styles.css"), /\.native-actions\[hidden\]\s*\{\s*display:\s*none/, "hidden 必须真的不占位");
});

test("原生插件与 Capacitor 大版本一致，且权限保持最小", () => {
  const pkg = JSON.parse(read("apk/package.json"));
  const caps = Object.entries(pkg.dependencies).filter(([k]) => k.startsWith("@capacitor/"));
  assert.ok(caps.length >= 7, `应声明核心 + 6 个插件，实测 ${caps.length}`);
  // 插件必须与 @capacitor/core 同一个大版本：混版会在运行时抛 "not implemented"
  const coreMajor = pkg.dependencies["@capacitor/core"].replace(/^[^\d]*/, "").split(".")[0];
  for (const [name, range] of caps) {
    assert.match(range, new RegExp(`\\^${coreMajor}\\.`), `${name} 必须与 @capacitor/core@${coreMajor} 同大版本，实测 ${range}`);
  }
  // Gradle 接线必须真的生成（只写 capacitor.plugins.json 是不够的，类不会被编译进来）
  const settings = read("apk/android/capacitor.settings.gradle");
  const buildGradle = read("apk/android/app/capacitor.build.gradle");
  for (const name of ["app", "clipboard", "filesystem", "network", "share", "status-bar"]) {
    assert.match(settings, new RegExp(`include ':capacitor-${name}'`), `${name} 必须写进 capacitor.settings.gradle`);
    assert.match(buildGradle, new RegExp(`implementation project\\(':capacitor-${name}'\\)`), `${name} 必须是 Gradle 依赖`);
  }
  // 只数真正的 <uses-permission> 声明（注释里提到某个权限名不算申请）
  const manifest = read("apk/android/app/src/main/AndroidManifest.xml");
  const declared = [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(declared, ["android.permission.ACCESS_NETWORK_STATE", "android.permission.INTERNET"],
    "权限必须是「最小集」：导出的 .md 落在应用专属 Documents，不需要外部存储权限；本轮未接入拍照，不需要相机权限");
});
