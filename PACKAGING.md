# 打包与安装说明

## 生成安装包

在项目根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\packaging\Build-Installer.ps1
```

生成结果：

```text
dist\MyTempleKnowledgeSetup.exe
```

这个文件是单文件安装程序，内部已经嵌入完整项目载荷。可以直接把这个 exe 发给他人，对方双击后即可安装。

首次安装时会检查依赖、安装项目、创建桌面快捷方式并启动应用。非首次安装或更新时，如果已经存在桌面快捷方式，不会重复创建，也不会再次提示“已创建快捷方式”。

## 安装路径

默认安装到当前用户目录：

```text
%LOCALAPPDATA%\MyTempleKnowledge
```

这样不需要管理员权限，也便于后续覆盖安装。

用户文档和图片资源会存放到独立数据目录：

```text
%LOCALAPPDATA%\MyTempleKnowledgeData\docs
%LOCALAPPDATA%\MyTempleKnowledgeData\source
```

这样安装包更新时只覆盖程序文件，不会覆盖用户新建的 Markdown 文档和截图资源。旧版本如果曾经把文档写在安装目录下，安装器会在更新前尝试迁移到这个数据目录。

## 依赖检查

安装程序会检查本机是否存在 Node.js：

- 优先查找 `PATH` 中的 `node.exe`
- 兼容 `D:\node\node.exe`
- 兼容 `Program Files\nodejs\node.exe`

如果没有检测到 Node.js，会弹窗提示用户先安装 Node.js 18 或更高版本。

## 启动逻辑

安装包会释放项目文件，并启动：

```text
MyTempleKnowledge.exe
```

启动器会：

1. 检查 `server.js` 是否存在。
2. 检查 Node.js 是否可用。
3. 初始化用户数据目录，并在首次运行时复制内置示例文档。
4. 启动本地 Markdown 服务。
5. 自动打开浏览器访问 `http://localhost:4173/`。
6. 如果 `4173` 被占用，会尝试后续端口。
7. 保留一个任务栏控制窗口，点击关闭即可停止后台服务并退出。

## 分享安装包

只需要分享这个文件：

```text
dist\MyTempleKnowledgeSetup.exe
```

不需要同时分享 `build`、`docs`、`public` 或其他目录。安装程序会自动释放完整项目。

## Logo

Logo 源文件：

```text
packaging\logo.svg
```

构建脚本会生成 `.ico` 并嵌入安装程序和启动器。

## 体积控制

当前方案不打包 Node.js 和 Chromium，只打包项目文件和轻量启动器，因此体积很小。

这个设计适合继续控制最终 exe 体积。如果后续引入 Electron 或内置浏览器运行时，体积会明显增加。
