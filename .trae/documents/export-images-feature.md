# 导出文档截图资源功能

## Context

用户在编写文档时插入的截图/图片资源保存在工作区的 `source/` 目录中，通过 `/source/screenshot-xxx.webp` 路径引用。当需要将文档移植到其他位置时，这些图片资源散落在各处，难以一并带走。需要新增一个导出入口，将当前文档中引用的所有本地图片一次性导出到用户选择的文件夹中，方便文档整体迁移。

## 方案

### 1. 前端：新增菜单项 + 导出函数

**index.html L1547 后新增菜单按钮**：
```html
<button class="menu-option" data-action="export-images">
  <span class="menu-option-icon">🖼️</span>导出截图资源
</button>
```

**app.js action 映射**（~L13059）新增：
```javascript
"export-images": () => exportDocImages(),
```

**app.js 新增 `exportDocImages()` 函数**，逻辑：
1. 获取当前文档内容 `state.currentContent`
2. 用正则提取所有图片引用：`!\[.*?\]\(([^)]+)\)` + `<img[^>]+src="([^"]+)"`
3. 过滤：跳过 `data:` URL 和 `http(s)://` 外部 URL，只保留本地资源路径（`/source/`、`/ws-asset/` 等）
4. 对每个图片 URL，`fetch()` 获取 blob → `FileReader.readAsDataURL()` 转为 base64
5. 提取文件名：从 URL 最后一段取 `screenshot-xxx.webp`
6. 调用后端 `/api/export/save-images` 端点，传递 `{ folder: null, images: [{name, dataBase64}] }`
7. 后端返回保存的文件夹路径，前端 `showToast` 提示成功

### 2. 后端：新增批量保存端点

**src-tauri/src/handlers.rs** 新增：

- 路由：`POST /api/export/save-images`（~L183 附近）
- 请求体：
  ```rust
  struct SaveImagesRequest {
      images: Vec<ImageData>,
  }
  struct ImageData {
      name: String,       // 文件名，如 "screenshot-xxx.webp"
      data_base64: String, // base64 编码的图片数据
  }
  ```
- 处理流程：
  1. 通过 `tauri_plugin_dialog` 弹出**选择文件夹**对话框
  2. 用户选择后，遍历 `images` 数组，base64 解码后写入 `<选择的文件夹>/<name>`
  3. 返回 `{ path: <文件夹路径>, saved: <数量> }`，用户取消返回 `{ path: null }`
- 参考 [handlers.rs:3018](file:///d:/game/mytemple/src-tauri/src/handlers.rs#L3018) 的 `export_save_as_http` 实现模式

### 3. 关键文件

| 文件 | 修改内容 |
|------|---------|
| `public/index.html` ~L1547 | 新增菜单按钮 |
| `public/app.js` ~L13059 | 新增 action 映射 |
| `public/app.js` ~L2871 附近 | 新增 `exportDocImages()` 函数 |
| `src-tauri/src/handlers.rs` ~L183 | 新增路由 |
| `src-tauri/src/handlers.rs` ~L3018 附近 | 新增 `save_images_http` handler |

## 验证

1. 打开一个包含截图的文档
2. 点击菜单 → 导出截图资源
3. 系统弹出文件夹选择对话框
4. 选择文件夹后，所有截图文件出现在该文件夹中
5. Toast 提示成功导出数量和路径
6. 无截图的文档点击后提示"未找到图片资源"
