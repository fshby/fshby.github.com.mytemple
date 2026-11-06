// 桌面端分享链接：可单测的纯逻辑部分。
// 完整链路（真实云端写入）由 .verify/share-link-check.cjs 在真浏览器里跑。
import assert from "node:assert/strict";
import { test } from "node:test";

// share-cloud.js 顶层会 import cloud-client.js（依赖 window/SDK），
// 所以这里用最小 window/localStorage 桩后再动态引入，避免测试环境差异。
function withBrowserStubs(fn) {
  const store = new Map();
  globalThis.window = globalThis.window || {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return fn();
}

test("shareExpiryText：永久 / 剩余天数 / 剩余小时 / 已过期", async () => {
  await withBrowserStubs(async () => {
    const { shareExpiryText } = await import("../public/modules/share-cloud.js");
    assert.equal(shareExpiryText(null), "永久有效");
    assert.equal(shareExpiryText(""), "永久有效");
    assert.equal(shareExpiryText("not-a-date"), "永久有效");
    assert.equal(shareExpiryText(new Date(Date.now() - 60_000).toISOString()), "已过期");
    assert.equal(shareExpiryText(new Date(Date.now() + 5 * 36e5).toISOString()), "剩 5 小时");
    assert.equal(shareExpiryText(new Date(Date.now() + 10 * 864e5).toISOString()), "剩 10 天");
  });
});

test("有效期读写：只接受 1/7/30/0，非法值回落 7 天", async () => {
  await withBrowserStubs(async () => {
    const { shareTtlDays, setShareTtlDays } = await import("../public/modules/share-cloud.js");
    assert.equal(shareTtlDays(), 7, "默认 7 天");
    setShareTtlDays(0);
    assert.equal(shareTtlDays(), 0, "0 = 永久");
    setShareTtlDays("30");
    assert.equal(shareTtlDays(), 30, "字符串数字也认");
    assert.equal(setShareTtlDays(999), 7, "非法值写入后回落默认");
    assert.equal(shareTtlDays(), 7);
  });
});

test("newShareId：9 字节 base36，长度与字符集稳定（与云端同算法）", async () => {
  await withBrowserStubs(async () => {
    const { newShareId } = await import("../public/modules/share-cloud.js");
    const a = newShareId();
    const b = newShareId();
    assert.match(a, /^[0-9a-z]{18}$/);
    assert.notEqual(a, b, "两次生成应不同");
  });
});

test("shareLink：固定指向云端 share.html，带 d 参数", async () => {
  await withBrowserStubs(async () => {
    const { shareLink } = await import("../public/modules/share-cloud.js");
    assert.equal(shareLink("abc123"), "https://mytemple-cloud.app.workbuddy.host/share.html?d=abc123");
  });
});

test("refToAsset：ws_ 前缀段是工作区 id，relPath 与云端读侧候选同构", async () => {
  await withBrowserStubs(async () => {
    const { refToAsset } = await import("../public/modules/share-cloud.js");
    // 绝对 + ws 前缀（真实案例：/source/ws_25a724bd6b/screenshot-x.webp）
    assert.deepEqual(refToAsset("/source/ws_25a724bd6b/screenshot-x.webp", "temple"), {
      wsId: "ws_25a724bd6b",
      fetchRel: "screenshot-x.webp",
      relPath: "source/ws_25a724bd6b/screenshot-x.webp",
    });
    // 无前导斜杠的 ws 形态
    assert.deepEqual(refToAsset("source/ws_abc1/p.webp", "temple"), {
      wsId: "ws_abc1",
      fetchRel: "p.webp",
      relPath: "source/ws_abc1/p.webp",
    });
    // 普通 source/ 引用：本工作区取，键带 source/ 前缀
    assert.deepEqual(refToAsset("source/screenshot-x.webp", "temple"), {
      wsId: "temple",
      fetchRel: "screenshot-x.webp",
      relPath: "source/screenshot-x.webp",
    });
    // 裸文件名：键保持裸名（读侧候选 #1 就是裸名）
    assert.deepEqual(refToAsset("img/pic.png", "temple"), {
      wsId: "temple",
      fetchRel: "img/pic.png",
      relPath: "img/pic.png",
    });
    assert.deepEqual(refToAsset("pic.png", "temple"), {
      wsId: "temple",
      fetchRel: "pic.png",
      relPath: "pic.png",
    });
    // 相对 ./ 前缀剥掉；路径穿越拒绝
    assert.equal(refToAsset("./source/a.webp", "temple").relPath, "source/a.webp");
    assert.equal(refToAsset("../etc/passwd", "temple"), null);
    assert.equal(refToAsset("", "temple"), null);
  });
});
