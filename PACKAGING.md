打包与安装说明

生成安装包

在项目根目录执行：
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\packaging\Build-Installer.ps1


生成结果：
dist\MyTempleKnowledgeSetup.exe


这个文件是单文件安装程序，内部已经嵌入完整项目载荷。可以直接把这个 exe 发给他人，对方双击后即可安装。

首次安装时会检查依赖、安装项目、创建桌面快捷方式并启动应用。非首次安装或更新时，如果已经存在桌面快捷方式，不会重复创建，也不会再次提示“已创建快捷方式”。

安装路径

默认安装到当前用户目录：
%LOCALAPPDATA%\MyTempleKnowledge


这样不需要管理员权限，也便于后续覆盖安装。

用户文档和图片资源会存放到独立数据目录：
%LOCALAPPDATA%\MyTempleKnowledgeData\docs
%LOCALAPPDATA%\MyTempleKnowledgeData\source


这样安装包更新时只覆盖程序文件，不会覆盖用户新建的 Markdown 文档和截图资源。旧版本如果曾经把文档写在安装目录下，安装器会在更新前尝试迁移到这个数据目录。

依赖检查与自动安装

安装程序会检查本机是否存在 Node.js：

• 优先查找 PATH 中的 node.exe

• 兼容 D:\node\node.exe

• 兼容 Program Files\nodejs\node.exe

如果没有检测到 Node.js，不再仅仅弹窗提示，而是提供两种可选行为（由构建参数控制）：

1. 自动下载便携版 Node.js：安装器从 CDN 镜像下载预编译的 Node.js 18 LTS 压缩包，解压到安装目录下的 node_portable 文件夹，并将其加入启动器的临时 PATH。此过程显示进度条，完成后直接启动应用。
2. 引导用户手动安装：弹窗提示用户下载，并提供一个一键跳转到官方 LTS 下载页面的链接（或国内镜像）。

推荐使用第一种方式，以保持“零手动干预”的用户体验。安装器体积增加约 20 MB，但仍远小于 Electron 方案。

启动逻辑

安装包会释放项目文件，并启动：
MyTempleKnowledge.exe


启动器（C# 编写）会：

1. 检查 server.js 是否存在。
2. 检查 Node.js 是否可用（若使用便携版则自动设置路径）。
3. 初始化用户数据目录，并在首次运行时复制内置示例文档。
4. 启动本地 Markdown 服务。
5. 自动打开浏览器访问 http://localhost:4173/。
6. 如果 4173 被占用，依次尝试后续端口，并在托盘图标右键菜单中显示“打开主页 (http://localhost:XXXX)”。
7. 保留一个任务栏控制窗口（或系统托盘图标），点击关闭或右键退出时，通过命名管道向 server.js 发送优雅关闭信号，确保文件写入完整后再终止进程。
8. 记录启动日志到 %LOCALAPPDATA%\MyTempleKnowledge\logs\launcher.log，便于排查问题。

卸载与更新

卸载

安装程序在第一次安装时会向系统“程序和功能”注册卸载条目。卸载时：
• 删除安装目录（%LOCALAPPDATA%\MyTempleKnowledge）

• 保留用户数据目录（%LOCALAPPDATA%\MyTempleKnowledgeData），并提供选项“是否同时删除用户文档”

• 移除桌面快捷方式和开始菜单快捷方式

自动更新

启动器内置版本检查模块。每次启动时（或每隔 24 小时）向服务器请求 https://yourdomain.com/version.json，对比本地版本号。若发现新版本：
• 弹窗提示用户下载更新

• 用户确认后，自动下载新的 MyTempleKnowledgeSetup.exe 并执行静默安装（覆盖安装，保留数据目录）

安全与防篡改加固

为防止他人直接修改项目源代码，在不引入 Electron 的前提下采用以下多层防护：

层级 措施 实施方式

源码混淆 对 public/ 目录下的 JS 文件使用 javascript-obfuscator 进行控制流平坦化、字符串加密 在构建脚本中作为前置步骤

资源加密 将所有 HTML/CSS/JS 打包成一个加密的 blob（AES-256），启动器在内存中解密后通过自定义协议传给 Node.js 或 WebView2 修改启动器加载逻辑

核心逻辑 Native 化 授权验证、关键算法用 C# 编写为 DLL，并使用 ConfuserEx 或 .NET Reactor 加壳 集成到启动器项目中

数字签名 对最终 exe 进行 Authenticode 签名（购买代码签名证书） 构建后步骤

注意：客户端保护无法做到绝对安全，最敏感的运算应放在服务端。

分享安装包

只需要分享这个文件：
dist\MyTempleKnowledgeSetup.exe


不需要同时分享 build、docs、public 或其他目录。安装程序会自动释放完整项目。

Logo

Logo 源文件：
packaging\logo.svg


构建脚本会生成 .ico 并嵌入安装程序和启动器。

体积控制

当前方案不打包 Node.js 和 Chromium，只打包项目文件和轻量启动器，因此体积很小。若启用“自动下载便携版 Node.js”功能，安装包体积约增加 20 MB（内含压缩的 Node.js 运行时）。即便如此，最终 exe 大小仍控制在 30 MB 以内，远优于 Electron 方案（通常 > 100 MB）。

CI/CD 集成（可选）

建议将构建脚本集成到 GitHub Actions 或 GitLab CI 中：

• 每次推送 Git Tag（如 v1.2.3）时自动触发构建

• 构建产物上传至 Release 页面

• 自动生成更新日志（基于 commit message）

• 可选：将安装包上传至私有分发服务器供自动更新使用

示例 GitHub Actions 工作流片段（.github/workflows/build.yml）：
name: Build Installer
on:
  push:
    tags:
      - 'v*'
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run build script
        run: powershell -NoProfile -ExecutionPolicy Bypass -File packaging/Build-Installer.ps1
      - name: Upload artifact
        uses: actions/upload-artifact@v3
        with:
          name: MyTempleKnowledgeSetup.exe
          path: dist/MyTempleKnowledgeSetup.exe


故障排除

常见问题及解决方法

现象 可能原因 解决

安装后双击无反应 Node.js 未正确安装或 PATH 未生效 检查启动器日志 %LOCALAPPDATA%\MyTempleKnowledge\logs\launcher.log

浏览器无法打开页面 端口被其他程序占用 查看托盘图标显示的端口号，手动访问该地址

杀毒软件误报 未数字签名或使用了混淆工具 提交误报申诉，或购买代码签名证书

更新后文档丢失 更新脚本未正确处理数据目录 检查数据目录 %LOCALAPPDATA%\MyTempleKnowledgeData 是否存在

如需更多帮助，请联系开发者或查阅项目 Wiki。