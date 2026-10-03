// RAG 关键词检索 0 段回归测试
//
// 症状：知识库问答徽标显示「关键词模式 · 0 段」，检索文档中确定存在的关键词
//（如「剑魔」）永远回答「检索到的文档中未包含相关内容」。
//
// 根因一（致命）：ai_reindex 用 std::mem::take 把 all_chunks 清空后，
//   Manifest.chunk_count 仍取 all_chunks.len()（恒 0）、写 chunks.ndjson 的循环遍历的
//   也是空数组 → v2.1.1（9335a9d）起「重建索引」落盘的一直是空索引；
//   而 toast 里的 chunkCount 用的是先算好的局部变量，显示正常，极具迷惑性。
// 根因二（体验）：索引只会在设置面板手动「重建索引」时构建，问答面板既不检查也不提示。
// 根因三（召回）：TOKEN_RE 把连续汉字当一整个 token，「剑魔伤害高」与 chunk.tokens
//   精确相等的概率几乎为零 → 中文整句提问即使索引正常也召回极低。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const handlersSrc = read("src-tauri", "src", "handlers.rs");
const ragSrc = read("src-tauri", "src", "rag.rs");
const appSrc = read("public", "app.js");

function fnBody(src, fnName, endMarker) {
  const start = src.indexOf(fnName);
  assert.ok(start >= 0, `未找到 ${fnName}`);
  const end = endMarker ? src.indexOf(endMarker, start) : -1;
  assert.ok(end > start, `未找到 ${fnName} 的结束边界 ${endMarker}`);
  return src.slice(start, end);
}

test("ai_reindex 落盘的必须是真实索引（修复 mem::take 清空后仍引用）", () => {
  const body = fnBody(handlersSrc, "async fn ai_reindex", "/// POST /api/ai/query");
  assert.ok(
    !body.includes("mem::take(&mut all_chunks)"),
    "不得用 mem::take 提前清空 all_chunks（后续写盘与 manifest 都还要用它）"
  );
  assert.ok(
    !body.includes("chunk_count: all_chunks.len()"),
    "Manifest.chunk_count 不得引用已被移交/清空的 all_chunks"
  );
  assert.ok(
    body.includes("let chunk_count = all_chunks.len();") && body.includes("\n        chunk_count,"),
    "chunk_count 必须在分块数组仍完整时先算好，并用于 Manifest"
  );

  // 移交内存必须发生在 chunks.ndjson 写盘循环之后
  const moveIdx = body.indexOf("*chunks_ref = all_chunks;");
  assert.ok(moveIdx > 0, "索引必须完整移交到 rag.chunks（直接 move，不 clone）");
  const writeLoopIdx = body.indexOf("for c in &all_chunks");
  assert.ok(writeLoopIdx > 0, "chunks.ndjson 写盘循环必须遍历 all_chunks");
  assert.ok(
    moveIdx > writeLoopIdx,
    "移交内存必须在写盘循环之后，否则写出的 chunks.ndjson 是空文件"
  );
});

test("中文长查询词做 bigram 扩展（整句提问也能命中片段词）", () => {
  const body = fnBody(ragSrc, "pub fn lexical_search", "unsafe fn bytes_as_f32");
  assert.ok(body.includes("cjk_bigrams("), "lexical_search 必须对查询词做 CJK bigram 扩展");
  assert.ok(ragSrc.includes("fn cjk_bigrams"), "缺少 cjk_bigrams 辅助函数");
  assert.ok(ragSrc.includes("fn is_cjk_token"), "缺少 is_cjk_token 辅助函数");
  // 只扩展查询侧，且必须有数量上限（防超长提问拖慢 O(chunks × tokens) 扫描）
  assert.ok(
    body.includes("added >= 64"),
    "bigram 扩展必须有数量上限（64），防止 O(chunks × tokens) 扫描失控"
  );
  // 评分逻辑不得改动：title/heading/text 加权与 token_set 命中保持原样
  for (const [frag, weight] of [["token_set.contains(tok)", "3.0"], ["title_lower.contains(tok)", "4.0"], ["heading_lower.contains(tok)", "5.0"], ["text_lower.contains(tok)", "1.0"]]) {
    assert.ok(body.includes(frag), `评分项缺失：${frag}`);
  }
  assert.ok(
    ragSrc.includes("fn test_lexical_search_cjk_bigram_hit"),
    "缺少 Rust 单测：中文整句命中片段词"
  );
});

test("打开问答面板时，空索引自动补建（仅一次、可跳过）", () => {
  const drawer = fnBody(appSrc, "function toggleAiDrawer", "async function ensureAiIndexReady");
  assert.ok(drawer.includes("ensureAiIndexReady()"), "打开面板时必须调用 ensureAiIndexReady");

  const guard = fnBody(appSrc, "async function ensureAiIndexReady", "async function jumpToAiSource");
  assert.ok(
    guard.includes("autoIndexAttempted"),
    "必须用 autoIndexAttempted 保证会话内只尝试一次"
  );
  assert.ok(
    guard.includes('chunkCount') && guard.includes("return;"),
    "索引非空（chunkCount > 0）时必须直接返回，不得重复全库扫描"
  );
  assert.ok(
    guard.includes('"/api/ai/reindex"'),
    "空索引时必须触发 /api/ai/reindex"
  );
  assert.ok(
    guard.includes("loadAiStatus()"),
    "重建完成后必须刷新徽标状态"
  );
});
