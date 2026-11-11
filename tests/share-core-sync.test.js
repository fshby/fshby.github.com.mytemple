/**
 * 分享共享核心的「单一实现源」守卫。
 *
 * 背景：桌面端（public/modules/share-cloud.js）与云端（cloud/app.js、cloud/share.js）
 * 曾经各自实现「引用 → 资产键」的解析，靠人工对齐。2026-11-06 一天内炸了三次
 * 线上事故（ws_ 前缀当子目录、写读键不同构、旧 ws id 无兜底），全部源于此。
 *
 * 现在规则收敛到 shared/share-core.js，`npm run build:share` 生成两份同名产物。
 * 这里锁三件事：
 *   ① 生成物带的水印哈希 == 当前源文件哈希（改了源忘记生成，或只改生成物都会失败）；
 *   ② 两份生成物逐字节相同（不存在「只更新了桌面那份」）；
 *   ③ 写侧 refToAsset 产出的键，必须落在读侧 assetCandidates 的候选里（真正的契约）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const SRC = new URL("../shared/share-core.js", import.meta.url);
const OUTS = [
  new URL("../public/modules/share-core.js", import.meta.url),
  new URL("../cloud/share-core.js", import.meta.url),
];

test("共享核心：两份生成物与源文件同步（水印哈希校验）", () => {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(SRC)).digest("hex");
  const bodies = OUTS.map((u) => fs.readFileSync(u, "utf8"));
  bodies.forEach((body, i) => {
    assert.match(
      body,
      new RegExp(`source-sha256: ${hash}`),
      `${OUTS[i].pathname} 与源文件不同步：改完 shared/share-core.js 记得跑 npm run build:share`
    );
  });
  assert.equal(bodies[0], bodies[1], "桌面与云端的生成物必须逐字节相同");
});

test("共享核心：三端都从同一份实现导入，不再各写一份", () => {
  const desktop = fs.readFileSync(new URL("../public/modules/share-cloud.js", import.meta.url), "utf8");
  const cloudApp = fs.readFileSync(new URL("../cloud/app.js", import.meta.url), "utf8");
  const cloudShare = fs.readFileSync(new URL("../cloud/share.js", import.meta.url), "utf8");

  assert.match(desktop, /from "\.\/share-core\.js"/, "桌面端必须导入共享核心");
  assert.match(cloudApp, /from "\.\/share-core\.js(\?[^"]*)?"/, "工作台必须导入共享核心");
  assert.match(cloudShare, /from "\.\/share-core\.js(\?[^"]*)?"/, "分享页必须导入共享核心（带缓存戳）");

  // 谁都不该再自己实现一份候选解析（函数体里有 ws-asset 正则即视为重复实现）
  for (const [name, src] of [["桌面", desktop], ["工作台", cloudApp], ["分享页", cloudShare]]) {
    assert.doesNotMatch(src, /function assetRelCandidates\(|function assetCandidates\(/,
      `${name}不该再自带一份候选解析`);
  }
});

test("共享核心：写侧键必须落在读侧候选里（这才是真正的契约）", async () => {
  const core = await import("../shared/share-core.js");
  const cases = [
    ["/source/ws_25a724bd6b/a.webp", "docs/note.md"],
    ["source/a.webp", "docs/note.md"],
    ["./source/a.webp", "docs/note.md"],
    ["a.webp", "docs/note.md"],
    ["img/a.png", "docs/sub/note.md"],
    ["ws-asset/ws_9abc/source/a.png", "note.md"],
  ];
  for (const [ref, docRel] of cases) {
    const asset = core.refToAsset(ref, "temple");
    assert.ok(asset, `${ref} 应能解析`);
    const cands = core.assetCandidates(ref, docRel);
    assert.ok(
      cands.includes(asset.relPath),
      `写侧键 ${asset.relPath} 不在读侧候选 [${cands.join(", ")}] 中（${ref}）—— 上传了也匹配不上`
    );
  }
});

test("共享核心：外链与越界引用一律不带", async () => {
  const core = await import("../shared/share-core.js");
  for (const ref of ["https://x/a.png", "data:image/png;base64,xx", "blob:abc", "javascript:alert(1)", "", "mailto:a@b.c"]) {
    assert.deepEqual(core.assetCandidates(ref, "a.md"), [], `${ref} 不应有候选`);
    assert.equal(core.refToAsset(ref, "temple"), null, `${ref} 不应被解析成资产`);
  }
  assert.equal(core.refToAsset("../../etc/passwd", "temple"), null, "越界引用必须拒绝");
});

test("共享核心：有效期读数不能把「未设置」当成永久", async () => {
  const core = await import("../shared/share-core.js");
  // Number(null) === 0 的坑：null 必须回落到默认 7 天，而不是 0（永久）
  assert.equal(core.parseShareTtl(null), 7);
  assert.equal(core.parseShareTtl(""), 7);
  assert.equal(core.parseShareTtl("0"), 0);
  assert.equal(core.parseShareTtl("30"), 30);
  assert.equal(core.parseShareTtl("999"), 7, "非法档位回落默认");
  assert.equal(core.expiresAtFromTtl(0), null, "0 = 永久 = null");
  assert.equal(core.expiresAtFromTtl(1, Date.UTC(2026, 0, 1)), "2026-01-02T00:00:00.000Z");
});

test("共享核心：体积上限常量存在且量级合理", async () => {
  const core = await import("../shared/share-core.js");
  assert.ok(core.SHARE_CONTENT_MAX_BYTES >= 512 * 1024, "正文上限不能太小（长文档）");
  assert.ok(core.SHARE_CONTENT_MAX_BYTES <= 5 * 1024 * 1024, "正文上限不能大到触发网关截断");
  assert.ok(core.SHARE_ASSETS_TOTAL_MAX_BYTES > core.SHARE_CONTENT_MAX_BYTES, "图片总量上限应大于正文上限");
  assert.equal(core.utf8Bytes("中"), 3, "UTF-8 字节数按真实编码算");
});
