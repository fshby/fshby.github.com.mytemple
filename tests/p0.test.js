import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDocumentTemplate, frontmatterSummary, normalizeFrontmatter } from "../server/frontmatter.js";
import { defaultAgentRules, loadAgentPolicy, policyAllows } from "../server/agent-policy.js";
import { RagService, chunkMarkdown } from "../server/rag.js";

test("Frontmatter template contains the P0 schema and remains parseable", () => {
  const template = createDocumentTemplate("测试文档", "2026-07-22");
  const summary = frontmatterSummary(template);
  assert.equal(summary.metadata.schema, "mytemple/v1");
  assert.equal(summary.metadata.title, "测试文档");
  assert.equal(summary.metadata.status, "draft");
  assert.deepEqual(summary.metadata.tags, []);
  assert.equal(summary.standard, true);
});

test("Frontmatter normalization preserves unknown metadata and body", () => {
  const source = `---\ncustom: keep-me\ntags:\n  - old\n---\n\n# 标题\n\n正文`;
  const result = normalizeFrontmatter(source, { tags: ["new"], domain: "工程" });
  assert.match(result, /custom: keep-me/);
  assert.match(result, /domain: 工程/);
  assert.match(result, /- new/);
  assert.match(result, /# 标题/);
  assert.match(result, /正文/);
});

test("Markdown chunks retain heading and source line metadata", () => {
  const chunks = chunkMarkdown({ path: "default:test.md", title: "测试", content: "# 主题\n\n第一段内容，包含 Docker 和内存。\n\n## 排查\n\n第二段内容。" });
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].heading, "主题");
  assert.ok(chunks.every((chunk) => chunk.startLine >= 1 && chunk.endLine >= chunk.startLine));
});

test("RAG service supports persistent keyword fallback without Ollama", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-rag-"));
  try {
    const rag = new RagService(root);
    await rag.initialize();
    const files = [{
      path: "default:docker.md",
      workspaceId: "default",
      title: "Docker 排查",
      contentSha256: "docker-v1",
      content: "# Docker 内存\n\n容器内存溢出时先检查 limit 和日志。",
    }];
    await rag.rebuild(files, "version-1");
    const result = await rag.retrieve("容器内存溢出", { scope: "all" });
    assert.equal(result.retrievalMode, "keyword");
    assert.equal(result.sources[0].path, "default:docker.md");
    const answer = await rag.ask("如何排查容器内存？");
    assert.equal(answer.answerMode, "retrieval-only");
    const persisted = JSON.parse(await readFile(path.join(root, "rag", "manifest.json"), "utf8"));
    assert.equal(persisted.knowledgeVersion, "version-1");
    assert.ok(persisted.chunkCount >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent policy defaults to confirm mode and supports scoped rules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-policy-"));
  try {
    await writeFile(path.join(root, "AGENTS.md"), defaultAgentRules(), "utf8");
    const policy = await loadAgentPolicy(root);
    assert.equal(policy.exists, true);
    assert.equal(policy.writeMode, "confirm");
    assert.equal(policy.maxFilesPerAction, 20);
    assert.equal(policyAllows(policy, "notes/topic.md"), true);
    assert.equal(policyAllows(policy, ".git/config.md"), false);
    assert.equal(policyAllows(policy, "secret.env"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
