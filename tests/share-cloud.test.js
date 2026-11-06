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
