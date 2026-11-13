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
  /* 站点访问参数（WorkBuddy 站点平台的防爬口令，绑定 applicationId）。
   *
   * 2026-11-13 平台升级后，**任何页面不带这个参数一律 403「链接不完整」**，
   * 裸域名不再是可用入口（浏览器只带 cookie 时除外 —— 首次必须由带参链接种下）。
   * 所以：分享链接、桌面端「打开云端」、APK 启动地址都必须带上它。
   * 实测同一 appId 反复重新发布，sharecode 不变；若某次发布后失效，
   * 从发布结果返回的 shareLink 里取出新值，改这一处（云端）并同步
   * public/modules/cloud-client.js 的同名常量。 */
  shareCode: "XEPPD6GHYK",
};
