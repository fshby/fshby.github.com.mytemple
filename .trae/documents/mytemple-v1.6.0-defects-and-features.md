# MyTemple Knowledge v1.6.0 — 缺陷修复 + 新增功能

## Context

用户报告 5 个编辑模式缺陷与 5 项新功能需求。本次迭代聚焦：完善编辑模式心流体验（大纲默认折叠、粘贴稳定性、预览去闪烁、表格可扩展、Obsidian 语法兼容），并补齐安装器可视体验、PPT 导出、导出水印、AI 润色/续写/代写、AI 智能编辑提示。

版本号将由 `1.5.0` 升至 `1.6.0`，同步更新 `version.json` 与安装器 `APP_VERSION`。

所有修改遵循项目既有约定：CSS 变量主题、自定义对话框（不泄露地址端口）、`version.json` 在 GitHub master 根目录、打包前 `node --check` 语法校验包含 `server\doc-views.js`。

---

## 一、缺陷修复

### 缺陷 1：编辑模式大纲子标题默认折叠
**根因**：`renderEditorOutline`（[app.js:1114](file:///e:/codex/mytemple/public/app.js)）生成 `<section class="editor-outline-group">` 时 `aria-expanded="true"` 且子标题区可见（无 `is-collapsed`），与阅读模式 `renderOutlineItems`（[app.js:1065](file:///e:/codex/mytemple/public/app.js)）默认折叠不一致。
**改法**：
- [app.js:1114-1119](file:///e:/codex/mytemple/public/app.js)：section 加 `is-collapsed` 初始类，`aria-expanded="true"` → `"false"`，标题改为「展开子标题」。
- 确认 CSS 已支持隐藏：`.editor-outline-children.is-collapsed { display: none }`（[styles.css:2217](file:///e:/codex/mytemple/public/styles.css)）已就绪，无需改 CSS。
- 折叠/展开切换逻辑（[app.js:7233-7238](file:///e:/codex/mytemple/public/app.js)）已存在，保持不变。

### 缺陷 2：空/短文档粘贴长文本失败
**根因**：`handleEditorPaste`（[app.js:5374](file:///e:/codex/mytemple/public/app.js)）在捕获阶段拦截，`shouldWrapPastedCode`（[app.js:5178](file:///e:/codex/mytemple/public/app.js)）的判定 `/[{};=<>]|.../` 过于宽松——长篇中文/含 `=`、`<` 的文案被误判为代码 → `event.preventDefault()` → `insertAtCursor` 经 CodeMirror 封装 `setRangeText`（[app.js:4996](file:///e:/codex/mytemple/public/app.js)）对超大单次插入处理异常，导致粘贴整体丢失。
**改法**：
- [app.js:5178](file:///e:/codex/mytemple/public/app.js) `shouldWrapPastedCode`：增加体积上限（如 `> 20000` 字符直接判定为非代码）并收紧代码判定（要求同时命中至少 2 个代码特征，或命中关键字且行数 ≥ 3）。
- [app.js:5374](file:///e:/codex/mytemple/public/app.js) `handleEditorPaste`：对超长纯文本走「不拦截、交由 CodeMirror 原生粘贴」路径，确保不丢内容；仅在确认为代码且体积合理时才 preventDefault + 包裹围栏。
- `insertAtCursor` 增加安全校验：插入失败时回退到 `document.execCommand('insertText')` 并兜底提示，避免静默失败。
- 实现阶段用一段超长中文（含 `=`/`<`）回归验证。

### 缺陷 3：插入 Markdown 时右侧预览闪烁
**根因**：`renderCurrentPreviewAsync`（[app.js:3330](file:///e:/codex/mytemple/public/app.js)）每次全量 `els.preview.innerHTML = html`（[app.js:3341](file:///e:/codex/mytemple/public/app.js)）替换，DOM 重建造成视觉抖动。
**改法**（轻量、不引入新依赖）：
- 在 `els.preview` 容器加 CSS `transition: opacity .12s ease`，替换前 `opacity:.55`，替换后 `requestAnimationFrame` 恢复 `1`，掩盖重排瞬间。
- `schedulePreviewUpdate`（[app.js:3357](file:///e:/codex/mytemple/public/app.js)）：插入类操作（代办/表格/链接等工具栏按钮触发）走 `immediate` 路径时合并到同一 `requestAnimationFrame`，避免多次重排。
- 内容未变（`state.previewLastContent === content`）时直接 return（已有，[app.js:3333](file:///e:/codex/mytemple/public/app.js)），保留。
- 预览滚动位置在重渲染后恢复（已有 `syncPreviewToEditor`，确认不丢）。

### 缺陷 4：编辑模式表格不能手动扩展行/列
**现状**：`insertMarkdownTable`（[app.js:5280](file:///e:/codex/mytemple/public/app.js)）插入静态 Markdown 表格；`flushTable`（[app.js:1724](file:///e:/codex/mytemple/public/app.js)）渲染为只读 HTML。
**改法**：
- `flushTable` 渲染时在每个表格外包 `<div class="md-table-tools">`，提供「+ 行」「+ 列」「- 列」按钮，并记录该表在源码中的起始行号（`data-table-start`）。
- 新增 `expandMarkdownTable(startLine, action)`：读取 `els.editor.value`，定位表格块（连续 `|` 行 + 分隔行），按操作改写源码并 `setRangeText` 回填，保留光标位置。
- 工具栏按钮点击委托在编辑器预览容器上统一监听（复用现有 `attachImageDeleteButtons` 同款委托模式）。
- 仅在编辑模式预览中显示工具按钮（阅读模式隐藏）。

### 缺陷 5：兼容 Obsidian Markdown 格式
**现状**（[app.js:1538 `inlineMarkdown`](file:///e:/codex/mytemple/public/app.js)）：已支持 `==高亮==`、`[[wikilink]]`、`++下划线++`、`~~删除~~`、任务列表、表格。
**补齐**（在 `renderMarkdown` / `inlineMarkdown` 中扩展，不引入 KaTeX 等重依赖）：
- **Callouts** `> [!note/info/tip/warning/danger/quote]`：在 `renderMarkdown`（[app.js:1737](file:///e:/codex/mytemple/public/app.js)）blockquote 处理处识别首行 `[!xxx]`，输出 `<div class="callout callout-{type}">` + 标题 + 内容；CSS 增配色（[styles.css](file:///e:/codex/mytemple/public/styles.css)）。
- **注释** `%%...%%`：`inlineMarkdown` 中替换为空字符串（渲染时不显示，源码保留）。
- **脚注** `[^id]` 与 `[^id]: 文本`：收集定义，行内引用渲染为 `<sup><a href="#fn-id">n</a></sup>`，文末追加 `<ol class="footnotes">`。
- **标签** `#tag`（行首或空格后、字母/数字/中文/下划线）：渲染为 `<span class="md-tag">#tag</span>`，排除 `#` 后跟数字（标题锚点）。
- **块引用 ID** `[[file#^blockid]]`：复用现有 `data-doc-link` 处理，显示为 `file`。
- 数学公式 `$$...$$` 本期以 `<code class="math">` 占位渲染（不做 KaTeX 渲染），在 releaseNotes 注明后续可接入。

---

## 二、新增功能

### 新增 1：安装包可视安装界面（WinForms GUI）
**现状**：`SelfExtractInstaller.cs`（[packaging/SelfExtractInstaller.cs](file:///e:/codex/mytemple/packaging/SelfExtractInstaller.cs)）为控制台程序；`build-installer.ps1:229` 用 `/target:exe` 编译。
**改法**：
- 将 `SelfExtractInstaller.cs` 重写为 WinForms 窗体程序：
  - **启动闪屏**：无边框窗体 + 品牌 logo（复用 `packaging/logo1.ico` / 新建 PNG 资源）+ 渐入，避免黑屏；闪屏在主线程 `Application.Run` 前显示。
  - **主界面**：进度条 + 步骤文案（停止旧进程/解压/复制/初始化/快捷方式/清理）+ logo 广告位。
  - **快捷方式勾选**：桌面快捷方式、开始菜单项默认不勾，用户手动勾选后才创建（改造 `CreateDesktopShortcut` 按勾选状态执行）。
  - **隐藏安装目录详情**：不显示完整路径，仅显示「正在安装到本地应用数据目录」。
  - **Node 依赖引导**：检测 `node.exe`（复用 `Get-Command node` 同款逻辑，C# 用 `where node` / `PATH` 查找）；缺失则弹引导窗：说明需要 Node.js，提供「打开官方下载页」按钮 + 「我已安装，重新检测」按钮，检测通过后继续安装。
  - **完成页**：安装完成后提供「立即启动」「完成」按钮。
- [build-installer.ps1:229-239](file:///e:/codex/mytemple/build-installer.ps1)：编译参数 `/target:exe` → `/target:winexe`，新增 `/reference:System.Windows.Forms.dll`、`/reference:System.Drawing.dll`；确认 `payload.zip` 资源嵌入不变。
- 安装目录使用 `Environment.SpecialFolder.LocalApplicationData`，与现有一致。

### 新增 2：文档导出 PPT（HTML 幻灯片）
**方案**：HTML 幻灯片导出（用户已选）。
**改法**：
- [index.html](file:///e:/codex/mytemple/public/index.html) 导出菜单（L1076 附近）新增「导出 PPT」项；设置-导出栏（L466）新增 PPT 选项区。
- 新增 `exportCurrentDocToSlides()`（app.js）：
  - 解析当前文档：以 `---`（frontmatter 后）与 `#/##` 标题切分为幻灯片，每页一个 H1/H2；正文段落、图片、列表、表格归入对应页。
  - 支持手动分页符 `---`（与 `<hr>` 区分：单独成行且前后空行时分页）。
  - 截图/图片单独成页或与所属段落合并（按页面高度阈值拆分长页）。
  - 生成自包含 HTML：每页 `<section class="slide">`，左右键/空格翻页，含页码与进度；样式内联，图片 base64 内联（复用 `inlinePrintImages` [app.js:1218](file:///e:/codex/mytemple/public/app.js)）。
  - 触发浏览器打印，用户在打印对话框选「另存为 PDF」即得 PPT 风格文件；页面尺寸按 16:9。
- 设置-导出栏新增「幻灯片主题色」「每页最大行数」可编辑项。

### 新增 3：导出栏可编辑 + 强制水印（仅 PDF/PPT，轻度）
**改法**：
- [index.html:466-488](file:///e:/codex/mytemple/public/index.html) 导出栏：所有 checkbox 改为可编辑表单（保留 checkbox + 增加文本输入如署名文字、页脚文字、时间格式），新增「导出水印文字」可编辑字段（默认「MyTemple Knowledge」，不可清空，仅可改文字）。
- `buildDocumentPrintHtml`（[app.js:1194](file:///e:/codex/mytemple/public/app.js)）：注入水印层 `<div class="print-watermark">`，CSS 用 `position:fixed; repeat` 斜向铺满，透明度 ~8%，`pointer-events:none`，打印媒体查询中显示。
- PPT 导出（新增 2）同样注入水印层。
- 公众号复制（`copyCurrentDocAsWechat`）**不加**水印（用户已确认仅 PDF/PPT）。
- 水印不可关闭（强制），但文字可在导出栏编辑。

### 新增 4：AI 润色 / 续写 / 代写
**复用现有转换模态框**（用户已选）：`runAiTransform`（[app.js:3029](file:///e:/codex/mytemple/public/app.js)）+ `/api/ai/transform`（[server.js:1963](file:///e:/codex/mytemple/server.js)）+ `transformSelection`（[rag.js:731](file:///e:/codex/mytemple/server/rag.js)）。
**改法**：
- [index.html:866-868](file:///e:/codex/mytemple/public/index.html) 新增按钮：`data-ai-transform="polish"`（润色）、`continue`（续写）、`rewrite`（代写）。
- [app.js:18](file:///e:/codex/mytemple/public/app.js) `AI_TRANSFORM_LABELS` 增加三模式标签。
- [rag.js:731](file:///e:/codex/mytemple/server/rag.js) `transformSelection`：
  - 扩展 `mode` 白名单：`["summary","keypoints","terms","polish","continue","rewrite"]`。
  - `polish`：系统指令「在保留原意与文档格式（标题/列表/表格/代码块）前提下润色文字，使表达更流畅专业，输出完整 Markdown」。
  - `continue`：基于选中文本上下文续写，保持风格与格式一致。
  - `rewrite`（代写）：用户在模态框新增「写作要求」输入框，AI 按要求生成新文档（如「根据我的能力写一份简历」→ 输出格式完善的 Markdown 简历）。
- 模态框（[index.html:870](file:///e:/codex/mytemple/public/index.html)）：`rewrite` 模式显示「写作要求」输入框；结果可直接「插入当前位置」或「新建文档」（复用现有 `aiTransformCreateBtn` 逻辑 [app.js:3064](file:///e:/codex/mytemple/public/app.js)）。
- 续写/润色结果兼容文档格式：系统指令明确要求保留 Markdown 结构；导出时与正常文档一致走 `renderMarkdown`。

### 新增 5：AI 智能编辑提示
**改法**：
- [index.html:531](file:///e:/codex/mytemple/public/index.html) AI 与索引设置新增开关「智能编辑提示」（默认关），存 localStorage `aiEditHint`。
- app.js：编辑器光标停留计时器——`cursorActivity`/`selectionDidChange` 后若光标静止 ≥ 2.5s 且当前行/选区非空，调用 `/api/ai/transform` 新模式 `hint`（传当前段落 + 选区上下文），返回结构化提示（改写建议/注释/翻译三选一或综合）。
- 浮层 popover：光标附近显示小提示卡（不抢焦点、可忽略），含「采纳改写」「插入注释」「翻译为英文」按钮，点击调用对应 AI 模式复用模态框。
- 防抖：输入/滚动/移动光标重置计时器；同一段落 5 分钟内不重复提示；AI 不可用时静默不弹。
- [rag.js](file:///e:/codex/mytemple/server/rag.js) `transformSelection` 增加 `hint` 模式：系统指令「分析给定文本，给出 1 条精炼编辑提示：可选改写/注释/翻译建议，JSON 返回 `{hint, suggestion}`」。

---

## 三、涉及文件汇总

| 文件 | 改动 |
|---|---|
| `public/app.js` | 缺陷 1-5 全部；PPT 导出；水印注入；AI 润色/续写/代写/提示 |
| `public/index.html` | 导出栏可编辑化 + PPT 菜单/选项；AI 转换按钮；AI 提示开关 |
| `public/styles.css` | 预览去闪 transition；表格工具栏；callout/footnote/tag 样式；水印样式；PPT 幻灯片样式；AI 提示 popover |
| `server/rag.js` | `transformSelection` 扩展 polish/continue/rewrite/hint 模式 |
| `server.js` | 无实质改动（`/api/ai/transform` 已通用，仅需确认透传新 mode） |
| `packaging/SelfExtractInstaller.cs` | 重写为 WinForms GUI（闪屏/进度/快捷方式勾选/Node 引导） |
| `build-installer.ps1` | 编译参数 `/target:winexe` + WinForms 引用 |
| `version.json` | 版本 1.5.0 → 1.6.0，更新 downloadUrl 与 releaseNotes |

复用点：`buildDocumentPrintHtml`/`inlinePrintImages`（PDF 与 PPT 共用）、`runAiTransform` 模态框（AI 模式共用）、`renderMarkdown`（Obsidian 扩展）、`createCustomDialog`（地址不外泄）。

---

## 四、版本与发布

- `version.json`：`version` → `1.6.0`，`downloadUrl` 指向 `v1.6.0` release 资产，`releaseNotes` 列本次缺陷与功能，`releaseDate` 更新。
- `package.json` 的 `version` 同步至 `1.6.0`（当前为 1.3.0，保持与 version.json 一致）。

---

## 五、验证

1. **语法校验**：打包前 `node --check` 覆盖 `server.js`、`server\rag.js`、`server\doc-views.js`、`public\app.js`、`public\graph-worker.js`（build-installer.ps1 已配置）。
2. **缺陷回归**：
   - 大纲：进入编辑模式，含 H3+ 子标题的文档默认折叠，点击展开正常。
   - 粘贴：空文档粘贴 5 万字含 `=`/`<` 的中文文案，内容完整不丢失。
   - 闪烁：连续点击工具栏代办/表格/链接按钮，预览无明显抖动。
   - 表格：插入表格后用 +行/+列按钮扩展，源码与预览同步。
   - Obsidian：含 callout/`%%注释%%`/`[^1]`/`#tag` 的文档渲染正确。
3. **新功能**：
   - 安装器：运行 `MyTempleKnowledge_Setup_v1.6.0.exe`，闪屏无黑屏、进度条流畅、快捷方式需勾选才创建、卸载 node 模拟引导流程。
   - PPT：导出含图文的文档为幻灯片 HTML，翻页正常，打印为 PDF 页面 16:9。
   - 水印：导出 PDF/PPT 含轻度斜向水印，公众号复制无水印。
   - AI：配置 DeepSeek 后，润色/续写/代写结果可插入或新建文档；开启编辑提示后光标停留弹出提示卡。
4. **打包**：执行 `.\build-installer.ps1`，生成 `dist\MyTempleKnowledge_Setup_v1.6.0.exe`，校验 `build-manifest.json` 与 `checksums.sha256`。
5. **地址防泄露**：确认自定义对话框、PDF/PPT 导出均不出现 IP/端口。
