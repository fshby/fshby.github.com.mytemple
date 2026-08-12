# MyTemple Knowledge 推广页

这是一个零依赖的静态推广页，包含柔光护眼主视觉、产品功能、使用文档与版本下载入口。

## 本地预览

在项目根目录运行：

```powershell
python -m http.server 4555 -d promo
```

然后打开 <http://localhost:4555/>。也可以直接将 `promo` 目录部署到任意静态托管服务。

## 设计与性能

- 主视觉使用原生 Canvas，不依赖 Three.js/CDN，适合离线分发与低资源部署。
- 图谱动画使用 IntersectionObserver 和 Page Visibility API：离开视口或切换标签页时暂停。
- `prefers-reduced-motion` 开启后自动关闭运动与滚动入场动画。
- 移动端减少节点数量，Canvas DPR 上限为 1.5，避免高分屏放大绘制成本。
- 移动端禁用原生下拉刷新（`overscroll-behavior: none`），并使用 `svh` 视口单位避免地址栏伸缩导致的空白。
- 文案中的正式版本更新为 v1.8.3；安装入口统一指向官方下载地址，避免失效直链。

## 文档与隐私

- 使用文档已内置到推荐页「使用文档」分区，无需外链。
- 隐私声明见 `privacy.html`，与推荐页保持同一套柔光护眼配色。
