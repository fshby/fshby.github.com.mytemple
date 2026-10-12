/**
 * 云端工作台的公开配置。
 *
 * 这四个值全部来自开通云服务时返回的 publicConfig（应用：知识库云端 /
 * wbapp_G343AdQ6OFueHemYr3IGkx），其中只有 publishableKey 是「标识应用」的
 * 公开键，本身不带任何权限。鉴权只看请求头里的 X-Wb-Webapp-Access-Key 与登录后的 JWT，
 * 再由数据库行级安全（RLS）决定能读能写哪几行 —— **与请求来源无关**。
 * 正因如此，桌面端（Tauri）与 Android 端可以直接跨源调用本 endpoint，无需浏览器中转：
 * 实测 OPTIONS 预检返回 204 且回显任意 Origin，允许头含 Authorization 与 X-Wb-Webapp-Access-Key。
 * 任何长期密钥都不会出现在前端。
 *
 * endpoint 必须始终来自这里，不要改写成 location.origin / 环境变量或其它域名：
 * 应用重新发布后域名不变（复用同一 applicationId），换域名会导致云端登录失效。
 */
window.__MT_CLOUD__ = {
  resourceId: "wbcs_CrIB9Ysl2jP8kyQFKlzNbq",
  endpoint: "https://mytemple-cloud.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_G343AdQ6OFueHemYr3IGkx_sc9KxfodCjPrrmWiBJCwucmyPuwaGSV5",
};
