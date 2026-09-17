# Alt+A 区域截图 / Alt+M 区域录屏 快捷键 实现计划

## 仓库调研结论

### 现状

- **设置面板**：已有 `shortcuts` 面板（index.html \~L922），目前只展示快捷键说明文档，无可配置开关

- **全局 keydown 监听**：app.js \~L11188，已有成熟的 `event.altKey + key.toLowerCase()` 匹配模式

- **Alt+A / Alt+M 当前行为**：无任何拦截，Windows 和浏览器中均无标准冲突

- **localStorage 持久化**：已有成熟模式（如 `mt_showSpellcheck`）

- **保存对话框**：已有 `tauri-plugin-dialog`

- **版本号**：4 处需同步更新 — Cargo.toml、tauri.conf.json、version.json、promo/version.json

### 约束与风险

1. **屏幕捕获 API 权限**：`navigator.mediaDevices.getDisplayMedia()` 在 WebView2 中需 Windows 系统设置开启权限
2. **录屏 MediaRecorder**：产物为 WebM 格式
3. **区域选择实现**：需正确处理 devicePixelRatio 避免选区偏移
4. **ESC 冲突**：录屏过程中 ESC 可能触发应用其他快捷键，需设全局 flag 阻断

### 技术选型

纯前端 Web API 方案，无额外 Rust/插件依赖：

- 区域截图：`getDisplayMedia()` → Canvas 裁剪 → `toBlob` PNG → Tauri dialog 保存

- 区域录屏：`getDisplayMedia()` → Canvas 裁剪绘制 → `captureStream()` → `MediaRecorder` → WebM → Tauri dialog 保存

## 文件与模块

| 文件                          | 变更                                                                     |
| --------------------------- | ---------------------------------------------------------------------- |
| `public/index.html`         | shortcuts 面板新增 2 个 checkbox 开关                                         |
| `public/app.js`             | state 初始化、keydown 监听、captureRegion/screenshot/recording 函数、checkbox 绑定 |
| `public/styles.css`         | 遮罩 + 选择框 + 提示条样式                                                       |
| `src-tauri/Cargo.toml`      | version 2.0.1 → 2.0.2                                                  |
| `src-tauri/tauri.conf.json` | version 2.0.1 → 2.0.2                                                  |
| `version.json`              | version + releaseNotes                                                 |
| `promo/version.json`        | version + releaseNotes                                                 |

**不修改**：handlers.rs、ipc.rs、lib.rs

## 实现步骤

### 1. 版本号 2.0.1 → 2.0.2（4 文件）

### 2. index.html shortcuts 面板新增 checkbox section

### 3. app.js state 新增字段 + checkbox 绑定 + localStorage

### 4. app.js keydown 监听新增 Alt+A / Alt+M 分支（前置 `!state.enableCaptureShortcut` 检查）

### 5. app.js 新增 captureRegion() / startRegionScreenshot() / startRegionRecording()

### 6. styles.css 新增遮罩样式

### 7. cargo check → cargo build --release → cargo tauri build

## 验证清单

- [ ] Alt+A → 触发区域截图 → 框选 → 另存为 PNG

- [ ] Alt+M → 触发区域录屏 → 框选 → ESC 停止 → 另存为 WebM

- [ ] 设置面板 checkbox 可切换，localStorage 持久化

- [ ] 重启后快捷键开关保留

- [ ] 版本号升级正确

- [ ] release 构建成功

## 风险与处理

| 风险                  | 处理                                        |
| ------------------- | ----------------------------------------- |
| getDisplayMedia 不可用 | 提前 return + showToast 提示                  |
| 区域选择框漂移（DPI）        | screenX/Y 或 clientX/Y \* devicePixelRatio |
| MediaRecorder 不可用   | 降级提示"当前环境不支持录屏"                           |
| ESC 触发应用其他快捷键       | 录屏态设全局 flag 阻断                            |

