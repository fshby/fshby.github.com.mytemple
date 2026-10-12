// 回归测试：知识库云端同步（云服务环境 + 云端工作台 + 桌面入口）
//
// 背景：本次需求分两部分 ——
//   1) 开通云服务环境，建立 owner-only 的数据表与 RLS 策略；
//   2) 让用户**自己决定**是否把知识库上传到云端（云端工作台里显式选择文件夹/文件/压缩包）。
//
// 这里锁住的是那些「改错了也不报错、但会静默破坏安全或功能」的契约：
//   - 数据隔离靠数据库 RLS，前端永不传 owner_id；
//   - 每处客户端初始化都必须带上 publicConfig 的 endpoint + publishableKey（+ 网页微信登录要 oauthRelayBaseUrl）；
//   - 写操作必须用 .select() 读回，才能把「RLS 过滤掉返回空数组」和「真的改成功了」区分开；
//   - 微信回调必须在任何路由守卫之前无条件执行，并在成功后清理 URL；
//   - 上传必须是增量（内容指纹比对）而不是全量重传；
//   - 云端与桌面共用同一份 Markdown 渲染器，构建产物不得分叉。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

const cloudHtml = read("cloud/index.html");
const cloudApp = read("cloud/app.js");
const cloudCss = read("cloud/styles.css");
const cloudCfg = read("cloud/cloud-config.js");
const desktopEntry = read("public/modules/cloud-sync.js");
const indexHtml = read("public/index.html");
const appSrc = read("public/app.js");

/* ── 云服务客户端初始化 ─────────────────────────────────────── */

test("云端工作台以公开配置初始化客户端，endpoint / publishableKey / oauthRelayBaseUrl 全部来自 publicConfig", () => {
  const i = cloudApp.indexOf("createWorkBuddyCloud({");
  assert.ok(i > 0, "必须调用 createWorkBuddyCloud 初始化（不得手写 fetch 打 /cloud/**）");
  const body = cloudApp.slice(i, cloudApp.indexOf("});", i));
  assert.match(body, /endpoint:\s*CFG\.endpoint/, "endpoint 必须来自配置对象（publicConfig）");
  assert.match(body, /publishableKey:\s*CFG\.publishableKey/, "必须传 publishableKey");
  assert.match(body, /oauthRelayBaseUrl:\s*CFG\.oauthRelayBaseUrl/, "网页微信登录必须传 oauthRelayBaseUrl");
  // 严禁把 endpoint 从 location / 环境变量里取
  assert.doesNotMatch(body, /location\.origin/, "endpoint 不得取自 location");
});

test("公开配置只含 publicConfig 的四项，且不含任何长期密钥字段", () => {
  for (const key of ["resourceId", "endpoint", "oauthRelayBaseUrl", "publishableKey"]) {
    assert.match(cloudCfg, new RegExp(`${key}:\\s*"`), `cloud-config.js 必须包含 ${key}`);
  }
  for (const bad of ["secret", "serviceRole", "service_role", "adminKey", "accessKey", "apiKey"]) {
    assert.doesNotMatch(cloudCfg, new RegExp(bad, "i"), `前端配置不得出现 ${bad}`);
  }
  assert.doesNotMatch(cloudApp, /apikey|Authorization:/i, "不得手写 apikey / Authorization 头");
});

test("云服务 SDK 以经典脚本的同源方式加载、暴露全局，且先于应用脚本", () => {
  // app.js 直接读 window.WorkBuddyCloud，所以 SDK 必须是经典脚本（顶层 var -> 挂到 window）、
  // 且必须排在 app.js 之前。改成 ES module 引入会静默拿不到全局。
  const sdkTag = cloudHtml.indexOf("/vendor/sdk/workbuddy-cloud-sdk.global.js");
  assert.ok(sdkTag > 0, "SDK 必须由同源 /vendor/ 提供（原 CDN 主机名在部分网络下不可达）");
  const appTag = cloudHtml.indexOf('src="/app.js');
  assert.ok(appTag > sdkTag, "应用脚本必须在 SDK 之后加载");
  const tagMatch = cloudHtml.match(/<script[^>]*workbuddy-cloud-sdk\.global\.js[^>]*>/);
  assert.ok(tagMatch, "找不到 SDK 的 script 标签");
  assert.doesNotMatch(tagMatch[0], /type="module"/, "SDK 必须是经典脚本，否则不会挂到 window 上");
  // 真的验一下这个文件确实声明了 app.js 要读的全局名
  assert.match(
    read("cloud/vendor/sdk/workbuddy-cloud-sdk.global.js").slice(0, 400),
    /var\s+WorkBuddyCloud\s*=/,
    "vendor 里的 SDK 必须声明 var WorkBuddyCloud= 全局（app.js 读的就是它）"
  );
});

/* ── 数据隔离：RLS 是唯一边界 ───────────────────────────────── */

test("前端从不上送 owner_id（归属由数据库 DEFAULT auth.uid() 决定）", () => {
  // 允许出现 owner_id 的地方只有：onConflict 冲突目标、以及注释
  const writeSites = cloudApp.match(/owner_id[^\n]*/g) || [];
  for (const line of writeSites) {
    assert.ok(
      /onConflict|^\s*owner_id|\*|--|\/\//.test(line.trim()) || line.includes("owner_id = auth.uid()"),
      `owner_id 不应出现在写入载荷里：${line.trim()}`,
    );
  }
  assert.doesNotMatch(cloudApp, /owner_id:\s*[^,}\n]/, "不得显式写入 owner_id（含显式 null）");
});

test("所有写操作都用 .select() 读回，用于区分「被 RLS 过滤」与「真的成功」", () => {
  const calls = cloudApp.match(/\.(upsert|update|delete)\(/g) || [];
  assert.ok(calls.length >= 3, `应有多处写操作，实测 ${calls.length}`);
  // 每个写操作链上都应出现 .select( —— 逐个切片检查
  let from = 0;
  for (let n = 0; n < calls.length; n += 1) {
    const at = cloudApp.indexOf(calls[n], from);
    from = at + 1;
    const tail = cloudApp.slice(at, at + 420);
    const end = tail.search(/;\s*\n/);
    const stmt = end > 0 ? tail.slice(0, end) : tail;
    assert.match(stmt, /\.select\(/, `写操作缺少 .select() 读回：${stmt.split("\n")[0].trim()}`);
  }
})

test("越权/未命中导致的空数组被显式提示，而不是当成成功", () => {
  assert.match(cloudApp, /data\.length === 0|affected\.length === 0|!Array\.isArray\(data\)/,
    "必须判断写回结果为空的情况");
});

/* ── 认证 ───────────────────────────────────────────────────── */

test("手机号验证码：11 位校验在前、发送与校验分开、新用户才要密码", () => {
  assert.match(cloudApp, /\^1\\d\{10\}\$/, "必须先做 11 位手机号校验再发请求");
  assert.match(cloudApp, /cloud\.auth\.sendOtp\(\{\s*phone\s*\}\)/, "手机路径必须用 phone 发码");
  assert.match(cloudApp, /verificationId:\s*sent\.data\.verificationId/, "必须保存 verificationId");
  assert.match(cloudApp, /isExistingUser:\s*sent\.data\.isExistingUser/, "必须保存 isExistingUser");
  assert.match(cloudApp, /password:\s*pending\.isExistingUser\s*\?\s*undefined/, "只有新用户才传密码");
  // 提交阶段不得再次发码
  const submit = cloudApp.slice(cloudApp.indexOf('el.phoneForm.addEventListener("submit"'));
  assert.doesNotMatch(submit.slice(0, 1600), /sendOtp/, "提交验证码时不得重新发码");
});

test("邮箱登录：验证码注册/登录、密码登录、找回密码三条路径齐备且各自合规", () => {
  // 1) 验证码路径：email 必须与发码时同一个，提交阶段不得重发
  assert.match(cloudApp, /cloud\.auth\.sendOtp\(\{\s*email\s*\}\)/, "邮箱路径必须用 email 发码");
  assert.match(cloudApp, /pending\.email !== email/, "提交前必须核对收件邮箱未变");
  const otpFn = cloudApp.slice(cloudApp.indexOf("async function submitEmailOtp"), cloudApp.indexOf("/** 密码登录"));
  assert.match(otpFn, /verificationId:\s*pending\.verificationId/, "verifyOtp 必须带 verificationId");
  assert.match(otpFn, /isExistingUser:\s*pending\.isExistingUser/, "verifyOtp 必须带 isExistingUser");
  assert.match(otpFn, /token:\s*code/, "verifyOtp 必须带用户输入的 token");
  assert.match(otpFn, /password:\s*pending\.isExistingUser\s*\?\s*undefined/, "新邮箱注册才需要密码");
  assert.doesNotMatch(otpFn, /sendOtp/, "提交验证码时不得重新发码");

  // 2) 密码登录（2026-10-12 重构：统一走表单提交，次级链接只负责切换形态）
  assert.match(cloudApp, /cloud\.auth\.signInWithPassword\(\{\s*email,\s*password\s*\}\)/, "必须支持邮箱+密码登录");
  const pwdFn = cloudApp.slice(cloudApp.indexOf("async function submitEmailPassword"), cloudApp.indexOf("el.emailPasswordLogin.addEventListener"));
  assert.match(pwdFn.slice(0, 900), /邮箱或密码不正确/, "密码错误提示不得暴露账号是否存在");
  assert.match(cloudApp, /state\.emailMode = state\.emailMode === "password" \? "otp" : "password"/,
    "「用密码登录」链接必须能在两种形态间往返");
  assert.match(cloudApp, /applyEmailMode\(\)/, "形态切换必须经过 applyEmailMode 统一重排");

  // 3) 找回密码（有密码登录就必须有找回流程）
  assert.match(cloudApp, /cloud\.auth\.resetPasswordForEmail\(email\)/, "必须支持忘记密码");
  assert.match(cloudApp, /updateUser\(\{\s*nonce:\s*code,\s*password\s*\}\)/, "必须用 nonce + 新密码完成重置");
  assert.match(cloudApp, /length < 8/, "新密码必须有长度校验");

  // 4) 邮箱格式前置校验
  assert.match(cloudApp, /EMAIL_RE\s*=\s*\/\^\[\^\\s@\]\+@/, "必须有邮箱格式校验");
});

test("登录界面渐进披露：验证码是主路径，密码框默认隐藏（实机反馈：冗余过多）", () => {
  // 密码框默认 hidden —— 验证码是主路径，只在注册/密码登录/找回时出现
  assert.match(cloudHtml, /id="emailPasswordField"[^>]*hidden/, "邮箱密码框默认必须隐藏");
  assert.match(cloudHtml, /id="emailCodeField"/, "验证码行必须可整体切换");
  assert.match(cloudHtml, /id="emailPasswordLabel"/, "密码标签文案随形态变化（密码/设置密码/新密码）");
  assert.doesNotMatch(cloudHtml, /首次注册时需设置密码；用密码登录时也填这里/,
    "旧的常驻混歧提示必须移除");
  assert.match(cloudApp, /el\.emailCodeField\.hidden = mode === "password"/,
    "密码形态下验证码整行隐藏");
  assert.match(cloudApp, /emailMode:\s*"otp"/, "默认落在验证码主路径");
  assert.match(cloudApp, /el\.emailSubmit\.textContent = reset \? "确认重置密码"/,
    "找回形态下提交按钮必须改名，避免歧义");
});

test("桌面同步面板：显示推送目标 + 工作区可选（实机反馈）", () => {
  assert.match(desktopEntry, /data-fact="target"/, "面板必须显示推送目标（云端地址 + 分区）");
  assert.match(desktopEntry, /data-el="wsSelect"/, "面板必须提供工作区选择器");
  assert.match(desktopEntry, /workspaceId: localData && localData\.ws \? localData\.ws\.id : undefined/,
    "推送/拉取必须带上所选工作区");
  assert.match(desktopEntry, /WS_KEY = "mtCloudWs\.v1"/, "工作区选择必须被记住");
  // camelCase 契约收口（实机：FileEntry 是 workspaceId / contentSha256）
  const clientJs = read("public/modules/cloud-client.js");
  assert.match(clientJs, /rename_all\s*=\s*"camelCase"|workspaceId \?\? .*workspace_id|fWs\(/,
    "cloud-client 必须显式适配 camelCase 字段");
  assert.match(clientJs, /contentSha256 \?\? .*content_sha256|fSha\(/,
    "sha 字段必须显式适配 camelCase");
});

test("登录界面三种方式并存，且默认落在邮箱", () => {
  assert.match(cloudHtml, /id="tabEmail"[\s\S]*id="tabPhone"/, "必须有邮箱/手机号切换");
  assert.match(cloudHtml, /id="wechatBtn"[\s\S]*微信登录/, "必须保留微信登录");
  assert.match(cloudApp, /loginTab:\s*"email"/, "默认落在邮箱方式");
  assert.match(cloudApp, /setLoginTab\(state\.loginTab\)/, "启动时应用默认方式");
});

test("实机回归：hidden 不被 flex 样式推翻（手机表单 / 密码框曾因此全部铺开）", () => {
  // 2026-10-12 实机截图：.form{display:flex} / .field{display:flex} 覆盖了浏览器
  // 对 [hidden] 的默认 display:none，APK 登录页把两套表单 + 密码框全部铺开。
  // 兜底规则必须存在且带 !important，且要早于任何组件样式（放在 :root 之后）。
  assert.match(cloudCss, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, "必须有全局 [hidden] 兜底");
  const guardAt = cloudCss.indexOf("[hidden] { display: none !important");
  const flexAt = cloudCss.indexOf(".form { display: flex");
  assert.ok(guardAt > 0 && flexAt > 0 && guardAt < flexAt, "兜底规则必须在 .form 之前声明");
  // 手机表单与密码框初始都必须带 hidden（靠兜底规则生效）
  assert.match(cloudHtml, /id="phoneForm"[\s\S]{0,120}hidden/, "手机表单初始必须 hidden");
  assert.match(cloudHtml, /id="emailPasswordField" hidden/, "邮箱密码框初始必须 hidden");
  assert.match(cloudHtml, /id="passwordField" class="field" hidden/, "手机密码框初始必须 hidden");
});

test("APK 里微信登录必须隐藏（网页扫码流程在手机上是自己扫自己）", () => {
  const native = cloudApp.slice(cloudApp.indexOf("if (NATIVE) {"), cloudApp.indexOf("if (NATIVE) {") + 1600);
  assert.match(native, /el\.wechatBtn\) el\.wechatBtn\.hidden\s*=\s*true/, "NATIVE 块必须隐藏微信登录入口");
  assert.match(native, /classList\.contains\("or"\)\)\s*wechatDivider\.hidden\s*=\s*true/, "「或」分隔线必须一并隐藏");
  // 浏览器侧（非 NATIVE）微信入口保留 —— 上面那条「必须保留微信登录」的 HTML 断言照旧成立
});

test("微信登录：用 signInWithOAuth 跳转，且回调在任何路由守卫之前无条件执行", () => {
  assert.match(cloudApp, /signInWithOAuth\(\{\s*provider:\s*"wechat"/, "网页微信登录必须用 signInWithOAuth");
  assert.doesNotMatch(cloudApp, /wx\.login|signInWithWechat/, "网页端不得调用小程序登录 API");
  const cb = cloudApp.indexOf("handleWechatWebCallback");
  assert.ok(cb > 0, "入口必须处理微信回调");
  const bootBody = cloudApp.slice(cloudApp.indexOf("async function boot()"));
  const cbAt = bootBody.indexOf("handleWechatWebCallback");
  const gateAt = bootBody.indexOf("cloud.auth.getSession()");
  assert.ok(cbAt > 0 && gateAt > 0 && cbAt < gateAt, "回调必须先于会话守卫执行");
  assert.match(bootBody, /history\.replaceState\(null,\s*"",\s*location\.pathname\)/,
    "回调成功后必须清理 URL（code 一次性）");
  assert.doesNotMatch(cloudApp, /handleOAuthCallback/, "网页微信登录不得用已废弃的 handleOAuthCallback");
  // 回调结果必须按 session 分支，而不是只判 error
  assert.match(bootBody, /r\s*&&\s*r\.data/, "必须显式按 session 分支");
});

test("有会话才进入工作台，退出登录后回到登录页且不残留数据", () => {
  assert.match(cloudApp, /if\s*\(error\s*\|\|\s*!session\)\s*\{\s*show\("login"\)/, "必须有登录门");
  assert.match(cloudApp, /signOut\(\)/, "必须支持退出登录");
  const out = cloudApp.slice(cloudApp.indexOf("await cloud.auth.signOut()"));
  assert.match(out.slice(0, 300), /state\.docs\s*=\s*\[\]/, "退出后必须清空本地缓存的数据");
  assert.doesNotMatch(cloudApp, /signInAnonymously|mockSession|localStorage.*session/i, "不得引入匿名登录或本地假会话");
});

/* ── 上传：用户显式选择 + 增量 ─────────────────────────────── */

test("上传由用户显式选择触发，支持文件夹 / 多选 / 拖拽 / zip 四种入口", () => {
  assert.match(cloudHtml, /webkitdirectory/, "必须支持选择文件夹");
  assert.match(cloudHtml, /accept="\.md,\.markdown,\.txt,\.zip"/, "必须支持选择 md/txt/zip");
  assert.match(cloudApp, /webkitGetAsEntry/, "必须支持拖拽文件夹");
  assert.match(cloudApp, /fflate\.unzipSync|window\.fflate/, "必须支持 zip 包解析");
  assert.match(cloudApp, /addEventListener\("drop"/, "必须有拖放处理");
});

test("上传是增量：按内容指纹比对，未变化的跳过", () => {
  assert.match(cloudApp, /sha256Hex\(/, "必须计算内容指纹");
  assert.match(cloudApp, /have\.get\(p\.rel_path\)\s*!==\s*p\.content_sha/, "必须与云端指纹比对");
  assert.match(cloudApp, /job\.skipped/, "必须统计跳过数量");
  assert.match(cloudApp, /onConflict:\s*"owner_id,workspace,rel_path"/,
    "upsert 冲突目标必须是含 owner_id 的唯一键（否则跨用户同名文件会互相覆盖）");
});

test("上传可取消，且分批提交（避免单次请求过大）", () => {
  assert.match(cloudApp, /cancelUploadBtn|job\.cancelled/, "必须支持取消");
  assert.match(cloudApp, /UPSERT_BATCH_MAX_DOCS/, "必须按条数分批");
  assert.match(cloudApp, /UPSERT_BATCH_MAX_BYTES/, "必须按字节分批");
});

test("不提供「镜像同步」式的隐式删除：删除只发生在用户明确要求的动作里", () => {
  // 上传路径中不得出现 delete()；删除只能来自删除按钮 / 清空按钮
  const uploadFn = cloudApp.slice(cloudApp.indexOf("async function runUpload"), cloudApp.indexOf("function finishUpload"));
  assert.doesNotMatch(uploadFn, /\.delete\(/, "上传流程不得包含删除（避免静默删掉用户云端内容）");
  assert.match(cloudApp, /data-del-ws/, "分区删除必须是显式按钮");
  assert.match(cloudApp, /clearAllBtn/, "清空必须是显式按钮");
});

/* ── 桌面端入口 ─────────────────────────────────────────────── */

test("桌面端只增不改：一个新按钮 + 一次 init 调用，且入口自包含", () => {
  assert.match(indexHtml, /<button id="cloudBtn"/, "工具栏必须有云端入口按钮");
  assert.match(appSrc, /import \{ initCloudSync \} from "\.\/modules\/cloud-sync\.js"/, "app.js 必须导入入口模块");
  assert.match(appSrc, /initCloudSync\(\{ reload:/, "必须调用 initCloudSync，并传入刷新回调（同步写回本机后要重扫文件树）");
  assert.ok(existsSync(new URL("public/modules/cloud-sync.js", ROOT)), "入口模块必须存在");
  // 自包含：样式注入，不修改合并产物 styles.css
  assert.match(desktopEntry, /document\.head\.appendChild\(style\)/, "入口样式应通过 <style> 注入");
  assert.doesNotMatch(desktopEntry, /^import .*from "\.\/toast/m, "入口不得依赖 app.js 作用域内的函数");
});

test("桌面端连云只经 cloud-client.js 一个入口，且复用同源 SDK（不手写 REST）", () => {
  // 历史：曾认为「云服务强制请求来源 == 发布域名」，于是桌面端只做入口引导。
  // 2026-10-12 实测推翻（预检对 http://127.0.0.1:<port> 放行 Authorization /
  // X-Wb-Webapp-Access-Key / Prefer），桌面端因此改为直连。
  // 但云访问必须**只有一个入口**，否则会话、密钥头、分页规则会各写一套并漂移。
  const client = read("public/modules/cloud-client.js");
  assert.match(client, /createWorkBuddyCloud\(\{/, "云客户端必须由 SDK 创建（不得手写 REST）");
  assert.match(client, /endpoint:\s*CFG\.endpoint/, "endpoint 必须来自 cloud-config（不得取自 location）");
  assert.match(client, /publishableKey:\s*CFG\.publishableKey/, "必须传 publishableKey");
  // 面板本身不得再出现云数据面路径与客户端初始化
  assert.doesNotMatch(desktopEntry, /\.cloud\//, "面板不得直接打 /.cloud/**，必须经 cloud-client");
  assert.doesNotMatch(desktopEntry, /createWorkBuddyCloud/, "面板不初始化云客户端");
  assert.match(desktopEntry, /from "\.\/cloud-client\.js"/, "面板必须从 cloud-client 取能力");
  // 桌面端与云端页必须用同一份 SDK 文件（同 sha），否则行为会分叉
  const a = read("cloud/vendor/sdk/workbuddy-cloud-sdk.global.js");
  const b = read("public/vendor/sdk/workbuddy-cloud-sdk.global.js");
  assert.equal(b, a, "桌面端 SDK 必须与云端页逐字节一致：跑 npm run vendor:cloud");
  // 桌面端与云端的公开配置必须键值一致（改一处就得重新生成另一处）
  const keys = ["resourceId", "endpoint", "oauthRelayBaseUrl", "publishableKey"];
  const pubCfg = read("public/cloud-config.js");
  for (const k of keys) {
    const m = cloudCfg.match(new RegExp(`${k}:\\s*"([^"]*)"`));
    assert.ok(m, `cloud-config.js 缺少 ${k}`);
    assert.match(pubCfg, new RegExp(`${k}:\\s*"${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      `public/cloud-config.js 的 ${k} 与云端不一致：跑 npm run vendor:cloud`);
  }
});

test("桌面端页面引入同源 SDK 与配置，且都先于 app.js（经典脚本）", () => {
  const sdkTag = indexHtml.indexOf("/vendor/sdk/workbuddy-cloud-sdk.global.js");
  const cfgTag = indexHtml.indexOf("/cloud-config.js");
  // 只看真正的 <script src>（顶部还有一条 modulepreload 的 <link href="/app.js?v=…">）
  const appTag = indexHtml.indexOf('<script src="/app.js');
  assert.ok(sdkTag > 0, "index.html 必须引入同源 SDK");
  assert.ok(cfgTag > 0, "index.html 必须引入 cloud-config.js");
  assert.ok(sdkTag < appTag, "SDK 必须先于 app.js 加载");
  assert.ok(cfgTag < appTag, "配置必须先于 app.js 加载");
  for (const name of ["workbuddy-cloud-sdk\\.global\\.js", "cloud-config\\.js"]) {
    const tag = indexHtml.match(new RegExp(`<script[^>]*${name}[^>]*>`));
    assert.ok(tag, `找不到 ${name} 的 script 标签`);
    assert.doesNotMatch(tag[0], /type="module"/, `${name} 必须是经典脚本，否则不会挂到 window`);
  }
});

test("桌面端直连押注的 SDK 契约：access-key 头名与客户端形状（换 SDK 版本会静默打断直连）", () => {
  // 2026-10-12 实测：OPTIONS 预检回的白名单头里含 X-Wb-Webapp-Access-Key，桌面端能否跨源直连
  // 完全押在这个头名上 —— 一旦换 SDK 版本改了名字，远端会 401，而本机一切照常、只表现为
  // 「登录不上」。所以把它钉成契约，而不是留一句注释。
  // 这个测试**不联网**：只加载 vendored SDK 检查其对外形状。
  const prevWindow = globalThis.window;
  globalThis.window = globalThis;
  let sdk;
  try {
    sdk = new Function(read("public/vendor/sdk/workbuddy-cloud-sdk.global.js") + "\nreturn WorkBuddyCloud;")();
    assert.ok(sdk, "SDK 必须声明全局 WorkBuddyCloud（经典脚本，app.js 读的就是它）");
    assert.equal(sdk.PUBLISHABLE_KEY_HEADER, "x-wb-webapp-access-key",
      "SDK 的公开键头名必须与云服务预检白名单里的实测值一致，改名会让桌面端直连全部 401");
    assert.equal(typeof sdk.createWorkBuddyCloud, "function", "必须导出 createWorkBuddyCloud");
    assert.equal(typeof sdk.createMemoryStorage, "function",
      "必须导出内存存储实现（桌面端测试环境与无 DOM 场景要用它）");
    const client = sdk.createWorkBuddyCloud({
      endpoint: "https://example.invalid",
      oauthRelayBaseUrl: "https://example.invalid/oauth",
      publishableKey: "wbpk_contract_probe",
      storage: sdk.createMemoryStorage(),
    });
    for (const m of ["auth", "database"]) {
      assert.ok(client[m], `云端客户端必须暴露 ${m} 模块（cloud-client.js 依赖它）`);
    }
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

/* ── 两端渲染器同源 ─────────────────────────────────────────── */

test("云端与桌面共用同一份 Markdown 渲染器（构建同步，防止排版分叉）", () => {
  const a = read("public/markdown-worker.js");
  const b = read("cloud/markdown-worker.js");
  assert.equal(b, a, "cloud/markdown-worker.js 与 public/markdown-worker.js 必须一致：跑 npm run build:cloud");
});

test("静态资源缓存戳三处一致，且改动后已递增", () => {
  // 只看主三件套（styles.css / editor-core.js / app.js）；highlight 语言包有自己的版本节奏
  const versions = [...indexHtml.matchAll(/(?:styles\.css|editor-core\.js|app\.js)\?v=([^"]+)/g)].map((m) => m[1]);
  assert.equal(versions.length, 4, `index.html 应有 4 处主资源引用，实测 ${versions.length}`);
  const unique = [...new Set(versions)];
  assert.equal(unique.length, 1, `主资源 ?v= 必须完全一致，实测 ${unique.join(" / ")}`);
  assert.match(unique[0], /^2026\d{4}-/, "缓存戳应是日期前缀形式");
  assert.match(cloudHtml, /\?v=cloud-\d+/, "云端工作台资源应带自己的缓存戳");
  // 云端三件套（styles.css / cloud-config.js / app.js）必须同版本串，且页面里不残留旧版本
  const cloudVersions = [...cloudHtml.matchAll(/(?:styles\.css|cloud-config\.js|app\.js)\?v=([^"]+)/g)].map((m) => m[1]);
  assert.equal(cloudVersions.length, 3, `云页面应有 3 处主资源引用，实测 ${cloudVersions.length}`);
  assert.equal(new Set(cloudVersions).size, 1, `云页面 ?v= 必须完全一致，实测 ${cloudVersions.join(" / ")}`);
  // app.js 内部的 ASSET_V 必须与页面同串：它拼的是 worker / mermaid / katex 的 URL，
  // 不一致会变成「页面已更新、子资源还是旧缓存」这种最难查的混合状态。
  const assetV = cloudApp.match(/const ASSET_V = "([^"]+)"/);
  assert.ok(assetV, "cloud/app.js 必须有 ASSET_V");
  assert.equal(assetV[1], cloudVersions[0], "cloud/app.js 的 ASSET_V 必须与页面缓存戳一致");
  // 桌面 app.js 内部引用的两个 URL 必须与页面一致，否则 WebView2 会命中旧缓存
  for (const target of ["editor-core.js", "markdown-worker.js"]) {
    const m = appSrc.match(new RegExp(`/${target.replace(".", "\\.")}\\?v=([^"]+)`));
    assert.ok(m, `app.js 必须引用 ${target}`);
    assert.equal(m[1], unique[0], `app.js 的 ${target} 缓存戳必须与 index.html 一致`);
  }
});

/* ── 第三方库自托管 ───────────────────────────────────────────
 * 事故背景：云端工作台的第三方库（含**登录 SDK**）原先全部取自 cdn.jsdelivr.net。
 * 该主机名在部分网络下 TLS 连接会被重置（实测 curl -> (35) Recv failure:
 * Connection was reset，而 unpkg / registry.npmjs.org 正常）。SDK 加载失败后
 * window.WorkBuddyCloud 为 undefined，initClient() 抛错，于是**验证码 / 微信 /
 * 密码三条登录路径同时失效** —— 表现为「登录完全不能用」。
 * 所以：库必须由站点同源提供（cloud/vendor/），且版本必须钉死。
 * ------------------------------------------------------------------------- */

/** 常见第三方 CDN 主机名，出现即视为回退到外部依赖。 */
const CDN_HOSTS = [
  "cdn.jsdelivr.net",
  "fastly.jsdelivr.net",
  "gcore.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "cdn.bootcdn.net",
  "cdn.staticfile.org",
  "fonts.googleapis.com",
];

test("云端页面与脚本不再引用任何第三方 CDN（库一律同源自托管）", () => {
  for (const [name, src] of [["cloud/index.html", cloudHtml], ["cloud/app.js", cloudApp]]) {
    for (const host of CDN_HOSTS) {
      // 允许在注释里提及（说明事故背景），但不允许出现在任何 src/href/URL 位置
      const inCode = new RegExp(`(?:src|href)\\s*=\\s*[\`"'][^\`"']*${host.replace(/\./g, "\\.")}`);
      const asUrl = new RegExp(`[\`"']https://${host.replace(/\./g, "\\.")}`);
      assert.ok(!inCode.test(src), `${name} 不应再从 ${host} 加载资源`);
      assert.ok(!asUrl.test(src), `${name} 不应再出现 ${host} 的 URL`);
    }
  }
});

test("登录 SDK 与 fflate 由同源 vendor 提供，且文件真实存在", () => {
  // 这两件是登录链路的硬依赖：缺 SDK 则任何登录方式都不可用
  assert.match(cloudHtml, /<script src="\/vendor\/sdk\/workbuddy-cloud-sdk\.global\.js\?v=/, "登录 SDK 必须走同源 /vendor/");
  assert.match(cloudHtml, /<script src="\/vendor\/fflate\/fflate\.min\.js\?v=/, "fflate 必须走同源 /vendor/");
  // SDK 必须在 app.js 之前加载，否则 window.WorkBuddyCloud 还是 undefined
  assert.ok(
    cloudHtml.indexOf("/vendor/sdk/workbuddy-cloud-sdk.global.js") < cloudHtml.indexOf("/app.js?v="),
    "SDK 必须先于 app.js 加载，否则初始化时拿不到 WorkBuddyCloud"
  );

  const floor = {
    "cloud/vendor/sdk/workbuddy-cloud-sdk.global.js": 50_000,
    "cloud/vendor/fflate/fflate.min.js": 20_000,
    "cloud/vendor/mermaid/mermaid.min.js": 1_000_000,
    "cloud/vendor/katex/katex.min.js": 100_000,
    "cloud/vendor/katex/katex.min.css": 10_000,
    "cloud/vendor/chartjs/chart.umd.js": 150_000,
    "cloud/vendor/echarts/echarts.min.js": 800_000,
  };
  for (const [rel, min] of Object.entries(floor)) {
    assert.ok(existsSync(new URL(rel, ROOT)), `${rel} 缺失，请跑 npm run vendor:cloud`);
    const size = statSync(new URL(rel, ROOT)).size;
    assert.ok(size >= min, `${rel} 体积异常（${size} B < ${min} B），可能是错误页而非真文件`);
  }
});

test("katex 样式与其字体保持相对路径关系（换域名也不会失效）", () => {
  const css = read("cloud/vendor/katex/katex.min.css");
  const fonts = [...new Set(css.match(/fonts\/[A-Za-z0-9_.-]+\.woff2/g) || [])];
  assert.ok(fonts.length >= 20, `katex 样式应引用字体，实测 ${fonts.length} 个 woff2`);
  // CSS 用的是相对路径 fonts/xxx，所以字体必须落在 CSS 同目录下的 fonts/ 里
  for (const f of fonts) {
    const rel = `cloud/vendor/katex/${f}`;
    assert.ok(existsSync(new URL(rel, ROOT)), `${rel} 缺失（CSS 用相对路径引用，缺了公式会掉字形）`);
  }
});

test("图表库由云端同源提供，且桌面端行为不受牵连", () => {
  // markdown-worker 两端共用同一份文件（上面已有字节一致性断言），
  // 所以不能把库地址写死：云端通过 Worker URL 的 ?assets= 指到 /vendor/，
  // 桌面端不传该参数，继续走原来的 CDN —— 本轮不动桌面端，不能产生回归。
  const shared = read("public/markdown-worker.js");
  assert.match(shared, /\[\?&\]assets=/, "worker 必须支持 ?assets= 覆盖自托管目录");
  assert.match(shared, /ASSET_BASE\s*\?/, "worker 必须按 ASSET_BASE 分支，不能写死一处地址");
  // 未传 assets 时的回退值必须还是原来那两个 CDN 地址（桌面端读到的就是这条分支）
  assert.ok(
    shared.includes("https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"),
    "桌面端回退地址必须保持原样（未传 assets 时不得改变既有行为）"
  );
  assert.ok(
    shared.includes("https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"),
    "桌面端回退地址必须保持原样（未传 assets 时不得改变既有行为）"
  );
  // 云端必须真的带上这个参数，否则还是会去请求 CDN
  assert.match(
    cloudApp,
    /new Worker\(`\/markdown-worker\.js\?v=\$\{ASSET_V\}&assets=\/vendor\/`\)/,
    "云端必须以 assets=/vendor/ 创建渲染 worker"
  );
  // 自托管目录里的文件名必须与 worker 拼出来的路径对得上
  assert.ok(shared.includes('ASSET_BASE + "chartjs/chart.umd.js"'), "worker 的 chart 路径写法变了，需同步 vendor 目录");
  assert.ok(shared.includes('ASSET_BASE + "echarts/echarts.min.js"'), "worker 的 echarts 路径写法变了，需同步 vendor 目录");
});

test("自托管脚本钉死精确版本，不得使用浮动 tag", () => {
  const src = read("scripts/vendor-cloud.mjs");
  // 原先页面用的是 `@dev` 这种浮动 tag（今天指向 0.1.3-dev.c090db7.…），
  // 上游一发新版就会静默换掉线上运行的代码。自托管必须钉到精确版本。
  for (const bad of ["@dev/", "@latest/", "@next/", "@beta/", "@canary/"]) {
    assert.ok(!src.includes(bad), `vendor 脚本不应使用浮动 tag ${bad}`);
  }
  // 每条依赖都必须形如 name@x.y.z（或带 dev 后缀的完整版本号）
  const pkgs = [...src.matchAll(/pkg:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(pkgs.length >= 5, `应声明至少 5 条依赖，实测 ${pkgs.length}`);
  for (const p of pkgs) {
    const name = p.startsWith("@") ? p.split("/").slice(0, 2).join("/") : p.split("/")[0];
    assert.match(name, /@\d+\.\d+\.\d+/, `依赖必须钉死精确版本：${p}`);
  }
  // katex 的样式与字体必须同版本，否则 CSS 里声明的字形会对不上字体文件
  const katexVers = [...new Set((src.match(/katex@[\d.]+/g) || []))];
  assert.equal(katexVers.length, 1, `katex 版本必须唯一，实测 ${katexVers.join(" / ")}`);
});
