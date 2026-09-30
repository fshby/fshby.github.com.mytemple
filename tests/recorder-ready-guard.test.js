// 录屏窗口 ready 守卫测试
// 目的：防止「冷启动时误弹全屏录屏遮罩」回归。
// 历史：v2.1.24 引入 /api/recorder/ready 显示出口时漏抄了截图侧的 pending 守卫，
// 导致预创建的 recorder 页面 init 无条件发 ready → 后端无条件 show → 启动即触发录屏。
// v2.1.27 修复：前端 fetch /api/recorder/bg 判断真实触发（404 = 预创建自检，不发 ready）；
// 后端 on_recorder_window_ready 加 pending_record_bg 守卫（为空不显示）。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const recorderSrc = fs.readFileSync(path.join(root, "public", "recorder.html"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const captureSrc = fs.readFileSync(path.join(root, "src-tauri", "src", "global_capture.rs"), "utf8");
const handlersSrc = fs.readFileSync(path.join(root, "src-tauri", "src", "handlers.rs"), "utf8");
const libSrc = fs.readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");

test("recorder.html 背景帧走专用端点 /api/recorder/bg（不是截图通道）", () => {
  assert.ok(
    recorderSrc.includes("fetch('/api/recorder/bg'"),
    "recorder.html 应 fetch /api/recorder/bg（真实触发流程的背景帧）"
  );
  assert.ok(
    !recorderSrc.includes("fetch('/api/screenshot/bg'"),
    "recorder.html 不应再 fetch /api/screenshot/bg（截图通道，录屏触发时恒 404）"
  );
});

test("recorder.html 预创建自检（fetch 失败）不得发送 ready", () => {
  // loadBackgroundFrame 的 catch 分支：静默待命，绝不能出现在 catch 块内发 ready
  const fnStart = recorderSrc.indexOf("async function loadBackgroundFrame()");
  assert.ok(fnStart >= 0, "未找到 loadBackgroundFrame");
  const fnEnd = recorderSrc.indexOf("function startRegionSelection()");
  assert.ok(fnEnd > fnStart, "未找到 loadBackgroundFrame 结束边界");
  const body = recorderSrc.slice(fnStart, fnEnd);
  const catchIdx = body.lastIndexOf("} catch (err) {");
  assert.ok(catchIdx >= 0, "loadBackgroundFrame 缺少 catch 分支");
  const catchBlock = body.slice(catchIdx);
  assert.ok(
    !catchBlock.includes("httpPost('/api/recorder/ready')"),
    "catch 分支（预创建自检）里不得发送 /api/recorder/ready，否则冷启动会误弹录屏遮罩"
  );
});

test("后端 on_recorder_window_ready 有 pending_record_bg 守卫", () => {
  const fnStart = captureSrc.indexOf("pub fn on_recorder_window_ready");
  assert.ok(fnStart >= 0, "未找到 on_recorder_window_ready");
  const fnEnd = captureSrc.indexOf("pub fn close_recorder_window");
  assert.ok(fnEnd > fnStart, "未找到 on_recorder_window_ready 结束边界");
  const body = captureSrc.slice(fnStart, fnEnd);
  assert.ok(
    body.includes("pending_record_bg().lock()") && body.includes("has_pending_bg"),
    "on_recorder_window_ready 开头必须检查 pending_record_bg，为空时不得显示窗口"
  );
  assert.ok(
    !body.includes('emit("record-bg-data"'),
    "record-bg-data emit 已删除（前端从不监听，死代码）"
  );
});

test("后端提供 GET /api/recorder/bg 端点", () => {
  assert.ok(
    handlersSrc.includes('.route("/api/recorder/bg", get(recorder_bg_http))'),
    "handlers.rs 缺少 /api/recorder/bg 路由"
  );
  assert.ok(
    handlersSrc.includes("async fn recorder_bg_http()"),
    "handlers.rs 缺少 recorder_bg_http 处理器"
  );
  assert.ok(
    captureSrc.includes("pub fn get_pending_record_bg_bytes()"),
    "global_capture.rs 缺少 get_pending_record_bg_bytes"
  );
});

// ── 动态画面采集（v2.1.27）──────────────────────────────────
// 历史：输出 canvas 用 left:-99999px + opacity:0 → Chromium 判定不可见、停帧 → 录像静止。

test("输出 canvas 必须留在视口内且 opacity 非 0（captureStream 才会持续产帧）", () => {
  assert.ok(
    recorderSrc.includes("opacity:0.01"),
    "recorder.html 输出 canvas 应使用 opacity:0.01（非 0）以保证参与合成"
  );
  assert.ok(
    !/outCanvas\.style\.cssText = '[^']*left:-99999px/.test(recorderSrc),
    "recorder.html 输出 canvas 不得移出屏幕（完全离屏会导致 captureStream 停帧）"
  );
  assert.ok(
    !/outCanvas\.style\.cssText = '[^']*opacity:0;/.test(recorderSrc),
    "recorder.html 输出 canvas 不得使用 opacity:0"
  );

  const fnStart = appSrc.indexOf("function _startNativeRecord");
  assert.ok(fnStart >= 0, "未找到 _startNativeRecord");
  const fnEnd = appSrc.indexOf("async function _stopNativeRecord");
  const body = appSrc.slice(fnStart, fnEnd);
  assert.ok(body.includes("document.body.appendChild(canvas)"), "主窗口路径的 canvas 必须加入 DOM");
  assert.ok(body.includes("opacity:0.01"), "主窗口路径的 canvas 应使用 opacity:0.01");
});

test("后端按选区裁剪并编码 JPEG（避免全屏 PNG 的每帧数百 ms + 数 MB IPC）", () => {
  assert.ok(captureSrc.includes("fn encode_region_jpeg"), "缺少 encode_region_jpeg");
  assert.ok(
    captureSrc.includes("image::codecs::jpeg::JpegEncoder"),
    "应使用 JPEG 编码器"
  );
  assert.ok(
    captureSrc.includes("data:image/jpeg;base64"),
    "发给前端的 dataUrl 应为 image/jpeg"
  );
  assert.ok(
    !captureSrc.includes("encode_rgba_to_png"),
    "不应再使用全屏 PNG 编码路径"
  );
  assert.ok(
    captureSrc.includes("pub fn set_record_region") && captureSrc.includes("pub fn clear_record_region"),
    "缺少选区设置/清理接口"
  );
});

test("前端开始录制时向后端下发选区，后端命令接受 region 参数", () => {
  assert.ok(
    recorderSrc.includes("api_start_native_record', { region: regionArg }"),
    "recorder.html 调用 api_start_native_record 时应传入 region"
  );
  assert.ok(
    appSrc.includes("region: { x: region.x, y: region.y, w: region.w, h: region.h, dpr }"),
    "app.js 主窗口路径调用时应传入 region"
  );
  assert.ok(
    libSrc.includes("region: Option<RecordRegionArg>"),
    "api_start_native_record 应接受可选 region 参数"
  );
});
