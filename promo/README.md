# MyTemple Knowledge 推广页

这是一个零依赖的静态推广页，包含暗色知识神经网络主视觉、产品功能、AI 接入、使用文档与版本下载入口。

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
- 文案中的正式安装包指向 GitHub Releases v1.1.5；v1.1.6 P0 明确标记为 `other` 源码预览，避免把开发分支误作稳定下载。
