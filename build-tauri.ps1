[CmdletBinding()]
param(
    [switch]$Dev,       # 开发模式运行（不打包，直接调试）
    [switch]$Release    # Release 模式打包安装包
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$srcTauriDir = Join-Path $projectRoot "src-tauri"

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

try {
    # 检查 tauri CLI
    $tauriCmd = Get-Command "cargo-tauri.exe" -ErrorAction SilentlyContinue
    if (-not $tauriCmd) {
        Write-Step "安装 Tauri CLI..."
        cargo install tauri-cli
        if ($LASTEXITCODE -ne 0) { throw "Tauri CLI 安装失败" }
    }

    if ($Dev) {
        Write-Step "启动 Tauri 开发模式"
        Set-Location $projectRoot
        cargo tauri dev
        return
    }

    # 默认走 Release 打包
    Write-Step "读取版本号"
    $versionFile = Join-Path $projectRoot "version.json"
    $versionInfo = Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $version = [string]$versionInfo.version
    Write-Host "当前版本: v$version"

    Write-Step "Tauri Release 打包"
    Set-Location $srcTauriDir
    cargo tauri build
    if ($LASTEXITCODE -ne 0) { throw "Tauri 打包失败" }

    # 输出位置
    $bundleDir = Join-Path $srcTauriDir "target\release\bundle"
    Write-Step "打包完成"
    Write-Host "输出目录: $bundleDir"
    if (Test-Path $bundleDir) {
        Get-ChildItem $bundleDir -Recurse -File | ForEach-Object {
            Write-Host "  $($_.FullName.Substring($bundleDir.Length + 1)) ($([math]::Round($_.Length / 1MB, 2)) MB)"
        }
    }

    Write-Host "`n打包成功！版本 v$version" -ForegroundColor Green

} catch {
    Write-Host "`n构建失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
