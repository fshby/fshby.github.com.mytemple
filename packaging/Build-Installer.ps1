$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$build = Join-Path $root "build"
$payload = Join-Path $build "payload"
$dist = Join-Path $root "dist"
$icon = Join-Path $build "mytemple.ico"
$launcher = Join-Path $payload "MyTempleKnowledge.exe"
$zip = Join-Path $build "payload.zip"
$setup = Join-Path $dist "MyTempleKnowledgeSetup.exe"

if (Test-Path -LiteralPath $build) { Remove-Item -LiteralPath $build -Recurse -Force }
if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
New-Item -ItemType Directory -Path $payload -Force | Out-Null
New-Item -ItemType Directory -Path $dist -Force | Out-Null

Add-Type -AssemblyName System.Drawing

function New-IconFile($path) {
  $bitmap = New-Object System.Drawing.Bitmap 256, 256
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $rect = New-Object System.Drawing.Rectangle 0, 0, 256, 256
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(15,118,110)), ([System.Drawing.Color]::FromArgb(29,41,57)), 45
  $g.FillRectangle($brush, $rect)

  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245,255,255,255))
  $doc = New-Object System.Drawing.Rectangle 64, 54, 128, 146
  $g.FillRectangle($white, $doc)

  $fontMd = New-Object System.Drawing.Font "Segoe UI", 44, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fontDot = New-Object System.Drawing.Font "Segoe UI", 36, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $green = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(15,118,110))
  $dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(29,41,57))
  $g.DrawString("MD", $fontMd, $green, 82, 94)
  $g.DrawString(".", $fontDot, $dark, 162, 112)

  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(159,231,220)), 10
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($pen, 84, 214, 172, 214)

  $handle = $bitmap.GetHicon()
  $iconObj = [System.Drawing.Icon]::FromHandle($handle)
  $stream = [System.IO.File]::Create($path)
  $iconObj.Save($stream)
  $stream.Close()
  $g.Dispose()
  $bitmap.Dispose()
}

function Get-Csc {
  $candidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
  )
  return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

New-IconFile $icon

$csc = Get-Csc
if (-not $csc) { throw "csc.exe was not found. Cannot build installer." }

$launcherSource = Join-Path $PSScriptRoot "MyTempleLauncher.cs"
$launcherArgs = @(
  "/nologo",
  "/target:winexe",
  "/platform:anycpu",
  "/optimize+",
  "/win32icon:$icon",
  "/out:$launcher",
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Drawing.dll",
  $launcherSource
)
& $csc @launcherArgs

$items = @("server.js", "package.json", "README.md", "STANDALONE.md", "public", "docs", "source", "scripts")
foreach ($item in $items) {
  $from = Join-Path $root $item
  if (Test-Path -LiteralPath $from) {
    Copy-Item -LiteralPath $from -Destination $payload -Recurse -Force
  }
}

Compress-Archive -Path (Join-Path $payload "*") -DestinationPath $zip -Force

$installerSource = Join-Path $PSScriptRoot "MyTempleInstaller.cs"
$installerArgs = @(
  "/nologo",
  "/target:winexe",
  "/platform:anycpu",
  "/optimize+",
  "/win32icon:$icon",
  "/out:$setup",
  "/resource:$zip,payload.zip",
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Management.dll",
  "/reference:System.IO.Compression.dll",
  "/reference:System.IO.Compression.FileSystem.dll",
  $installerSource
)
& $csc @installerArgs

$payloadSize = (Get-Item -LiteralPath $zip).Length
$setupSize = (Get-Item -LiteralPath $setup).Length
$launcherSize = (Get-Item -LiteralPath $launcher).Length
[PSCustomObject]@{
  Installer = $setup
  InstallerKB = [math]::Round($setupSize / 1KB, 2)
  PayloadKB = [math]::Round($payloadSize / 1KB, 2)
  LauncherKB = [math]::Round($launcherSize / 1KB, 2)
  InstallPath = "%LOCALAPPDATA%\MyTempleKnowledge"
} | Format-List
