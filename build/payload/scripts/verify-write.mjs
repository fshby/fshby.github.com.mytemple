import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "mytemple-api-"));
const docs = path.join(root, "docs");
const source = path.join(root, "source");
await mkdir(docs);
await mkdir(source);

const child = spawn(process.execPath, ["server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: "4199",
    MYTEMPLE_DOCS_ROOT: docs,
    MYTEMPLE_SOURCE_ROOT: source,
  },
  stdio: "ignore",
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(route) {
  const response = await fetch(`http://127.0.0.1:4199${route}`);
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  return response.json();
}

async function postJson(route, body) {
  const response = await fetch(`http://127.0.0.1:4199${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

try {
  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    await wait(150);
    try {
      await getJson("/api/tree");
      ready = true;
      break;
    } catch {
      // Keep polling until the child process starts listening.
    }
  }
  if (!ready) throw new Error("Server did not start on port 4199");

  await postJson("/api/create-folder", { parent: "", name: "测试文件夹" });
  await postJson("/api/create-doc", { parent: "测试文件夹", name: "实时保存测试" });
  await postJson("/api/save", {
    path: "测试文件夹/实时保存测试.md",
    content: "# 实时保存测试\n\n已自动保存。",
  });
  writeFileSync(path.join(docs, "plain-note.txt"), "# plain note\n");
  const converted = await postJson("/api/normalize-md", {});

  const doc = await getJson(`/api/doc?path=${encodeURIComponent("测试文件夹/实时保存测试.md")}`);
  const expectedFile = path.join(docs, "测试文件夹", "实时保存测试.md");
  if (!existsSync(expectedFile)) throw new Error("Created document was not written to the configured docs root");
  if (!doc.content.includes("已自动保存")) throw new Error("Saved content was not returned by /api/doc");
  if (!existsSync(path.join(docs, "plain-note.md"))) throw new Error("Non-md file was not converted to .md");
  if (converted.changed < 1) throw new Error("normalize-md did not report converted files");

  console.log(JSON.stringify({
    ok: true,
    docsRoot: docs,
    created: doc.path,
    converted: converted.changed,
  }, null, 2));
} finally {
  child.kill();
  await rm(root, { recursive: true, force: true });
}
