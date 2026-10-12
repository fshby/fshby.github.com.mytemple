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
import { readFileSync, existsSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

const cloudHtml = read("cloud/index.html");
const cloudApp = read("cloud/app.js");
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

test("云服务 SDK 通过 CDN 全局形态加载，且初始化在脚本加载之后", () => {
  const sdkTag = cloudHtml.indexOf("workbuddy-cloud-sdk@dev/lib/index.global.js");
  assert.ok(sdkTag > 0, "必须使用 @dev 通道的 IIFE 构建（@latest 未维护）");
  const appTag = cloudHtml.indexOf('src="/app.js');
  assert.ok(appTag > sdkTag, "应用脚本必须在 SDK 之后加载");
  assert.doesNotMatch(cloudHtml, /@tencent-ai\/workbuddy-cloud-sdk@latest/, "不得使用 @latest");
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
  const otpFn = cloudApp.slice(cloudApp.indexOf("async function submitEmailOtp"), cloudApp.indexOf("el.emailForm.addEventListener"));
  assert.match(otpFn, /verificationId:\s*pending\.verificationId/, "verifyOtp 必须带 verificationId");
  assert.match(otpFn, /isExistingUser:\s*pending\.isExistingUser/, "verifyOtp 必须带 isExistingUser");
  assert.match(otpFn, /token:\s*code/, "verifyOtp 必须带用户输入的 token");
  assert.match(otpFn, /password:\s*pending\.isExistingUser\s*\?\s*undefined/, "新邮箱注册才需要密码");
  assert.doesNotMatch(otpFn, /sendOtp/, "提交验证码时不得重新发码");

  // 2) 密码登录
  assert.match(cloudApp, /cloud\.auth\.signInWithPassword\(\{\s*email,\s*password\s*\}\)/, "必须支持邮箱+密码登录");
  const pwdFn = cloudApp.slice(cloudApp.indexOf("el.emailPasswordLogin.addEventListener"));
  assert.match(pwdFn.slice(0, 900), /邮箱或密码不正确/, "密码错误提示不得暴露账号是否存在");

  // 3) 找回密码（有密码登录就必须有找回流程）
  assert.match(cloudApp, /cloud\.auth\.resetPasswordForEmail\(email\)/, "必须支持忘记密码");
  assert.match(cloudApp, /updateUser\(\{\s*nonce:\s*code,\s*password\s*\}\)/, "必须用 nonce + 新密码完成重置");
  assert.match(cloudApp, /length < 8/, "新密码必须有长度校验");

  // 4) 邮箱格式前置校验
  assert.match(cloudApp, /EMAIL_RE\s*=\s*\/\^\[\^\\s@\]\+@/, "必须有邮箱格式校验");
});

test("登录界面三种方式并存，且默认落在邮箱", () => {
  assert.match(cloudHtml, /id="tabEmail"[\s\S]*id="tabPhone"/, "必须有邮箱/手机号切换");
  assert.match(cloudHtml, /id="wechatBtn"[\s\S]*微信登录/, "必须保留微信登录");
  assert.match(cloudApp, /loginTab:\s*"email"/, "默认落在邮箱方式");
  assert.match(cloudApp, /setLoginTab\(state\.loginTab\)/, "启动时应用默认方式");
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
  assert.match(appSrc, /initCloudSync\(\);/, "必须调用 initCloudSync");
  assert.ok(existsSync(new URL("public/modules/cloud-sync.js", ROOT)), "入口模块必须存在");
  // 自包含：样式注入，不修改合并产物 styles.css
  assert.match(desktopEntry, /document\.head\.appendChild\(style\)/, "入口样式应通过 <style> 注入");
  assert.doesNotMatch(desktopEntry, /^import .*from "\.\/toast/m, "入口不得依赖 app.js 作用域内的函数");
});

test("桌面入口不直接向云数据面发请求（发布域名之外会被服务端 Origin 校验拒绝）", () => {
  assert.doesNotMatch(desktopEntry, /\.cloud\//, "桌面入口不得直接打 /.cloud/**");
  assert.doesNotMatch(desktopEntry, /createWorkBuddyCloud/, "桌面入口不初始化云客户端");
  assert.match(desktopEntry, /CLOUD_WORKBENCH_URL/, "必须以「打开云端工作台」的方式引导用户");
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
  assert.ok(cloudHtml.includes("?v=cloud-2"), "云端工作台资源应带自己的缓存戳");
  // 云端三件套（styles.css / cloud-config.js / app.js）必须同版本串，且页面里不残留旧版本
  const cloudVersions = [...cloudHtml.matchAll(/(?:styles\.css|cloud-config\.js|app\.js)\?v=([^"]+)/g)].map((m) => m[1]);
  assert.equal(cloudVersions.length, 3, `云页面应有 3 处主资源引用，实测 ${cloudVersions.length}`);
  assert.equal(new Set(cloudVersions).size, 1, `云页面 ?v= 必须完全一致，实测 ${cloudVersions.join(" / ")}`);
  // 桌面 app.js 内部引用的两个 URL 必须与页面一致，否则 WebView2 会命中旧缓存
  for (const target of ["editor-core.js", "markdown-worker.js"]) {
    const m = appSrc.match(new RegExp(`/${target.replace(".", "\\.")}\\?v=([^"]+)`));
    assert.ok(m, `app.js 必须引用 ${target}`);
    assert.equal(m[1], unique[0], `app.js 的 ${target} 缓存戳必须与 index.html 一致`);
  }
});
