import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["server.js"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});

const base = "http://127.0.0.1:4173";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

try {
  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    await wait(200);
    try {
      await getJson("/api/tree");
      ready = true;
      break;
    } catch {
      // Keep polling until the child process starts listening.
    }
  }
  if (!ready) throw new Error("Server did not start on port 4173");

  const tree = await getJson("/api/tree");
  const search = await getJson("/api/search?q=%E6%90%9C%E7%B4%A2");
  const doc = await getJson("/api/doc?path=README.md");
  const graph = await getJson("/api/graph");

  if (tree.count < 3) throw new Error("Expected sample docs to be indexed");
  if (!search.results.length) throw new Error("Expected search results");
  if (!doc.content.includes("# 文档知识库说明")) throw new Error("Document content mismatch");
  if (!graph.nodes.length) throw new Error("Expected graph nodes");

  console.log(JSON.stringify({
    docs: tree.count,
    searchResults: search.results.length,
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
  }, null, 2));
} finally {
  child.kill();
}
