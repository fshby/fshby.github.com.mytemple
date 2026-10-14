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
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const WS_ID = "ws_test1";
const WS_NAME = "测试知识库";
/** 与下面 window.__MT_CLOUD__.endpoint 必须一致（资产直连自己拼 URL，不走 SDK）。 */
const CLOUD_EP = "https://cloud.example.test";
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
      /* 平台侧内容检测（2026-10-14 实测）：正文含 <script> / onXxx= 时服务端返回 403，
       * 且那个错误页**不带 CORS 头** → SDK 只看到 "No 'Access-Control-Allow-Origin'…"。
       * 这里让用例按同一规则拒写，用来验「逐篇定位 + 剥离脚本降级 + 原因可见」。 */
      if (this.cloud.rejectUpsert) {
        const err = this.cloud.rejectUpsert(list, this.table);
        if (err) return { data: null, error: typeof err === "string" ? { message: err } : err };
      }
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
    // 云存储：对象全路径 → {bytes, contentType}；uploads 记录每一次真实上传（用于
    // 断言「已有对象不重传」——只看最终 objects 是分辨不出来的）。
    objects: new Map(),
    uploads: [],
    nextId: 1,
    writes: 0,
    /** 平台内容检测的替身：返回错误对象/字符串即表示这次 upsert 被拒（见 run 里的用法）。 */
    rejectUpsert: null,
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

function makeLocal(files, opts = {}) {
  // ⚠️ FileEntry 序列化是 camelCase（Rust #[serde(rename_all="camelCase")]，实机确认）。
  // 这里必须照抄真实契约 —— 早期版本写成了 workspace_id / content_sha256，
  // 结果测试全绿但实机「永远 0 篇」，教训：假实现必须照抄真实序列化。
  const workspaces = opts.workspaces || [{ id: WS_ID, name: WS_NAME, root: "C:/lib" }];
  const defaultId = opts.defaultWorkspaceId || workspaces[0].id;
  // 本机 source/ 目录里的资源字节：相对路径（如 "source/x.webp"）→ Uint8Array。
  // 真实后端是 Rust 的 /source/*path（axum get 同时吃 HEAD），命中则带 content-length。
  const sources = new Map(Object.entries(opts.sources || {}).map(([k, v]) => [k, Buffer.from(v)]));
  const stats = { listCalls: 0, contentReads: 0, saves: 0, sourceHeads: 0, sourceGets: 0, storageHeads: 0, storagePosts: 0 };
  let beforeSave = null;
  /** 让资产上传返回指定状态码（模拟 CORS 被拦 / 鉴权失败 / 5xx），用于验「失败可见 + 可重试」。 */
  let storageFailStatus = opts.storageFailStatus || 0;
  const setStorageFail = (code) => { storageFailStatus = code || 0; };
  const fetchStub = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || "GET";
    if (u.startsWith("/source/")) {
      // 前端把 "source/x.webp" 拼成 "/source/source/x.webp"，去掉第一个 "/source/" 后
      // 也可能仍带一层 "source/" —— 两种写法都按「相对工作区根」解析（与 Rust 一致）。
      let rel = decodeURIComponent(u.slice("/source/".length));
      const cands = [rel, rel.replace(/^source\//, "")];
      const hit = cands.map((c) => sources.get(c)).find(Boolean);
      if (!hit) return { ok: false, status: 404, headers: { get: () => null }, text: async () => "Not Found" };
      // 真实 /source/* 由 Rust serve_file 按扩展名给 content-type；Blob 的 type 就是它，
      // 上传时作为 multipart 分片的 Content-Type 落到云存储（渲染能否内联看这个）。
      const ext = rel.split(".").pop().toLowerCase();
      const ctype = { webp: "image/webp", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", mp4: "video/mp4" }[ext] || "application/octet-stream";
      if (method === "HEAD") {
        stats.sourceHeads += 1;
        return { ok: true, status: 200, headers: { get: (n) => (n.toLowerCase() === "content-length" ? String(hit.byteLength) : null) }, blob: async () => new Blob([hit]) };
      }
      stats.sourceGets += 1;
      return new Response(hit, { status: 200, headers: { "content-length": String(hit.byteLength), "content-type": ctype } });
    }
    if (u.startsWith(`${CLOUD_EP}/.cloud/storage/object/runtime/`)) {
      // 资产直连的假实现（照抄平台 REST 契约）：HEAD 探针 + multipart POST。
      // 并且**强制校验请求头只在平台 CORS 白名单内** —— 白名单外的头会让真浏览器
      // 在预检阶段直接失败（net::ERR_FAILED），这里是防复发的硬门槛。
      const hdrs = {};
      for (const [k, v] of Object.entries(options.headers || {})) hdrs[k.toLowerCase()] = String(v);
      const ALLOWED = new Set(["authorization", "x-wb-webapp-access-key", "content-type"]);
      for (const k of Object.keys(hdrs)) {
        if (!ALLOWED.has(k)) throw new Error(`资产请求头「${k}」不在平台 CORS 白名单内，真浏览器会直接拦掉`);
      }
      if (!hdrs["x-wb-webapp-access-key"]) throw new Error("资产请求必须带 x-wb-webapp-access-key");
      const key = u.slice(`${CLOUD_EP}/.cloud/storage/object/runtime/`.length)
        .split("/").map((s) => decodeURIComponent(s)).join("/");
      if (method === "HEAD") {
        stats.storageHeads += 1;
        const has = activeCloud.objects.has(key);
        return { ok: has, status: has ? 200 : 404, headers: { get: () => null }, text: async () => (has ? "" : "Not Found") };
      }
      if (method === "POST") {
        stats.storagePosts += 1;
        const fd = options.body;
        if (!(fd instanceof FormData)) throw new Error("资产上传必须是 multipart/form-data");
        if (fd.get("cacheControl") !== "31536000") throw new Error("必须带 cacheControl 分片（与 SDK 同契约）");
        const blob = fd.get("");
        if (!(blob instanceof Blob)) throw new Error("文件必须放在**无名**分片里（与 SDK 同契约）");
        if (storageFailStatus) {
          return { ok: false, status: storageFailStatus, headers: { get: () => null }, text: async () => '{"message":"upload rejected"}' };
        }
        const buf = Buffer.from(await blob.arrayBuffer());
        if (activeCloud.objects.has(key)) return { ok: false, status: 409, headers: { get: () => null }, text: async () => '{"error":"already exists"}' };
        activeCloud.objects.set(key, { bytes: buf, contentType: blob.type || "" });
        activeCloud.uploads.push({ path: key, size: buf.byteLength, contentType: blob.type || "" });
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ Key: `runtime/${key}` }) };
      }
    }
    if (u === "/api/workspaces") {
      return jsonResponse({ workspaces, defaultWorkspaceId: defaultId });
    }
    if (u === "/api/files" && method === "GET") {
      stats.listCalls += 1;
      return jsonResponse({
        ok: true,
        data: [...files.entries()].map(([ref, f]) => ({
          path: ref,
          workspaceId: ref.split("/")[0],
          workspaceName: (workspaces.find((w) => w.id === ref.split("/")[0]) || {}).name || "",
          title: ref,
          content: null, // 列表不带正文（与真实后端一致）
          contentSha256: sha(f.content),
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
        data: { path: ref, workspaceId: ref.split("/")[0], content: f.content, contentSha256: sha(f.content), modified: f.modified },
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
  return { fetchStub, stats, setStorageFail, armBeforeSave: (fn) => { beforeSave = fn; } };
}

/* ══ 装载被测模块 ═════════════════════════════════════════════ */

// 模块在**顶层**就读 window.__MT_CLOUD__，所以必须在 import 之前把环境铺好。
const storeBackup = new Map();
globalThis.window = {
  __MT_CLOUD__: {
    resourceId: "wbcs_test",
    endpoint: CLOUD_EP,
    oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
    publishableKey: "wbpk_test",
  },
  crypto: globalThis.crypto,
  WorkBuddyCloud: {
    // ⚠️ SDK 的 storage 面照抄真实契约（见 cloud/vendor 里的 SDK 类型声明）：
    //    userPath(uid, path) → 对象全路径；exists(path) → HEAD 探针 {data:bool}；
    //    upload(path, blob, {contentType, upsert, cacheControl}) → {data, error}。
    //    写成别的形状（比如让 exists 抛异常）会让「探针失败按缺失处理」的分支假绿。
    //
    // ⚠️⚠️ 2026-10-13 起**资产一律不得走 SDK 的 storage**：官方 SDK 每次存储请求都固定带
    //    X-Client-Info（上传还带 X-Upsert），而平台 CORS 白名单不含这两个头 ——
    //    桌面端这种跨源调用会在预检阶段被浏览器拦掉（真机表现为 "Failed to fetch"，
    //    且错误被吞掉，界面上什么都看不到）。所以下面这两个方法**故意抛错**：
    //    只要有人把资产上传改回 SDK 路径，测试立刻红，而不是等实机再发现。
    createWorkBuddyCloud: () => ({
      database: { from: (t) => activeCloud.query(t) },
      auth: {
        getSession: async () => ({ data: activeSession, error: null }),
        // 资产直连要自己取令牌；无会话时返回 null（与真实 SDK 一致）
        getAccessToken: async () => (activeSession ? "test-token" : null),
      },
      storage: {
        // 真实 SDK：userPath(uid, path) → `users/<uid>/<path>`（**无**前导斜杠），
        // 且会校验路径必须以 users/<uid>/ 开头（见 cloud/vendor/sdk 的 scopedPath）。
        userPath: (uid, path) => {
          if (!uid || /[\\/]/.test(uid)) throw new Error("owner/user id is not a valid storage path segment.");
          const p = String(path).replace(/^\/+|\/+$/g, "");
          if (!p || p.includes("\\") || p.includes("//") || p.split("/").some((s) => s === "" || s === "." || s === "..")) {
            throw new Error("Storage path is not a safe relative object path.");
          }
          return `users/${uid}/${p}`;
        },
        exists: async () => { throw new Error("资产不得走 SDK storage.exists（X-Client-Info 会被 CORS 拦）"); },
        upload: async () => { throw new Error("资产不得走 SDK storage.upload（X-Upsert / X-Client-Info 会被 CORS 拦）"); },
      },
    }),
  },
};
let activeCloud = null;
let activeSession = null;
globalThis.localStorage = {
  _m: storeBackup,
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

const mod = await import(pathToFileURL(fileURLToPath(new URL("public/modules/cloud-client.js", ROOT))).href);

/* ══ 夹具 ═════════════════════════════════════════════════════ */

/** 每个用例开始前重置三样东西：本机文件、云数据面、同步快照。 */
function setup({ files = {}, cloud = null, localOpts = {}, uid = "uid_test" } = {}) {
  const localFiles = new Map(Object.entries(files));
  const local = makeLocal(localFiles, localOpts);
  globalThis.fetch = local.fetchStub;
  activeCloud = cloud || makeCloud();
  activeSession = uid ? { user: { id: uid } } : null;
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

test("两端内容一致时跳过，且不改写本机；图片核对只做一次（增量同步的关键）", async () => {
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
  assert.equal(local.stats.saves, 0, "内容一致时不应写本机");
  assert.equal(localFiles.get(`${WS_ID}/same.md`).content, content);

  // 正文只在**图片核对**时被读过一次：文档同步本身不读正文（增量同步的关键），
  // 但「这篇引用的图片在不在云端」必须看正文才知道（见 public/modules/cloud-client.js
  // 的图片同步说明）。读完会落下「核对戳」，所以第二次同步一次都不该再读。
  assert.equal(local.stats.contentReads, 1,
    `首次同步只应为图片核对读 1 次正文，实测 ${local.stats.contentReads}`);

  const before = local.stats.contentReads;
  const s2 = await mod.syncCloud({});
  assert.equal(s2.skipped, 1);
  assert.equal(local.stats.contentReads, before,
    `核对戳命中后不应再读正文，实测多了 ${local.stats.contentReads - before} 次`);
  assert.equal(local.stats.saves, 0);
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

/* ══ 实机反馈回归（2026-10-12）：camelCase 与工作区选择 ════════ */

const WS2 = { id: "ws_temple", name: "temple", root: "O:/temple" };

test("FileEntry 契约：仅 camelCase（workspaceId/contentSha256）也能读到文件（实机回归）", async () => {
  // 2026-10-12 实机：后端 #[serde(rename_all="camelCase")]，按 snake_case 读恒为 undefined，
  // 表现为「可同步内容：暂无 Markdown」「没有需要同步的内容」。此用例钉死真实序列化。
  const cloud = makeCloud();
  setup({
    files: { [`${WS_ID}/real.md`]: { content: "# 实机契约\n", modified: 1000 } },
    cloud,
  });
  const idx = await mod.readLocalIndex();
  assert.equal(idx.files.length, 1, `camelCase 列表必须能读到文件，实测 ${idx.files.length} 篇`);
  assert.ok(idx.files[0].workspaceId === undefined || typeof idx.files[0].workspaceId === "string");

  const s = await mod.syncCloud({});
  assert.equal(s.push, 1, `必须能把实机 camelCase 列表推上去，实测 push=${s.push} notes=${JSON.stringify(s.notes)}`);
  assert.equal(s.localCount, 1, "摘要应带本机篇数");
  assert.equal(cloud.tables.documents.length, 1);
});

test("readLocalIndex：countsByWs 覆盖全部工作区，选择非默认工作区时只同步它的文件", async () => {
  const cloud = makeCloud();
  setup({
    files: {
      [`${WS_ID}/default-only.md`]: { content: "# 默认\n", modified: 1000 },
      [`${WS2.id}/temple-one.md`]: { content: "# 庙 One\n", modified: 2000 },
      [`${WS2.id}/temple-two.md`]: { content: "# 庙 Two\n", modified: 3000 },
    },
    cloud,
    localOpts: {
      workspaces: [{ id: WS_ID, name: WS_NAME, root: "C:/dos" }, WS2],
      defaultWorkspaceId: WS_ID,
    },
  });

  const idx = await mod.readLocalIndex();
  assert.equal(idx.ws.id, WS_ID, "不带参数时落在默认工作区");
  assert.equal(idx.countsByWs.get(WS_ID), 1);
  assert.equal(idx.countsByWs.get(WS2.id), 2);

  const s = await mod.syncCloud({ workspaceId: WS2.id });
  assert.equal(s.workspace, WS2.name, `云端分区必须是所选工作区名，实测 ${s.workspace}`);
  assert.equal(s.push, 2, `只应上传 temple 的 2 篇，实测 ${s.push}`);
  assert.ok(cloud.tables.documents.every((r) => r.workspace === WS2.name),
    "云端不得出现默认工作区的文档");
  assert.ok(!cloud.tables.documents.some((r) => r.rel_path === "default-only.md"),
    "默认工作区的文件不得被带入所选分区");

  // 快照按分区隔离：切回默认工作区是「首次接触」，不会把 temple 的墓碑带过去
  const s2 = await mod.syncCloud({ workspaceId: WS_ID });
  assert.equal(s2.workspace, WS_NAME);
  assert.equal(s2.push, 1, "默认工作区单独推送自己的 1 篇");
});

test("summarize：空转时把「为什么没有」说清楚（实机反馈：只说『没有需要同步的内容』）", async () => {
  const { summarize } = mod;
  assert.equal(
    summarize({ mode: "push", localCount: 0, cloudCount: 0 }),
    "这个工作区本机和云端都还没有内容",
  );
  assert.match(
    summarize({ mode: "push", localCount: 11, cloudCount: 11 }),
    /没有需要上传的改动（本机 11 篇，云端已有 11 篇）/,
  );
  assert.match(
    summarize({ mode: "pull", localCount: 5, cloudCount: 0 }),
    /云端此分区还没有内容/,
  );
  assert.match(
    summarize({ mode: "both", localCount: 5, cloudCount: 5 }),
    /内容已一致（本机 5 篇 = 云端 5 篇）/,
  );
  assert.match(summarize({ mode: "push", push: 3 }), /上传 3/, "有动作时仍报动作");
});

/* ══ 图片 / 视频同步（2026-10-13 实机反馈：APK 侧截图全「未同步」）════
 *
 * 根因：推送同步只搬正文，图片字节从来没人传过 —— 云端有文档、没图片。
 * 下面这几个用例把「按引用扫描 → 缺哪张补哪张」的行为钉死，并顺带锁住
 * 两端（桌面内核 / 云端工作台）必须同规则的对象路径。
 */

const IMG_UID = "uid_test";
const IMG_OBJ = `users/${IMG_UID}/assets/${WS_NAME}/source/shot.webp`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const DOC_WITH_IMG = "# 带图笔记\n\n看这个：\n\n![截图](source/shot.webp)\n";

test("推送：文档引用的本机图片会被补进云存储（路径与文档 rel_path 同构）", async () => {
  const cloud = makeCloud();
  const { local, cloud: c } = setup({
    files: { [`${WS_ID}/note.md`]: { content: DOC_WITH_IMG, modified: 1000 } },
    cloud,
    localOpts: { sources: { "source/shot.webp": PNG } },
  });

  const s = await mod.syncCloud({ mode: "push" });

  assert.equal(s.push, 1, "文档本身应上传");
  assert.equal(s.assetPush, 1, `应补传 1 张图，实测 ${s.assetPush}（missing=${s.assetMissing} failed=${s.assetFailed}）`);
  assert.equal(s.assetFailed, 0);
  assert.equal(s.assetMissing, 0, "本机存在的引用不该判为缺失");
  assert.deepEqual(c.uploads.map((u) => u.path), [IMG_OBJ],
    "对象路径必须是 users/<uid>/assets/<分区>/<工作区相对路径>");
  assert.equal(c.uploads[0].contentType, "image/webp", "必须带正确的 contentType，否则浏览器不内联渲染");
  assert.deepEqual([...c.objects.get(IMG_OBJ).bytes], [...PNG], "上传的字节必须与本机一致");
  assert.ok(local.stats.sourceHeads >= 1, "存在性先看本机（HEAD）再探云端");
});

test("推送：云端已有该对象时只探针、不重传（老库重复同步不产生流量）", async () => {
  const cloud = makeCloud();
  cloud.objects.set(IMG_OBJ, { bytes: PNG, contentType: "image/webp" });
  const { local } = setup({
    files: { [`${WS_ID}/note.md`]: { content: DOC_WITH_IMG, modified: 1000 } },
    cloud,
    localOpts: { sources: { "source/shot.webp": PNG } },
  });

  const s = await mod.syncCloud({ mode: "push" });

  assert.equal(s.assetPush, 0, "已有对象不该重传");
  assert.equal(s.assetExists, 1, `应记为「云端已有 1 张」，实测 ${s.assetExists}`);
  assert.equal(cloud.uploads.length, 0, "不得产生任何上传");
  assert.ok(local.stats.storageHeads >= 1, "云端存在性用 HEAD 探针（只带白名单头，跨源才可用）");
  assert.ok(local.stats.sourceHeads >= 1, "仍要看本机是否存在（引用失效与已同步要能区分）");
});

test("历史库修复：正文两端一致（文档同步跳过）时，缺的图片仍会被补上", async () => {
  // 这是本次实机问题的核心场景：老库用「只推正文」的逻辑推过云端，
  // 文档 content_sha 完全一致 → 文档环节 skipped，图片却一张都没有。
  // 图片同步必须独立于文档指纹，否则这种库永远修不回来。
  const cloud = makeCloud();
  cloud.seed("note.md", DOC_WITH_IMG);
  const { local } = setup({
    files: { [`${WS_ID}/note.md`]: { content: DOC_WITH_IMG, modified: 1000 } },
    cloud,
    localOpts: { sources: { "source/shot.webp": PNG } },
  });

  const s = await mod.syncCloud({});

  assert.equal(s.skipped, 1, "正文一致，文档环节应跳过");
  assert.equal(s.push, 0);
  assert.equal(s.assetPush, 1, `正文跳过也必须补图，实测 ${s.assetPush}`);
  assert.ok(cloud.objects.has(IMG_OBJ));

  // 再同步一次：不该重复上传（核对戳生效）
  const s2 = await mod.syncCloud({});
  assert.equal(s2.assetPush, 0, "第二次同步不该重复上传");
  assert.equal(local.stats.contentReads, 1, `正文只应在首次核对时读一次，实测 ${local.stats.contentReads}`);
});

test("引用在本机找不到（图片被删 / 路径写错）→ 记为缺失而不是失败", async () => {
  const cloud = makeCloud();
  const { } = setup({
    files: { [`${WS_ID}/note.md`]: { content: DOC_WITH_IMG, modified: 1000 } },
    cloud,
    localOpts: { sources: {} },   // 本机没有 source/shot.webp
  });

  const s = await mod.syncCloud({});
  assert.equal(s.assetPush, 0);
  assert.equal(s.assetMissing, 1, `应记为 1 张缺失，实测 ${s.assetMissing}`);
  assert.equal(s.assetFailed, 0);
  assert.equal(cloud.uploads.length, 0);
});

test("图片上传失败：原因可见、不写核对戳、下次同步自愈", async () => {
  // 2026-10-13 实机教训：资产上传被浏览器 CORS 拦下时，错误被 per-file catch 吞掉，
  // 界面上什么都看不到；更糟的是**核对戳照写**，于是这个内容版本以后永远不会再核对，
  // 图片就再也修不回来了（云存储里 0 个对象的直接原因）。
  const cloud = makeCloud();
  const { local } = setup({
    files: { [`${WS_ID}/note.md`]: { content: DOC_WITH_IMG, modified: 1000 } },
    cloud,
    localOpts: { sources: { "source/shot.webp": PNG }, storageFailStatus: 403 },
  });

  const s = await mod.syncCloud({ mode: "push" });

  assert.equal(s.assetPush, 0);
  assert.equal(s.assetFailed, 1, `上传失败必须计数，实测 ${s.assetFailed}`);
  assert.ok(
    s.assetFailures[0] && s.assetFailures[0].includes("source/shot.webp") && s.assetFailures[0].includes("upload rejected"),
    `必须带原始原因，实测 ${JSON.stringify(s.assetFailures)}`,
  );
  assert.ok(s.notes.some((n) => n.includes("图片未上传")), "notes 里也要留痕");
  assert.match(mod.summarize(s), /图片失败 1 张/, "汇总文案要能直接看到失败与原因");

  const st = JSON.parse(globalThis.localStorage.getItem("mtCloudSync.v1"));
  assert.ok(!(st.assets || {})["note.md"], "失败时不得写图片核对戳，否则永远不再重试");

  // 放开故障后重试：同一份状态必须能自愈（这正是老库补图的路径）
  local.setStorageFail(0);
  const s2 = await mod.syncCloud({ mode: "push" });
  assert.equal(s2.assetPush, 1, `重试应成功补传，实测 ${s2.assetPush}`);
  assert.equal(s2.assetFailed, 0);
  assert.ok(cloud.objects.has(IMG_OBJ));
  const st2 = JSON.parse(globalThis.localStorage.getItem("mtCloudSync.v1"));
  assert.ok((st2.assets || {})["note.md"], "成功后应该写上核对戳");
});

test("升级迁移：旧世代（v1）的图片核对戳必须一次性作废，否则老库永远补不上图", async () => {
  // v1 的戳是在「上传失败也照写戳」的代码下产生的，内容不可信。
  // 不递增世代的话，升级到修复版后点推送会直接跳过图片环节 → 看起来像没修好。
  const cloud = makeCloud();
  const { } = setup({
    files: { [`${WS_ID}/note.md`]: { content: DOC_WITH_IMG, modified: 1000 } },
    cloud,
    localOpts: { sources: { "source/shot.webp": PNG } },
  });
  // 伪造一份 v1 状态：文档内容 sha 与当前完全一致，且已写图片核对戳（无 assetsEpoch）
  globalThis.localStorage.setItem("mtCloudSync.v1", JSON.stringify({
    workspace: WS_NAME,
    lastSyncAt: new Date().toISOString(),
    files: { "note.md": sha(DOC_WITH_IMG) },
    assets: { "note.md": sha(DOC_WITH_IMG) },
  }));

  const s = await mod.syncCloud({ mode: "push" });
  assert.equal(s.assetPush, 1, `旧世代戳必须作废并重新补图，实测 ${s.assetPush}`);
  assert.ok(cloud.objects.has(IMG_OBJ));
  const st = JSON.parse(globalThis.localStorage.getItem("mtCloudSync.v1"));
  assert.equal(st.assetsEpoch, 2, "升级后要写下当前世代");
});

test("拉取模式不碰图片上传（本机没有新东西要推）", async () => {  const cloud = makeCloud();
  const { } = setup({
    files: { [`${WS_ID}/note.md`]: { content: DOC_WITH_IMG, modified: 1000 } },
    cloud,
    localOpts: { sources: { "source/shot.webp": PNG } },
  });

  await mod.syncCloud({ mode: "pull" });
  assert.equal(cloud.uploads.length, 0, "pull 模式不得上传任何对象");
});

test("summarize：把图片结果说清楚（含「图片也都在云端」的空转解释）", () => {
  const { summarize } = mod;
  assert.match(summarize({ mode: "push", assetPush: 3 }), /补传图片 3 张/);
  assert.match(summarize({ mode: "push", assetMissing: 2 }), /2 张引用在本机找不到/);
  assert.match(summarize({ mode: "push", assetTooBig: 1 }), /超过 12MB/);
  assert.match(
    summarize({ mode: "both", localCount: 2, cloudCount: 2, assetExists: 5 }),
    /5 张引用图片也都在云端/,
    "全部已同步但要解释「为什么什么都没做」",
  );
});


test("引用写成本文档同目录的相对路径时，候选要依次试而不是只看第一个", async () => {
  // 笔记里写 `![](shot.webp)` 时，第一候选是「工作区根/shot.webp」，第二候选才是
  // 「文档所在目录/shot.webp」。只试第一候选会把后者误报成「本机找不到」——
  // 用户看到的是「图片明明在，却一直提示缺失」。
  const cloud = makeCloud();
  const { } = setup({
    files: { [`${WS_ID}/note/inner.md`]: { content: "# 子目录笔记\n\n![图](shot.webp)\n", modified: 1000 } },
    cloud,
    localOpts: { sources: { "note/shot.webp": PNG } },
  });

  const s = await mod.syncCloud({ mode: "push" });
  assert.equal(s.assetMissing, 0, `不该误报缺失，实测 missing=${s.assetMissing}`);
  assert.equal(s.assetPush, 1, `应补传 1 张，实测 ${s.assetPush}`);
  assert.deepEqual(cloud.uploads.map((u) => u.path),
    [`users/${IMG_UID}/assets/${WS_NAME}/note/shot.webp`],
    "对象路径要用真正命中的那个候选");
});

/* ══ 独立 HTML 文档同步（2026-10-13 用户决策：放开 html，json/csv 仍排除）════
 *
 * 背景：桌面端本就把 .html 当一等公民（沙箱预览、去标签检索、索引收录），
 * 只有同步白名单没跟上 → 「本机能看、云端永远没有」。放开后必须同时锁住三件事：
 *   1) 正文按原样同步、标题取 <title>（不是正文里的 # 行）；
 *   2) 文档里 <img src> 引用的本机图片一起补传（否则云端是一堆破图）；
 *   3) 超大的整页 HTML 不许上传（documents.content 是 text，一篇能拖死列表与检索）。
 */

const HTML_DOC = [
  "<!doctype html>",
  "<html><head><title>网页笔记标题</title></head>",
  "<body><h1>这是正文里的一级标题，不该当文档标题</h1>",
  "<img src=\"source/shot.webp\" alt=\"截图\"></body></html>",
  "",
].join("\n");

test("推送：.html 文档与 Markdown 一视同仁地同步，标题取 <title>", async () => {
  const cloud = makeCloud();
  const { } = setup({
    files: { [`${WS_ID}/hello.html`]: { content: HTML_DOC, modified: 1000 } },
    cloud,
  });

  const s = await mod.syncCloud({ mode: "push" });

  assert.equal(s.push, 1, `html 文档应上传，实测 push=${s.push}`);
  const row = cloud.row("hello.html");
  assert.ok(row, "云端应有 hello.html 一行");
  assert.equal(row.title, "网页笔记标题", "<title> 优先于正文里的 # 行");
  assert.equal(row.content, HTML_DOC, "正文按原样同步，不做格式转换");
});

test("推送：html 文档里 <img src> 引用的本机图片也会补传（否则云端全是破图）", async () => {
  const cloud = makeCloud();
  const { } = setup({
    files: { [`${WS_ID}/hello.html`]: { content: HTML_DOC, modified: 1000 } },
    cloud,
    localOpts: { sources: { "source/shot.webp": PNG } },
  });

  const s = await mod.syncCloud({ mode: "push" });

  assert.equal(s.push, 1);
  assert.equal(s.assetPush, 1, `应补传 1 张，实测 ${s.assetPush}（missing=${s.assetMissing}）`);
  assert.deepEqual(cloud.uploads.map((u) => u.path), [IMG_OBJ]);
});

test("拉取：云端新增的 .html 文档会写回本机", async () => {
  const cloud = makeCloud();
  cloud.seed("docs/hello.html", HTML_DOC);
  const { localFiles } = setup({ files: {}, cloud });

  const s = await mod.syncCloud({});

  assert.equal(s.pull, 1, `应拉取 1 篇，实测 ${s.pull}`);
  assert.equal(
    localFiles.get(`${WS_ID}/docs/hello.html`).content,
    HTML_DOC,
    "子目录里的 html 也要落到同一相对路径",
  );
});

test("超过上限的 HTML 文档：跳过并计数，不把云端正文撑爆", async () => {
  const cloud = makeCloud();
  const huge = "<html><body>" + "x".repeat(1_300_000) + "</body></html>";
  const { } = setup({
    files: { [`${WS_ID}/big.html`]: { content: huge, modified: 1000 } },
    cloud,
  });

  const s = await mod.syncCloud({ mode: "push" });

  assert.equal(s.push, 0, "超限不该上传");
  assert.equal(s.docTooBig, 1, `应记为 1 个超限，实测 ${s.docTooBig}`);
  assert.equal(cloud.row("big.html"), undefined, "云端不该出现这一行");
  assert.match(mod.summarize(s), /1 个 HTML 文档过大未上传/);
});

test("json / csv 仍不上云（工作区里的 json 常是含密钥的配置文件）", async () => {
  const cloud = makeCloud();
  const { } = setup({
    files: {
      [`${WS_ID}/config.json`]: { content: "{\"token\":\"secret\"}", modified: 1000 },
      [`${WS_ID}/data.csv`]: { content: "a,b\n1,2\n", modified: 1000 },
    },
    cloud,
  });

  const s = await mod.syncCloud({ mode: "push" });

  assert.equal(s.push, 0, "json / csv 不该进同步集合");
  assert.equal(s.localCount, 0, `白名单里不该含 json/csv，实测 localCount=${s.localCount}`);
  assert.equal(cloud.tables.documents.length, 0);
});

/* ── 两端同规则（静态契约）────────────────────────────────────
 * 同一篇笔记在桌面内核与云端工作台必须解析出**同一个**对象路径，否则会出现
 * 「桌面推到 A、云端找 B」的互相看不见。这里把两个文件里的实现抽出来逐字比对。 */

function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `未找到函数 ${name}`);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === "{") { depth += 1; started = true; }
    else if (ch === "}") { depth -= 1; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`函数 ${name} 不闭合`);
}

const normFn = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")      // 块注释
  .replace(/\/\/[^\n]*/g, "")            // 行注释
  .replace(/\s+/g, " ")                  // 空白
  .trim();

test("对象路径规则两端逐字一致（assetWsSegment / extractAssetRefs / assetRelCandidates）", () => {
  const desk = readFileSync(new URL("../public/modules/cloud-client.js", import.meta.url), "utf8");
  const web = readFileSync(new URL("../cloud/app.js", import.meta.url), "utf8");
  for (const fn of ["assetWsSegment", "extractAssetRefs", "assetRelCandidates", "normPath"]) {
    assert.equal(normFn(extractFn(desk, fn)), normFn(extractFn(web, fn)),
      `${fn} 在桌面内核与云端工作台之间已经分叉 —— 两端会算出不同的对象路径`);
  }
});

/* ══ 平台内容策略拦下正文特征（2026-10-14 实测根因）══════════════
 * 现象：一篇含 `<script>` 的 HTML 永远推不上云端，桌面端口只能看到
 * `push:0 / failed:1` 与一句误导性的 CORS 文案。实测（Node 直连拿到的真身）：
 * 服务端对含 `<script>…</script>` / `onclick="…"` 的请求体返回 403「WAF拦截页面」，
 * 而那个错误页不带 CORS 头。下面用「按正文特征拒写」的假数据面复现整条链路。 */

const WAF_MSG = "No 'Access-Control-Allow-Origin' header is present on the requested resource";

/** 照抄实测的拦截规则：正文含脚本标签或内联事件属性即拒。 */
function armPlatformContentFilter(cloud) {
  cloud.rejectUpsert = (rows, table) => {
    if (table !== "documents") return null;
    const hit = rows.some((r) => /<script\b|\son[a-z]+\s*=/i.test(String(r.content || "")));
    return hit ? { message: WAF_MSG } : null;
  };
}

const SCRIPT_HTML = '<!DOCTYPE html><html><head><title>倒计时</title></head>\n'
  + '<body onload="tick()"><script>var n=11;setInterval(tick,1000);</script>\n<p>冲刺</p></body></html>';

test("平台按正文特征拒写：剥离脚本后重试成功，本机文件保持完整版", async () => {
  const cloud = makeCloud();
  armPlatformContentFilter(cloud);
  const { localFiles, local } = setup({
    files: {
      [`${WS_ID}/count.html`]: { content: SCRIPT_HTML, modified: 1000 },
      [`${WS_ID}/note.md`]: { content: "# 笔记\n静态内容\n", modified: 1000 },
    },
    cloud,
  });

  const s = await mod.syncCloud({ mode: "push" });

  const row = cloud.row("count.html");
  assert.ok(row, "剥离后必须真的写进云端");
  assert.ok(!/<script\b/i.test(row.content), "云端正文不得再含脚本标签");
  assert.ok(!/\son[a-z]+\s*=/i.test(row.content), "内联事件属性也要移除");
  assert.ok(row.content.includes("<!-- mt-cloud-no-script -->"), "要留可识别的标记（云端渲染据此提示）");
  assert.ok(row.content.includes("冲刺"), "静态内容必须原样保留");
  assert.ok(row.content.indexOf("<!DOCTYPE") < row.content.indexOf("<!-- mt-cloud-no-script -->"),
    "标记必须在 DOCTYPE 之后，否则浏览器可能退回怪异模式");
  assert.equal(row.content_sha, sha(SCRIPT_HTML),
    "content_sha 仍写本机原文指纹 —— 下一轮才会判「两端一致」，不会每次都来撞一次失败请求");
  assert.equal(s.push, 2, `同批里正常的文档也不能被连带算失败，实测 ${s.push}`);
  assert.equal(s.stripped, 1);
  assert.equal(s.failed, 0);
  assert.ok(s.notes.some((n) => n.includes("count.html") && n.includes("已移除脚本")), "降级要在 notes 里说清楚");
  assert.equal(localFiles.get(`${WS_ID}/count.html`).content, SCRIPT_HTML, "本机文件必须是完整版");
  assert.equal(local.stats.saves, 0, "推送不写本机");

  // 下一轮：内容没变 → 既不重传，也不会再撞一次注定失败的请求
  const s2 = await mod.syncCloud({ mode: "push" });
  assert.equal(s2.push, 0, `已同步的文档不得重复上传，实测 ${s2.push}`);
  assert.equal(s2.failed, 0);
  assert.equal(cloud.tables.documents.length, 2);
});

test("Markdown 里出现脚本特征被拒：不擅自改写内容，只报原因且不写基线", async () => {
  const cloud = makeCloud();
  armPlatformContentFilter(cloud);
  const MD = "# 代码笔记\n\n```html\n<script>alert(1)</script>\n```\n";
  const { localFiles } = setup({ files: { [`${WS_ID}/code.md`]: { content: MD, modified: 1000 } }, cloud });

  const s = await mod.syncCloud({ mode: "push" });

  assert.equal(cloud.row("code.md"), undefined, "被拒就不能算写进去了");
  assert.equal(s.push, 0);
  assert.equal(s.failed, 1);
  assert.ok(s.pushFailures[0] && s.pushFailures[0].rel === "code.md",
    `失败原因要指到具体文档，实测 ${JSON.stringify(s.pushFailures)}`);
  assert.match(s.pushFailures[0].reason, /服务端拒绝|平台内容安全策略/,
    `原因要人话，实测 ${s.pushFailures[0] && s.pushFailures[0].reason}`);
  assert.ok(!/Access-Control-Allow-Origin/.test(s.pushFailures[0].reason),
    "误导性的 CORS 文案不能原样甩给用户");
  assert.match(mod.summarize(s), /失败 1/, "汇总文案要能直接看到失败");
  assert.ok(s.notes.some((n) => n.startsWith("未上传：code.md")), "notes 也要留痕");
  assert.equal(localFiles.get(`${WS_ID}/code.md`).content, MD, "Markdown 内容不得被改写（代码块里的标签是真内容）");

  const st = JSON.parse(globalThis.localStorage.getItem("mtCloudSync.v1"));
  assert.ok(!(st.files || {})["code.md"], "失败的文档不得写同步基线，否则下一轮直接跳过、永远不重试");
});

test("云端存的是「剥离形态」时不覆盖本机完整版（本机不能丢脚本）", async () => {
  const cloud = makeCloud();
  const stripped = mod.stripCloudUnsafeHtml(SCRIPT_HTML).text;
  assert.ok(stripped.includes("<!-- mt-cloud-no-script -->"), "夹具前提：剥离产物必须带标记");
  // 云端这份是「后来的」版本（updated_at 明显更新），才会被判成「云端改过 → 要拉」
  cloud.seed("count.html", stripped, { updatedAt: new Date(Date.now() + 3_600_000).toISOString() });
  const { localFiles, local } = setup({
    files: { [`${WS_ID}/count.html`]: { content: SCRIPT_HTML, modified: 1000 } },
    cloud,
  });

  const s = await mod.syncCloud({});

  assert.equal(localFiles.get(`${WS_ID}/count.html`).content, SCRIPT_HTML, "本机必须保持完整版");
  assert.equal(local.stats.saves, 0, "不得写回本机");
  assert.equal(s.pull, 0);
  assert.ok(s.notes.some((n) => n.includes("跳过覆盖")), `要在 notes 里说明为什么没拉，实测 ${JSON.stringify(s.notes)}`);
});

test("剥离脚本的实现两端同源（本机与云端工作台必须剥出同一份正文）", () => {
  const desk = readFileSync(new URL("../public/modules/cloud-client.js", import.meta.url), "utf8");
  const web = readFileSync(new URL("../cloud/app.js", import.meta.url), "utf8");
  assert.equal(normFn(extractFn(desk, "stripCloudUnsafeHtml")), normFn(extractFn(web, "stripCloudUnsafeHtml")),
    "stripCloudUnsafeHtml 已分叉 —— 同一篇文档在两端的云端形态会不一致");
  // 只看函数体还不够：常量（标记串、正则）也得同值，所以再跑一遍同一批输入比结果
  const apiOf = (src) => {
    const from = src.indexOf("const HTML_CLOUD_STRIP_MARK");
    const to = src.indexOf("function isCloudStripped");
    assert.ok(from > 0 && to > from, "必须能找到剥离函数段");
    const code = src.slice(from, to).replace(/\bexport\s+/g, "");
    return new Function(`${code}\nreturn stripCloudUnsafeHtml;`)();
  };
  const a = apiOf(desk);
  const b = apiOf(web);
  const inputs = [
    SCRIPT_HTML,
    '<html><body><a href="javascript:alert(1)">x</a></body></html>',
    "<html><body><p>纯静态</p></body></html>",
    "<div onclick='x()'>t</div>",
    "no doctype<script>a</script>",
    "",
  ];
  for (const inp of inputs) {
    assert.deepEqual(a(inp), b(inp), `两端剥出的结果不同：${inp.slice(0, 40)}`);
  }
});
