// 「文档标准与 AI 规则」+「知识标签适配」缺陷修复的防回归测试。
// 历史：三项功能在 Rust 重写时前端契约全部对不上 ——
//   ① preview_frontmatter 返回 frontmatter 键值对，前端期待 {before,after,changed,baseHash}
//      → 弹窗显示 undefined、「确认应用」永久禁用（!undefined === true）；apply 无备份无审计。
//   ② handlers 接的是 agent_policy.rs 里自造的 JSON 版（.mytemple/agent-policy.json，
//      writeMode:"safe"），而读 .mytemple/AGENTS.md 的那套实现全库零引用
//      → 用户写的规则文件永不被读取；policy_allows 零引用 = AI 写入从未被策略校验。
//   ③ /api/semantic-tags 后端只收 {text} 返回 {ok,tags}，前端发 {maxTags,apply}
//      期待 {total,changed,changes,applied} → 请求必然失败。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const appRsSrc = read("src-tauri", "src", "app.rs");
const handlersSrc = read("src-tauri", "src", "handlers.rs");
const utilsSrc = read("src-tauri", "src", "utils.rs");
const policySrc = read("src-tauri", "src", "agent_policy.rs");
const frontmatterSrc = read("src-tauri", "src", "frontmatter.rs");

/** 截取 src 中 fnName 到 endMarker 之间的函数体 */
function fnBody(src, fnName, endMarker) {
  const start = src.indexOf(fnName);
  assert.ok(start >= 0, `未找到 ${fnName}`);
  const end = endMarker ? src.indexOf(endMarker, start) : -1;
  assert.ok(end > start, `未找到 ${fnName} 的结束边界 ${endMarker}`);
  return src.slice(start, end);
}

test("文档标准：preview 返回前端弹窗所需的完整结构", () => {
  const body = fnBody(
    appRsSrc,
    "pub async fn preview_frontmatter",
    "pub async fn apply_frontmatter"
  );
  for (const field of ['"path"', '"baseHash"', '"changed"', '"before"', '"after"', '"summary"']) {
    assert.ok(body.includes(field), `preview_frontmatter 响应缺少字段 ${field}`);
  }
  assert.ok(
    body.includes("crate::frontmatter::normalize_frontmatter"),
    "必须复用 frontmatter.rs 的规范化实现（它已完整移植旧 server/frontmatter.js）"
  );
  assert.ok(
    body.includes("crate::frontmatter::frontmatter_block"),
    "before/after 必须是含 --- 的 frontmatter 块文本"
  );
  assert.ok(
    frontmatterSrc.includes("pub fn frontmatter_block"),
    "frontmatter.rs 应提供 frontmatter_block()"
  );
});

test("文档标准：apply 带原文备份 + 审计记录，且无变化时不写盘", () => {
  const body = fnBody(appRsSrc, "pub async fn apply_frontmatter", "fn backup_document");
  assert.ok(
    body.includes("backup_document"),
    "写盘前必须备份原文（前端 toast「原文已备份」依赖它）"
  );
  assert.ok(body.includes("append_audit_record"), "必须写审计记录（对齐旧 server.js）");
  assert.ok(
    body.includes('"changed": false'),
    "内容无变化时必须返回 changed:false 且不写盘（幂等）"
  );
  const backup = fnBody(appRsSrc, "fn backup_document", "pub async fn health_check");
  assert.ok(backup.includes("backups"), "备份目录应为 data_root/backups");
  assert.ok(backup.includes(".bak"), "备份文件扩展名应为 .bak");
});

test("文档标准：删除残缺的自造 frontmatter 解析", () => {
  assert.ok(
    !appRsSrc.includes("fn extract_frontmatter_block"),
    "应删除只按冒号切分、会丢 YAML 数组/多行的 extract_frontmatter_block"
  );
  assert.ok(
    !appRsSrc.includes("fn frontmatter_summary(content: &str)"),
    "应删除自造的 BTreeMap 版 frontmatter_summary"
  );
  const body = fnBody(
    appRsSrc,
    "pub async fn get_frontmatter",
    "pub async fn preview_frontmatter"
  );
  assert.ok(
    body.includes("crate::frontmatter::split_frontmatter"),
    "get_frontmatter 应复用 split_frontmatter（支持列表值）"
  );
});

test("AI 规则：端点读写 .mytemple/AGENTS.md，自造 JSON 版已删除", () => {
  const getBody = fnBody(handlersSrc, "async fn get_agent_policy", "struct CreateAgentPolicyRequest");
  assert.ok(getBody.includes("load_agent_policy"), "get_agent_policy 应调用 load_agent_policy");
  assert.ok(!getBody.includes("load_policy"), "不得再调用自造的 JSON 版 load_policy");

  const createBody = fnBody(handlersSrc, "async fn create_agent_policy", "// ── 更新检查");
  assert.ok(
    createBody.includes("create_agent_policy_file"),
    "create 应写入 AGENTS.md（前端提示文案承诺的就是这个路径）"
  );

  assert.ok(!handlersSrc.includes("agent-policy.json"), "全库不得再出现 agent-policy.json");
  assert.ok(!policySrc.includes("pub fn load_policy"), "应删除 B 组自造实现 load_policy");
  assert.ok(!policySrc.includes("default_policy_json"), "应删除 B 组自造默认值 default_policy_json");
  assert.ok(policySrc.includes("create_agent_policy_file"), "应提供 create_agent_policy_file");
  assert.ok(
    policySrc.includes('rename_all = "camelCase"'),
    "AgentPolicy 必须以 camelCase 序列化（前端读 writeMode / maxFilesPerAction）"
  );
  assert.ok(
    policySrc.includes(".mytemple") && policySrc.includes("AGENTS.md"),
    "规则文件路径必须是 .mytemple/AGENTS.md"
  );
});

test("AI 规则：policy_allows 有真实执行点（不再只加载不使用）", () => {
  const body = fnBody(
    handlersSrc,
    "async fn agent_action_preview",
    "struct AgentActionApplyRequest"
  );
  assert.ok(body.includes("load_agent_policy"), "应加载 AGENTS.md 规则");
  assert.ok(body.includes("policy_allows"), "必须用 policy_allows 判定目标路径是否允许");
  assert.ok(!body.includes("let _policy"), "不得只加载不使用（历史 _policy 导致规则形同虚设）");
});

test("知识标签：semantic-tags 契约与前端一致", () => {
  const body = fnBody(handlersSrc, "struct SemanticTagsRequest", "struct NormalizeMdRequest");
  assert.ok(body.includes('rename = "maxTags"'), "应接受前端传入的 maxTags");
  assert.ok(body.includes('rename = "workspaceIds"'), "应接受 workspaceIds（旧实现按工作区筛选）");
  for (const field of ['"total"', '"changed"', '"changes"', '"applied"']) {
    assert.ok(body.includes(field), `响应缺少字段 ${field}`);
  }
  assert.ok(body.includes("suggest_semantic_tags"), "应调用全库语义标签算法");
  assert.ok(body.includes("save_file"), "apply=true 时必须写盘");
  assert.ok(
    body.includes('"path": change.path') || body.includes('"path": c.path'),
    "changes 每项必须带 path（前端据此渲染预览行）"
  );
  assert.ok(
    body.includes("extract_semantic_tags"),
    "单文档模式 {text} 应保留（旧契约向后兼容）"
  );
});

test("知识标签：全库算法移植了 IDF + 标题加权 + 保护已有标签", () => {
  const body = fnBody(utilsSrc, "pub fn suggest_semantic_tags", "#[cfg(test)]");
  assert.ok(body.includes("clean_suggested_tag"), "候选词必须规范化");
  assert.ok(body.includes("idf"), "必须计算 IDF");
  assert.ok(body.includes("title_boost"), "标题命中必须加权（旧实现为 3.2）");
  assert.ok(body.includes('"待分类"'), "必须移除占位标签「待分类」");
  assert.ok(body.includes("existing"), "必须保留文档已有标签");
  assert.ok(
    body.includes("min_df") && body.includes("max_df"),
    "必须有文档频率上下界，避免高频噪声词成为标签"
  );

  const replace = fnBody(utilsSrc, "pub fn replace_frontmatter_tags", "pub fn suggest_semantic_tags");
  assert.ok(replace.includes("tags:"), "写回时必须重建 tags 字段");
  assert.ok(
    replace.includes("body_lines") && replace.includes("suffix"),
    "必须只替换 tags 行、保留其它 frontmatter 字段与正文"
  );
});
