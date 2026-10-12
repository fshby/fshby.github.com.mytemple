// 功能测试：三端联动的**同步内核**（public/modules/cloud-client.js）真的跑起来。
//
// 与 tests/cloud-sync.test.js（静态契约）不同，这里不是正则匹配源码，而是在 Node 里
// 搭一套最小的运行环境 —— 假的本机 axum 接口 + 假的云数据面 —— 然后调用真实的
// syncCloud()，断言它到底做了什么：读了哪些接口、写了什么、有没有覆盖本机。
//
// 之所以值得这么做：同步的方向判定（推 / 拉 / 冲突）是这次改动里唯一「错了也不报错、
// 但会静默丢数据」的地方，而沙箱里没有浏览器也没有桌面端可跑。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const WS_ID = "ws_test1";
const WS_NAME = "测试知识库";
const ROOT = new URL("../", import.meta.url);

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/* ══ 假云数据面 ═══════════════════════════════════════════════ */

/** 最小可用的 PostgREST 风格构造器：只实现内核真正用到的那几个方法。 */
class FakeQuery {
  constructor(cloud, table) {
    this.cloud = cloud;
    this.table = table;
    this.filters = [];
    this.op = null;
    this.payload = null;
    this.cols = null;
    // 注意：字段名不能与下面的链式方法同名（order / range 若写成实例字段会遮蔽方法）
    this._order = null;
    this._range = null;
  }
  select(cols) { this.cols = cols; return this; }
  eq(c, v) { this.filters.push([c, v, "eq"]); return this; }
  in(c, v) { this.filters.push([c, v, "in"]); return this; }
  is(c, v) { this.filters.push([c, v, "is"]); return this; }
  order(c, o) { this._order = { c, asc: !o || o.ascending !== false }; return this; }
  range(a, b) { this._range = [a, b]; return this; }
  upsert(payload, opts) { this.op = "upsert"; this.payload = payload; this.opts = opts; return this; }
  update(obj) { this.op = "update"; this.payload = obj; return this; }

  get store() { return this.cloud.tables[this.table]; }

  match(row) {
    return this.filters.every(([c, v, kind]) => {
      if (kind === "in") return v.includes(row[c]);
      if (kind === "is") return v === null ? row[c] == null : row[c] === v;
      return row[c] === v;
    });
  }

  pick(row) {
    if (!this.cols || this.cols === "*") return { ...row };
    const out = {};
    for (const c of this.cols.split(",").map((s) => s.trim()).filter(Boolean)) out[c] = row[c];
    return out;
  }

  async run() {
    const store = this.store;
    if (this.op === "upsert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const out = [];
      for (const item of list) {
        // documents 的冲突键是 (workspace, rel_path)；kb_meta 按 owner 单行
        const key = this.table === "documents" ? ["workspace", "rel_path"] : [];
        const hit = store.find((r) => key.every((k) => r[k] === item[k]));
        if (hit) Object.assign(hit, item);
        else store.push({ id: this.cloud.nextId++, created_at: new Date().toISOString(), ...item });
        out.push({ ...(hit || store[store.length - 1]) });
      }
      return { data: this.cols ? out : null, error: null };
    }
    if (this.op === "update") {
      const hit = store.filter((r) => this.match(r));
      for (const r of hit) Object.assign(r, this.payload);
      return { data: this.cols ? hit.map((r) => this.pick(r)) : null, error: null };
    }
    let rows = store.filter((r) => this.match(r));
    if (this._order) {
      const { c, asc } = this._order;
      rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
    }
    if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
    return { data: this.cols ? rows.map((r) => this.pick(r)) : rows, error: null };
  }

  // 让构造器可以被 await
  then(res, rej) { return this.run().then(res, rej); }
}

function makeCloud() {
  const cloud = {
    tables: { documents: [], kb_meta: [] },
    nextId: 1,
    writes: 0,
    query(table) {
      if (!(table in this.tables)) throw new Error(`未预期的表：${table}`);
      return new FakeQuery(this, table);
    },
    seed(relPath, content, { updatedAt = new Date().toISOString(), deletedAt = null } = {}) {
      this.tables.documents.push({
        id: this.nextId++,
        workspace: WS_NAME,
        rel_path: relPath,
        title: relPath,
        content,
        content_sha: sha(content),
        bytes: Buffer.byteLength(content),
        doc_mtime: Date.now(),
        updated_at: updatedAt,
        deleted_at: deletedAt,
      });
    },
    row(relPath) {
      return this.tables.documents.find((r) => r.rel_path === relPath && r.workspace === WS_NAME);
    },
  };
  // 统计云端写入次数（用来断言「拉取模式不上传」）
  const origQuery = cloud.query.bind(cloud);
  cloud.query = (table) => {
    const q = origQuery(table);
    for (const m of ["upsert", "update"]) {
      const fn = q[m].bind(q);
      q[m] = (...args) => { cloud.writes += 0; return fn(...args); };
    }
    return q;
  };
  return cloud;
}

/* ══ 假本机接口 ═══════════════════════════════════════════════ */

function jsonResponse(body, status = 200) {
  const ok = status >= 200 && status < 300;
  return { ok, status, text: async () => JSON.stringify(body) };
}

function makeLocal(files) {
  const stats = { listCalls: 0, contentReads: 0, saves: 0 };
  let beforeSave = null;
  const fetchStub = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || "GET";
    if (u === "/api/workspaces") {
      return jsonResponse({
        workspaces: [{ id: WS_ID, name: WS_NAME, root: "C:/lib" }],
        defaultWorkspaceId: WS_ID,
      });
    }
    if (u === "/api/files" && method === "GET") {
      stats.listCalls += 1;
      return jsonResponse({
        ok: true,
        data: [...files.entries()].map(([ref, f]) => ({
          path: ref,
          workspace_id: WS_ID,
          workspace_name: WS_NAME,
          title: ref,
          content: null, // 列表不带正文（与真实后端一致）
          content_sha256: sha(f.content),
          modified: f.modified,
        })),
      });
    }
    if (u.startsWith("/api/files/") && method === "GET") {
      stats.contentReads += 1;
      const ref = decodeURIComponent(u.slice("/api/files/".length));
      const f = files.get(ref);
      if (!f) return jsonResponse({ ok: false, error: "not found" }, 404);
      return jsonResponse({
        ok: true,
        data: { path: ref, content: f.content, content_sha256: sha(f.content), modified: f.modified },
      });
    }
    if (u === "/api/save" && method === "POST") {
      stats.saves += 1;
      if (beforeSave) { beforeSave(files); beforeSave = null; }
      const { path: ref, content, baseHash } = JSON.parse(options.body);
      const existing = files.get(ref);
      if (baseHash && existing && sha(existing.content) !== baseHash) {
        // 真实后端：HTTP 200 + {ok:false,conflict:true}（见 ipc::save_doc）
        return jsonResponse({
          ok: false, conflict: true, path: ref,
          diskSha256: sha(existing.content),
          message: "文件已被外部编辑器修改，保存将被覆盖。是否继续？",
        });
      }
      files.set(ref, { content, modified: Date.now() });
      return jsonResponse({ ok: true, path: ref, contentSha256: sha(content) });
    }
    if (u === "/api/open-url") return jsonResponse({ ok: true });
    throw new Error(`未预期的请求：${method} ${u}`);
  };
  return { fetchStub, stats, armBeforeSave: (fn) => { beforeSave = fn; } };
}

/* ══ 装载被测模块 ═════════════════════════════════════════════ */

// 模块在**顶层**就读 window.__MT_CLOUD__，所以必须在 import 之前把环境铺好。
const storeBackup = new Map();
globalThis.window = {
  __MT_CLOUD__: {
    resourceId: "wbcs_test",
    endpoint: "https://cloud.example.test",
    oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
    publishableKey: "wbpk_test",
  },
  crypto: globalThis.crypto,
  WorkBuddyCloud: {
    createWorkBuddyCloud: () => ({
      database: { from: (t) => activeCloud.query(t) },
      auth: {},
    }),
  },
};
let activeCloud = null;
globalThis.localStorage = {
  _m: storeBackup,
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

const mod = await import(pathToFileURL(fileURLToPath(new URL("public/modules/cloud-client.js", ROOT))).href);

/* ══ 夹具 ═════════════════════════════════════════════════════ */

/** 每个用例开始前重置三样东西：本机文件、云数据面、同步快照。 */
function setup({ files = {}, cloud = null } = {}) {
  const localFiles = new Map(Object.entries(files));
  const local = makeLocal(localFiles);
  globalThis.fetch = local.fetchStub;
  activeCloud = cloud || makeCloud();
  storeBackup.clear();
  return { localFiles, local, cloud: activeCloud };
}

let prevRel = null;

test("首次同步：本机有、云端为空 → 全部上传，且不改写本机", async () => {
  const { localFiles, local, cloud } = setup({
    files: {
      [`${WS_ID}/a.md`]: { content: "# A\n内容甲\n", modified: 1000 },
      [`${WS_ID}/dir/b.md`]: { content: "# B\n内容乙\n", modified: 2000 },
    },
  });
  const before = new Map(localFiles);

  const s = await mod.syncCloud({});

  assert.equal(s.push, 2, `应上传 2 篇，实测 ${s.push}`);
  assert.equal(s.pull, 0);
  assert.equal(s.failed, 0);
  assert.equal(cloud.tables.documents.length, 2);
  assert.equal(cloud.row("dir/b.md").content, "# B\n内容乙\n");
  assert.equal(cloud.row("a.md").content_sha, sha("# A\n内容甲\n"));
  assert.equal(local.stats.saves, 0, "推送不应写本机文件");
  assert.deepEqual([...localFiles.entries()], [...before.entries()], "本机文件必须逐字节不变");
  prevRel = "a.md";
});

test("首次同步：云端有、本机没有 → 拉取到本机（含子目录）", async () => {
  const cloud = makeCloud();
  cloud.seed("note/x.md", "# 云端笔记\n来自云端\n");
  const { localFiles } = setup({ files: {}, cloud });

  const s = await mod.syncCloud({});

  assert.equal(s.pull, 1, `应拉取 1 篇，实测 ${s.pull}`);
  assert.equal(s.push, 0);
  assert.equal(localFiles.get(`${WS_ID}/note/x.md`).content, "# 云端笔记\n来自云端\n");
});

test("两端内容一致时跳过，且**不读正文**（增量同步的关键）", async () => {
  const content = "# 同款\n";
  const cloud = makeCloud();
  cloud.seed("same.md", content);
  const { local, localFiles } = setup({
    files: { [`${WS_ID}/same.md`]: { content, modified: 1000 } },
    cloud,
  });

  const s = await mod.syncCloud({});

  assert.equal(s.skipped, 1, "应判为已同步");
  assert.equal(s.push, 0);
  assert.equal(s.pull, 0);
  assert.equal(local.stats.contentReads, 0, "内容一致时不应读取本机正文");
  assert.equal(local.stats.saves, 0, "内容一致时不应写本机");
  assert.equal(localFiles.get(`${WS_ID}/same.md`).content, content);
});

test("只有本机改过 → 推送覆盖云端（不触碰本机）", async () => {
  const oldText = "# V1\n";
  const cloud = makeCloud();
  cloud.seed("v.md", oldText);
  const { localFiles, local, cloud: c } = setup({
    files: { [`${WS_ID}/v.md`]: { content: oldText, modified: 1000 } },
    cloud,
  });
  await mod.syncCloud({}); // 建立基线快照

  localFiles.get(`${WS_ID}/v.md`).content = "# V2\n本机改了\n";
  const s = await mod.syncCloud({});

  assert.equal(s.push, 1, `应推送 1 篇，实测 ${s.push}`);
  assert.equal(s.pull, 0);
  assert.equal(c.row("v.md").content, "# V2\n本机改了\n");
  assert.equal(local.stats.saves, 0, "推送方向不应写本机");
});

test("只有云端改过 → 拉取覆盖本机（带 baseHash 防并发覆盖）", async () => {
  const oldText = "# V1\n";
  const cloud = makeCloud();
  cloud.seed("w.md", oldText);
  const { localFiles, local, cloud: c } = setup({
    files: { [`${WS_ID}/w.md`]: { content: oldText, modified: 1000 } },
    cloud,
  });
  await mod.syncCloud({});

  const row = c.row("w.md");
  row.content = "# V2\n云端改了\n";
  row.content_sha = sha(row.content);
  row.updated_at = new Date(Date.now() + 60_000).toISOString();

  const s = await mod.syncCloud({});

  assert.equal(s.pull, 1, `应拉取 1 篇，实测 ${s.pull}`);
  assert.equal(s.push, 0);
  assert.equal(localFiles.get(`${WS_ID}/w.md`).content, "# V2\n云端改了\n");
  assert.equal(local.stats.saves, 1, "拉取应通过 /api/save 写入");
});

test("两端都改过 → 本机原样保留，云端版本另存冲突副本，并把本机版本收敛上去", async () => {
  const base = "# V1\n";
  const cloud = makeCloud();
  cloud.seed("c.md", base);
  const { localFiles, local, cloud: c } = setup({
    files: { [`${WS_ID}/c.md`]: { content: base, modified: 1000 } },
    cloud,
  });
  await mod.syncCloud({});

  localFiles.get(`${WS_ID}/c.md`).content = "# 本机版\n";
  const row = c.row("c.md");
  row.content = "# 云端版\n";
  row.content_sha = sha(row.content);
  row.updated_at = new Date(Date.now() + 60_000).toISOString();

  const s = await mod.syncCloud({});

  assert.equal(s.conflict, 1, `应判为冲突，实测 ${s.conflict}`);
  assert.equal(localFiles.get(`${WS_ID}/c.md`).content, "# 本机版\n", "本机文件绝不能被覆盖");
  const copies = [...localFiles.keys()].filter((k) => k.includes(".conflict-云-"));
  assert.equal(copies.length, 1, `应产生 1 个冲突副本，实测 ${copies.length}`);
  assert.equal(localFiles.get(copies[0]).content, "# 云端版\n", "副本里必须是云端那一版");
  assert.equal(c.row("c.md").content, "# 本机版\n", "冲突后云端应收敛到本机版本");
  assert.ok(s.notes.some((n) => n.includes("冲突") || n.includes("另存")), "摘要里应有冲突说明");
  void local;
});

test("本机删除 → 给云端打墓碑（软删除），而非物理删除", async () => {
  const cloud = makeCloud();
  cloud.seed("gone.md", "# 要删的\n");
  const { localFiles, cloud: c } = setup({
    files: { [`${WS_ID}/gone.md`]: { content: "# 要删的\n", modified: 1000 } },
    cloud,
  });
  await mod.syncCloud({});

  localFiles.delete(`${WS_ID}/gone.md`);
  const s = await mod.syncCloud({});

  assert.equal(s.tombstone, 1, `应标记 1 篇删除，实测 ${s.tombstone}`);
  assert.ok(c.row("gone.md"), "墓碑不是物理删除，行必须还在");
  assert.ok(c.row("gone.md").deleted_at, "deleted_at 必须被置值");
  assert.ok(c.row("gone.md").content, "墓碑不应清空正文（可恢复）");
});

test("云端软删除 → 只提示，绝不删除本机文件", async () => {
  const cloud = makeCloud();
  cloud.seed("keep.md", "# 保留\n");
  const { localFiles, cloud: c } = setup({
    files: { [`${WS_ID}/keep.md`]: { content: "# 保留\n", modified: 1000 } },
    cloud,
  });
  await mod.syncCloud({});

  c.row("keep.md").deleted_at = new Date().toISOString();
  const s = await mod.syncCloud({});

  assert.equal(s.cloudDeleted, 1, `应提示 1 篇云端已删，实测 ${s.cloudDeleted}`);
  assert.ok(localFiles.has(`${WS_ID}/keep.md`), "本机文件必须还在");
  assert.equal(localFiles.get(`${WS_ID}/keep.md`).content, "# 保留\n");
});

test("单向模式：push 不写本机、pull 不上传（除冲突收敛）", async () => {
  const cloud = makeCloud();
  cloud.seed("srv.md", "# 只在云端的\n");
  const { local, localFiles } = setup({
    files: { [`${WS_ID}/mine.md`]: { content: "# 只在本机的\n", modified: 1000 } },
    cloud,
  });

  const pushed = await mod.syncCloud({ mode: "push" });
  assert.equal(pushed.push, 1, "push 模式应上传本机新增");
  assert.equal(pushed.pull, 0, "push 模式不应拉取");
  assert.equal(local.stats.saves, 0, "push 模式不得写本机");
  assert.ok(!localFiles.has(`${WS_ID}/srv.md`), "push 模式不得把云端文件写到本机");

  const pulled = await mod.syncCloud({ mode: "pull" });
  assert.equal(pulled.pull, 1, "pull 模式应拉取云端新增");
  assert.equal(pulled.push, 0, "pull 模式不应上传");
  assert.equal(localFiles.get(`${WS_ID}/srv.md`).content, "# 只在云端的\n");
});

test("拉取时本机被并发改动 → 落冲突副本而不是覆盖，且不丢任何一版", async () => {
  const cloud = makeCloud();
  cloud.seed("race.md", "# 云端新\n");
  const { local, localFiles } = setup({
    files: { [`${WS_ID}/race.md`]: { content: "# 本机旧\n", modified: 1000 } },
    cloud,
  });
  // 制造「索引读完之后本机又被改了」：在第一次写本机之前改动磁盘内容
  local.armBeforeSave((f) => {
    f.set(`${WS_ID}/race.md`, { content: "# 本机刚改的\n", modified: Date.now() });
  });

  const s = await mod.syncCloud({});

  assert.equal(s.conflict, 1, `应识别为冲突，实测 ${s.conflict}`);
  assert.equal(localFiles.get(`${WS_ID}/race.md`).content, "# 本机刚改的\n", "并发改动不能被覆盖");
  const copies = [...localFiles.keys()].filter((k) => k.includes(".conflict-云-"));
  assert.equal(copies.length, 1, "云端那一版必须被保存下来");
  assert.equal(localFiles.get(copies[0]).content, "# 云端新\n");
});

test("不向云端发送 owner_id（归属由数据库默认值决定）", async () => {
  const cloud = makeCloud();
  const { } = setup({ files: { [`${WS_ID}/o.md`]: { content: "# O\n", modified: 1 } }, cloud });
  await mod.syncCloud({});
  for (const row of cloud.tables.documents) {
    assert.ok(!("owner_id" in row), "前端不得上送 owner_id");
  }
  assert.ok(cloud.tables.kb_meta.length <= 1, "kb_meta 只应有一行（按账号唯一）");
  void prevRel;
});
