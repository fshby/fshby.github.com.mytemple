import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createDocumentTemplate, frontmatterSummary, normalizeFrontmatter } from "../server/frontmatter.js";
import { defaultAgentRules, loadAgentPolicy, policyAllows } from "../server/agent-policy.js";
import { RagService, chunkMarkdown, fallbackTransformSelection } from "../server/rag.js";

test("License deactivation is exposed as a dedicated credential removal route", async () => {
  const serverSource = await readFile(path.join(process.cwd(), "server.js"), "utf8");
  const appSource = await readFile(path.join(process.cwd(), "public/app.js"), "utf8");
  assert.match(serverSource, /\/api\/license\/deactivate/);
  assert.match(serverSource, /unlink\(licenseFile\)/);
  assert.match(appSource, /api\.post\("\/api\/license\/deactivate"/);
  assert.match(appSource, /授权已解除，请重新授权/);
  assert.match(serverSource, /code: "LICENSE_REQUIRED"/);
  assert.match(appSource, /license-locked/);
  assert.match(appSource, /license-required/);
});

test("AI edit hint acceptance writes the suggested markdown back to its original paragraph", async () => {
  const appSource = await readFile(path.join(process.cwd(), "public/app.js"), "utf8");
  assert.match(appSource, /if \(action === "rewrite"\) applyAiHintRewrite\(suggestion, para\)/);
  assert.match(appSource, /insertAiHintComment\(suggestion, para\)/);
  assert.match(appSource, /function replaceEditorRange\(value, start, end, selectionMode = "end"\)/);
  assert.match(appSource, /function resolveAiEditorRange\(range\)/);
  assert.match(appSource, /els\.editor\.dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
  assert.match(appSource, /aiTransformGenerateBtn/);
  assert.match(appSource, /preserveInstruction: true/);
  assert.match(appSource, /state\.currentPath !== requestPath/);
  assert.match(appSource, /els\.editor\.value !== requestContent/);
  assert.match(appSource, /result\.answerMode === "local-fallback"/);
  assert.match(appSource, /AI 没有生成不同内容/);
  assert.match(appSource, /return saveCurrentDoc\(\{ keepEditorState: true, renderAfterSave: false \}\)/);
});

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

test("Selection transforms keep an offline fallback for all P1 modes", () => {
  const source = "Docker 内存溢出时先检查容器限制。随后查看应用日志并确认异常请求。";
  assert.match(fallbackTransformSelection(source, "summary"), /Docker/);
  assert.match(fallbackTransformSelection(source, "keypoints"), /- /);
  assert.match(fallbackTransformSelection(source, "terms"), /解析|术语|docker/);
});

test("AI settings reject unsafe service protocols", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-rag-settings-"));
  try {
    const rag = new RagService(root);
    await assert.rejects(() => rag.updateSettings({ baseUrl: "file:///secret" }), /HTTP/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DeepSeek credentials stay server-side and are preserved when the UI leaves the key blank", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-rag-secret-"));
  try {
    const rag = new RagService(root);
    await rag.updateSettings({
      chatProvider: "deepseek",
      deepseekApiKey: "sk-test-secret",
      deepseekChatModel: "deepseek-chat",
    });
    const publicSettings = rag.publicSettings();
    assert.equal(publicSettings.deepseekApiKey, undefined);
    assert.equal(publicSettings.deepseekApiKeyConfigured, true);
    await rag.updateSettings({ chatProvider: "deepseek", deepseekApiKey: undefined });
    assert.equal(rag.chatConfigured(), true);
    assert.equal(rag.settings.deepseekApiKey, "sk-test-secret");
    const compatibility = await rag.configuredModelCompatibility(undefined, "", "", {
      provider: "deepseek",
      deepseekModel: "deepseek-chat",
    });
    assert.equal(compatibility.compatibility.chat.installed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI transforms reject oversized selections instead of silently truncating them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-rag-transform-limit-"));
  try {
    const rag = new RagService(root);
    await assert.rejects(
      () => rag.transformSelection("x".repeat(16001), "polish"),
      /16000/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Embedding capability check rejects chat-only models with a clear remedy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-rag-capability-"));
  const server = createServer((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "This server does not support embeddings" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const rag = new RagService(root);
    await assert.rejects(
      () => rag.testEmbeddingModel(`http://127.0.0.1:${address.port}`, "gemma4:12b"),
      /qwen3-embedding/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("Failed embedding jobs are recorded and not scheduled forever", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-rag-retry-"));
  const server = createServer((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "This server does not support embeddings" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const rag = new RagService(root);
    await rag.updateSettings({
      baseUrl: `http://127.0.0.1:${address.port}`,
      embeddingModel: "gemma4:12b",
      chatModel: "gemma4:12b",
    });
    const files = [{
      path: "default:test.md",
      workspaceId: "default",
      title: "测试",
      contentSha256: "failed-embed-v1",
      content: "# 测试\n\n这是一段用于验证失败索引状态的文档内容。",
    }];
    await rag.rebuild(files, "failed-version");
    assert.equal(rag.manifest.requestedEmbeddingModel, "gemma4:12b");
    assert.equal(rag.status().mode, "keyword");
    rag.schedule(files, "failed-version");
    assert.equal(rag.pending, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
