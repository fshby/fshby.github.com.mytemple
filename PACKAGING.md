打包与安装说明

## 一键生成安装包

双击项目根目录下的 `一键打包.cmd` 即可完成打包。

也可以在 PowerShell 中执行：

```powershell
.\build-installer.ps1
```

工具会自动完成：

1. 读取并校验 `version.json`。
2. 检查必要文件、C# 编译器和 JavaScript 语法。
3. 编译启动器并组装、校验 `payload.zip`。
4. 将当前版本号自动注入安装程序。
5. 同时生成通用安装包和带版本号安装包。
6. 生成 SHA-256 校验文件与构建清单。
7. 构建成功或失败后自动清理临时目录。

构建会强制校验 `docs` 中的默认使用说明和 `知识库主清单.json`。安装后这些文件位于：

```text
%LOCALAPPDATA%\MyTempleKnowledge\docs
```

应用每次刷新知识库时会在该目录重新生成 `知识库主清单.json`，供本地 AI 工具快速读取文档索引和图谱关系。用户实际知识文档仍保存在工作区或 `%LOCALAPPDATA%\MyTempleKnowledgeData\docs`，不会被主清单覆盖。

生成结果：

```text
dist\MyTempleKnowledge.exe
dist\MyTempleKnowledge_Setup.exe
dist\MyTempleKnowledge_Setup_v<version>.exe
dist\checksums.sha256
dist\build-manifest.json
```

其中 `<version>` 自动取自 `version.json`，以后升级版本只需修改这一个文件。

如需保留临时构建文件以便排查：

```powershell
.\build-installer.ps1 -KeepBuildFiles
```

## 手工生成安装包（备用）

在项目根目录执行以下步骤：

1. 编译启动器：
```powershell
$cscPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$cscPath /target:winexe /out:dist\MyTempleKnowledge.exe /win32icon:packaging\logo.ico /platform:x64 /nologo /reference:System.Windows.Forms.dll /reference:System.Drawing.dll packaging\Launcher.cs
```

2. 更新 payload.zip：
```powershell
$tempDir = "packaging\build_temp"
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir | Out-Null

Copy-Item "server.js" -Destination $tempDir
Copy-Item "version.json" -Destination $tempDir
Copy-Item "public" -Destination $tempDir -Recurse
Copy-Item "docs" -Destination $tempDir -Recurse
Copy-Item "source" -Destination $tempDir -Recurse
Copy-Item "packaging\logo.ico" -Destination $tempDir
Copy-Item "dist\MyTempleKnowledge.exe" -Destination $tempDir

$zipPath = "packaging\payload.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$tempDir\*" -DestinationPath $zipPath -Force

Remove-Item $tempDir -Recurse -Force
```

3. 编译安装程序：
```powershell
$cscPath /target:exe /out:dist\MyTempleKnowledge_Setup.exe /resource:packaging\payload.zip,payload.zip /win32icon:packaging\logo.ico /platform:x64 /nologo /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll packaging\SelfExtractInstaller.cs
```

生成结果：
dist\MyTempleKnowledge_Setup.exe

版本管理

每次打包新版本时，只需修改一个文件：
version.json

```json
{
  "version": "1.1.4",
  "downloadUrl": "https://github.com/fshby/fshby.github.com.mytemple/releases/download/v1.1.4/MyTempleKnowledge_Setup.exe",
  "releaseNotes": "新版本特性描述...",
  "releaseDate": "2026-07-17"
}
```

启动器会自动从本地 version.json 读取当前版本号，无需手动修改 Launcher.cs。

安装路径

默认安装到当前用户目录：
%LOCALAPPDATA%\MyTempleKnowledge

用户文档和图片资源会存放到独立数据目录：
%LOCALAPPDATA%\MyTempleKnowledgeData\docs
%LOCALAPPDATA%\MyTempleKnowledgeData\source

安装包更新时只覆盖程序文件，不会覆盖用户新建的 Markdown 文档和截图资源。

依赖检查

安装程序会检查本机是否存在 Node.js：
• 优先查找 PATH 中的 node.exe
• 兼容 D:\node\node.exe
• 兼容 Program Files\nodejs\node.exe

如果没有检测到 Node.js，弹窗提示用户下载，并提供一键跳转到官方下载页面的链接。

启动逻辑

安装包会释放项目文件，并启动：
MyTempleKnowledge.exe

启动器（C# 编写）会：

1. 检查 server.js 是否存在。
2. 检查 Node.js 是否可用。
3. 从本地 version.json 读取当前版本号。
4. 初始化用户数据目录，并在首次运行时复制内置示例文档。
5. 启动本地 Markdown 服务。
6. 自动打开浏览器访问 http://localhost:4173/。
7. 如果 4173 被占用，依次尝试后续端口。
8. 保留系统托盘图标，右键菜单包含"打开主页"、"检查更新"、"退出"选项。
9. 点击退出时，优雅关闭 Node.js 进程。

卸载与更新

卸载

安装程序在第一次安装时会向系统"程序和功能"注册卸载条目。卸载时：
• 删除安装目录（%LOCALAPPDATA%\MyTempleKnowledge）
• 保留用户数据目录（%LOCALAPPDATA%\MyTempleKnowledgeData），并提供选项"是否同时删除用户文档"
• 移除桌面快捷方式

自动更新

启动器内置版本检查模块。每次启动时（或每隔 24 小时）向服务器请求：
https://raw.githubusercontent.com/fshby/fshby.github.com.mytemple/main/version.json

对比本地版本号。若发现新版本：
• 弹窗提示用户下载更新
• 用户确认后，显示下载进度窗口（带进度条和百分比）
• 下载完成后，以管理员身份启动安装程序（覆盖安装，保留数据目录）
• 安装完成后用户手动双击快捷方式重启

分享安装包

只需要分享这个文件：
dist\MyTempleKnowledge_Setup.exe

不需要同时分享 build、docs、public 或其他目录。安装程序会自动释放完整项目。

Logo

Logo 源文件：
packaging\logo.ico

构建脚本会将图标嵌入安装程序和启动器。

体积控制

当前方案不打包 Node.js 和 Chromium，只打包项目文件和轻量启动器，因此体积很小（约 500 KB）。远优于 Electron 方案（通常 > 100 MB）。

CI/CD 集成（可选）

建议将构建脚本集成到 GitHub Actions 中：

示例 GitHub Actions 工作流片段（.github/workflows/build.yml）：
```yaml
name: Build Installer
on:
  push:
    tags:
      - 'v*'
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build and validate installer
        shell: powershell
        run: .\build-installer.ps1
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: MyTempleKnowledge-${{ github.ref_name }}
          path: |
            dist/MyTempleKnowledge_Setup*.exe
            dist/checksums.sha256
            dist/build-manifest.json
```

故障排除

常见问题及解决方法

现象 可能原因 解决

安装后双击无反应 Node.js 未正确安装或 PATH 未生效 检查启动器日志，确保 Node.js 18+ 已安装

浏览器无法打开页面 端口被其他程序占用 查看托盘图标显示的端口号，手动访问该地址

杀毒软件误报 未数字签名 提交误报申诉，或购买代码签名证书

更新后文档丢失 更新脚本未正确处理数据目录 检查数据目录 %LOCALAPPDATA%\MyTempleKnowledgeData 是否存在

权限不足 无法创建/修改文档 检查用户数据目录的权限设置

如需更多帮助，请联系开发者或查阅项目 Wiki。
