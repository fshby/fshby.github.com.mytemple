[CmdletBinding()]
param(
    # Target version (e.g. 2.1.16); if omitted, auto-increment last segment
    [string]$Version,
    # Skip tauri build, only sync resources and version files
    [switch]$SkipBuild,
    # Skip deploy to dist/ and promo/downloads/
    [switch]$SkipDeploy,
    # Skip promo/index.html version update
    [switch]$SkipPromoUpdate,
    # Short release notes (single line)
    [string]$ReleaseNotes
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$packagingDir = Join-Path $projectRoot "packaging"
$publicDir = Join-Path $projectRoot "public"
$promoDir = Join-Path $projectRoot "promo"
$distDir = Join-Path $projectRoot "dist"
$srcTauriDir = Join-Path $projectRoot "src-tauri"
$versionFile = Join-Path $projectRoot "version.json"
$promoVersionFile = Join-Path $promoDir "version.json"
$tauriConfFile = Join-Path $srcTauriDir "tauri.conf.json"
$indexHtmlFile = Join-Path $promoDir "index.html"

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}
function Write-OK([string]$Message) {
    Write-Host "    OK: $Message" -ForegroundColor Green
}
function Write-Warn2([string]$Message) {
    Write-Host "    !! $Message" -ForegroundColor Yellow
}

# ──────────────────────────────────────────────────────────────
# 1. Compute target version
# ──────────────────────────────────────────────────────────────
Write-Step "Compute target version"

$currentVersionJson = Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8 | ConvertFrom-Json
$currentVersion = [string]$currentVersionJson.version
Write-Host "    Current: v$currentVersion"

if (-not $Version) {
    $parts = $currentVersion -split '\.'
    if ($parts.Length -lt 2) {
        throw "Cannot parse current version: $currentVersion"
    }
    $last = [int]$parts[-1]
    $parts[-1] = [string]($last + 1)
    $Version = $parts -join '.'
}
Write-Host "    Target:  v$Version"

# ──────────────────────────────────────────────────────────────
# 2. Sync icons: packaging/ is the single source of truth
#    Copy to public/ and promo/ to avoid icon mismatch
# ──────────────────────────────────────────────────────────────
Write-Step "Sync icons (packaging/ -> public/ + promo/)"

$logoSources = @(
    @{ Src = Join-Path $packagingDir "logo.png"; Dst = Join-Path $publicDir "logo.png" },
    @{ Src = Join-Path $packagingDir "logo.png"; Dst = Join-Path $promoDir "logo.png" },
    @{ Src = Join-Path $packagingDir "logo.ico"; Dst = Join-Path $promoDir "logo.ico" },
    @{ Src = Join-Path $packagingDir "logo.webp"; Dst = Join-Path $publicDir "logo.webp" },
    @{ Src = Join-Path $packagingDir "logo.webp"; Dst = Join-Path $promoDir "logo.webp" }
)

foreach ($item in $logoSources) {
    $src = $item.Src
    $dst = $item.Dst
    if (-not (Test-Path $src)) {
        Write-Warn2 "Source missing, skip: $src"
        continue
    }
    $srcHash = (Get-FileHash $src -Algorithm SHA256).Hash
    $needCopy = $true
    if (Test-Path $dst) {
        $dstHash = (Get-FileHash $dst -Algorithm SHA256).Hash
        if ($srcHash -eq $dstHash) {
            $needCopy = $false
        }
    }
    if ($needCopy) {
        Copy-Item -LiteralPath $src -Destination $dst -Force
        $relSrc = $src.Substring($projectRoot.Length + 1)
        $relDst = $dst.Substring($projectRoot.Length + 1)
        Write-Host "    Synced: $relSrc -> $relDst"
    } else {
        $relDst = $dst.Substring($projectRoot.Length + 1)
        Write-OK "$relDst already up-to-date"
    }
}

# ──────────────────────────────────────────────────────────────
# 3. Update version.json (project root + promo/)
# ──────────────────────────────────────────────────────────────
Write-Step "Update version.json (v$Version)"

$today = (Get-Date).ToString("yyyy-MM-dd")
$shortNotes = if ($ReleaseNotes) { $ReleaseNotes } else { "v$Version release" }
$longNotes = "v$Version release. See changelog for details."

$versionObj = [PSCustomObject]@{
    version = $Version
    downloadUrl = "https://mytemple.fshby.cc/downloads/MyTempleKnowledge_Setup.exe"
    latestReleaseNotes = $shortNotes
    releaseNotes = $longNotes
    releaseDate = $today
}

$versionJson = $versionObj | ConvertTo-Json -Depth 5
# Write as UTF-8 without BOM
[System.IO.File]::WriteAllText($versionFile, $versionJson, [System.Text.UTF8Encoding]::new($false))
Write-OK "version.json updated"

[System.IO.File]::WriteAllText($promoVersionFile, $versionJson, [System.Text.UTF8Encoding]::new($false))
Write-OK "promo/version.json updated"

# ──────────────────────────────────────────────────────────────
# 4. Update tauri.conf.json version
# ──────────────────────────────────────────────────────────────
Write-Step "Update tauri.conf.json version"

$tauriConf = Get-Content -LiteralPath $tauriConfFile -Raw -Encoding UTF8
$pattern = '"version"\s*:\s*"[\d.]+"'
$replacement = "`"version`": `"$Version`""
$tauriConfNew = [regex]::Replace($tauriConf, $pattern, $replacement)
if ($tauriConf -eq $tauriConfNew) {
    Write-Warn2 "version field not found in tauri.conf.json"
} else {
    [System.IO.File]::WriteAllText($tauriConfFile, $tauriConfNew, [System.Text.UTF8Encoding]::new($false))
    Write-OK "tauri.conf.json version -> $Version"
}

# ──────────────────────────────────────────────────────────────
# 5. Update promo/index.html version strings
# ──────────────────────────────────────────────────────────────
if (-not $SkipPromoUpdate) {
    Write-Step "Update promo/index.html version strings"

    if (Test-Path $indexHtmlFile) {
        $html = Get-Content -LiteralPath $indexHtmlFile -Raw -Encoding UTF8
        # Only replace the 3 CURRENT version spots (not historical entries in update-list)
        # 1. Download button: "download>v2.1.15"
        # 2. Desktop badge:  "v2.1.15 desktop"
        # 3. Stable badge:    "stable v2.1.15"
        $htmlNew = $html `
            -replace "download>v$currentVersion", "download>v$Version" `
            -replace "v$currentVersion ", "v$Version " `
            -replace "v$currentVersion<", "v$Version<"

        if ($html -ne $htmlNew) {
            [System.IO.File]::WriteAllText($indexHtmlFile, $htmlNew, [System.Text.UTF8Encoding]::new($false))
            Write-OK "promo/index.html version -> v$Version"
        } else {
            Write-Warn2 "promo/index.html: no current-version pattern matched"
        }
    } else {
        Write-Warn2 "promo/index.html not found, skip"
    }
}

# ──────────────────────────────────────────────────────────────
# 6. Clean stale icon cache in resources/public
# ──────────────────────────────────────────────────────────────
Write-Step "Clean stale icon cache in resources/public"

$resPublicDir = Join-Path $srcTauriDir "resources\public"
if (Test-Path $resPublicDir) {
    Get-ChildItem -Path $resPublicDir -Filter "logo.*" -File | Remove-Item -Force
    Write-OK "Cleaned resources/public/logo.*"
} else {
    Write-OK "resources/public not exist, skip clean"
}

# ──────────────────────────────────────────────────────────────
# 7. Build
# ──────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    Write-Step "Tauri Release build (v$Version)"

    Push-Location $projectRoot
    try {
        & npx tauri build 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri build failed (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }
    Write-OK "Build succeeded"
}

# ──────────────────────────────────────────────────────────────
# 8. Deploy installer to dist/ and promo/downloads/
# ──────────────────────────────────────────────────────────────
if (-not $SkipDeploy -and -not $SkipBuild) {
    Write-Step "Deploy installer"

    $bundleNsisDir = Join-Path $srcTauriDir "target\release\bundle\nsis"
    $setupExe = Get-ChildItem -Path $bundleNsisDir -Filter "*x64-setup.exe" -File | Select-Object -First 1

    if (-not $setupExe) {
        throw "Build output not found: $bundleNsisDir\*x64-setup.exe"
    }

    Write-Host "    Source: $($setupExe.FullName)"
    Write-Host "    Size:   $([math]::Round($setupExe.Length / 1MB, 2)) MB"

    if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
    $promoDownloadsDir = Join-Path $promoDir "downloads"
    if (-not (Test-Path $promoDownloadsDir)) { New-Item -ItemType Directory -Path $promoDownloadsDir | Out-Null }

    $distCopy = Join-Path $distDir "MyTemple Knowledge_${Version}_x64-setup.exe"
    $promoMainCopy = Join-Path $promoDownloadsDir "MyTempleKnowledge_Setup.exe"
    $promoVerCopy = Join-Path $promoDownloadsDir "MyTempleKnowledge_Setup_v${Version}.exe"

    Copy-Item -LiteralPath $setupExe.FullName -Destination $distCopy -Force
    Write-OK "-> $distCopy"

    Copy-Item -LiteralPath $setupExe.FullName -Destination $promoMainCopy -Force
    Write-OK "-> $promoMainCopy"

    Copy-Item -LiteralPath $setupExe.FullName -Destination $promoVerCopy -Force
    Write-OK "-> $promoVerCopy"
}

# ──────────────────────────────────────────────────────────────
# 9. Done
# ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Version v$Version build complete" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (-not $SkipBuild -and -not $SkipDeploy) {
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  git add -A ; git commit -m `"v$Version`" ; git push origin main"
    Write-Host "  Verify:   https://mytemple.fshby.cc/downloads/MyTempleKnowledge_Setup.exe"
}
