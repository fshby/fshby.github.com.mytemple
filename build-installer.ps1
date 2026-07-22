[CmdletBinding()]
param(
    [switch]$KeepBuildFiles,
    [switch]$SkipSyntaxCheck
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$packagingDir = Join-Path $projectRoot "packaging"
$distDir = Join-Path $projectRoot "dist"
$buildRoot = Join-Path $packagingDir ".build"
$payloadDir = Join-Path $buildRoot "payload"
$payloadZip = Join-Path $buildRoot "payload.zip"
$launcherOutput = Join-Path $buildRoot "MyTempleKnowledge.exe"
$installerOutput = Join-Path $buildRoot "MyTempleKnowledge_Setup.exe"
$generatedInstallerSource = Join-Path $buildRoot "SelfExtractInstaller.generated.cs"

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-Path([string]$RelativePath, [string]$Kind = "Any") {
    $fullPath = Join-Path $projectRoot $RelativePath
    $exists = if ($Kind -eq "Directory") { Test-Path -LiteralPath $fullPath -PathType Container } else { Test-Path -LiteralPath $fullPath }
    if (-not $exists) { throw "Required packaging item is missing: $RelativePath" }
    return $fullPath
}

function Remove-SafeBuildDirectory {
    if (-not (Test-Path -LiteralPath $buildRoot)) { return }
    $resolved = [IO.Path]::GetFullPath($buildRoot)
    $expectedParent = [IO.Path]::GetFullPath($packagingDir).TrimEnd('\') + '\'
    if (-not ($resolved + '\').StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the packaging directory: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Resolve-CSharpCompiler {
    $candidates = @(
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $command = Get-Command csc.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "C# compiler csc.exe was not found. Install or enable .NET Framework 4.x."
}

function Invoke-Compiler([string]$Compiler, [string[]]$Arguments, [string]$TargetName) {
    & $Compiler @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$TargetName compilation failed with exit code $LASTEXITCODE." }
}

function Copy-PayloadItem([string]$RelativePath) {
    $source = Join-Path $projectRoot $RelativePath
    Copy-Item -LiteralPath $source -Destination $payloadDir -Recurse -Force
}

try {
    Write-Step "Validating project and version metadata"
    $requiredFiles = @(
        "server.js",
        "package.json",
        "server",
        "version.json",
        "public",
        "public\qqqun.webp",
        "docs",
        "docs\README.md",
        "source",
        "packaging\logo.ico",
        "packaging\Launcher.cs",
        "packaging\SelfExtractInstaller.cs"
    )
    foreach ($item in $requiredFiles) { [void](Assert-Path $item) }

    $docsDir = Join-Path $projectRoot "docs"
    $docGuideFiles = @(Get-ChildItem -LiteralPath $docsDir -File -Filter "*.md")
    if ($docGuideFiles.Count -lt 5) { throw "The docs directory must contain the complete default usage guide set (at least 5 Markdown files)." }
    $knowledgeIndexFile = $null
    foreach ($candidate in @(Get-ChildItem -LiteralPath $docsDir -File -Filter "*.json")) {
        try {
            $candidateJson = Get-Content -LiteralPath $candidate.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            $properties = @($candidateJson.PSObject.Properties.Name)
            if ([int]$candidateJson.schemaVersion -ge 1 -and $properties -contains "documents" -and $properties -contains "graph") {
                $knowledgeIndexFile = $candidate
                break
            }
        } catch { }
    }
    if (-not $knowledgeIndexFile) { throw "The docs directory does not contain a valid knowledge index JSON file." }
    $requiredDocEntries = @($docGuideFiles | ForEach-Object { "docs/$($_.Name)" })
    $knowledgeIndexPayloadEntry = "docs/$($knowledgeIndexFile.Name)"

    $versionFile = Join-Path $projectRoot "version.json"
    try {
        $versionInfo = Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "version.json is not valid JSON: $($_.Exception.Message)"
    }
    $version = [string]$versionInfo.version
    if ([string]::IsNullOrWhiteSpace($version)) { throw "version.json does not contain a version value." }
    if ($version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw "Version contains characters that cannot be used in a file name: $version" }
    Write-Host "Version: v$version"

    if (-not $SkipSyntaxCheck) {
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($node) {
            Write-Step "Checking JavaScript syntax"
            $javascriptFiles = @(
                "server.js",
                "server\rag.js",
                "server\frontmatter.js",
                "server\agent-policy.js",
                "public\app.js",
                "public\graph-worker.js"
            )
            foreach ($javascriptFile in $javascriptFiles) {
                & $node.Source --check (Join-Path $projectRoot $javascriptFile)
                if ($LASTEXITCODE -ne 0) { throw "$javascriptFile syntax check failed." }
            }
        } else {
            Write-Warning "Node.js was not found. JavaScript syntax checks were skipped; the installed app still requires Node.js."
        }
    }

    $cscPath = Resolve-CSharpCompiler
    Write-Host "Compiler: $cscPath"

    Remove-SafeBuildDirectory
    New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null

    Write-Step "Compiling launcher"
    Invoke-Compiler $cscPath @(
        "/target:winexe",
        "/out:$launcherOutput",
        "/win32icon:$(Join-Path $packagingDir 'logo.ico')",
        "/platform:x64",
        "/nologo",
        "/reference:System.Windows.Forms.dll",
        "/reference:System.Drawing.dll",
        (Join-Path $packagingDir "Launcher.cs")
    ) "Launcher"

    Write-Step "Assembling and validating payload.zip"
    Copy-PayloadItem "server.js"
    Copy-PayloadItem "package.json"
    Copy-PayloadItem "server"
    Copy-PayloadItem "version.json"
    Copy-PayloadItem "public"
    Copy-PayloadItem "docs"
    Copy-PayloadItem "source"
    Copy-Item -LiteralPath (Join-Path $packagingDir "logo.ico") -Destination $payloadDir -Force
    Copy-Item -LiteralPath $launcherOutput -Destination (Join-Path $payloadDir "MyTempleKnowledge.exe") -Force
    Compress-Archive -Path (Join-Path $payloadDir "*") -DestinationPath $payloadZip -CompressionLevel Optimal -Force

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($payloadZip)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        $requiredPayloadEntries = @(
            "server.js",
            "package.json",
            "server/rag.js",
            "server/frontmatter.js",
            "server/agent-policy.js",
            "version.json",
            "MyTempleKnowledge.exe",
            "public/index.html",
            "public/app.js",
            "public/qqqun.webp",
            "docs/README.md"
        ) + $requiredDocEntries + @($knowledgeIndexPayloadEntry)
        foreach ($requiredEntry in $requiredPayloadEntries) {
            if ($entries -notcontains $requiredEntry) { throw "payload.zip is missing: $requiredEntry" }
        }
    } finally {
        $archive.Dispose()
    }

    Write-Step "Injecting version and compiling installer"
    $installerSource = Get-Content -LiteralPath (Join-Path $packagingDir "SelfExtractInstaller.cs") -Raw -Encoding UTF8
    $versionPattern = 'const\s+string\s+APP_VERSION\s*=\s*"[^"]*";'
    if ($installerSource -notmatch $versionPattern) { throw "APP_VERSION was not found in the installer source." }
    $installerSource = [regex]::Replace($installerSource, $versionPattern, "const string APP_VERSION = `"$version`";", 1)
    Set-Content -LiteralPath $generatedInstallerSource -Value $installerSource -Encoding UTF8

    Invoke-Compiler $cscPath @(
        "/target:exe",
        "/out:$installerOutput",
        "/resource:$payloadZip,payload.zip",
        "/win32icon:$(Join-Path $packagingDir 'logo.ico')",
        "/platform:x64",
        "/nologo",
        "/reference:System.IO.Compression.dll",
        "/reference:System.IO.Compression.FileSystem.dll",
        $generatedInstallerSource
    ) "Installer"

    if ((Get-Item -LiteralPath $installerOutput).Length -le (Get-Item -LiteralPath $payloadZip).Length) {
        throw "Installer size is invalid; payload.zip may not have been embedded."
    }

    Write-Step "Publishing build outputs"
    $genericInstaller = Join-Path $distDir "MyTempleKnowledge_Setup.exe"
    $versionedInstaller = Join-Path $distDir "MyTempleKnowledge_Setup_v$version.exe"
    $publishedLauncher = Join-Path $distDir "MyTempleKnowledge.exe"
    Copy-Item -LiteralPath $launcherOutput -Destination $publishedLauncher -Force
    Copy-Item -LiteralPath $payloadZip -Destination (Join-Path $packagingDir "payload.zip") -Force
    Copy-Item -LiteralPath $installerOutput -Destination $genericInstaller -Force
    Copy-Item -LiteralPath $installerOutput -Destination $versionedInstaller -Force

    $publishedFiles = @($publishedLauncher, $genericInstaller, $versionedInstaller)
    $manifestFiles = foreach ($file in $publishedFiles) {
        $item = Get-Item -LiteralPath $file
        $hash = Get-FileHash -LiteralPath $file -Algorithm SHA256
        [ordered]@{ name = $item.Name; bytes = $item.Length; sha256 = $hash.Hash.ToLowerInvariant() }
    }
    $manifest = [ordered]@{
        product = "MyTemple Knowledge"
        version = $version
        builtAt = (Get-Date).ToUniversalTime().ToString("o")
        files = @($manifestFiles)
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $distDir "build-manifest.json") -Encoding UTF8
    $manifestFiles | ForEach-Object { "$($_.sha256)  $($_.name)" } | Set-Content -LiteralPath (Join-Path $distDir "checksums.sha256") -Encoding ASCII

    Write-Host "`nBuild completed successfully." -ForegroundColor Green
    Write-Host "Generic installer: $genericInstaller"
    Write-Host "Versioned installer: $versionedInstaller"
    Write-Host "Checksums: $(Join-Path $distDir 'checksums.sha256')"
} catch {
    Write-Host "`nBuild failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if (-not $KeepBuildFiles) {
        try { Remove-SafeBuildDirectory } catch { Write-Warning $_.Exception.Message }
    }
}
