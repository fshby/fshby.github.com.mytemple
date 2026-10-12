/**
 * 云端工作台的公开配置。
 *
 * 这四个值全部来自开通云服务时返回的 publicConfig（应用：知识库云端 /
 * wbapp_G343AdQ6OFueHemYr3IGkx），其中只有 publishableKey 是「标识应用」的
 * 公开键，本身不带任何权限 —— 服务端还会校验请求来源必须是本应用的发布域名。
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
