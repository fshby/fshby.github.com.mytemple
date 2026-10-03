// AI 写入守卫（工作区规则 .mytemple/AGENTS.md）测试
//
// 背景：v2.1.27 之前 `agent_policy::policy_allows` 与 `append_audit_record` 全库零引用，
// UI 承诺的「规则文件约束 AI 的读写范围」没有任何执行点，audit/operations.ndjson 也从未写入。
// 本次把规则接到 AI 写入链路，唯一执行入口是 `guard_ai_write`。
//
// 铁律（防止后续改动破坏既有功能）：
//   - 只有请求显式带 origin: "ai" 才校验；人类保存/导入/任务勾选一律不校验；
//   - 工作区没有 AGENTS.md 时一律放行（policy.exists == false），行为与旧版本逐字节一致；
//   - 只有 deniedPaths 与 writeMode=readonly 会硬拒绝；allowedPaths 仅留痕不阻断，
//     否则用户在编辑器里让 AI 改写 .txt 会突然失败（破坏既有功能）。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const policySrc = read("src-tauri", "src", "agent_policy.rs");
const ipcSrc = read("src-tauri", "src", "ipc.rs");
const handlersSrc = read("src-tauri", "src", "handlers.rs");
const libSrc = read("src-tauri", "src", "lib.rs");
const appSrc = read("public", "app.js");

/** 截取 src 中 fnName 到 endMarker 之间的函数体 */
function fnBody(src, fnName, endMarker) {
  const start = src.indexOf(fnName);
  assert.ok(start >= 0, `未找到 ${fnName}`);
  const end = endMarker ? src.indexOf(endMarker, start) : -1;
  assert.ok(end > start, `未找到 ${fnName} 的结束边界 ${endMarker}`);
  return src.slice(start, end);
}

test("guard_ai_write 存在，且规则文件不存在时提前放行", () => {
  const body = fnBody(policySrc, "pub fn guard_ai_write", "#[cfg(test)]");
  assert.ok(
    body.includes("if !policy.exists"),
    "必须先在 policy.exists == false 时返回，保证未创建规则文件的用户零感知"
  );
  // 该提前返回必须出现在任何拒绝分支之前
  const absentIdx = body.indexOf("if !policy.exists");
  const denyIdx = body.indexOf("allowed: false");
  assert.ok(denyIdx > absentIdx, "「无规则文件」分支必须早于任何拒绝分支");
});

test("只有 deniedPaths 与 readonly 会硬拒绝，allowedPaths 仅留痕", () => {
  const body = fnBody(policySrc, "pub fn guard_ai_write", "#[cfg(test)]");
  assert.ok(body.includes("first_match(&policy.denied_paths"), "deniedPaths 必须参与判定");
  assert.ok(
    body.includes('eq_ignore_ascii_case("readonly")'),
    "writeMode = readonly 必须拒绝"
  );
  assert.ok(
    body.includes("outside_allowed_paths: outside"),
    "allowedPaths 之外的路径只标记不阻断（避免 AI 改写 .txt 时突然失败）"
  );
  // 拒绝分支只应有两处 allowed: false（deniedPaths / readonly）
  const denyCount = (body.match(/allowed: false/g) || []).length;
  assert.strictEqual(denyCount, 2, `拒绝分支应恰好 2 处，实际 ${denyCount} 处`);
});

test("check_ai_write 只对 origin === \"ai\" 生效", () => {
  const body = fnBody(ipcSrc, "async fn check_ai_write", "async fn record_ai_write");
  assert.ok(
    body.includes('if origin != Some("ai")') && body.includes("return Ok(None)"),
    "非 AI 来源（人类编辑、导入、任务勾选）必须直接放行，不得进入规则校验"
  );
  assert.ok(
    body.includes("if !policy.exists"),
    "工作区没有 AGENTS.md 时必须放行（Ok(None)，不产生审计）"
  );
  assert.ok(
    body.includes("guard_ai_write"),
    "必须复用 agent_policy::guard_ai_write，不得另写一套判定"
  );
  assert.ok(body.includes("Err("), "规则拒绝时必须返回 Err 让调用方中止写入");
});

test("两条保存链路都在写盘前校验、写盘成功后才审计", () => {
  const fileRaw = fnBody(ipcSrc, "pub async fn save_file_raw", "pub async fn delete_file");
  const saveDoc = fnBody(ipcSrc, "pub async fn save_doc", "pub async fn delete_docs");
  for (const [name, body] of [["save_file_raw", fileRaw], ["save_doc", saveDoc]]) {
    assert.ok(body.includes("check_ai_write"), `${name} 缺少 AI 写入校验`);
    const guardIdx = body.indexOf("check_ai_write");
    const writeIdx = body.indexOf("save_file(");
    assert.ok(writeIdx > guardIdx, `${name} 必须先校验后写盘`);
    assert.ok(body.includes("record_ai_write"), `${name} 写盘成功后必须补审计记录`);
  }
  // save_doc 的冲突分支（未真正写盘）不应产生审计
  const conflictIdx = saveDoc.indexOf("conflict");
  const auditIdx = saveDoc.indexOf("record_ai_write");
  assert.ok(auditIdx < conflictIdx, "审计应在成功分支内，冲突分支不得审计");
});

test("origin 从 HTTP / IPC / 前端三处贯通到 ipc 层", () => {
  assert.ok(
    handlersSrc.includes("crate::ipc::save_doc(&state, req.path, req.content, req.base_hash, req.origin)"),
    "handlers::save_doc 未透传 origin"
  );
  assert.ok(
    handlersSrc.includes("crate::ipc::save_file_raw(&state, req.path, req.content, req.origin)"),
    "handlers::save_file 未透传 origin"
  );
  assert.ok(
    handlersSrc.includes("origin: Option<String>"),
    "两个请求结构体都应声明可选 origin 字段（#[serde(default)] 保证旧请求不缺键报错）"
  );
  assert.ok(
    libSrc.includes("api_save_doc(") &&
      libSrc.includes("base_hash: Option<String>, origin: Option<String>"),
    "Tauri 命令 api_save_doc 应接受 origin"
  );
  assert.ok(
    /api_save_file\(s: Srv<'_>, path: String, content: String, origin: Option<String>\)/.test(libSrc),
    "Tauri 命令 api_save_file 应接受 origin"
  );

  const saveLine = appSrc.split("\n").find((l) => l.includes('"/api/save",'));
  assert.ok(saveLine && saveLine.includes("origin: p.origin"), "IPC 映射 /api/save 必须带上 origin");
  const fileLine = appSrc.split("\n").find((l) => l.includes('"/api/file/save",'));
  assert.ok(fileLine && fileLine.includes("origin: p.origin"), "IPC 映射 /api/file/save 必须带上 origin");
});

test("前端只在 AI 写入路径标注 origin: \"ai\"", () => {
  const marked = appSrc.split("\n").filter((l) => l.includes('origin: "ai" })'));
  assert.strictEqual(
    marked.length,
    2,
    `应恰好 2 处 AI 写入标记（AI 内容插入 / AI 新建整理文档），实际 ${marked.length} 处`
  );

  const rangeBody = fnBody(appSrc, "async function replaceEditorRange", "function insertAtCursor");
  assert.ok(
    rangeBody.includes('origin: "ai"'),
    "replaceEditorRange 服务于 AI 内容写入，必须标注来源"
  );

  const createBody = fnBody(appSrc, "async function createAiTransformDocument", "function aiEditHintEnabled");
  assert.ok(createBody.includes('origin: "ai"'), "AI 新建整理文档写盘必须标注来源");

  const saveBody = fnBody(appSrc, "async function saveCurrentDoc", "function clearAutoSaveTimers");
  assert.ok(
    saveBody.includes("origin = undefined"),
    "saveCurrentDoc 的 origin 默认必须为 undefined，保证人类保存路径不被误标为 AI"
  );
  assert.ok(
    (saveBody.match(/\borigin\b/g) || []).length >= 3,
    "saveCurrentDoc 必须把 origin 透传到两处 /api/save 调用"
  );
});

test("agent_action_apply（AI 代理写删入口）已接入规则校验", () => {
  const body = fnBody(handlersSrc, "async fn agent_action_apply", "// ── 授权管理 Handler");
  assert.ok(body.includes("load_agent_policy"), "必须加载工作区规则");
  assert.ok(body.includes("guard_ai_write"), "必须调用写入守卫");
  assert.ok(
    body.includes("policy_allows") && body.includes('req.action == "delete"'),
    "删除不可逆，规则文件存在时须额外要求命中 allowedPaths"
  );
  assert.ok(body.includes("append_audit_record"), "规则文件存在时操作必须留痕");
});
