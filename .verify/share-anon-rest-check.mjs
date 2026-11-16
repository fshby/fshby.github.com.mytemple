/**
 * 云端分享匿名读通道回归探针（线上实测，非本地桩）。
 *
 * 历史上这里抓过两次事故，判据也随之演进：
 *
 *  A. v2.3.0：shared_docs 缺 anon SELECT GRANT → 401 DATABASE_42501，
 *     分享页落「暂时打不开」。当时判据是「200 + 空数组」= 授权在。
 *  B. v2.3.3（安全审计）：表级 SELECT 只能约束「哪些行可见」，约束不了
 *     「能不能不带条件全表 dump」—— 匿名访客可以直接列出**全部**有效分享，
 *     链接保密模型形同虚设。改为：收回 anon 表级 SELECT，只暴露
 *     SECURITY DEFINER 的 RPC（按精确 id 取单条）。
 *
 * 因此现在的正确形态是「表 401 / RPC 200」，与 A 的判据恰好相反。
 *
 * 判据：
 *   1. share.html 可访问（200）；
 *   2. 匿名 GET /shared_docs、/shared_assets → **必须 401**（无表级授权）；
 *      若返回 200，说明枚举漏洞又回来了（本探针要抓的回归）；
 *   3. 匿名 POST /rpc/get_shared_doc（不存在 id）→ 200 且 []（RPC 可达且不泄露）；
 *   4. 匿名 POST /rpc/get_shared_assets（不存在 id）→ 200 且 []；
 *   5. 可选：指定 shareId → RPC 返回恰好 1 条。
 *
 * 用法：node .verify/share-anon-rest-check.mjs [shareId]
 */
import https from "node:https";

const ENDPOINT = "https://mytemple-cloud.app.workbuddy.host";
const PK = "wbpk_G343AdQ6OFueHemYr3IGkx_sc9KxfodCjPrrmWiBJCwucmyPuwaGSV5";
const HDR = { apikey: PK, "X-Wb-Webapp-Access-Key": PK, accept: "application/json" };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  → " + detail : ""));
}

function get(path, headers) {
  return new Promise((resolve, reject) => {
    https
      .get(ENDPOINT + path, { headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

function postJson(path, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(ENDPOINT + path);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
          headers
        ),
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const REST = "/.cloud/database/rest/v1";
const randomId = Array.from({ length: 18 }, () => "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 36)]).join("");
/** 站点访问参数（平台 2026-11 升级后裸路径一律 403「链接不完整」）。 */
const SHARE_CODE = "XEPPD6GHYK";

// 1. 分享页本身可达（必须带 sharecode：访客没有站点 cookie）
const page = await get("/share.html?d=" + randomId + "&sharecode=" + SHARE_CODE, {});
check("share.html 可访问（200，带站点访问参数）", page.status === 200, "status=" + page.status);

// 2/3. 匿名表级 SELECT 必须被拒（枚举漏洞的回归锁）
for (const [table, q] of [
  ["shared_docs", `/shared_docs?select=id,title,content&limit=5`],
  ["shared_assets", `/shared_assets?select=share_id,bytes_b64&limit=5`],
]) {
  const r = await get(REST + q, HDR);
  const denied = r.status === 401 || r.status === 403;
  check(
    table + " 匿名表级 SELECT 已被拒（不可枚举）",
    denied,
    denied ? `status=${r.status}` : `status=${r.status} body=${(r.body || "").slice(0, 120)}`
  );
}

// 4/5. RPC 通道可达且不泄露（不存在 id → 空数组）
for (const [name, payload] of [
  ["get_shared_doc", { p_id: randomId }],
  ["get_shared_assets", { p_share_id: randomId, p_limit: 5 }],
]) {
  const r = await postJson(REST + "/rpc/" + name, payload, HDR);
  const body = (r.body || "").trim();
  const ok = r.status === 200 && body === "[]";
  check(
    `rpc/${name} 可达且不泄露（200 + 空数组）`,
    ok,
    ok ? "status=200 body=[]" : `status=${r.status} body=${body.slice(0, 120)}`
  );
}

// 6. 可选：验证指定分享可读
const shareId = process.argv[2];
if (shareId) {
  const r = await postJson(REST + "/rpc/get_shared_doc", { p_id: shareId }, HDR);
  const rows = (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })();
  check(
    `分享 ${shareId} 匿名可读（RPC 1 条）`,
    r.status === 200 && Array.isArray(rows) && rows.length === 1,
    r.status === 200 ? "rows=" + rows.length : `status=${r.status} body=${(r.body || "").slice(0, 120)}`
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`==== ${results.length - failed.length}/${results.length} 通过 ====`);
if (failed.length) process.exitCode = 1;
