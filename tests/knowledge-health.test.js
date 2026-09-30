// 知识脉络健康度测试
// 目的：防止「点击『分析知识脉络』没有任何数据」回归。
// 历史：旧实现原本在 Node 后端 server.js:2332-2410，2026-09-28 大清理时随整个
// Node 后端被删除；Rust 侧 /api/knowledge/health 只返回通用服务健康检查
// （status/version/workspaces/...），前端期待的 stats/missingTags/healthScore
// 全部缺失 → 界面计数恒 0、评分 0 分，且请求 200 所以不报错，表现为「点了没效果」。
// v2.1.27 修复：Rust 端补回完整实现（链接 40 / 标签 30 / 活跃 20 / 概念 10）。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const ipcSrc = read("src-tauri", "src", "ipc.rs");
const handlersSrc = read("src-tauri", "src", "handlers.rs");
const appRsSrc = read("src-tauri", "src", "app.rs");
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

test("后端 knowledge_health 返回完整字段，不再转发通用服务健康检查", () => {
  const body = fnBody(ipcSrc, "pub async fn knowledge_health", "fn doc_ref");
  assert.ok(
    !body.includes("health_check"),
    "knowledge_health 不得再返回 app.health_check() 的通用服务状态"
  );
  for (const field of ['"stats"', '"missingTags"', '"missingLinks"', '"staleDocs"', '"healthScore"', '"scoreBreakdown"']) {
    assert.ok(body.includes(field), `knowledge_health 响应缺少字段 ${field}`);
  }
  for (const label of ['"链接密度"', '"标签覆盖"', '"知识活跃"', '"概念关联"']) {
    assert.ok(body.includes(label), `评分维度缺少 ${label}`);
  }
  assert.ok(body.includes("days.clamp(1, 365)"), "days 必须夹到 1..365");
});

test("缺链接按真实 link 边统计（不能用图谱 orphan，它含 tag/keyword 边）", () => {
  const body = fnBody(ipcSrc, "pub async fn knowledge_health", "fn doc_ref");
  assert.ok(
    body.includes('"link" => &mut link_degree'),
    "missingLinks 必须只统计 link 边（对齐旧实现 outgoingLinks/backlinks 语义）"
  );
  assert.ok(
    !body.includes("orphan"),
    "不得用 GraphNode.orphan 代替链接维度（tag/keyword 边也会计入 degree）"
  );
  assert.ok(body.includes('"keyword" => &mut concept_degree'), "概念关联应统计 keyword 边");
});

test("图谱与知识脉络共用 to_graph_files 转换（正文懒加载必须回填）", () => {
  assert.ok(ipcSrc.includes("async fn to_graph_files"), "缺少 to_graph_files");
  const body = fnBody(ipcSrc, "async fn to_graph_files", "pub async fn get_version");
  assert.ok(body.includes("read_file_force"), "content 为 None 的文件必须触发磁盘读取");
  const graphBody = fnBody(ipcSrc, "pub async fn get_graph", "pub async fn move_entry");
  assert.ok(graphBody.includes("to_graph_files"), "get_graph 应复用 to_graph_files，避免两份转换逻辑");
});

test("浏览记录已挂到 AppState，且 get_doc 成功时写入", () => {
  assert.ok(
    appRsSrc.includes("pub doc_views: Arc<crate::doc_views::DocViewStore>"),
    "AppState 缺少 doc_views 字段（v2.1.26 前该模块全库无引用，浏览记录从未被记录）"
  );
  assert.ok(
    appRsSrc.includes("crate::doc_views::DocViewStore::new(&data_root)"),
    "AppState::new 必须构造 DocViewStore"
  );
  const docBody = fnBody(ipcSrc, "pub async fn get_doc", "pub async fn check_doc");
  assert.ok(
    docBody.includes("doc_views.record("),
    "get_doc 成功路径必须记录浏览（知识脉络「待温习」的唯一数据源）"
  );
});

test("days 参数贯通 HTTP / IPC / 前端三处", () => {
  assert.ok(
    handlersSrc.includes("struct KnowledgeHealthQuery") && handlersSrc.includes("days: Option<u32>"),
    "HTTP handler 应解析 days 查询参数"
  );
  assert.ok(
    handlersSrc.includes("crate::ipc::knowledge_health(&state, days)"),
    "handlers 应把 days 传给 ipc 层"
  );
  assert.ok(
    libSrc.includes("pub async fn api_knowledge_health(s: Srv<'_>, days: Option<u32>)"),
    "Tauri 命令应接受 days 参数"
  );
  const mapLine = appSrc.split("\n").find((l) => l.includes('"/api/knowledge/health"'));
  assert.ok(mapLine, "app.js IPC_ROUTE_MAP 缺少 /api/knowledge/health");
  assert.ok(
    mapLine.includes("days") && mapLine.includes("Number("),
    "IPC 映射必须把 days 从 query 字符串转成数字（否则 Option<u32> 反序列化会报类型错误）"
  );
});
